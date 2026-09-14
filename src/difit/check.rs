//! `mt difit check` — ゲート判定。
//!
//! 未 resolve スレッド（`difit comment get` に現れるスレッド）が 1 つでも
//! ブロッキングなら exit 1。すべてノンブロッキング（want 単独 / `[context]`）なら
//! 通過としてサーバ停止・状態削除を行い exit 0。
//!
//! 契約:
//! - 通過: セッションを片付ける（次ラウンドは `mt difit start` で新規に開始する）
//! - ブロック: サーバ・状態を残し、次ラウンドでコメントを追記して再利用する
//! - 後始末の実装は `done` と共用する `shared::close_session` の 1 箇所のみ
//! - コメントは state に記録した選択キーで固定して読む（ブラウザ UI の
//!   リビジョン切替で別セッションを読み、無音で通過しない）
//! - 選択キー未記録の state はゲートを判定せず fail-closed で停止する
//!
//! `--dry-run` はゲート判定だけを行い、サーバ停止・状態削除・状態書き換え・
//! stale 復旧を一切しない。出力 JSON と exit code は通常の
//! `check` と同一で、ワークフローが「非破壊で verdict と突合 → 一致後に
//! `mt difit done` で後始末」という順序を組めるようにする。読み取りの前に
//! 記録 pid が記録 port の LISTEN であることを照合し、照合できない state は
//! 復旧せず fail-closed で止める（記録 port の別プロセスをゲートと誤認しない）。
//!
//! 通常・`--dry-run` のどちらも、ゲート固定の選択と difit サーバが現在返す選択を
//! 比較し（GET のみ）、ドリフトを検知したら stderr 警告と出力 JSON の
//! `selection_drift` で報告する。検知結果は `detection`（`detected` / `none` /
//! `unavailable`）の三値で、probe 失敗（検知不能）を「ドリフトなし」と区別する。
//! ワークフローは `unavailable` を fail-closed に扱える。ワークフローが使う
//! `--dry-run` 経路でも、difit UI での reply / resolve が別セッションへ向かう
//! 状態を検知できる。
//!
//! stale state（サーバ死）は保存済みコメントで自己修復する（`--dry-run` を除く）。

use serde::Serialize;

use super::client::{self, CommentGetResponse, CommentSelection};
use super::gate::{self, Taxonomy, Thread};
use super::shared;

/// `mt difit check` のエントリポイント。
///
/// ゲート通過 → `Ok(())`（exit 0）、ブロック → `std::process::exit(1)`。
pub fn check(dry_run: bool) -> anyhow::Result<()> {
    let repo_root = shared::git_repo_root()?;

    let Some(state) = shared::read_review_state(&repo_root) else {
        anyhow::bail!(
            "アクティブな difit レビューセッションがありません。先に mt difit start を実行してください"
        );
    };

    // 選択キーがない state（選択固定前の旧 state）では、どのコメントセッションが
    // ゲート対象か確定できない。無音 pass を避けるため、サーバ・状態を変更せず
    // fail-closed で止める。
    let selection = shared::require_selection(&state)?;

    if dry_run {
        // 非破壊判定: stale 復旧（ensure_server_running）も後始末も状態更新も行わない。
        // ただし読み取りの前提として、記録 pid が記録 port の LISTEN であることを
        // 照合する。照合なしに state.port へ問い合わせると、記録 port で応答する
        // 別プロセス（PID 再利用・細工した state）から空セッションを読み、未 resolve
        // を残したまま passes:true を返し得る。照合不能なら非破壊のまま fail-closed。
        shared::require_server_identity(&state)?;
        // ワークフローが使う dry-run 経路でも選択ドリフトを検知して出力に含める
        // （GET /api/diff のみ・非破壊。ゲート判定は固定した選択で継続する）。
        let drift = detect_selection_drift(state.port, selection);
        warn_on_selection_drift(&drift);
        // state に記録された選択へ read-only で問い合わせ、結果だけを返す。
        let response = client::fetch_comments(state.port, Some(selection))?;
        let out = output_for_response(&response).with_selection_drift(drift);
        println!("{}", serde_json::to_string(&out)?);
        if !out.passes {
            std::process::exit(1);
        }
        return Ok(());
    }

    // --- stale 自己修復（サーバ死 → 保存済みコメントで再起動）---
    let state = shared::ensure_server_running(&repo_root, state)?;
    let selection = shared::require_selection(&state)?;

    // ブラウザの選択ドリフトを検知したら警告する（判定は固定した選択で継続）。
    let drift = detect_selection_drift(state.port, selection);
    warn_on_selection_drift(&drift);

    // --- コメント取得 & ゲート判定 ---
    let response = client::fetch_comments(state.port, Some(selection))?;
    let out = output_for_response(&response).with_selection_drift(drift);

    if out.passes {
        // 通過: サーバ・状態を片付ける。
        shared::close_session(&repo_root, Some((state.pid, state.port)));
        println!("{}", serde_json::to_string(&out)?);
        Ok(())
    } else {
        // ブロック: サーバ・状態を残して次ラウンドで再利用する。
        // 状態のコメントを未 resolve のみに更新し、resolve 済みの復活を防ぐ。
        let mut kept = state;
        kept.comments = shared::threads_to_import_comments(&response.threads);
        shared::write_review_state(&repo_root, &kept)?;
        println!("{}", serde_json::to_string(&out)?);
        std::process::exit(1);
    }
}

