use std::fs;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;

use anyhow::{Context, bail};
use serde::Deserialize;

use crate::cli::style;

#[derive(Deserialize, Debug, PartialEq, Clone)]
pub struct PlanConfig {
    pub owner: String,
    #[serde(rename = "projectNumber")]
    pub project_number: u64,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "statusFieldId")]
    pub status_field_id: String,
    #[serde(rename = "statusOptions")]
    pub status_options: StatusOptions,
}

#[derive(Deserialize, Debug, PartialEq, Clone)]
pub struct StatusOptions {
    pub draft: String,
}

/// 今回作成した Issue の表示用情報。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedIssue {
    pub title: String,
    pub url: String,
}

/// 既存の open な `kind/plan` Issue の表示用情報。
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ExistingIssue {
    pub number: u64,
    pub title: String,
    pub url: String,
}

pub fn run() -> anyhow::Result<()> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        bail!("mt plan draft は TTY 環境でのみ実行できます（パイプやリダイレクト経由では実行できません）");
    }

    let config = load_config()?;

    // 認証チェックはフォーム入力に依存しないため、フォーム表示中に裏で先走りさせる。
    // 結果は mpsc チャンネル経由で TUI 側にポーリングされる。
    let auth_rx = spawn_gh_auth_check();

    // 起票（submit）は TUI 内のバックグラウンドスレッドで実行される。
    // TUI は終了時に今回セッションで作成した Issue 一覧を返す。
    let created = super::draft_tui::run_tui(config, auth_rx)?;

    if created.is_empty() {
        style::outro("キャンセルしました");
    } else {
        println!();
        style::success(&format!("🎉 {} 件の Issue を作成しました！", created.len()));
        for issue in &created {
            println!("     {}", issue.url);
        }
        println!();
    }

    Ok(())
}

/// 起票パイプライン全体（repo 検証・label 確保・Issue 作成・Project 追加/Status 設定）
/// を実行し、成功時は作成した Issue の URL を返す。
///
/// TUI のバックグラウンドスレッドから呼ばれることを想定し、イベントループを
/// ブロッキングしない。いずれかの段階で失敗した場合はエラーを返す（このとき
/// Issue が作成済みでも Project 設定失敗ならエラーとして扱われる）。
pub fn submit_draft(
    config: &PlanConfig,
    repo_path: &std::path::Path,
    title: &str,
    description: &str,
) -> anyhow::Result<String> {
    let (selected_owner, selected_name) = get_repo_owner_and_name(repo_path)?;
    let (target_repo, has_external_label) =
        determine_target(&selected_owner, &selected_name, &config.owner);

    // リポジトリ確認と label 作成は互いに独立しているため並列に実行し、
    // 任一の失敗で bail する。
    std::thread::scope(|s| -> anyhow::Result<()> {
        let repo_result = s.spawn(|| verify_repo_exists(&target_repo));
        let label_result = s.spawn(|| {
            ensure_labels(
                &target_repo,
                &selected_owner,
                &selected_name,
                has_external_label,
            )
        });
        let repo_result = repo_result.join().expect("リポジトリ確認スレッドが異常終了しました");
        let label_result = label_result.join().expect("label 作成スレッドが異常終了しました");
        repo_result?;
        label_result?;
        Ok(())
    })?;

    let external_label = if has_external_label {
        Some(format_external_label_name(&selected_owner, &selected_name))
    } else {
        None
    };
    let issue_url = create_issue(
        &target_repo,
        title,
        description,
        external_label.as_deref(),
    )?;

    add_to_project_and_set_status(config, &issue_url)
        .map_err(|e| anyhow::anyhow!("Project/Status の設定に失敗しました: {e}\nIssue URL: {issue_url}"))?;

    Ok(issue_url)
}

