use std::process::Command;

use anyhow::{Context, bail};
use clap::Subcommand;
use dialoguer::Confirm;
use serde::Deserialize;

use crate::cli::style;
use crate::tool::shared::Manifests;

#[derive(Subcommand)]
pub enum HerdrPluginCommands {
    /// manifests/herdr-plugins.toml に従ってプラグインを導入し、manifest 外の GitHub 導入を削除候補として確認する
    Sync,
}

pub fn run(cmd: HerdrPluginCommands) -> anyhow::Result<()> {
    match cmd {
        HerdrPluginCommands::Sync => sync_cmd(),
    }
}

fn sync_cmd() -> anyhow::Result<()> {
    style::intro("herdr プラグイン同期");
    let manifests = Manifests::discover()?;
    manifests.ensure_files()?;
    sync_core(&manifests)?;
    style::outro("✅ herdr プラグインの同期が完了しました");
    Ok(())
}

/// `mt tool install` から呼び出す入口。intro/outro は本流に任せて静かに実行する。
pub fn sync_with_tool_install(manifests: &Manifests) -> anyhow::Result<()> {
    style::info("herdr プラグインを manifest に同期します");
    sync_core(manifests)
}

fn sync_core(manifests: &Manifests) -> anyhow::Result<()> {
    let desired = read_manifest(&manifests.herdr_plugins)?;
    let installed = list_installed()?;

    for source in &desired {
        run_herdr_inherit(&["plugin", "install", source, "--yes"])?;
    }

    reconcile_extras(&desired, &installed)?;
    report_out_of_scope(&installed);
    Ok(())
}

/// GitHub 導入のうち manifest 外のプラグインを差分表示して確認し、承認されたら uninstall する。
/// ローカル link 等の GitHub 管理外プラグインは対象外として報告のみ行う。
fn reconcile_extras(desired: &[String], installed: &[InstalledPlugin]) -> anyhow::Result<()> {
    let github_sources = installed_github_shorthands(installed);
    let extras = extras_of(desired, &github_sources);

    if extras.is_empty() {
        style::success("manifest 外の herdr プラグインはありません");
        return Ok(());
    }

    for extra in &extras {
        style::warn(&format!("削除候補: herdr plugin {extra}"));
    }
    let confirmed = Confirm::new()
        .with_prompt("manifest 外の herdr プラグインをアンインストールしますか？")
        .default(false)
        .interact()?;

    if !confirmed {
        style::info("herdr プラグインの削除はスキップしました");
        return Ok(());
    }

    for extra in &extras {
        run_herdr_inherit(&["plugin", "uninstall", extra])?;
    }
    Ok(())
}

fn report_out_of_scope(installed: &[InstalledPlugin]) {
    let out_of_scope = installed
        .iter()
        .filter(|plugin| plugin.github_shorthand().is_none())
        .map(|plugin| plugin.plugin_id.as_str())
        .collect::<Vec<_>>();
    if !out_of_scope.is_empty() {
        style::info(&format!(
            "GitHub 管理外のため同期対象外としました: {}",
            out_of_scope.join(", ")
        ));
    }
}

/// `mt tool verify` / `mt doctor` 用の drift 検証。状態は変更しない。
pub fn verify_plugins(manifests: &Manifests) -> anyhow::Result<()> {
    let desired = read_manifest(&manifests.herdr_plugins)?;
    let installed = list_installed()?;
    let github_sources = installed_github_shorthands(&installed);
    let missing = missing_of(&desired, &github_sources);
    let extras = extras_of(&desired, &github_sources);

    if missing.is_empty() && extras.is_empty() {
        style::success("herdr プラグインは manifest と一致しています");
        return Ok(());
    }

    let mut parts = Vec::new();
    if !missing.is_empty() {
        parts.push(format!("未導入: {}", missing.join(", ")));
    }
    if !extras.is_empty() {
        parts.push(format!("manifest 外: {}", extras.join(", ")));
    }
    bail!("herdr プラグインに drift があります({})", parts.join(" / "))
}

