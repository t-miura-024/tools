use std::process::Command;

use anyhow::{Context, bail};
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

pub fn tab_create(
    workspace_id: &str,
    cwd: &str,
    label: &str,
) -> anyhow::Result<(String, String)> {
    let output = run_herdr(&[
        "tab",
        "create",
        "--workspace",
        workspace_id,
        "--cwd",
        cwd,
        "--label",
        label,
        "--no-focus",
    ])?;
    let v = parse_result(&output)?;
    let tab_id = v
        .pointer("/result/tab/tab_id")
        .and_then(|s| s.as_str())
        .context("tab create の応答に tab_id がありません")?
        .to_string();
    let pane_id = v
        .pointer("/result/root_pane/pane_id")
        .and_then(|s| s.as_str())
        .context("tab create の応答に root_pane がありません")?
        .to_string();
    Ok((tab_id, pane_id))
}

pub fn tab_rename(tab_id: &str, label: &str) -> anyhow::Result<()> {
    let output = run_herdr(&["tab", "rename", tab_id, label])?;
    parse_result(&output)?;
    Ok(())
}

pub fn tab_focus(tab_id: &str) -> anyhow::Result<()> {
    let output = run_herdr(&["tab", "focus", tab_id])?;
    parse_result(&output)?;
    Ok(())
}

pub fn pane_split(
    pane_id: &str,
    direction: &str,
    ratio: f64,
    cwd: &str,
) -> anyhow::Result<String> {
    let output = run_herdr(&[
        "pane",
        "split",
        pane_id,
        "--direction",
        direction,
        "--ratio",
        &ratio.to_string(),
        "--cwd",
        cwd,
        "--no-focus",
    ])?;
    let v = parse_result(&output)?;
    let new_pane_id = v
        .pointer("/result/pane/pane_id")
        .and_then(|s| s.as_str())
        .context("pane split の応答に pane_id がありません")?
        .to_string();
    Ok(new_pane_id)
}
