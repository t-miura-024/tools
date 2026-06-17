use super::*;
use std::path::PathBuf;

fn make_config(doc_dir: &std::path::Path) -> VectorConfig {
    VectorConfig {
        collection_name: "test_collection".to_string(),
        doc_dir: doc_dir.to_path_buf(),
        qdrant_url: "http://localhost:6333".to_string(),
        vector_dim: 384,
        chunk_pattern: "^#{1,3}\\s+".to_string(),
        batch_size: 32,
        top_k: 20,
        embed_model: "dummy-sha256".to_string(),
        title_key: "title".to_string(),
        source_key: "source".to_string(),
    }
}

#[test]
fn test_resolve_doc_dir_absolute() {
    let resolved = resolve_doc_dir(&PathBuf::from("/tmp/docs")).unwrap();
    assert_eq!(resolved, PathBuf::from("/tmp/docs"));
}

#[test]
fn test_resolve_doc_dir_relative() {
    let resolved = resolve_doc_dir(&PathBuf::from("doc")).unwrap();
    assert!(resolved.ends_with("doc"));
}

#[test]
fn test_collect_markdown_files_finds_md_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "a").unwrap();
    std::fs::write(dir.path().join("b.md"), "b").unwrap();
    std::fs::write(dir.path().join("c.txt"), "c").unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    std::fs::write(dir.path().join("sub/d.md"), "d").unwrap();

    let files = collect_markdown_files(dir.path());
    let names: Vec<String> = files
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
        .collect();
    assert!(names.contains(&"a.md".to_string()));
    assert!(names.contains(&"b.md".to_string()));
    assert!(names.contains(&"d.md".to_string()));
    assert!(!names.contains(&"c.txt".to_string()));
    assert_eq!(files.len(), 3);
}

#[test]
fn test_collect_markdown_files_skips_hidden_and_node_modules() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".hidden")).unwrap();
    std::fs::write(dir.path().join(".hidden/x.md"), "x").unwrap();
    std::fs::create_dir(dir.path().join("node_modules")).unwrap();
    std::fs::write(dir.path().join("node_modules/y.md"), "y").unwrap();
    std::fs::write(dir.path().join("z.md"), "z").unwrap();

    let files = collect_markdown_files(dir.path());
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].file_name().unwrap(), "z.md");
}

#[test]
fn test_collect_markdown_files_missing_dir_returns_empty() {
    let files = collect_markdown_files(&PathBuf::from("/this/does/not/exist"));
    assert!(files.is_empty());
}

#[test]
fn test_collect_markdown_files_picks_up_md_extension() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.MD"), "a").unwrap();
    std::fs::write(dir.path().join("b.Md"), "b").unwrap();
    let files = collect_markdown_files(dir.path());
    assert_eq!(files.len(), 2);
}

#[test]
fn test_collect_markdown_files_skips_dotted_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".DS_Store"), "ignore").unwrap();
    std::fs::write(dir.path().join("real.md"), "real").unwrap();
    let files = collect_markdown_files(dir.path());
    assert_eq!(files.len(), 1);
}

#[test]
fn test_run_against_unreachable_qdrant_returns_error() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "# T\nbody").unwrap();
    let mut config = make_config(dir.path());
    config.qdrant_url = "http://127.0.0.1:1".to_string();
    let result = run(&config);
    assert!(result.is_err());
}