/// サーバの現在の選択を state の選択（ゲート固定）と比較する（GET のみ・非破壊）。
///
/// ゲート判定は選択固定済みなので結果は変わらないが、difit UI の reply / resolve は
/// サーバの現在選択へ向かうため、起動時の選択と異なる状態を可視化する。
/// probe に失敗した場合は「検知不能」（`DriftDetection::Unavailable`）として返し、
/// 「ドリフトなし」と混同しない。ワークフローはこの値を見て fail-closed に
/// 扱える（セッション同一性を確認できないまま通過させない）。
pub(crate) fn detect_selection_drift(port: u16, expected: &CommentSelection) -> SelectionDrift {
    let current = client::probe_selection(port).ok();
    let detection = match &current {
        Some(value) if value != expected => DriftDetection::Detected,
        Some(_) => DriftDetection::None,
        None => DriftDetection::Unavailable,
    };
    SelectionDrift {
        detection,
        expected: expected.clone(),
        current,
    }
}

/// 選択ドリフトを検知した場合に警告する。
///
/// 検知不能（probe 失敗）も警告する。「ドリフトなし」と区別できないまま
/// ゲートを通過すると、difit UI の resolve / reply がゲートと別セッションへ
/// 向かう状態を見逃すため、人間と executor に可視化する。
pub(crate) fn warn_on_selection_drift(drift: &SelectionDrift) {
    match drift.detection {
        DriftDetection::Detected => {
            let Some(current) = &drift.current else {
                return;
            };
            eprintln!(
                "mt difit: 警告: ブラウザの diff 選択が起動時と異なります \
                 （起動時: base={}, target={}, baseMode={} / 現在: base={}, target={}, baseMode={}）。\
                 ゲート判定とコメント追加は起動時のセッションに固定されます。difit UI での \
                 resolve / reply は起動時のリビジョン選択に戻してから行ってください",
                drift.expected.base,
                drift.expected.target,
                drift.expected.base_mode.as_deref().unwrap_or("direct"),
                current.base,
                current.target,
                current.base_mode.as_deref().unwrap_or("direct"),
            );
        }
        DriftDetection::Unavailable => {
            eprintln!(
                "mt difit: 警告: ブラウザの diff 選択を確認できませんでした（GET /api/diff 失敗）。\
                 ゲート判定とコメント追加は起動時のセッション（base={}, target={}, baseMode={}）に\
                 固定されますが、difit UI の resolve / reply が同じセッションへ向かうことは\
                 確認できていません",
                drift.expected.base,
                drift.expected.target,
                drift.expected.base_mode.as_deref().unwrap_or("direct"),
            );
        }
        DriftDetection::None => {}
    }
}

/// 選択ドリフトの検知結果（三値）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DriftDetection {
    /// サーバが現在返す選択が state の選択（ゲート固定）と異なる。
    Detected,
    /// probe に成功し、サーバの現在の選択が state の選択と一致した。
    None,
    /// probe に失敗し、ドリフトの有無を判定できなかった（検知不能）。
    ///
    /// 「ドリフトなし」と区別できる形で出力し、ワークフローが fail-closed に
    /// 扱えるようにする（probe 失敗時に `detected: false` へ倒さない）。
    Unavailable,
}

