//! `mt difit start` — difit サーバの起動とコメント注入。
//!
//! - 実行中セッション（同一 difit 引数）は再利用し、コメントを追記する。
//!   サーバのポートが変わらないため、次ラウンドも同じ URL でレビューを継続できる。
//! - コメントの読み書きは起動時に確定した diff 選択（base / target / baseMode）で
//!   固定し、ブラウザ UI のリビジョン切替で別セッションへ追記・取得しない。
//! - stale state（サーバ死）や difit 引数の変更時は、保存済みの未 resolve コメントを
//!   再注入して新サーバを起動する（クラッシュ復旧）。新サーバの起動と状態保存が
//!   完了するまで旧サーバ・旧 state は残す。
//! - レビュー表示は stdout JSON の `url`（`http://localhost:<port>`）を提示するのみで、
//!   外部表示ツールには依存しない（ADR-0027）。

use std::io::{IsTerminal, Read};
use std::path::Path;

use anyhow::Context;

use super::client;
use super::shared::{self, ReviewState};

/// `mt difit start` のエントリポイント。
pub fn start(args: Vec<String>) -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;
    shared::ensure_difit_dir(&repo_root)?;

    // --- 引数変換: ワーキングディレクトリ vs ベースブランチのセマンティクス ---
    let difit_args = translate_difit_args(&repo_root, args);

    // --- コメントの決定: stdin が TTY または空ならコメントなし ---
    let new_comments =
        shared::synthesize_missing_positions(read_stdin_comments()?.unwrap_or_default());

    // --- 実行中サーバの再利用、または stale 復旧を伴う起動 ---
    // 選択キーの未記録な state（旧形式）は再利用せず、コメントを引き継いで
    // 再起動する（`restart_session` は選択キー不明でも保存済みコメントを使う）。
    let state = match shared::read_review_state(&repo_root) {
        Some(state)
            if state.difit_args == difit_args
                && state.selection.is_some()
                && shared::is_server_live(&state) =>
        {
            match reuse_running_session(&repo_root, state, &new_comments) {
                Ok(state) => state,
                Err(error) => {
                    eprintln!(
                        "mt difit start: 実行中セッションの再利用に失敗したため再起動します: {error:#}"
                    );
                    let prior = shared::read_review_state(&repo_root);
                    restart_session(&repo_root, prior, &difit_args, &new_comments)?
                }
            }
        }
        prior => restart_session(&repo_root, prior, &difit_args, &new_comments)?,
    };

    // --- stdout に JSON 出力 ---
    let out = serde_json::json!({
        "port": state.port,
        "url": shared::url_for_port(state.port),
        "comments": new_comments.len(),
    });
    println!("{out}");

    Ok(())
}

/// 実行中サーバを再利用し、コメント追記と状態更新を行う。
///
/// 読み書きは state に記録済みの選択キーで固定する（ブラウザ UI のリビジョン
/// 切替で別セッションへ追記・取得しない）。
fn reuse_running_session(
    repo_root: &std::path::Path,
    mut state: ReviewState,
    new_comments: &[serde_json::Value],
) -> anyhow::Result<ReviewState> {
    let selection = state
        .selection
        .clone()
        .context("difit セッションのコメント選択キーが state にないため再利用できません")?;

    client::add_comments(state.port, Some(&selection), new_comments)?;

    // 未 resolve のみを状態へ反映する（resolve 済みスレッドの復活防止）。
    // 取得に失敗した場合はサーバが不健全とみなし、呼び出し側で再起動させる。
    let response = client::fetch_comments(state.port, Some(&selection))?;
    state.comments = shared::threads_to_import_comments(&response.threads);

    shared::write_review_state(repo_root, &state)?;
    Ok(state)
}

