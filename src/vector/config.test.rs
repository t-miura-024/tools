use super::*;
use std::path::PathBuf;

#[test]
fn test_validate_minimal_config() {
    let config = VectorConfig {
        collection_name: "paleo_docs".to_string(),
        doc_dir: PathBuf::from("doc"),
        qdrant_url: default_qdrant_url(),
        vector_dim: default_vector_dim(),
        chunk_pattern: default_chunk_pattern(),
        batch_size: default_batch_size(),
        top_k: default_top_k(),
        embed_model: default_embed_model(),
        title_key: default_title_key(),
        source_key: default_source_key(),
    };
    assert!(config.validate().is_ok());
}

#[test]
fn test_validate_rejects_empty_collection_name() {
    let config = VectorConfig {
        collection_name: "  ".to_string(),
        doc_dir: PathBuf::from("doc"),
        qdrant_url: default_qdrant_url(),
        vector_dim: default_vector_dim(),
        chunk_pattern: default_chunk_pattern(),
        batch_size: default_batch_size(),
        top_k: default_top_k(),
        embed_model: default_embed_model(),
        title_key: default_title_key(),
        source_key: default_source_key(),
    };
    assert!(config.validate().is_err());
}

#[test]
fn test_validate_rejects_empty_doc_dir() {
    let config = VectorConfig {
        collection_name: "docs".to_string(),
        doc_dir: PathBuf::new(),
        qdrant_url: default_qdrant_url(),
        vector_dim: default_vector_dim(),
        chunk_pattern: default_chunk_pattern(),
        batch_size: default_batch_size(),
        top_k: default_top_k(),
        embed_model: default_embed_model(),
        title_key: default_title_key(),
        source_key: default_source_key(),
    };
    assert!(config.validate().is_err());
}

#[test]
fn test_validate_rejects_zero_dim() {
    let config = VectorConfig {
        collection_name: "docs".to_string(),
        doc_dir: PathBuf::from("doc"),
        qdrant_url: default_qdrant_url(),
        vector_dim: 0,
        chunk_pattern: default_chunk_pattern(),
        batch_size: default_batch_size(),
        top_k: default_top_k(),
        embed_model: default_embed_model(),
        title_key: default_title_key(),
        source_key: default_source_key(),
    };
    assert!(config.validate().is_err());
}

#[test]
fn test_validate_rejects_zero_batch() {
    let config = VectorConfig {
        collection_name: "docs".to_string(),
        doc_dir: PathBuf::from("doc"),
        qdrant_url: default_qdrant_url(),
        vector_dim: default_vector_dim(),
        chunk_pattern: default_chunk_pattern(),
        batch_size: 0,
        top_k: default_top_k(),
        embed_model: default_embed_model(),
        title_key: default_title_key(),
        source_key: default_source_key(),
    };
    assert!(config.validate().is_err());
}

#[test]
fn test_load_minimal_toml() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vector.config.toml");
    std::fs::write(
        &path,
        r#"
collection_name = "paleo_docs"
doc_dir = "doc"
"#,
    )
    .unwrap();

    let config = VectorConfig::load(&path).unwrap();
    assert_eq!(config.collection_name, "paleo_docs");
    assert_eq!(config.doc_dir, PathBuf::from("doc"));
    assert_eq!(config.qdrant_url, "http://localhost:6333");
    assert_eq!(config.vector_dim, 384);
    assert_eq!(config.batch_size, 32);
    assert_eq!(config.top_k, 20);
    assert_eq!(config.title_key, "title");
    assert_eq!(config.source_key, "source");
}

#[test]
fn test_load_full_toml_overrides() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vector.config.toml");
    std::fs::write(
        &path,
        r#"
collection_name = "wiki"
doc_dir = "content"
qdrant_url = "http://qdrant.internal:6333"
vector_dim = 768
chunk_pattern = "^##\\s+"
batch_size = 16
top_k = 5
embed_model = "dummy-sha256"
title_key = "name"
source_key = "url"
"#,
    )
    .unwrap();

    let config = VectorConfig::load(&path).unwrap();
    assert_eq!(config.collection_name, "wiki");
    assert_eq!(config.qdrant_url, "http://qdrant.internal:6333");
    assert_eq!(config.vector_dim, 768);
    assert_eq!(config.chunk_pattern, "^##\\s+");
    assert_eq!(config.batch_size, 16);
    assert_eq!(config.top_k, 5);
    assert_eq!(config.title_key, "name");
    assert_eq!(config.source_key, "url");
}

#[test]
fn test_load_invalid_toml_returns_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vector.config.toml");
    std::fs::write(&path, "this is :: not valid toml [[[").unwrap();
    assert!(VectorConfig::load(&path).is_err());
}

#[test]
fn test_load_missing_required_field() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vector.config.toml");
    std::fs::write(&path, r#"collection_name = "docs""#).unwrap();
    let result = VectorConfig::load(&path);
    assert!(result.is_err());
}
