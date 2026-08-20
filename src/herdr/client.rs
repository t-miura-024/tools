use std::process::Command;

use anyhow::{Context, bail};
use serde::Deserialize;
use serde_json::Value;

fn run_herdr(args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new("herdr")
        .args(args)
        .output()
        .context("herdr コマンドの実行に失敗しました")?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("herdr {} が失敗しました: {}", args.join(" "), stderr.trim());
    }
    Ok(stdout)
}

fn parse_result(output: &str) -> anyhow::Result<Value> {
    let v: Value = serde_json::from_str(output)
        .with_context(|| format!("herdr の応答を JSON として解釈できませんでした: {output}"))?;
    if let Some(err) = v.get("error") {
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        bail!("herdr API error: {message}");
    }
    Ok(v)
}

#[derive(Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub open_workspace_id: Option<String>,
}

pub fn worktree_list() -> anyhow::Result<Vec<WorktreeInfo>> {
    let output = run_herdr(&["worktree", "list"])?;
    let v = parse_result(&output)?;
    let arr = v
        .pointer("/result/worktrees")
        .and_then(|w| w.as_array())
        .context("worktree list の応答に worktrees がありません")?;
    arr.iter()
        .map(|w| {
            serde_json::from_value::<WorktreeInfo>(w.clone())
                .context("worktree エントリの解析に失敗しました")
        })
        .collect()
}

pub fn api_snapshot() -> anyhow::Result<Value> {
    let output = run_herdr(&["api", "snapshot"])?;
    let v = parse_result(&output)?;
    v.pointer("/result/snapshot")
        .cloned()
        .context("snapshot に snapshot フィールドがありません")
}

pub fn workspace_create(cwd: &str, label: &str) -> anyhow::Result<String> {
    let output = run_herdr(&[
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        label,
        "--focus",
    ])?;
    let v = parse_result(&output)?;
    let workspace_id = v
        .pointer("/result/workspace/workspace_id")
        .and_then(|s| s.as_str())
        .context("workspace create の応答に workspace_id がありません")?
        .to_string();
    Ok(workspace_id)
}
