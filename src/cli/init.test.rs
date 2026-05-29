use super::*;

#[test]
fn test_path_contains_check() {
    let path = "/usr/local/bin:/usr/bin:/home/user/.cargo/bin:/bin";
    assert!(path_contains(path, "/home/user/.cargo/bin"));

    let path2 = "/usr/local/bin:/usr/bin:/bin";
    assert!(!path_contains(path2, "/home/user/.cargo/bin"));
}

#[test]
fn test_append_block() {
    let mut content = "export FOO=bar\n".to_string();
    append_block(&mut content, "export BAR=baz");

    assert_eq!(content, "export FOO=bar\n\nexport BAR=baz\n");
}

#[test]
fn test_has_wt_bridge() {
    assert!(has_wt_bridge(WT_BRIDGE_ENTRY));
    assert!(!has_wt_bridge("wt() { cd /tmp; }"));
}
