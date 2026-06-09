use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct ToolInput {
    file_path: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HookInput {
    tool_name: Option<String>,
    tool_input: Option<ToolInput>,
}

#[derive(Debug, Serialize)]
struct HookOutput {
    decision: String,
    reason: Option<String>,
}

pub fn check() -> Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;

    let hook_input: HookInput = serde_json::from_str(&input)?;

    let home = std::env::var("HOME").unwrap_or_default();
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

    if let Some(path) = file_path {
        let abs_path = if path.starts_with('/') {
            PathBuf::from(path)
        } else {
            std::env::current_dir()?.join(path)
        };

        let abs_path_str = abs_path.to_string_lossy();

        for protected in &protected_dirs {
            if abs_path_str.starts_with(protected) {
                let output = HookOutput {
                    decision: "deny".to_string(),
                    reason: Some(format!(
                        "Direct edit to protected directory {} is not allowed. Edit agent-configs/ instead and run 'mt agent-config sync'.",
                        protected
                    )),
                };
                println!("{}", serde_json::to_string(&output)?);
                return Ok(());
            }
        }
    }

    let output = HookOutput {
        decision: "allow".to_string(),
        reason: None,
    };
    println!("{}", serde_json::to_string(&output)?);

    Ok(())
}

#[cfg(test)]
#[path = "hook.test.rs"]
mod tests;
