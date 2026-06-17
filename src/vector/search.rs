use anyhow::{Context, Result};
use serde::Serialize;

use super::config::VectorConfig;
use super::embed::{DummyEmbedder, Embedder};
use super::qdrant::{QdrantClient, ScoredPoint};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub score: f32,
    pub file_path: String,
    pub title: String,
    pub url: String,
    pub heading: String,
    pub text: String,
    pub chunk_index: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutput {
    pub query: String,
    pub count: usize,
    pub top10_avg_score: f64,
    pub avg_score_sample_size: usize,
    pub results: Vec<SearchHit>,
}

pub fn run(config: &VectorConfig, query: &str) -> Result<SearchOutput> {
    let client = QdrantClient::new(&config.qdrant_url);
    client.ping().with_context(|| {
        format!(
            "Qdrant ({}) に接続できません。`mise run docker-up` などで起動してください",
            config.qdrant_url
        )
    })?;

    if !client.collection_exists(&config.collection_name)? {
        anyhow::bail!(
            "コレクション '{}' が見つかりません。先に `mt vector ingest` を実行してください",
            config.collection_name
        );
    }

    let embedder = DummyEmbedder::new(config.vector_dim);
    let vectors = embedder.embed(&[query.to_string()])?;
    let query_vector = vectors.into_iter().next().unwrap();

    let raw = client.search(&config.collection_name, &query_vector, config.top_k)?;

    let mut results: Vec<SearchHit> = raw.into_iter().map(point_to_hit).collect();
    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let top10: Vec<&SearchHit> = results.iter().take(10).collect();
    let avg_score_sample_size = top10.len();
    let top10_avg_score = if avg_score_sample_size > 0 {
        top10.iter().map(|h| h.score as f64).sum::<f64>() / avg_score_sample_size as f64
    } else {
        0.0
    };

    Ok(SearchOutput {
        query: query.to_string(),
        count: results.len(),
        top10_avg_score,
        avg_score_sample_size,
        results,
    })
}

fn point_to_hit(point: ScoredPoint) -> SearchHit {
    let payload = point.payload;
    let get_string = |key: &str| -> String {
        payload
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let chunk_index = payload
        .get("chunkIndex")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    SearchHit {
        score: point.score,
        file_path: get_string("filePath"),
        title: get_string("title"),
        url: get_string("url"),
        heading: get_string("heading"),
        text: get_string("text"),
        chunk_index,
    }
}

#[cfg(test)]
#[path = "search.test.rs"]
mod tests;
