use super::*;

fn write_brewfile(dir: &Path, content: &str) -> PathBuf {
    let brewfile = dir.join("Brewfile");
    fs::write(&brewfile, content).expect("Brewfile を書き込めること");
    brewfile
}

fn link(target: &Path, link: &Path) {
    fs::create_dir_all(link.parent().expect("親ディレクトリ")).expect("親ディレクトリを作れること");
    std::os::unix::fs::symlink(target, link).expect("symlink を作れること");
}

#[test]
fn brewfile_casks_extracts_entries_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let brewfile = write_brewfile(
        dir.path(),
        "tap \"anomalyco/tap\"\nbrew \"fzf\"\ncask \"docker-desktop\"\n# cask \"commented-out\"\ncask \"arc\"\n",
    );

    assert_eq!(
        brewfile_casks(&brewfile).unwrap(),
        vec!["docker-desktop".to_string(), "arc".to_string()]
    );
}

#[test]
fn brewfile_casks_returns_empty_without_cask_entries() {
    let dir = tempfile::tempdir().unwrap();
    let brewfile = write_brewfile(dir.path(), "tap \"a/b\"\nbrew \"fzf\"\n");

    assert!(brewfile_casks(&brewfile).unwrap().is_empty());
}

#[test]
fn broken_casks_detects_dangling_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let caskroom = dir.path().join("Caskroom");
    let version_dir = caskroom.join("docker-desktop/4.89.0,238018");
    let artifact = version_dir.join("Docker.app");
    let missing_target = dir.path().join("Applications/Docker.app");
    link(&missing_target, &artifact);

    let broken = broken_casks(&caskroom, &["docker-desktop".to_string()]);

    assert_eq!(broken.len(), 1);
    assert_eq!(broken[0].spec, "docker-desktop");
    assert_eq!(broken[0].dangling, vec![artifact]);
    assert!(broken[0].dangling_display().contains("Docker.app"));
}

#[test]
fn broken_casks_ignores_intact_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let caskroom = dir.path().join("Caskroom");
    let app = dir.path().join("Applications/Arc.app");
    fs::create_dir_all(&app).expect("実体を作れること");
    link(&app, &caskroom.join("arc/1.166.0,87668/Arc.app"));

    assert!(broken_casks(&caskroom, &["arc".to_string()]).is_empty());
}

#[test]
fn broken_casks_ignores_uninstalled_cask() {
    let dir = tempfile::tempdir().unwrap();

    assert!(broken_casks(&dir.path().join("Caskroom"), &["arc".to_string()]).is_empty());
}

#[test]
fn broken_casks_ignores_metadata_directory() {
    let dir = tempfile::tempdir().unwrap();
    let caskroom = dir.path().join("Caskroom");
    let metadata_dir = caskroom.join("arc/.metadata/1.166.0,87668/20260927032418.650");
    fs::create_dir_all(&metadata_dir).expect("metadata を作れること");
    link(
        &dir.path().join("missing.json"),
        &metadata_dir.join("Casks/arc.json"),
    );

    assert!(broken_casks(&caskroom, &["arc".to_string()]).is_empty());
}

#[test]
fn broken_casks_strips_tap_prefix_for_caskroom_lookup() {
    let dir = tempfile::tempdir().unwrap();
    let caskroom = dir.path().join("Caskroom");
    link(
        &dir.path().join("missing.app"),
        &caskroom.join("notesmd-cli/1.0.0/notesmd-cli.app"),
    );

    let broken = broken_casks(&caskroom, &["yakitrak/yakitrak/notesmd-cli".to_string()]);

    assert_eq!(broken.len(), 1);
    assert_eq!(broken[0].spec, "yakitrak/yakitrak/notesmd-cli");
}