/// 新サーバの起動・選択キー確定・状態保存が完了してから旧サーバを停止する。
///
/// 旧 state / 旧サーバは新 state の保存が成功するまで残す。spawn 失敗や状態
/// 保存失敗時は新サーバを停止して旧 state を復旧源として残し、未 resolve
/// コメント・人間 reply の唯一の永続記録を失わない（shared::ensure_server_running
/// と同じ復旧契約）。
fn restart_session(
    repo_root: &std::path::Path,
    prior: Option<ReviewState>,
    difit_args: &[String],
    new_comments: &[serde_json::Value],
) -> anyhow::Result<ReviewState> {
    let (saved_comments, obsolete_pid) = match prior {
        Some(state) => {
            let mut saved = state.comments.clone();
            let mut obsolete_pid = None;

            // 旧サーバが記録 port を LISTEN していることを OS 情報で照合し、
            // difit として応答する場合のみ kill 対象にする。照合できない pid は
            // 同一性不明（PID 再利用・細工した state の可能性）として残す。
            // 選択キー既知なら固定したセッションの未 resolve を引き継ぐ。不明
            // （旧 state）な応答はサーバ可変の選択に依存するため使わない。
            if shared::is_pid_listening_on_port(state.pid, state.port) {
                if let Ok(response) = client::fetch_comments(state.port, state.selection.as_ref()) {
                    obsolete_pid = Some(state.pid);
                    if state.selection.is_some() {
                        saved = shared::threads_to_import_comments(&response.threads);
                    }
                } else {
                    // LISTEN の照合は取れているがコメントを回収できなかった旧サーバは、
                    // 未回収コメントの唯一の保持者であり得るため停止しない
                    // （ensure_server_running と同じ判断・同じ孤児警告）。
                    shared::warn_server_unresponsive_orphan(state.pid, state.port);
                }
            } else if shared::is_process_alive(state.pid) {
                shared::warn_server_identity_unverified(state.pid, state.port);
            }

            (saved, obsolete_pid)
        }
        None => (Vec::new(), None),
    };

    let mut comments = shared::synthesize_missing_positions(saved_comments);
    comments.extend(new_comments.iter().cloned());

    // 旧サーバはまだ停止しない。ここで失敗しても旧 state / 旧サーバが残る。
    let server = shared::start_difit_server(repo_root, difit_args, &comments)?;

    let state = ReviewState {
        port: server.port,
        pid: server.pid,
        comments,
        difit_args: difit_args.to_vec(),
        selection: Some(server.selection),
    };

    if let Err(error) = shared::write_review_state(repo_root, &state) {
        // 新 state を保存できない限り旧 state を置き換えない。新サーバを停止し、
        // 旧サーバと旧 state をそのまま残して再試行可能にする。
        shared::kill_server(state.pid);
        return Err(error.context(
            "新しい difit セッションの状態を保存できなかったため、起動したサーバを停止しました",
        ));
    }

    // ここで初めて旧 state の置き換えが完了した。旧サーバを停止する。
    if let Some(pid) = obsolete_pid {
        shared::kill_server(pid);
    }

    Ok(state)
}

// ---------------------------------------------------------------------------
// 引数変換（ADR-0008）
// ---------------------------------------------------------------------------

/// difit の特殊ターゲット。これらは `--merge-base` を必要としない。
const SPECIAL_TARGETS: &[&str] = &["working", "staged"];

/// `mt difit start` の引数を difit CLI の引数に変換する。
///
/// セマンティクス: 「ワーキングディレクトリ vs ベースブランチのレビューセッション開始」。
/// 末尾に共通フラグ（`--clean` / `--include-untracked`）を付与する。
///
/// | 入力 | 変換後 | 説明 |
/// |---|---|---|
/// | `["main"]` | `[".", "main", "--merge-base", "--clean", "--include-untracked"]` | ブランチ名 → `.` 挿入 |
/// | `[".", "main"]` | `[".", "main", "--merge-base", "--clean", "--include-untracked"]` | 既に `.` 付き |
/// | `["working"]` | `["working", "--clean", "--include-untracked"]` | 特殊ターゲット |
/// | `["staged"]` | `["staged", "--clean", "--include-untracked"]` | 特殊ターゲット |
/// | `[]` | `[]` | 空 → 透過 |
/// | `["HEAD~3"]` | `["HEAD~3", "--clean", "--include-untracked"]` | コミット参照 |
/// | `["deadbeef"]` | `[".", "deadbeef", "--merge-base", "--clean", "--include-untracked"]` | 同名 ref が実在する hex 名ブランチ / タグ |
/// | `["abc1234"]` | `["abc1234", "--clean", "--include-untracked"]` | ref が実在しない SHA 風文字列 |
pub fn translate_difit_args(repo_root: &Path, args: Vec<String>) -> Vec<String> {
    if args.is_empty() {
        return args;
    }

    // 既に `.` で始まる 2 ターゲット形式 → --merge-base + 共通フラグを付与
    if args[0] == "." {
        let mut result = args;
        result.push("--merge-base".to_string());
        push_common_flags(&mut result);
        return result;
    }

    // 単一引数の場合
    if args.len() == 1 {
        let target = &args[0];

        // 特殊ターゲット → 共通フラグのみ
        if SPECIAL_TARGETS.contains(&target.as_str()) {
            let mut result = args;
            push_common_flags(&mut result);
            return result;
        }

        // コミット参照 → 共通フラグのみ（--merge-base 不要）
        if is_commit_ref(repo_root, target) {
            let mut result = args;
            push_common_flags(&mut result);
            return result;
        }

        // ブランチ名 → "." を先頭に挿入 + --merge-base + 共通フラグ
        let mut result = Vec::with_capacity(args.len() + 4);
        result.push(".".to_string());
        result.extend(args);
        result.push("--merge-base".to_string());
        push_common_flags(&mut result);
        return result;
    }

    // 複数引数（`.` なし）→ 共通フラグのみ付与（保守的フォールバック）
    let mut result = args;
    push_common_flags(&mut result);
    result
}

