use super::*;

#[test]
fn test_parse_github_repo_url_ssh() {
    let result = parse_github_repo_url("git@github.com:owner/name.git");
    assert_eq!(result, Some(("owner".to_string(), "name".to_string())));
}

#[test]
fn test_parse_github_repo_url_ssh_no_git_suffix() {
    let result = parse_github_repo_url("git@github.com:owner/name");
    assert_eq!(result, Some(("owner".to_string(), "name".to_string())));
}

#[test]
fn test_parse_github_repo_url_https() {
    let result = parse_github_repo_url("https://github.com/owner/name.git");
    assert_eq!(result, Some(("owner".to_string(), "name".to_string())));
}

#[test]
fn test_parse_github_repo_url_https_no_git_suffix() {
    let result = parse_github_repo_url("https://github.com/owner/name");
    assert_eq!(result, Some(("owner".to_string(), "name".to_string())));
}

#[test]
fn test_parse_github_repo_url_https_trailing_slash() {
    let result = parse_github_repo_url("https://github.com/owner/name/");
    assert_eq!(result, Some(("owner".to_string(), "name".to_string())));
}

#[test]
fn test_parse_github_repo_url_http() {
    let result = parse_github_repo_url("http://github.com/owner/name.git");
    assert_eq!(result, Some(("owner".to_string(), "name".to_string())));
}

#[test]
fn test_parse_github_repo_url_empty() {
    assert_eq!(parse_github_repo_url(""), None);
}

#[test]
fn test_parse_github_repo_url_invalid() {
    assert_eq!(parse_github_repo_url("not a url"), None);
    assert_eq!(parse_github_repo_url("git@gitlab.com:owner/name.git"), None);
}

#[test]
fn test_parse_github_repo_url_ssh_with_newline() {
    let result = parse_github_repo_url("git@github.com:owner/name.git\n");
    assert_eq!(result, Some(("owner".to_string(), "name".to_string())));
}

#[test]
fn test_determine_target_personal_repo() {
    let (target, has_external) =
        determine_target("myuser", "myrepo", "myuser");
    assert_eq!(target, "myuser/myrepo");
    assert!(!has_external);
}

#[test]
fn test_determine_target_external_repo() {
    let (target, has_external) =
        determine_target("otheruser", "otherrepo", "myuser");
    assert_eq!(target, "myuser/note");
    assert!(has_external);
}

#[test]
fn test_format_external_label_name() {
    let label = format_external_label_name("otheruser", "otherrepo");
    assert_eq!(label, "external/otheruser-otherrepo");
}

#[test]
fn test_parse_config_from_str() {
    let json = r#"{
        "owner": "testuser",
        "projectNumber": 4,
        "projectId": "PVT_test",
        "statusFieldId": "PVTSSF_test",
        "statusOptions": {
            "draft": "abc123",
            "refined": "def456",
            "in-progress": "ghi789",
            "done": "jkl012"
        }
    }"#;

    let config = parse_config_from_str(json).unwrap();
    assert_eq!(config.owner, "testuser");
    assert_eq!(config.project_number, 4);
    assert_eq!(config.project_id, "PVT_test");
    assert_eq!(config.status_field_id, "PVTSSF_test");
    assert_eq!(config.status_options.draft, "abc123");
}
