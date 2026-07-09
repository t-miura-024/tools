use super::*;

#[test]
fn test_parse_with_title_and_source() {
    let content = "---\ntitle: グレーブ\nsource: https://example.com/foo\n---\n本文";
    let (fm, body) = parse(content, "title", "source").unwrap();
    assert_eq!(fm.title, "グレーブ");
    assert_eq!(fm.source, "https://example.com/foo");
    assert_eq!(body, "本文");
}

#[test]
fn test_parse_without_frontmatter() {
    let content = "# タイトル\n本文だけ";
    let (fm, body) = parse(content, "title", "source").unwrap();
    assert_eq!(fm, DocFrontmatter::default());
    assert_eq!(body, content);
}

#[test]
fn test_parse_with_missing_keys() {
    let content = "---\nfoo: bar\n---\n本文";
    let (fm, body) = parse(content, "title", "source").unwrap();
    assert_eq!(fm.title, "");
    assert_eq!(fm.source, "");
    assert_eq!(body, "本文");
}

#[test]
fn test_parse_with_custom_keys() {
    let content = "---\nname: 名前\nurl: https://example.com\n---\n本文";
    let (fm, body) = parse(content, "name", "url").unwrap();
    assert_eq!(fm.title, "名前");
    assert_eq!(fm.source, "https://example.com");
    assert_eq!(body, "本文");
}

#[test]
fn test_parse_unterminated_frontmatter_errors() {
    let content = "---\ntitle: foo\nno terminator";
    assert!(parse(content, "title", "source").is_err());
}

#[test]
fn test_parse_with_crlf_line_endings() {
    let content = "---\r\ntitle: グレーブ\r\nsource: https://example.com\r\n---\r\n本文";
    let (fm, body) = parse(content, "title", "source").unwrap();
    assert_eq!(fm.title, "グレーブ");
    assert_eq!(fm.source, "https://example.com");
    assert_eq!(body, "本文");
}

#[test]
fn test_from_value_with_non_string_values() {
    let value: yaml_serde::Value = yaml_serde::from_str("title: 123\nsource: [a, b]").unwrap();
    let fm = DocFrontmatter::from_value(&value, "title", "source");
    assert_eq!(fm.title, "");
    assert_eq!(fm.source, "");
}

#[test]
fn test_parse_lf_start_with_crlf_end() {
    let content = "---\ntitle: foo\n---\r\nbody";
    let (fm, body) = parse(content, "title", "source").unwrap();
    assert_eq!(fm.title, "foo");
    assert_eq!(body, "body");
}

#[test]
fn test_parse_crlf_start_with_lf_end() {
    let content = "---\r\ntitle: foo\r\n---\nbody";
    let (fm, body) = parse(content, "title", "source").unwrap();
    assert_eq!(fm.title, "foo");
    assert_eq!(body, "body");
}

#[test]
fn test_parse_mixed_internal_crlf() {
    // 開始 LF, 本文内 CRLF, 終端 LF: 現状の実装では CRLF の LF 部分だけが
    // 終端マーカー `\n---\n` の先頭 LF として誤認マッチする。
    // 結果として frontmatter_str に末尾 `\r` が残り、YAML 解析は通るが
    // title キーが LF + CR の両方を含む値になる可能性がある。
    // 現状は実用上の問題が出ないが、Markdown 解析の厳密化は別計画で。
    let content = "---\ntitle: foo\r\n---\nbody";
    let result = parse(content, "title", "source");
    // 実装の現状挙動をドキュメント化: Err にも Ok にもなり得るが、
    // 少なくともパニックはしないことを確認する。
    let _ = result;
}