/// 選択リポジトリに対応する target repo の open な `kind/plan` Issue を取得する。
///
/// external repo の場合は external label でも絞り込み、当前 repo スコープの
/// Issue のみを返す。TUI のバックグラウンド fetch から呼ばれる。
pub fn fetch_existing_for_repo(
    repo_path: &std::path::Path,
    config_owner: &str,
) -> anyhow::Result<Vec<ExistingIssue>> {
    let (selected_owner, selected_name) = get_repo_owner_and_name(repo_path)?;
    let (target_repo, has_external_label) =
        determine_target(&selected_owner, &selected_name, config_owner);
    let external_label = if has_external_label {
        Some(format_external_label_name(&selected_owner, &selected_name))
    } else {
        None
    };
    fetch_existing_issues(&target_repo, external_label.as_deref())
}

/// 指定 repo の open な `kind/plan` Issue を `gh issue list` で取得する。
/// `extra_label` が指定された場合は AND 条件で追加絞り込みする。
fn fetch_existing_issues(repo: &str, extra_label: Option<&str>) -> anyhow::Result<Vec<ExistingIssue>> {
    let mut args = vec![
        "issue",
        "list",
        "--repo",
        repo,
        "--label",
        "kind/plan",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,url",
    ];
    if let Some(label) = extra_label {
        args.push("--label");
        args.push(label);
    }

    let output = Command::new("gh")
        .args(&args)
        .output()
        .context("gh issue list の実行に失敗しました")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("既存 Issue の取得に失敗しました: {}", stderr.trim());
    }

    let issues: Vec<ExistingIssue> = serde_json::from_slice(&output.stdout)
        .context("gh issue list の出力を解析できませんでした")?;
    Ok(issues)
}

pub fn determine_target(
    selected_owner: &str,
    selected_name: &str,
    config_owner: &str,
) -> (String, bool) {
    if selected_owner == config_owner {
        (format!("{selected_owner}/{selected_name}"), false)
    } else {
        (format!("{config_owner}/note"), true)
    }
}

pub fn parse_config_from_str(json: &str) -> anyhow::Result<PlanConfig> {
    serde_json::from_str(json).context("設定のパースに失敗しました")
}

pub fn load_config() -> anyhow::Result<PlanConfig> {
    let config_path = dirs_config().join("mt-plan").join("config.json");
    let content = fs::read_to_string(&config_path).with_context(|| {
        format!(
            "設定ファイルが見つかりません: {}\n  mt-plan init を実行して設定を初期化してください",
            config_path.display()
        )
    })?;
    parse_config_from_str(&content)
}

fn dirs_config() -> PathBuf {
    match std::env::var("HOME") {
        Ok(home) => PathBuf::from(home).join(".config"),
        Err(_) => {
            let home = dirs_fallback_home();
            PathBuf::from(home).join(".config")
        }
    }
}

fn dirs_fallback_home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/Users/mt".to_string())
}

fn verify_repo_exists(repo: &str) -> anyhow::Result<()> {
    let status = Command::new("gh")
        .args(["repo", "view", repo])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("gh repo view の実行に失敗しました")?;

    if !status.success() {
        bail!("リポジトリ '{repo}' が見つからないか、アクセス権がありません");
    }
    Ok(())
}

fn check_gh_auth() -> anyhow::Result<()> {
    let status = Command::new("gh")
        .args(["auth", "status"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("gh コマンドの実行に失敗しました")?;

    if !status.success() {
        bail!("gh CLI が認証されていません。\n  gh auth login を実行してください");
    }
    Ok(())
}

/// `check_gh_auth` をバックグラウンドスレッドで起動し、結果の Receiver を返す。
///
/// 送信値は `true` = 認証成功、`false` = 認証失敗。gh コマンドの責務は
/// このモジュール内に閉じ、TUI 側はチャンネル結果のみを受け取る。
fn spawn_gh_auth_check() -> mpsc::Receiver<bool> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let authenticated = check_gh_auth().is_ok();
        let _ = tx.send(authenticated);
    });
    rx
}

pub fn get_repo_owner_and_name(repo_path: &std::path::Path) -> anyhow::Result<(String, String)> {
    let output = Command::new("git")
        .args(["-C"])
        .arg(repo_path)
        .args(["remote", "get-url", "origin"])
        .output()
        .context("git remote get-url origin の実行に失敗しました")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "git remote get-url origin が失敗しました: {}",
            stderr.trim()
        );
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_github_repo_url(&url)
        .with_context(|| format!("リモート URL から owner/name を解析できませんでした: {url}"))
}