/// ブラウザ UI のリビジョン切替（選択ドリフト）の検知結果。
///
/// `mt difit check`（通常 / `--dry-run`）と `mt difit threads --json` の出力に
/// 含まれ、ワークフローが `detection` を見て「difit UI での reply / resolve が
/// ゲートと別のセッションへ向かう」状態を人間と executor へ伝える。
#[derive(Debug, Serialize)]
pub(crate) struct SelectionDrift {
    /// 三値の検知結果（`detected` / `none` / `unavailable`）。
    detection: DriftDetection,
    /// state に記録された起動時の選択（ゲートが読み書きするセッション）。
    expected: CommentSelection,
    /// サーバが現在返す選択。probe 失敗時（`unavailable`）は null。
    current: Option<CommentSelection>,
}

#[derive(Serialize)]
pub(crate) struct CheckOutput {
    passes: bool,
    /// ブラウザ選択ドリフトの検知結果。probe しない経路（done 等）では省略する。
    #[serde(skip_serializing_if = "Option::is_none")]
    selection_drift: Option<SelectionDrift>,
    blocking_threads: Vec<BlockingThread>,
}

impl CheckOutput {
    /// 選択ドリフトの検知結果を添えて返す（check の通常 / `--dry-run` 経路）。
    pub(crate) fn with_selection_drift(mut self, drift: SelectionDrift) -> Self {
        self.selection_drift = Some(drift);
        self
    }
}

/// コメント取得結果から、`check` / `done` / `threads` 共通のゲート出力を作る。
pub(crate) fn output_for_response(response: &CommentGetResponse) -> CheckOutput {
    let passes = gate::gate_passes(&response.threads);
    let blocking_threads = if passes {
        Vec::new()
    } else {
        BlockingThread::blocking_from_threads(&response.threads)
    };

    CheckOutput {
        passes,
        selection_drift: None,
        blocking_threads,
    }
}

/// レビュー状態がない場合の冪等な終了結果。
pub(crate) fn empty_output() -> CheckOutput {
    CheckOutput {
        passes: true,
        selection_drift: None,
        blocking_threads: Vec::new(),
    }
}

/// コメントを取得できず、ゲート結果を判定できない場合の終了結果。
///
/// `done` は終了処理そのものを失敗させないため、エラーを JSON の
/// スキーマ外へ持ち出さず、通過とは判定しない結果を返す。
pub(crate) fn error_output() -> CheckOutput {
    CheckOutput {
        passes: false,
        selection_drift: None,
        blocking_threads: Vec::new(),
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct BlockingThread {
    pub(crate) id: String,
    pub(crate) file: String,
    pub(crate) line: Option<serde_json::Value>,
    pub(crate) taxonomy: String,
    pub(crate) body: String,
    pub(crate) replies: Vec<String>,
}

impl BlockingThread {
    pub(crate) fn from_thread(thread: &Thread) -> Option<Self> {
        if !gate::thread_blocks(thread) {
            return None;
        }
        let parent = thread.messages.first()?;
        let taxonomy = gate::classify_message(parent);
        Some(Self {
            id: thread.id.clone(),
            file: thread.file_path.clone(),
            line: thread.position.get("line").cloned(),
            taxonomy: taxonomy_label(taxonomy),
            body: parent.body.clone(),
            replies: thread.messages[1..]
                .iter()
                .map(|m| m.body.clone())
                .collect(),
        })
    }

    /// 未 resolve スレッド群からブロッキング分だけを `check` と同一の形状で抽出する。
    pub(crate) fn blocking_from_threads(threads: &[Thread]) -> Vec<Self> {
        threads.iter().filter_map(Self::from_thread).collect()
    }
}

pub(crate) fn taxonomy_label(t: Taxonomy) -> String {
    match t {
        Taxonomy::Issue => "issue",
        Taxonomy::Question => "question",
        Taxonomy::Context => "context",
        Taxonomy::Human => "human",
    }
    .to_string()
}

#[cfg(test)]
#[path = "check.test.rs"]
mod tests;
