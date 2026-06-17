use assert_cmd::Command;
use predicates::prelude::predicate;

#[test]
fn test_mt_vector_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["vector", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("vector"));
}

#[test]
fn test_mt_vector_ingest_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["vector", "ingest", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("vector.config.toml"));
}

#[test]
fn test_mt_vector_search_help() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["vector", "search", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("query"));
}

#[test]
fn test_mt_vector_ingest_with_missing_config_errors() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args(["vector", "ingest", "--config", "/this/does/not/exist.toml"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("設定ファイルが読み込めません"));
}

#[test]
fn test_mt_vector_search_with_missing_config_errors() {
    let mut cmd = Command::cargo_bin("mt").unwrap();
    cmd.args([
        "vector",
        "search",
        "--config",
        "/this/does/not/exist.toml",
        "--query",
        "foo",
    ])
    .assert()
    .failure()
    .stderr(predicate::str::contains("設定ファイルが読み込めません"));
}
