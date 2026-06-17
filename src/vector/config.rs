use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const DEFAULT_QDRANT_URL: &str = "http://localhost:6333";
const DEFAULT_VECTOR_DIM: usize = 384;
const DEFAULT_CHUNK_PATTERN: &str = "^#{1,3}\\s+";
const DEFAULT_BATCH_SIZE: usize = 32;
const DEFAULT_TOP_K: usize = 20;
const DEFAULT_EMBED_MODEL: &str = "dummy-sha256";
const DEFAULT_TITLE_KEY: &str = "title";
const DEFAULT_SOURCE_KEY: &str = "source";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorConfig {
    pub collection_name: String,
    pub doc_dir: PathBuf,
    #[serde(default = "default_qdrant_url")]
    pub qdrant_url: String,
    #[serde(default = "default_vector_dim")]
    pub vector_dim: usize,
    #[serde(default = "default_chunk_pattern")]
    pub chunk_pattern: String,
    #[serde(default = "default_batch_size")]
    pub batch_size: usize,
    #[serde(default = "default_top_k")]
    pub top_k: usize,
    #[serde(default = "default_embed_model")]
    pub embed_model: String,
    #[serde(default = "default_title_key")]
    pub title_key: String,
    #[serde(default = "default_source_key")]
    pub source_key: String,
}

fn default_qdrant_url() -> String {
    DEFAULT_QDRANT_URL.to_string()
}

fn default_vector_dim() -> usize {
    DEFAULT_VECTOR_DIM
}

fn default_chunk_pattern() -> String {
    DEFAULT_CHUNK_PATTERN.to_string()
}

fn default_batch_size() -> usize {
    DEFAULT_BATCH_SIZE
}

fn default_top_k() -> usize {
    DEFAULT_TOP_K
}

fn default_embed_model() -> String {
    DEFAULT_EMBED_MODEL.to_string()
}

fn default_title_key() -> String {
    DEFAULT_TITLE_KEY.to_string()
}

fn default_source_key() -> String {
    DEFAULT_SOURCE_KEY.to_string()
}

impl VectorConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let content = fs::read_to_string(path)
            .with_context(|| format!("設定ファイルが読み込めません: {}", path.display()))?;
        let config: VectorConfig = toml::from_str(&content)
            .with_context(|| format!("設定ファイルの解析に失敗しました: {}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.collection_name.trim().is_empty() {
            anyhow::bail!("collection_name は必須です");
        }
        if self.doc_dir.as_os_str().is_empty() {
            anyhow::bail!("doc_dir は必須です");
        }
        if self.vector_dim == 0 {
            anyhow::bail!("vector_dim は 1 以上で指定してください");
        }
        if self.batch_size == 0 {
            anyhow::bail!("batch_size は 1 以上で指定してください");
        }
        if self.top_k == 0 {
            anyhow::bail!("top_k は 1 以上で指定してください");
        }
        if self.chunk_pattern.is_empty() {
            anyhow::bail!("chunk_pattern は空にできません");
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "config.test.rs"]
mod tests;
