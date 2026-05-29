#[test]
fn test_repo_name_validation() {
    let valid_names = ["my-repo", "my.repo", "my_repo", "repo123", "a.b-c_d"];
    for name in &valid_names {
        assert!(
            name.chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-'),
            "{} should be valid",
            name
        );
    }

    let invalid_names = ["my repo", "repo/name", "repo!name"];
    for name in &invalid_names {
        assert!(
            !name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-'),
            "{} should be invalid",
            name
        );
    }
}
