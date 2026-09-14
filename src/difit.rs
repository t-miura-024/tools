//! difit レビューセッション管理（`mt difit`）。
//!
//! `start` で difit サーバを起動しコメントを注入して URL を提示、`check` / `done` で
//! ゲート判定を行う。`status` でセッション状態を診断表示し、`threads --json` で
//! 選択固定の未 resolve スレッドを読み取り、`resolve` で同一性検証つきの
//! 選択固定 resolve を行う。
//! 実装本体は `src/difit/` 配下（src/README.md ルール A / B 準拠）。

use clap::Subcommand;

pub mod check;
pub mod client;
pub mod done;
pub mod gate;
pub mod resolve;
pub mod shared;
pub mod start;
pub mod status;
pub mod threads;

#[derive(Subcommand)]
pub enum DifitCommands {
    /// difit サーバを起動し、コメントを注入して URL を提示する
    Start {
        /// difit に透過する引数（working, HEAD~3, main 等）
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// ゲート判定: 未 resolve スレッドがあれば exit 1、なければサーバを停止して exit 0
    Check {
        /// ゲート判定のみ行い、サーバ停止・状態削除・状態書き換えをしない
        #[arg(long)]
        dry_run: bool,
    },
    /// レビューを終了し、ゲート結果にかかわらずサーバと状態を片付ける
    Done,
    /// セッション状態を表示する（読み取り専用。stale state は警告のみ）
    Status,
    /// 未 resolve スレッドを選択固定で読み取り、JSON で出力する（読み取り専用）
    Threads {
        /// JSON で出力する（機械可読契約。mt-review-diff ワークフローが使用する）
        #[arg(long)]
        json: bool,
    },
    /// 修正済み AI スレッドを選択固定で resolve する（同一性検証つき。人間コメントは拒否）
    #[command(long_about = "修正済み AI スレッドを選択固定で resolve する。\n\
        state（.difit/difit-review.json）を fail-closed で読み、選択キーと、記録 pid が記録 port の \
        LISTEN であることを確認してから、選択固定の DELETE /api/comments/<threadId> を送る。\
        対象が未 resolve スレッドにない場合と、親メッセージが人間（author: User）の場合は拒否する。\n\n\
        成功: {\"resolved\":true,\"threadId\":\"<id>\"} を stdout へ出して exit 0。\n\
        失敗（state 不在 / 選択未記録 / 同一性未確認 / 未 resolve に不在 / 人間コメント / HTTP 失敗）: \
        stderr に理由を出して非 0 exit（stdout に JSON を出さない）")]
    Resolve {
        /// resolve するスレッド ID（mt difit threads --json の threads[].id）
        thread_id: String,
    },
}

pub fn run(cmd: DifitCommands) -> anyhow::Result<()> {
    match cmd {
        DifitCommands::Start { args } => start::start(args),
        DifitCommands::Check { dry_run } => check::check(dry_run),
        DifitCommands::Done => done::done(),
        DifitCommands::Status => status::status(),
        DifitCommands::Threads { json } => {
            if !json {
                anyhow::bail!(
                    "mt difit threads は機械可読出力のみを提供します。--json を指定してください"
                );
            }
            threads::threads()
        }
        DifitCommands::Resolve { thread_id } => resolve::resolve(thread_id),
    }
}
