use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use walkdir::WalkDir;

use super::chunk::{self, Chunk};
use super::config::VectorConfig;
use super::embed::{DummyEmbedder, Embedder};
use super::frontmatter;
use super::qdrant::{Point, QdrantClient};

pub struct IngestSummary {
    pub files: usize,
    pub chunks: usize,
    pub upserted: usize,
}

pub fn run(config: &VectorConfig) -> Result<IngestSummary> {
    let client = QdrantClient::new(&config.qdrant_url);
    client.ping().with_context(|| {
        format!(
            "Qdrant ({}) に接続できません。`mise run docker-up` などで起動してください",
            config.qdrant_url
        )
    })?;

    println!(
        "コレクション '{}' を作成中... (既存の場合は削除・再作成されます)",
        config.collection_name
    );
    client.delete_collection(&config.collection_name).ok();
    client.recreate_collection(&config.collection_name, config.vector_dim)?;

    let doc_dir = resolve_doc_dir(&config.doc_dir)?;
    let files = collect_markdown_files(&doc_dir);
    println!("Markdown ファイルを収集中...");
    println!("  → {} 件の .md ファイルを発見", files.len());

    let mut all_chunks: Vec<IndexedChunk> = Vec::new();
    for path in &files {
        let raw = match fs::read_to_string(path) {
            Ok(content) => content,
            Err(err) => {
                eprintln!("スキップ: {} ({})", path.display(), err);
                continue;
            }
        };
        let (frontmatter, body) =
            match frontmatter::parse(&raw, &config.title_key, &config.source_key) {
                Ok(parsed) => parsed,
                Err(err) => {
                    eprintln!("スキップ: {} (frontmatter: {})", path.display(), err);
                    continue;
                }
            };
        let sections = match chunk::split_by_headings(&body, &config.chunk_pattern) {
            Ok(sections) => sections,
            Err(err) => {
                eprintln!("スキップ: {} (chunk: {})", path.display(), err);
                continue;
            }
        };
        let relative = path
            .strip_prefix(&doc_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        for section in sections {
            all_chunks.push(IndexedChunk {
                chunk: section,
                file_path: relative.clone(),
                title: frontmatter.title.clone(),
                source: frontmatter.source.clone(),
            });
        }
    }

    println!("  → 総チャンク数: {}", all_chunks.len());

    let embedder = DummyEmbedder::new(config.vector_dim);
    let texts: Vec<String> = all_chunks.iter().map(|c| c.chunk.text.clone()).collect();
    println!("Embedding 中... (model: {})", config.embed_model);
    let vectors = embedder.embed(&texts)?;

    let mut total_upserted = 0usize;
    let mut i = 0usize;
    while i < all_chunks.len() {
        let end = (i + config.batch_size).min(all_chunks.len());
        let batch: Vec<Point> = (i..end)
            .map(|j| {
                let chunk = &all_chunks[j];
                Point {
                    id: uuid::Uuid::new_v4().to_string(),
                    vector: vectors[j].clone(),
                    payload: serde_json::json!({
                        "text": chunk.chunk.text,
                        "filePath": chunk.file_path,
                        "title": chunk.title,
                        "url": chunk.source,
                        "heading": chunk.chunk.heading,
                        "chunkIndex": chunk.chunk.chunk_index,
                    }),
                }
            })
            .collect();
        client.upsert(&config.collection_name, batch)?;
        total_upserted = end;
        let pct = (end as f64 / all_chunks.len() as f64) * 100.0;
        println!("  → {}/{} 件完了 ({:.1}%)", end, all_chunks.len(), pct);
        i = end;
    }

    Ok(IngestSummary {
        files: files.len(),
        chunks: all_chunks.len(),
        upserted: total_upserted,
    })
}

struct IndexedChunk {
    chunk: Chunk,
    file_path: String,
    title: String,
    source: String,
}

fn resolve_doc_dir(raw: &Path) -> Result<PathBuf> {
    if raw.is_absolute() {
        Ok(raw.to_path_buf())
    } else {
        let cwd = std::env::current_dir().context("カレントディレクトリの取得に失敗しました")?;
        Ok(cwd.join(raw))
    }
}

fn collect_markdown_files(dir: &Path) -> Vec<PathBuf> {
    if !dir.is_dir() {
        return Vec::new();
    }
    WalkDir::new(dir)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().is_dir() {
                let name = entry.file_name().to_string_lossy();
                !(name.starts_with('.') || name == "node_modules")
            } else {
                true
            }
        })
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
        })
        .map(|entry| entry.into_path())
        .collect()
}

#[cfg(test)]
#[path = "ingest.test.rs"]
mod tests;
