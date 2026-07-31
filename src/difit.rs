//! difit レビューセッション管理（`mt difit`）。
//!
//! `start` で difit サーバを起動し、`check` / `done` でゲート判定を行う。
//! 実装本体は `src/difit/` 配下（src/README.md ルール A / B 準拠）。

use clap::Subcommand;

pub mod check;
pub mod done;
pub mod shared;
pub mod start;

#[derive(Subcommand)]
pub enum DifitCommands {
    /// difit サーバを起動し、コメントを注入する
    Start {
        /// difit に透過する引数（working, HEAD~3, main 等）
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// ゲート判定: 未解決スレッドがあれば exit 1、なければ exit 0
    Check,
    /// レビューを終了し、ゲート結果にかかわらずサーバを停止する
    Done,
}

pub fn run(cmd: DifitCommands) -> anyhow::Result<()> {
    match cmd {
        DifitCommands::Start { args } => start::start(args),
        DifitCommands::Check => check::check(),
        DifitCommands::Done => done::done(),
    }
}