/// 全ターゲットに共通して付与する起動フラグ。
///
/// - `--clean`: 前ラウンドのブラウザ内コメントを引き継がず、state のコメントだけを
///   注入源にする
/// - `--include-untracked`: untracked ファイルをワーキングディレクトリ diff に
///   含める（ADR-0009）。intent-to-add は difit 自身が起動時に行うため、mt は
///   git index を事前に書き換えない。
///
/// `--background` 親は IPC ハンドシェイクの JSON 1 行だけを stdout に出し、子
/// stdout（`--include-untracked` 時の "✅ Files added" 等）は `stdio: ignore` で
/// 転送されない（difit 5.0.12）。親が子の非 JSON 行を転送してハングする、という
/// 旧実装の前提は成立しない。この契約は実 difit を使う E2E テストで固定する。
fn push_common_flags(result: &mut Vec<String>) {
    result.push("--clean".to_string());
    result.push("--include-untracked".to_string());
}

/// 引数がコミット参照かどうかを判定する。
///
/// - `HEAD` で始まる（HEAD, HEAD~3, HEAD^2 等）
/// - `~`, `^`, `:` を含む（branch~3, tag^{} 等）
/// - 16 進数のみで 7〜40 文字（SHA ハッシュ）で、同名の ref が実在しない
///
/// 16 進数の文字種だけでは hex 名のブランチ / タグ（`deadbeef` 等）を commit
/// 参照と誤判定し、merge-base モードが失われて未コミット変更が diff から
/// 落ちる。git の名前解決順（ref 優先）に合わせ、ref が実在する場合は
/// SHA ヒューリスティックより ref を優先する。
fn is_commit_ref(repo_root: &Path, s: &str) -> bool {
    if s.starts_with("HEAD") {
        return true;
    }
    if s.contains('~') || s.contains('^') || s.contains(':') {
        return true;
    }
    // SHA ハッシュ: 7〜40 文字の 16 進数（同名 ref がなければ）
    if s.len() >= 7 && s.len() <= 40 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return !ref_exists(repo_root, s);
    }
    false
}

/// ローカルブランチまたはタグの ref が実在するかどうか。
///
/// `git show-ref --verify --quiet` は ref が存在すれば exit 0、存在しなければ
/// 非 0 を返す。git 実行自体に失敗した場合も false（判定不能なら SHA
/// ヒューリスティックを維持し、従来動作から退行させない）。
fn ref_exists(repo_root: &Path, name: &str) -> bool {
    ["refs/heads/", "refs/tags/"].iter().any(|prefix| {
        crate::git::common::command_with_clean_git_context("git")
            .args(["show-ref", "--verify", "--quiet"])
            .arg(format!("{prefix}{name}"))
            .current_dir(repo_root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}

/// stdin からコメント JSON を読み込む。
///
/// - stdin が TTY（パイプなし）→ `None`
/// - stdin が空 → `None`
/// - JSON 配列 → そのまま
/// - JSON オブジェクト → 1 要素の配列にラップ
fn read_stdin_comments() -> anyhow::Result<Option<Vec<serde_json::Value>>> {
    if std::io::stdin().is_terminal() {
        return Ok(None);
    }

    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .context("stdin の読み込みに失敗しました")?;

    let trimmed = buf.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let value: serde_json::Value =
        serde_json::from_str(trimmed).context("stdin の JSON パースに失敗しました")?;

    let comments = match value {
        serde_json::Value::Array(arr) => arr,
        other => vec![other],
    };

    Ok(Some(comments))
}

#[cfg(test)]
#[path = "start.test.rs"]
mod tests;
