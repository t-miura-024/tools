//! `client`（difit サーバ HTTP クライアント）のテスト。

use super::*;

#[test]
fn test_selection_query_direct_omits_base_mode() {
    let selection = CommentSelection {
        base: "staged".to_string(),
        target: "working".to_string(),
        base_mode: None,
    };
    assert_eq!(selection.query(), "base=staged&target=working");
}

#[test]
fn test_selection_query_merge_base_includes_base_mode() {
    let selection = CommentSelection {
        base: "a1b2c3d".to_string(),
        target: ".".to_string(),
        base_mode: Some("merge-base".to_string()),
    };
    assert_eq!(
        selection.query(),
        "base=a1b2c3d&target=.&baseMode=merge-base"
    );
}

#[test]
fn test_selection_query_percent_encodes_special_characters() {
    // `&` / `#` / `%` / `+` / `=` / 空白等を素通しすると、別パラメータ・
    // フラグメント・空白解釈に化けて別セッションを読み書きする。
    let selection = CommentSelection {
        base: "feature&x=1".to_string(),
        target: "topic%2F#frag +plus".to_string(),
        base_mode: Some("merge base".to_string()),
    };
    assert_eq!(
        selection.query(),
        "base=feature%26x%3D1&target=topic%252F%23frag%20%2Bplus&baseMode=merge%20base"
    );
}

#[test]
fn test_selection_query_encodes_unicode_as_utf8_percent_escapes() {
    let selection = CommentSelection {
        base: "ブランチ".to_string(),
        target: ".".to_string(),
        base_mode: None,
    };
    assert_eq!(
        selection.query(),
        "base=%E3%83%96%E3%83%A9%E3%83%B3%E3%83%81&target=."
    );
}

#[test]
fn test_selection_query_keeps_unreserved_characters() {
    let selection = CommentSelection {
        base: "aB9-._~".to_string(),
        target: "working".to_string(),
        base_mode: None,
    };
    assert_eq!(selection.query(), "base=aB9-._~&target=working");
}

// ---------------------------------------------------------------------------
// chunk_comments（difit の HTTP ボディ上限への分割）
// ---------------------------------------------------------------------------

fn comment_with_body_size(path: &str, size: usize) -> serde_json::Value {
    serde_json::json!({
        "type": "thread",
        "filePath": path,
        "position": {"side": "new", "line": 1},
        "body": "x".repeat(size),
    })
}

#[test]
fn test_chunk_comments_packs_under_the_chunk_budget() {
    // 1 件 20 KiB のコメント 5 件 → 直列化 + カンマで 64 KiB を超えるため分割される
    let comments: Vec<serde_json::Value> = (0..5)
        .map(|index| comment_with_body_size(&format!("f{index}.rs"), 20 * 1024))
        .collect();
    let chunks = chunk_comments(&comments).unwrap();
    assert!(chunks.len() >= 2, "上限を超えないよう分割する: {chunks:?}");
    assert_eq!(
        chunks.iter().map(|chunk| chunk.len()).sum::<usize>(),
        comments.len(),
        "全件が過不足なく分割される"
    );
    for chunk in &chunks {
        let size = serde_json::to_string(chunk).unwrap().len();
        assert!(
            size <= COMMENT_IMPORT_CHUNK_BYTES,
            "チャンクは上限以下: {size} bytes"
        );
    }
}

#[test]
fn test_chunk_comments_sends_oversized_entry_alone() {
    // チャンク上限は超えるが difit のリクエスト上限内の 1 件は、単独チャンクで送る
    let large = comment_with_body_size("big.rs", 80 * 1024);
    let small = comment_with_body_size("small.rs", 16);
    let comments = vec![large, small];
    let chunks = chunk_comments(&comments).unwrap();
    assert_eq!(chunks.len(), 2, "大きい 1 件は単独チャンク");
    assert_eq!(chunks[0].len(), 1);
    assert_eq!(chunks[1].len(), 1);
}

#[test]
fn test_chunk_comments_empty_returns_no_chunks() {
    assert!(chunk_comments(&[]).unwrap().is_empty());
}

#[test]
fn test_chunk_comments_rejects_entry_over_difit_request_limit() {
    // difit の 100kb 上限を超える単一コメントは、413 で原因不明に失敗させる前に
    // 明示エラーにする。
    let oversized = comment_with_body_size("huge.rs", COMMENT_IMPORT_REQUEST_LIMIT);
    let error = chunk_comments(&[oversized]).expect_err("上限超過は明示エラー");
    assert!(error.to_string().contains("上限"), "{error:#}");
}

#[test]
fn test_selection_json_roundtrip() {
    let selection = CommentSelection {
        base: "a1b2c3d".to_string(),
        target: ".".to_string(),
        base_mode: Some("merge-base".to_string()),
    };
    let json = serde_json::to_string(&selection).unwrap();
    // difit API と同じ baseMode キーで永続化・出力する
    assert_eq!(
        json,
        r#"{"base":"a1b2c3d","target":".","baseMode":"merge-base"}"#
    );
    let parsed: CommentSelection = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, selection);
}

#[test]
fn test_selection_json_omits_direct_base_mode() {
    let selection = CommentSelection {
        base: "staged".to_string(),
        target: "working".to_string(),
        base_mode: None,
    };
    let json = serde_json::to_string(&selection).unwrap();
    assert_eq!(json, r#"{"base":"staged","target":"working"}"#);
    // baseMode なしの JSON も読める（direct へ正規化）
    let parsed: CommentSelection = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.base_mode, None);
}

#[test]
fn test_fetch_comments_errors_for_unreachable_server() {
    // difit が応答しないポートでは Err（ゲート判定へ進ませない）
    let error = fetch_comments(1, None).expect_err("応答なしはエラー");
    assert!(error.to_string().contains("comment get"));
}

#[test]
fn test_resolve_comment_errors_for_unreachable_server() {
    // difit が応答しないポートでは Err（resolve 成功と区別できるようにする）
    let selection = CommentSelection {
        base: "staged".to_string(),
        target: "working".to_string(),
        base_mode: None,
    };
    let error = resolve_comment(1, Some(&selection), "t1").expect_err("応答なしはエラー");
    assert!(error.to_string().contains("comment resolve"), "{error:#}");
}
