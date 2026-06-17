use super::*;

#[test]
fn test_new_trims_trailing_slash() {
    let client = QdrantClient::new("http://localhost:6333/");
    assert_eq!(client.base_url, "http://localhost:6333");
}

#[test]
fn test_new_keeps_url_without_slash() {
    let client = QdrantClient::new("http://localhost:6333");
    assert_eq!(client.base_url, "http://localhost:6333");
}

#[test]
fn test_point_serialization_roundtrip() {
    let point = Point {
        id: "abc-123".to_string(),
        vector: vec![0.1, 0.2, 0.3],
        payload: json!({"title": "test"}),
    };
    let serialized = serde_json::to_string(&point).unwrap();
    let deserialized: Point = serde_json::from_str(&serialized).unwrap();
    assert_eq!(deserialized.id, "abc-123");
    assert_eq!(deserialized.vector, vec![0.1, 0.2, 0.3]);
    assert_eq!(deserialized.payload["title"], "test");
}

#[test]
fn test_scored_point_serialization_roundtrip() {
    let scored = ScoredPoint {
        id: json!("uuid-xyz"),
        score: 0.95,
        payload: json!({"filePath": "foo.md"}),
    };
    let serialized = serde_json::to_string(&scored).unwrap();
    let deserialized: ScoredPoint = serde_json::from_str(&serialized).unwrap();
    assert_eq!(deserialized.score, 0.95);
    assert_eq!(deserialized.payload["filePath"], "foo.md");
}
