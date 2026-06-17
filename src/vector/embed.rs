use anyhow::Result;
use sha2::{Digest, Sha256};

pub trait Embedder {
    #[allow(dead_code)]
    fn dim(&self) -> usize;
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

pub struct DummyEmbedder {
    dim: usize,
}

impl DummyEmbedder {
    pub fn new(dim: usize) -> Self {
        Self { dim }
    }
}

impl Embedder for DummyEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts
            .iter()
            .map(|t| normalize(dummy_vector(t, self.dim)))
            .collect())
    }
}

fn dummy_vector(text: &str, dim: usize) -> Vec<f32> {
    let mut vector = vec![0.0f32; dim];
    let mut counter: u64 = 0;

    while (counter as usize) * 8 < dim {
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        hasher.update(counter.to_le_bytes());
        let digest = hasher.finalize();

        for (i, chunk) in digest.chunks_exact(4).enumerate() {
            let idx = (counter as usize) * 8 + i;
            if idx >= dim {
                break;
            }
            let bytes: [u8; 4] = chunk.try_into().unwrap();
            let raw = i32::from_le_bytes(bytes);
            vector[idx] = (raw as f32) / (i32::MAX as f32);
        }

        counter += 1;
    }

    vector
}

pub fn normalize(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm == 0.0 {
        return vector;
    }
    for value in vector.iter_mut() {
        *value /= norm;
    }
    vector
}

#[cfg(test)]
#[path = "embed.test.rs"]
mod tests;
