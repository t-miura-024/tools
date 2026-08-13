//! hunk レビューセッション管理（`mt hunk`）。
//!
//! `start` でアクティブな hunk セッションにコメントを適用し、
//! `check` / `done` でゲート判定を行う。`status` でセッション状態を診断表示する。
//! 実装本体は `src/hunk/` 配下（src/README.md ルール A / B 準拠）。

use clap::Subcommand;

pub mod check;
pub mod done;
pub mod shared;
pub mod start;
pub mod status;

#[derive(Subcommand)]
pub enum HunkCommands {
    /// アクティブな hunk セッションにコメントを適用する
    Start,
    /// ゲート判定: 未解決 AI コメントまたは人間コメントがあれば exit 1、なければ exit 0
    Check,
    /// レビューを終了し、ゲート結果にかかわらず状態を片付ける
    Done,
    /// セッション状態を表示する（読み取り専用。stale state は警告のみ）
    Status,
}

pub fn run(cmd: HunkCommands) -> anyhow::Result<()> {
    match cmd {
        HunkCommands::Start => start::start(),
        HunkCommands::Check => check::check(),
        HunkCommands::Done => done::done(),
        HunkCommands::Status => status::status(),
    }
}
