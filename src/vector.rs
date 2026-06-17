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
    /// Ingest markdown files into a Qdrant collection
    Ingest {
        /// Path to vector.config.toml
        #[arg(long)]
        config: PathBuf,
    },
    /// Search the Qdrant collection with a query
    Search {
        /// Path to vector.config.toml
        #[arg(long)]
        config: PathBuf,
        /// Query text
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