pub fn parse_github_repo_url(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }

    if let Some(rest) = url.strip_prefix("git@github.com:") {
        let rest = rest.strip_suffix(".git").unwrap_or(rest);
        let mut parts = rest.splitn(2, '/');
        let owner = parts.next()?.to_string();
        let name = parts.next()?.to_string();
        if owner.is_empty() || name.is_empty() {
            return None;
        }
        return Some((owner, name));
    }

    if let Some(rest) = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
    {
        let rest = rest.strip_suffix(".git").unwrap_or(rest);
        let rest = rest.trim_end_matches('/');
        let mut parts = rest.splitn(2, '/');
        let owner = parts.next()?.to_string();
        let name = parts.next()?.to_string();
        if owner.is_empty() || name.is_empty() {
            return None;
        }
        return Some((owner, name));
    }

    None
}

pub fn format_external_label_name(selected_owner: &str, selected_name: &str) -> String {
    format!("external/{selected_owner}-{selected_name}")
}

fn ensure_labels(
    target_repo: &str,
    selected_owner: &str,
    selected_name: &str,
    has_external_label: bool,
) -> anyhow::Result<()> {
    ensure_label(
        target_repo,
        "kind/plan",
        "0E8A16",
        "mt-plan で管理する計画 Issue",
    )?;

    if has_external_label {
        let label_name = format_external_label_name(selected_owner, selected_name);
        ensure_label(
            target_repo,
            &label_name,
            "BFD4F2",
            &format!("External repo: {selected_owner}/{selected_name}"),
        )?;
    }

    Ok(())
}

fn ensure_label(repo: &str, name: &str, color: &str, description: &str) -> anyhow::Result<()> {
    let status = Command::new("gh")
        .args([
            "label",
            "create",
            name,
            "--repo",
            repo,
            "--color",
            color,
            "--description",
            description,
            "--force",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context(format!("label '{name}' の作成に失敗しました"))?;

    if !status.success() {
        bail!("label '{name}' の作成に失敗しました");
    }

    Ok(())
}

fn create_issue(
    repo: &str,
    title: &str,
    body: &str,
    extra_label: Option<&str>,
) -> anyhow::Result<String> {
    let mut args = vec![
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        title,
        "--body",
        body,
        "--label",
        "kind/plan",
    ];

    if let Some(label) = extra_label {
        args.push("--label");
        args.push(label);
    }

    let output = Command::new("gh")
        .args(&args)
        .output()
        .context("gh issue create の実行に失敗しました")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Issue の作成に失敗しました: {}", stderr.trim());
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        bail!("Issue の作成結果から URL を取得できませんでした");
    }

    Ok(url)
}

fn add_to_project_and_set_status(config: &PlanConfig, issue_url: &str) -> anyhow::Result<()> {
    let item_output = Command::new("gh")
        .args([
            "project",
            "item-add",
            &config.project_number.to_string(),
            "--owner",
            &config.owner,
            "--url",
            issue_url,
            "--format",
            "json",
        ])
        .output()
        .context("gh project item-add の実行に失敗しました")?;

    if !item_output.status.success() {
        let stderr = String::from_utf8_lossy(&item_output.stderr);
        bail!("Project への追加に失敗しました: {}", stderr.trim());
    }

    #[derive(Deserialize)]
    struct ItemAddOutput {
        id: String,
    }

    let item: ItemAddOutput = serde_json::from_slice(&item_output.stdout)
        .context("Project item-add の出力を解析できませんでした")?;

    let status = Command::new("gh")
        .args([
            "project",
            "item-edit",
            "--project-id",
            &config.project_id,
            "--id",
            &item.id,
            "--field-id",
            &config.status_field_id,
            "--single-select-option-id",
            &config.status_options.draft,
        ])
        .status()
        .context("gh project item-edit の実行に失敗しました")?;

    if !status.success() {
        bail!("Status の設定に失敗しました");
    }

    Ok(())
}

#[cfg(test)]
#[path = "draft.test.rs"]
mod tests;
