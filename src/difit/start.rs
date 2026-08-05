//! `mt difit start` — difit サーバの起動とコメント注入。
//!
//! 完了条件 1: stdout に `{"port": N, "url": "http://localhost:N"}` を出力。
//! 完了条件 3: `.difit/` を idempotent に作成し `difit-review.json` を管理。
//! 完了条件 4: stdin 空の場合、保存済みコメントで再注入（クラッシュ復旧）。
//! 完了条件 5: stale 状態を自己修復（旧サーバ kill → 再起動）。

use std::io::{IsTerminal, Read};

use anyhow::Context;

use super::shared::{self, ReviewState};

/// `mt difit start` のエントリポイント。
pub fn start(difit_args: Vec<String>) -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;
    shared::ensure_difit_dir(&repo_root)?;

    // --- 引数変換: ワーキングディレクトリ vs ベースブランチのセマンティクス ---
    let difit_args = translate_difit_args(difit_args);

    // --- untracked ファイルを intent-to-add で diff に含める（ADR-0009）---
    mark_untracked_intent_to_add(&repo_root);

    // --- 旧サーバの処理（ゾンビ防止 & stale 自己修復）---
    let old_state = shared::read_review_state(&repo_root);

    // 旧サーバが生存していれば kill 前に現在コメントを取得する。
    // resolve 済みスレッドは comment get から消えるため、
    // 再注入時に正しく解決済み扱いになる（方針 6）。
    let saved_comments = match old_state {
        Some(ref old) if shared::is_process_alive(old.pid) => {
            let fetched = shared::fetch_comments(old.port)
                .ok()
                .map(|resp| shared::threads_to_import_comments(&resp.threads))
                .unwrap_or_else(|| old.comments.clone());
            shared::kill_server(old.pid);
            shared::delete_review_state(&repo_root);
            fetched
        }
        Some(ref old) => {
            // stale（サーバ死）→ 保存済みコメントで復旧
            let comments = old.comments.clone();
            shared::delete_review_state(&repo_root);
            comments
        }
        None => Vec::new(),
    };

    // --- コメントの決定: stdin 優先、空なら保存済みで復旧 ---
    let comments = read_stdin_comments()?.unwrap_or(saved_comments);

    // --- position 正規化（ADR-0011, 完了条件 1, 2, 3）---
    // difit 5.0.8 の normalizeCommentImportEntry は position（side + line）を必須とし、
    // 欠落時は throw する。stdin と保存済みコメントの統合後の最終配列に合成を適用する
    // ことで、両パス（stdin 入力 / クラッシュ復旧）の position 欠落エントリを正規化する。
    let comments = synthesize_missing_positions(comments);

    // --- difit サーバ起動 ---
    let bg = shared::spawn_difit_server(&repo_root, &difit_args, &comments)?;

    // --- 状態保存 ---
    let state = ReviewState {
        port: bg.port,
        pid: bg.pid,
        comments,
        difit_args,
    };
    shared::write_review_state(&repo_root, &state)?;

    // --- stdout に JSON 出力（完了条件 1）---
    let out = serde_json::json!({
        "port": bg.port,
        "url": format!("http://localhost:{}", bg.port),
    });
    println!("{}", out);

    Ok(())
}

// ---------------------------------------------------------------------------
// 引数変換（ADR-0008）
// ---------------------------------------------------------------------------

/// difit の特殊ターゲット。これらは `--merge-base` を必要としない。
const SPECIAL_TARGETS: &[&str] = &["working", "staged"];

