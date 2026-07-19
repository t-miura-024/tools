use std::path::PathBuf;

use anyhow::Result;
use clap::Subcommand;

pub mod chunk;
pub mod config;
pub mod embed;
pub mod frontmatter;
pub mod ingest;
pub mod qdrant;
pub mod search;

#[derive(Subcommand)]
pub enum VectorCommands {
    /// Markdown ファイルを Qdrant コレクションに投入
    Ingest {
        /// vector.config.toml のパス
        #[arg(long)]
        config: PathBuf,
    },
    /// Qdrant コレクションを検索
    Search {
        /// vector.config.toml のパス
        #[arg(long)]
        config: PathBuf,
        /// 検索クエリ
        #[arg(long)]
        query: String,
    },
}

pub fn run(cmd: VectorCommands) -> Result<()> {
    match cmd {
        VectorCommands::Ingest { config } => {
            let cfg = config::VectorConfig::load(&config)?;
            let summary = ingest::run(&cfg)?;
            println!(
                "✅ 完了: {} ファイル / {} チャンク / {} ポイント投入",
                summary.files, summary.chunks, summary.upserted
            );
            Ok(())
        }
        VectorCommands::Search { config, query } => {
            let cfg = config::VectorConfig::load(&config)?;
            let output = search::run(&cfg, &query)?;
            let json = serde_json::to_string_pretty(&output)?;
            println!("{json}");
            Ok(())
        }
    }
}
