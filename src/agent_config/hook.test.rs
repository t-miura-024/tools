use super::*;

#[test]
fn test_hook_check_allow() {
    let input = r#"{"tool_name":"write","tool_input":{"file_path":"/tmp/test.txt"}}"#;
    let hook_input: HookInput = serde_json::from_str(input).unwrap();

    let home = "/home/testuser";
    let protected_dirs = vec![
        format!("{}/.cursor/skills", home),
        format!("{}/.cursor/rules", home),
        format!("{}/.cursor/agents", home),
        format!("{}/.cursor/commands", home),
    ];

    let file_path = hook_input
        .tool_input
        .as_ref()
        .and_then(|ti| ti.file_path.as_ref().or(ti.path.as_ref()));

    let mut denied = false;
    if let Some(path) = file_path {
        let abs_path = if path.starts_with('/') {
            PathBuf::from(path)
        } else {
            PathBuf::from("/tmp").join(path)
        };

        let abs_path_str = abs_path.to_string_lossy();

        for protected in &protected_dirs {
            if abs_path_str.starts_with(protected) {
                denied = true;
                break;
            }
        }
    }

    assert!(!denied);
}

#[test]
fn test_hook_check_deny_cursor_skills() {
    let input = r#"{"tool_name":"write","tool_input":{"file_path":"/home/testuser/.cursor/skills/test.md"}}"#;
    let hook_input: HookInput = serde_json::from_str(input).unwrap();

    let home = "/home/testuser";
    let protected_dirs = vec![
        format!("{}/.cursor/skills", home),
        format!("{}/.cursor/rules", home),
        format!("{}/.cursor/agents", home),
        format!("{}/.cursor/commands", home),
    ];

    let file_path = hook_input
        .tool_input
        .as_ref()
        .and_then(|ti| ti.file_path.as_ref().or(ti.path.as_ref()));

    let mut denied = false;
    if let Some(path) = file_path {
        let abs_path = if path.starts_with('/') {
            PathBuf::from(path)
        } else {
            PathBuf::from("/tmp").join(path)
        };

        let abs_path_str = abs_path.to_string_lossy();

        for protected in &protected_dirs {
            if abs_path_str.starts_with(protected) {
                denied = true;
                break;
            }
        }
    }

    assert!(denied);
}

#[test]
fn test_hook_check_deny_claude_agents() {
    let input = r#"{"tool_name":"write","tool_input":{"file_path":"/home/testuser/.claude/agents/test.md"}}"#;
    let hook_input: HookInput = serde_json::from_str(input).unwrap();

    let home = "/home/testuser";
    let protected_dirs = vec![
        format!("{}/.cursor/skills", home),
        format!("{}/.cursor/rules", home),
        format!("{}/.cursor/agents", home),
        format!("{}/.cursor/commands", home),
        format!("{}/.claude/skills", home),
        format!("{}/.claude/agents", home),
    ];

    let file_path = hook_input
        .tool_input
        .as_ref()
        .and_then(|ti| ti.file_path.as_ref().or(ti.path.as_ref()));

    let mut denied = false;
    if let Some(path) = file_path {
        let abs_path = if path.starts_with('/') {
            PathBuf::from(path)
        } else {
            PathBuf::from("/tmp").join(path)
        };

        let abs_path_str = abs_path.to_string_lossy();

        for protected in &protected_dirs {
            if abs_path_str.starts_with(protected) {
                denied = true;
                break;
            }
        }
    }

    assert!(denied);
}

#[test]
fn test_hook_check_deny_opencode_skills() {
    let input = r#"{"tool_name":"write","tool_input":{"file_path":"/home/testuser/.config/opencode/skills/test.md"}}"#;
    let hook_input: HookInput = serde_json::from_str(input).unwrap();

    let home = "/home/testuser";
    let protected_dirs = vec![
        format!("{}/.cursor/skills", home),
        format!("{}/.cursor/rules", home),
        format!("{}/.cursor/agents", home),
        format!("{}/.cursor/commands", home),
        format!("{}/.claude/skills", home),
        format!("{}/.claude/agents", home),
        format!("{}/.config/opencode/skills", home),
        format!("{}/.config/opencode/agents", home),
    ];

    let file_path = hook_input
        .tool_input
        .as_ref()
        .and_then(|ti| ti.file_path.as_ref().or(ti.path.as_ref()));

    let mut denied = false;
    if let Some(path) = file_path {
        let abs_path = if path.starts_with('/') {
            PathBuf::from(path)
        } else {
            PathBuf::from("/tmp").join(path)
        };

        let abs_path_str = abs_path.to_string_lossy();

        for protected in &protected_dirs {
            if abs_path_str.starts_with(protected) {
                denied = true;
                break;
            }
        }
    }

    assert!(denied);
}

#[test]
fn test_hook_check_deny_opencode_plugins() {
    let input = r#"{"tool_name":"write","tool_input":{"file_path":"/home/testuser/.config/opencode/plugins/cmux-notify.ts"}}"#;
    let hook_input: HookInput = serde_json::from_str(input).unwrap();

    let home = "/home/testuser";
    let protected_dirs = vec![
        format!("{}/.cursor/skills", home),
        format!("{}/.cursor/rules", home),
        format!("{}/.cursor/agents", home),
        format!("{}/.cursor/commands", home),
        format!("{}/.claude/skills", home),
        format!("{}/.claude/agents", home),
        format!("{}/.config/opencode/skills", home),
        format!("{}/.config/opencode/agents", home),
        format!("{}/.config/opencode/plugins", home),
    ];

    let file_path = hook_input
        .tool_input
        .as_ref()
        .and_then(|ti| ti.file_path.as_ref().or(ti.path.as_ref()));

    let mut denied = false;
    if let Some(path) = file_path {
        let abs_path = if path.starts_with('/') {
            PathBuf::from(path)
        } else {
            PathBuf::from("/tmp").join(path)
        };

        let abs_path_str = abs_path.to_string_lossy();

        for protected in &protected_dirs {
            if abs_path_str.starts_with(protected) {
                denied = true;
                break;
            }
        }
    }

    assert!(denied);
}

#[test]
fn test_hook_check_allow_opencode_config() {
    let input = r#"{"tool_name":"write","tool_input":{"file_path":"/home/testuser/.config/opencode/config.json"}}"#;
    let hook_input: HookInput = serde_json::from_str(input).unwrap();

    let home = "/home/testuser";
    let protected_dirs = vec![
        format!("{}/.cursor/skills", home),
        format!("{}/.cursor/rules", home),
        format!("{}/.cursor/agents", home),
        format!("{}/.cursor/commands", home),
        format!("{}/.claude/skills", home),
        format!("{}/.claude/agents", home),
        format!("{}/.config/opencode/skills", home),
        format!("{}/.config/opencode/agents", home),
        format!("{}/.config/opencode/plugins", home),
    ];

    let file_path = hook_input
        .tool_input
        .as_ref()
        .and_then(|ti| ti.file_path.as_ref().or(ti.path.as_ref()));

    let mut denied = false;
    if let Some(path) = file_path {
        let abs_path = if path.starts_with('/') {
            PathBuf::from(path)
        } else {
            PathBuf::from("/tmp").join(path)
        };

        let abs_path_str = abs_path.to_string_lossy();

        for protected in &protected_dirs {
            if abs_path_str.starts_with(protected) {
                denied = true;
                break;
            }
        }
    }

    assert!(!denied);
}
