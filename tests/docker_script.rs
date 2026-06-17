use std::path::Path;
use std::process::Command;

fn repo_root() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

#[test]
fn test_docker_sh_help_prints_usage() {
    let script = repo_root().join("scripts/docker.sh");
    let output = Command::new(&script)
        .arg("help")
        .output()
        .expect("scripts/docker.sh help should run");
    assert!(output.status.success(), "exit status should be 0");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Usage: scripts/docker.sh"));
    assert!(stdout.contains("up"));
    assert!(stdout.contains("down"));
    assert!(stdout.contains("logs"));
}

#[test]
fn test_docker_sh_without_args_prints_usage_to_stderr() {
    let script = repo_root().join("scripts/docker.sh");
    let output = Command::new(&script)
        .output()
        .expect("scripts/docker.sh should run");
    assert!(!output.status.success(), "exit status should be non-zero");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Usage: scripts/docker.sh"));
}

#[test]
fn test_docker_sh_config_resolves_both_services() {
    let script = repo_root().join("scripts/docker.sh");
    let output = Command::new(&script)
        .arg("config")
        .output()
        .expect("scripts/docker.sh config should run");
    assert!(output.status.success(), "exit status should be 0");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("qdrant:"),
        "config should include qdrant service"
    );
    assert!(
        stdout.contains("searxng:"),
        "config should include searxng service"
    );
}
