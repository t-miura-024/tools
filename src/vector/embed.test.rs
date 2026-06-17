use super::*;

fn l2_norm(vector: &[f32]) -> f32 {
    vector.iter().map(|x| x * x).sum::<f32>().sqrt()
}

#[test]
fn test_dummy_vector_dim() {
    let v = dummy_vector("hello", 384);
    assert_eq!(v.len(), 384);
}

#[test]
fn test_dummy_vector_deterministic() {
    let v1 = dummy_vector("hello", 384);
    let v2 = dummy_vector("hello", 384);
    assert_eq!(v1, v2);
}

#[test]
fn test_dummy_vector_different_inputs() {
    let v1 = dummy_vector("hello", 384);
    let v2 = dummy_vector("world", 384);
    assert_ne!(v1, v2);
}

#[test]
fn test_dummy_vector_values_in_range() {
    let v = dummy_vector("test", 384);
    for value in &v {
        assert!(*value >= -1.0 && *value <= 1.0);
    }
}

#[test]
fn test_dummy_vector_short_dim() {
    let v = dummy_vector("test", 16);
    assert_eq!(v.len(), 16);
}

#[test]
fn test_dummy_vector_dim_one() {
    let v = dummy_vector("test", 1);
    assert_eq!(v.len(), 1);
}

#[test]
fn test_embedder_dim_returns_configured_dim() {
    let embedder = DummyEmbedder::new(128);
    assert_eq!(embedder.dim(), 128);
}

#[test]
fn test_embedder_returns_one_vector_per_text() {
    let embedder = DummyEmbedder::new(384);
    let texts = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    let vectors = embedder.embed(&texts).unwrap();
    assert_eq!(vectors.len(), 3);
    for v in &vectors {
        assert_eq!(v.len(), 384);
    }
}

#[test]
fn test_normalize_produces_unit_vector() {
    let v = dummy_vector("hello", 384);
    let norm = l2_norm(&v);
    assert!(norm > 0.0, "non-zero vector expected");
    let n = normalize(v.clone());
    let unit_norm = l2_norm(&n);
    assert!(
        (unit_norm - 1.0).abs() < 1e-5,
        "L2 norm of normalized vector should be ~1.0, got {unit_norm}"
    );
    let scale = 1.0 / norm;
    for (orig, scaled) in v.iter().zip(n.iter()) {
        assert!((orig * scale - scaled).abs() < 1e-5);
    }
}

#[test]
fn test_normalize_zero_vector_stays_zero() {
    let zero = vec![0.0f32; 16];
    let result = normalize(zero.clone());
    assert_eq!(
        result, zero,
        "zero vector should remain zero (no division by zero)"
    );
}

#[test]
fn test_embedder_returns_unit_vectors() {
    let embedder = DummyEmbedder::new(384);
    let texts = vec!["a".to_string(), "b".to_string()];
    let vectors = embedder.embed(&texts).unwrap();
    for v in &vectors {
        let norm = l2_norm(v);
        assert!(
            (norm - 1.0).abs() < 1e-5,
            "embed() should return unit-normalized vectors, got norm {norm}"
        );
    }
}
