use clap::Subcommand;

pub mod add;
pub mod apply;
pub mod diff;
pub mod doctor;
pub mod edit;
pub mod init;
pub mod install_hook;
pub mod secret;
pub mod shared;
pub mod status;
pub mod uninstall_hook;

#[derive(Subcommand)]
pub enum ChezmoiCommands {
    /// chezmoi ソースを home ディレクトリに展開
    Apply,
    /// chezmoi ソースを初期化（clone, pull 等）
    Init,
    /// ターゲット状態とデスティネーション状態の差分を表示
    Diff,
    /// chezmoi 管理対象の状態を表示
    Status,
    /// chezmoi doctor + mt 固有チェック（環境変数・ソースディレクトリ・age鍵・post-commitフック）
    Doctor,
    /// 既存のファイルやディレクトリを chezmoi ソースに追加
    Add,
    /// ターゲットの chezmoi ソースを編集
    Edit,
    /// mt post-commit フックをインストール
    InstallHook,
    /// dot_zsh_secrets.age のシークレット管理
    #[command(subcommand)]
    Secret(SecretCommands),
    /// mt post-commit フックを削除
    UninstallHook,
}

#[derive(Subcommand)]
pub enum SecretCommands {
    /// シークレット値を設定・更新（dot_zsh_secrets.age に暗号化保存）
    #[command(name = "set")]
    Set {
        /// 設定する環境変数名（例: TAVILY_API_KEY）
        key: String,
        /// 書き込まずに暗号化内容をプレビュー
        #[arg(long)]
        dry_run: bool,
        /// 設定後の apply 確認をスキップ
        #[arg(long)]
        no_apply: bool,
    },
    /// dot_zsh_secrets.age からシークレット値を削除
    #[command(name = "delete")]
    Delete {
        /// 削除する環境変数名（省略時は対話的に選択）
        key: Option<String>,
        /// 書き込まずに暗号化内容をプレビュー
        #[arg(long)]
        dry_run: bool,
        /// 削除後の apply 確認をスキップ
        #[arg(long)]
        no_apply: bool,
    },
}

pub fn run(cmd: ChezmoiCommands) -> anyhow::Result<()> {
    match cmd {
        ChezmoiCommands::Apply => apply::run(&[]),
        ChezmoiCommands::Init => init::run(&[]),
        ChezmoiCommands::Diff => diff::run(&[]),
        ChezmoiCommands::Status => status::run(&[]),
        ChezmoiCommands::Doctor => doctor::run(),
        ChezmoiCommands::Add => add::run(&[]),
        ChezmoiCommands::Edit => edit::run(&[]),
        ChezmoiCommands::InstallHook => install_hook::run(),
        ChezmoiCommands::UninstallHook => uninstall_hook::run(),
        ChezmoiCommands::Secret(SecretCommands::Set {
            key,
            dry_run,
            no_apply,
        }) => secret::run_set(secret::SecretSetArgs {
            key: &key,
            dry_run,
            skip_apply: no_apply,
        }),
        ChezmoiCommands::Secret(SecretCommands::Delete {
            key,
            dry_run,
            no_apply,
        }) => secret::run_delete(secret::SecretDeleteArgs {
            key,
            dry_run,
            skip_apply: no_apply,
        }),
    }
}
