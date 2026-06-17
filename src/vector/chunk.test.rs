use super::*;

#[test]
fn test_split_by_headings_basic() {
    let content = "# 見出し1\n本文A\n\n## 見出し2\n本文B\n\n# 見出し3\n本文C";
    let chunks = split_by_headings(content, r"^#{1,3}\s+").unwrap();
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[0].heading, "# 見出し1");
    assert_eq!(chunks[0].text, "本文A");
    assert_eq!(chunks[0].chunk_index, 0);
    assert_eq!(chunks[1].heading, "## 見出し2");
    assert_eq!(chunks[1].text, "本文B");
    assert_eq!(chunks[1].chunk_index, 1);
    assert_eq!(chunks[2].heading, "# 見出し3");
    assert_eq!(chunks[2].text, "本文C");
    assert_eq!(chunks[2].chunk_index, 2);
}

#[test]
fn test_split_by_headings_pre_heading_text() {
    let content = "front matter\n\n# 見出し\n本文";
    let chunks = split_by_headings(content, r"^#{1,3}\s+").unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].heading, "");
    assert_eq!(chunks[0].text, "front matter");
    assert_eq!(chunks[1].heading, "# 見出し");
    assert_eq!(chunks[1].text, "本文");
}

#[test]
fn test_split_by_headings_drops_empty_sections() {
    let content = "# A\n本文\n# B\n\n# C\n本文C";
    let chunks = split_by_headings(content, r"^#{1,3}\s+").unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].heading, "# A");
    assert_eq!(chunks[1].heading, "# C");
}

#[test]
fn test_split_by_headings_h4_not_split() {
    let content = "# 見出し1\n本文\n#### 見出し4\n本文4";
    let chunks = split_by_headings(content, r"^#{1,3}\s+").unwrap();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].heading, "# 見出し1");
    assert_eq!(chunks[0].text, "本文\n#### 見出し4\n本文4");
}

#[test]
fn test_split_by_headings_h2_only() {
    let content = "# H1\n本文1\n## H2\n本文2\n### H3\n本文3";
    let chunks = split_by_headings(content, r"^##\s+").unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].heading, "");
    assert_eq!(chunks[0].text, "# H1\n本文1");
    assert_eq!(chunks[1].heading, "## H2");
    assert_eq!(chunks[1].text, "本文2\n### H3\n本文3");
}

#[test]
fn test_split_by_headings_invalid_pattern_errors() {
    assert!(split_by_headings("any", "(").is_err());
}

#[test]
fn test_split_by_headings_empty_input() {
    let chunks = split_by_headings("", r"^#{1,3}\s+").unwrap();
    assert!(chunks.is_empty());
}

#[test]
fn test_split_by_headings_multiline_section() {
    let content = "# Title\nline1\nline2\nline3\n# Next\nnext line";
    let chunks = split_by_headings(content, r"^#{1,3}\s+").unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].text, "line1\nline2\nline3");
}
