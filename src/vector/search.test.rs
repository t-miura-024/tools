use super::*;
use serde_json::json;

fn make_hit(score: f32, file_path: &str) -> SearchHit {
    SearchHit {
        score,
        file_path: file_path.to_string(),
        title: "title".to_string(),
        url: "https://example.com".to_string(),
        heading: "## h".to_string(),
        text: "body".to_string(),
        chunk_index: 0,
    }
}

#[test]
fn test_top10_avg_score_with_ten_results() {
    let results: Vec<SearchHit> = (0..10).map(|i| make_hit((10 - i) as f32, "a")).collect();
    let top10: Vec<&SearchHit> = results.iter().collect();
    let avg = top10.iter().map(|h| h.score as f64).sum::<f64>() / top10.len() as f64;
    assert!((avg - 5.5).abs() < 0.01);
}

#[test]
fn test_top10_avg_score_with_no_results() {
    let results: Vec<SearchHit> = vec![];
    let top10: Vec<&SearchHit> = results.iter().collect();
    let avg = if top10.is_empty() {
        0.0
    } else {
        top10.iter().map(|h| h.score as f64).sum::<f64>() / top10.len() as f64
    };
    assert_eq!(avg, 0.0);
}

#[test]
fn test_top10_avg_score_with_fewer_than_ten_results() {
    let results = [make_hit(0.9, "a"), make_hit(0.7, "b"), make_hit(0.5, "c")];
    let top10: Vec<&SearchHit> = results.iter().collect();
    let avg = top10.iter().map(|h| h.score as f64).sum::<f64>() / top10.len() as f64;
    assert!((avg - 0.7).abs() < 0.01);
}

#[test]
fn test_point_to_hit_extracts_payload_fields() {
    let payload = json!({
        "filePath": "foo.md",
        "title": "T",
        "url": "https://example.com/foo",
        "heading": "# H",
        "text": "hello",
        "chunkIndex": 3,
    });
    let point = ScoredPoint {
        id: json!("id"),
        score: 0.95,
        payload,
    };
    let hit = point_to_hit(point);
    assert_eq!(hit.file_path, "foo.md");
    assert_eq!(hit.title, "T");
    assert_eq!(hit.url, "https://example.com/foo");
    assert_eq!(hit.heading, "# H");
    assert_eq!(hit.text, "hello");
    assert_eq!(hit.chunk_index, 3);
    assert!((hit.score - 0.95).abs() < 0.001);
}

#[test]
fn test_point_to_hit_handles_missing_fields() {
    let point = ScoredPoint {
        id: json!("id"),
        score: 0.5,
        payload: json!({}),
    };
    let hit = point_to_hit(point);
    assert_eq!(hit.file_path, "");
    assert_eq!(hit.title, "");
    assert_eq!(hit.text, "");
    assert_eq!(hit.chunk_index, 0);
}

#[test]
fn test_search_output_serializes_to_expected_json() {
    let output = SearchOutput {
        query: "foo".to_string(),
        count: 1,
        top10_avg_score: 0.85,
        avg_score_sample_size: 1,
        results: vec![make_hit(0.85, "a")],
    };
    let serialized = serde_json::to_value(&output).unwrap();
    assert_eq!(serialized["query"], "foo");
    assert_eq!(serialized["count"], 1);
    assert_eq!(serialized["top10AvgScore"], 0.85);
    assert_eq!(serialized["results"][0]["filePath"], "a");
}
