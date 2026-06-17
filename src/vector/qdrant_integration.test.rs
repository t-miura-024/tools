use super::*;
use std::env;
use uuid::Uuid;

fn qdrant_url() -> String {
    env::var("MT_VECTOR_TEST_QDRANT_URL").unwrap_or_else(|_| "http://localhost:6333".to_string())
}

fn unique_collection() -> String {
    format!(
        "test_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

#[test]
#[ignore = "requires a running Qdrant instance; run with `cargo test -- --ignored`"]
fn test_qdrant_ping_succeeds_against_local_instance() {
    let client = QdrantClient::new(&qdrant_url());
    assert!(
        client.ping().is_ok(),
        "ping against {url} should succeed; ensure `mise run docker-up` has started Qdrant",
        url = qdrant_url()
    );
}

#[test]
#[ignore = "requires a running Qdrant instance; run with `cargo test -- --ignored`"]
fn test_qdrant_collection_lifecycle_round_trip() {
    let client = QdrantClient::new(&qdrant_url());
    client.ping().expect("Qdrant should be reachable");

    let name = unique_collection();

    assert!(
        !client.collection_exists(&name).expect("exists check"),
        "freshly-named collection should not exist yet"
    );

    client
        .recreate_collection(&name, 4)
        .expect("recreate_collection should succeed");
    assert!(client.collection_exists(&name).expect("exists check"));

    let point = Point {
        id: Uuid::new_v4().to_string(),
        vector: vec![1.0, 0.0, 0.0, 0.0],
        payload: serde_json::json!({"label": "alpha"}),
    };
    client
        .upsert(&name, vec![point])
        .expect("upsert should succeed");

    let results: Vec<ScoredPoint> = client
        .search(&name, &[1.0, 0.0, 0.0, 0.0], 1)
        .expect("search should succeed");
    assert_eq!(results.len(), 1, "search should return the upserted point");
    assert!(
        results[0].score > 0.99,
        "cosine similarity of identical vectors should be ~1.0, got {}",
        results[0].score
    );

    client
        .delete_collection(&name)
        .expect("delete_collection should succeed");
    assert!(
        !client.collection_exists(&name).expect("exists check"),
        "collection should be gone after delete"
    );
}

#[test]
#[ignore = "requires a running Qdrant instance; run with `cargo test -- --ignored`"]
fn test_qdrant_upsert_empty_list_is_noop() {
    let client = QdrantClient::new(&qdrant_url());
    let name = unique_collection();
    client.recreate_collection(&name, 2).expect("recreate ok");
    client
        .upsert(&name, vec![])
        .expect("empty upsert should be a no-op");
    client.delete_collection(&name).ok();
}

#[test]
#[ignore = "requires a running Qdrant instance; run with `cargo test -- --ignored`"]
fn test_qdrant_delete_collection_is_idempotent_on_404() {
    let client = QdrantClient::new(&qdrant_url());
    let name = unique_collection();

    // 存在しないコレクションの削除は 404 を返すが、冪等性のため Ok 扱い。
    client
        .delete_collection(&name)
        .expect("delete of non-existent collection should be Ok(())");
}
