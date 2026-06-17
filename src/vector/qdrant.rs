use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct QdrantClient {
    base_url: String,
    agent: ureq::Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub id: String,
    pub vector: Vec<f32>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoredPoint {
    pub id: Value,
    pub score: f32,
    pub payload: Value,
}

impl QdrantClient {
    pub fn new(base_url: &str) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(30))
            .build();
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            agent,
        }
    }

    pub fn ping(&self) -> Result<()> {
        let url = format!("{}/healthz", self.base_url);
        let response = self
            .agent
            .get(&url)
            .call()
            .map_err(|e| anyhow!("Qdrant への接続に失敗しました: {e}"))?;
        if response.status() != 200 {
            return Err(anyhow!(
                "Qdrant ヘルスチェックが失敗しました: HTTP {}",
                response.status()
            ));
        }
        Ok(())
    }

    pub fn collection_exists(&self, name: &str) -> Result<bool> {
        let url = format!("{}/collections/{}", self.base_url, name);
        match self.agent.get(&url).call() {
            Ok(response) => match response.status() {
                200 => Ok(true),
                status => Err(anyhow!("コレクション存在確認が失敗しました: HTTP {status}")),
            },
            Err(ureq::Error::Status(404, _)) => Ok(false),
            Err(e) => Err(anyhow!("コレクション存在確認に失敗しました: {e}")),
        }
    }

    pub fn recreate_collection(&self, name: &str, dim: usize) -> Result<()> {
        let url = format!("{}/collections/{}", self.base_url, name);
        let body = json!({
            "vectors": {
                "size": dim,
                "distance": "Cosine"
            }
        });
        self.agent
            .put(&url)
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| anyhow!("コレクション再作成に失敗しました: {e}"))?;
        Ok(())
    }

    pub fn delete_collection(&self, name: &str) -> Result<()> {
        let url = format!("{}/collections/{}", self.base_url, name);
        match self.agent.delete(&url).call() {
            Ok(response) => {
                if response.status() != 200 {
                    return Err(anyhow!(
                        "コレクション削除が失敗しました: HTTP {}",
                        response.status()
                    ));
                }
                Ok(())
            }
            Err(ureq::Error::Status(404, _)) => {
                // 既に存在しない場合は冪等性のため成功扱い（collection_exists と整合）。
                Ok(())
            }
            Err(e) => Err(anyhow!("コレクション削除に失敗しました: {e}")),
        }
    }

    pub fn upsert(&self, name: &str, points: Vec<Point>) -> Result<()> {
        if points.is_empty() {
            return Ok(());
        }
        let url = format!("{}/collections/{}/points", self.base_url, name);
        let body = json!({
            "wait": true,
            "points": points,
        });
        self.agent
            .put(&url)
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| anyhow!("ポイント upsert に失敗しました: {e}"))?;
        Ok(())
    }

    pub fn search(&self, name: &str, vector: &[f32], limit: usize) -> Result<Vec<ScoredPoint>> {
        let url = format!("{}/collections/{}/points/search", self.base_url, name);
        let body = json!({
            "vector": vector,
            "limit": limit,
            "with_payload": true,
        });
        let response = self
            .agent
            .post(&url)
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| anyhow!("ベクトル検索に失敗しました: {e}"))
            .context("Qdrant へのリクエスト送信に失敗しました")?;
        let value: Value = response
            .into_json()
            .map_err(|e| anyhow!("Qdrant レスポンスの JSON 解析に失敗しました: {e}"))?;
        let result = value
            .get("result")
            .ok_or_else(|| anyhow!("Qdrant レスポンスに 'result' フィールドがありません"))?;
        let points: Vec<ScoredPoint> = serde_json::from_value(result.clone())
            .map_err(|e| anyhow!("Qdrant レスポンスの points 解析に失敗しました: {e}"))?;
        Ok(points)
    }
}

#[cfg(test)]
#[path = "qdrant.test.rs"]
mod tests;

#[cfg(test)]
#[path = "qdrant_integration.test.rs"]
mod integration_tests;