// ── manifest ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct PluginManifest {
    #[serde(default)]
    plugin: Vec<PluginEntry>,
}

#[derive(Debug, Deserialize)]
struct PluginEntry {
    source: String,
}

fn read_manifest(path: &std::path::Path) -> anyhow::Result<Vec<String>> {
    let content = std::fs::read_to_string(path).with_context(|| {
        format!(
            "herdr-plugins.toml の読み込みに失敗しました: {}",
            path.display()
        )
    })?;
    parse_manifest(&content).with_context(|| {
        format!(
            "herdr-plugins.toml の解析に失敗しました: {}",
            path.display()
        )
    })
}

fn parse_manifest(content: &str) -> anyhow::Result<Vec<String>> {
    let manifest: PluginManifest =
        toml::from_str(content).context("TOML として解析できませんでした")?;

    let mut sources = Vec::new();
    for entry in manifest.plugin {
        if entry.source.trim().is_empty() {
            bail!("plugin の source が空です");
        }
        if sources.contains(&entry.source) {
            bail!("plugin の source が重複しています: {}", entry.source);
        }
        sources.push(entry.source);
    }
    Ok(sources)
}

// ── herdr CLI ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct PluginListResponse {
    result: PluginListResult,
}

#[derive(Debug, Deserialize)]
struct PluginListResult {
    #[serde(default)]
    plugins: Vec<InstalledPlugin>,
}

#[derive(Debug, Deserialize)]
struct InstalledPlugin {
    plugin_id: String,
    #[serde(default)]
    source: Option<PluginSource>,
}

#[derive(Debug, Deserialize)]
struct PluginSource {
    kind: String,
    owner: Option<String>,
    repo: Option<String>,
    subdir: Option<String>,
}

impl InstalledPlugin {
    /// GitHub 管理プラグインなら install shorthand(owner/repo[/subdir])を返す。
    fn github_shorthand(&self) -> Option<String> {
        let source = self.source.as_ref()?;
        if source.kind != "github" {
            return None;
        }
        let mut shorthand = format!("{}/{}", source.owner.as_deref()?, source.repo.as_deref()?);
        if let Some(subdir) = &source.subdir {
            shorthand.push('/');
            shorthand.push_str(subdir);
        }
        Some(shorthand)
    }
}

fn list_installed() -> anyhow::Result<Vec<InstalledPlugin>> {
    let output = run_herdr_capture(&["plugin", "list", "--json"])?;
    parse_plugin_list(&output)
}

fn parse_plugin_list(output: &str) -> anyhow::Result<Vec<InstalledPlugin>> {
    let response: PluginListResponse = serde_json::from_str(output)
        .context("herdr plugin list の応答を JSON として解析できませんでした")?;
    Ok(response.result.plugins)
}

fn installed_github_shorthands(installed: &[InstalledPlugin]) -> Vec<String> {
    installed
        .iter()
        .filter_map(|plugin| plugin.github_shorthand())
        .collect()
}

/// desired のうち未導入のもの。
fn missing_of(desired: &[String], installed: &[String]) -> Vec<String> {
    desired
        .iter()
        .filter(|source| !installed.contains(source))
        .cloned()
        .collect()
}

/// 導入済みのうち desired にないもの。
fn extras_of(desired: &[String], installed: &[String]) -> Vec<String> {
    installed
        .iter()
        .filter(|source| !desired.contains(source))
        .cloned()
        .collect()
}

fn run_herdr_capture(args: &[&str]) -> anyhow::Result<String> {
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

/// 進行状況を表示するため stdout/stderr を継承して実行する。
fn run_herdr_inherit(args: &[&str]) -> anyhow::Result<()> {
    style::info(&format!("実行: herdr {}", args.join(" ")));
    let status = Command::new("herdr")
        .args(args)
        .status()
        .context("herdr コマンドの実行に失敗しました")?;

    if !status.success() {
        bail!("herdr {} が失敗しました", args.join(" "));
    }
    Ok(())
}

#[cfg(test)]
#[path = "plugin.test.rs"]
mod tests;