/// `mt difit start` の引数を difit CLI の引数に変換する。
///
/// セマンティクス: 「ワーキングディレクトリ vs ベースブランチのレビューセッション開始」。
///
/// | 入力 | 変換後 | 説明 |
/// |---|---|---|
/// | `["main"]` | `[".", "main", "--merge-base", "--clean"]` | ブランチ名 → `.` 挿入 |
/// | `[".", "main"]` | `[".", "main", "--merge-base", "--clean"]` | 既に `.` 付き |
/// | `["working"]` | `["working", "--clean"]` | 特殊ターゲット |
/// | `["staged"]` | `["staged", "--clean"]` | 特殊ターゲット |
/// | `[]` | `[]` | 空 → 透過 |
/// | `["HEAD~3"]` | `["HEAD~3", "--clean"]` | コミット参照 |
pub fn translate_difit_args(args: Vec<String>) -> Vec<String> {
    if args.is_empty() {
        return args;
    }

    // 既に `.` で始まる 2 ターゲット形式 → --merge-base + --clean を付与
    if args[0] == "." {
        let mut result = args;
        result.push("--merge-base".to_string());
        result.push("--clean".to_string());
        return result;
    }

    // 単一引数の場合
    if args.len() == 1 {
        let target = &args[0];

        // 特殊ターゲット → --clean のみ
        if SPECIAL_TARGETS.contains(&target.as_str()) {
            let mut result = args;
            result.push("--clean".to_string());
            return result;
        }

        // コミット参照 → --clean のみ（--merge-base 不要）
        if is_commit_ref(target) {
            let mut result = args;
            result.push("--clean".to_string());
            return result;
        }

        // ブランチ名 → "." を先頭に挿入 + --merge-base + --clean
        let mut result = Vec::with_capacity(args.len() + 3);
        result.push(".".to_string());
        result.extend(args);
        result.push("--merge-base".to_string());
        result.push("--clean".to_string());
        return result;
    }

    // 複数引数（`.` なし）→ --clean のみ付与（保守的フォールバック）
    let mut result = args;
    result.push("--clean".to_string());
    result
}

/// 引数がコミット参照かどうかを判定する。
///
/// - `HEAD` で始まる（HEAD, HEAD~3, HEAD^2 等）
/// - `~`, `^`, `:` を含む（branch~3, tag^{} 等）
/// - 16 進数のみで 7 文字以上（SHA ハッシュ）
fn is_commit_ref(s: &str) -> bool {
    if s.starts_with("HEAD") {
        return true;
    }
    if s.contains('~') || s.contains('^') || s.contains(':') {
        return true;
    }
    // SHA ハッシュ: 7〜40 文字の 16 進数
    if s.len() >= 7 && s.len() <= 40 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    false
}

/// untracked ファイル（.gitignore 対象外）に intent-to-add を付ける（ADR-0009）。
///
/// `git diff` に untracked ファイルが現れるようになり、difit のワーキング
/// ディレクトリ diff に含まれる。difit の `--include-untracked` と同じ機構だが、
/// あのフラグは `--background` 起動時に親プロセスが子の stdout 最初の 1 行
/// （JSON ではなく "✅ Files added" メッセージ）を転送してハングするため
/// 使わず、mt 側で事前に実行する。
///
/// best-effort: 失敗時は警告のみで続行する（untracked なしの diff に縮退）。
pub fn mark_untracked_intent_to_add(repo_root: &std::path::Path) {
    use std::os::unix::ffi::OsStrExt;

    let listed = match std::process::Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .current_dir(repo_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => output.stdout,
        _ => return,
    };

    let files: Vec<std::ffi::OsString> = listed
        .split(|byte| *byte == 0)
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| std::ffi::OsStr::from_bytes(chunk).to_os_string())
        .collect();

    if files.is_empty() {
        return;
    }

    let result = std::process::Command::new("git")
        .arg("add")
        .arg("--intent-to-add")
        .arg("--")
        .args(&files)
        .current_dir(repo_root)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output();

    match result {
        Ok(output) if output.status.success() => {
            eprintln!("marked {} untracked file(s) as intent-to-add", files.len());
        }
        Ok(output) => {
            eprintln!(
                "warning: git add --intent-to-add failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Err(error) => {
            eprintln!("warning: git add --intent-to-add failed: {error}");
        }
    }
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

/// position キーを持たないコメントエントリに `{"side":"new","line":1}` を合成する。
///
/// difit 5.0.8 の `normalizeCommentImportEntry` は position（side + line）を必須として
/// おり、欠落時は throw して起動が失敗する。position なし（ファイルレベル）のコメント
/// エントリを difit に渡す前に line:1 に正規化する（ADR-0011）。
///
/// 合成は position キーが**存在しない**エントリにのみ適用される。position を持つ
/// エントリ（thread / reply）は一切変更しない。非オブジェクトのエントリも変更しない。
/// 適用後に再適用しても結果は変わらない（冪等）。
fn synthesize_missing_positions(comments: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    comments
        .into_iter()
        .map(|entry| match entry {
            serde_json::Value::Object(mut obj) if !obj.contains_key("position") => {
                obj.insert(
                    "position".to_string(),
                    serde_json::json!({"side": "new", "line": 1}),
                );
                serde_json::Value::Object(obj)
            }
            other => other,
        })
        .collect()
}

#[cfg(test)]
#[path = "start.test.rs"]
mod tests;
