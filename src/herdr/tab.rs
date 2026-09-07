use clap::Subcommand;

pub mod duplicate;
pub mod template;

#[derive(Subcommand)]
pub enum HerdrTabCommands {
    /// 実行中タブのペーン構成を同一ワークスペース内に複製して新しいタブを作成
    Duplicate,
    /// タブテンプレートの作成・反映・削除
    #[command(subcommand)]
    Template(template::HerdrTabTemplateCommands),
}

pub fn run(cmd: HerdrTabCommands) -> anyhow::Result<()> {
    match cmd {
        HerdrTabCommands::Duplicate => duplicate::duplicate(),
        HerdrTabCommands::Template(sub) => template::run(sub),
    }
}
