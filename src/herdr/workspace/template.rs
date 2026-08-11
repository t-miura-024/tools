//! `mt herdr workspace template create|apply|delete` の実装。
//!
//! - 対象ワークスペースは `HERDR_WORKSPACE_ID` 環境変数のみから解決し、推測しない。
//! - create は `layout.export` で全タブを取得し、cwd / command / env を除いた
//!   テンプレートへ変換して `~/.config/mt/herdr/templates/<name>.json` に保存する。
//! - apply は検証・確認の後に既存タブの置換・不足タブの作成・余剰タブの削除・
//!   反映時 cwd の注入・active tab / pane の復元を順次実行する（途中失敗はロールバックしない）。
//! - delete は一覧選択・確認（default false）の後に JSON を削除する。

use std::io::IsTerminal;

use anyhow::{Context, bail};
use clap::Subcommand;

use crate::cli::style;
use crate::herdr::socket::{HerdrSocket, TabInfo, WireNode};
use crate::herdr::template::{
    Template, TemplateEntry, TemplateNode, TemplateTab, delete_template, list_templates,
    save_template, validate_name,
};

#[derive(Subcommand)]
pub enum HerdrWorkspaceTemplateCommands {
    /// ワークスペースのタブ・ペーン構成を名前付きテンプレートとして保存
    Create,
    /// テンプレートをワークスペースに反映（既存タブを置換・不足タブは作成・余剰タブは削除）
    Apply,
    /// 保存済みテンプレートを一覧から選択して削除
    Delete,
}

pub fn run(cmd: HerdrWorkspaceTemplateCommands) -> anyhow::Result<()> {
    match cmd {
        HerdrWorkspaceTemplateCommands::Create => create(),
        HerdrWorkspaceTemplateCommands::Apply => apply(),
        HerdrWorkspaceTemplateCommands::Delete => delete(),
    }
}

fn resolve_workspace_id() -> anyhow::Result<String> {
    match std::env::var("HERDR_WORKSPACE_ID") {
        Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        _ => bail!(
            "HERDR_WORKSPACE_ID 環境変数が未設定または空です。対象ワークスペース ID を指定してください（推測はしません）"
        ),
    }
}

/// 対話が必要なコマンドの TTY ガード。非 TTY では実行せずエラーにする。
fn require_tty(command: &str) -> anyhow::Result<()> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        bail!(
            "mt herdr workspace template {command} は対話が必要なため TTY 環境でのみ実行できます（非対話用引数や --yes はありません）"
        );
    }
    Ok(())
}

// ---- create ----

pub fn create() -> anyhow::Result<()> {
    style::intro("herdr ワークスペーステンプレート作成");
    let workspace_id = resolve_workspace_id()?;
    require_tty("create")?;

    let socket = HerdrSocket::resolve()?;
    let pong = socket.ensure_capabilities()?;
    style::info(&format!(
        "herdr v{} (protocol {}) に接続しました",
        pong.version, pong.protocol
    ));

    let template = export_workspace(&socket, &workspace_id)?;
    style::info(&format!(
        "タブ {} 個をエクスポートしました（cwd / command / env は保存しません）",
        template.tabs.len()
    ));

    let name: String = dialoguer::Input::new()
        .with_prompt("テンプレート名")
        .allow_empty(false)
        .interact_text()
        .context("テンプレート名の入力に失敗しました")?;
    let name = validate_name(&name)?;

    let path = save_template(&template, &name)?;
    style::success(&format!(
        "テンプレート {name} を保存しました: {}",
        path.display()
    ));
    Ok(())
}

/// ワークスペースの全タブをエクスポートしてテンプレート形式へ変換する（create の中核）。
/// active tab / active pane は tree path として記録する。
fn export_workspace(socket: &HerdrSocket, workspace_id: &str) -> anyhow::Result<Template> {
    let active_tab_id = socket.workspace_active_tab(workspace_id).with_context(|| {
        format!("ワークスペース {workspace_id} が見つかりません（HERDR_WORKSPACE_ID を確認してください）")
    })?;
    let tabs = socket.tab_list(workspace_id)?;
    if tabs.is_empty() {
        bail!("ワークスペース {workspace_id} にタブがありません");
    }

    let mut template_tabs = Vec::with_capacity(tabs.len());
    let mut active_pane_path = None;
    for tab in &tabs {
        let layout = socket.layout_export(workspace_id, &tab.tab_id)?;
        if tab.tab_id == active_tab_id {
            active_pane_path = layout.root.pane_path(&layout.focused_pane_id);
        }
        template_tabs.push(TemplateTab {
            label: tab.label.clone(),
            root: TemplateNode::from_wire(&layout.root),
        });
    }

    let active_tab_index = tabs
        .iter()
        .position(|t| t.tab_id == active_tab_id)
        .context("active tab がタブ一覧に見つかりません")?;
    let template = Template {
        tabs: template_tabs,
        active_tab_index,
        active_pane_path,
    };
    template.validate()?;
    Ok(template)
}

// ---- apply ----

pub fn apply() -> anyhow::Result<()> {
    style::intro("herdr ワークスペーステンプレート反映");
    let workspace_id = resolve_workspace_id()?;
    require_tty("apply")?;

    // 実行中の pane が対象ワークスペース内にある場合、反映の最後に自分のタブを
    // 置換・削除する（途中でプロセスが終了して残りの反映が止まらないようにする）。
    let self_tab_id = running_pane_tab_id(&workspace_id);

    let entries = list_templates()?;
    let selection = select_template(&entries, "反映するテンプレートを選択")?;
    let entry = &entries[selection];
    entry
        .template
        .validate()
        .with_context(|| format!("テンプレート {} が不正です", entry.name))?;
    let template = entry.template.clone();

    let socket = HerdrSocket::resolve()?;
    let pong = socket.ensure_capabilities()?;
    style::info(&format!(
        "herdr v{} (protocol {}) に接続しました",
        pong.version, pong.protocol
    ));
    socket.workspace_active_tab(&workspace_id).with_context(|| {
        format!("ワークスペース {workspace_id} が見つかりません（HERDR_WORKSPACE_ID を確認してください）")
    })?;

    // 反映時 cwd: 保存された cwd は存在しないものとして扱い、実行時 cwd を使う
    let cwd = std::env::current_dir().context("反映時 cwd を取得できません")?;
    let cwd_str = cwd.to_string_lossy().to_string();

    let existing_tabs = socket.tab_list(&workspace_id)?;
    let missing = template.tabs.len().saturating_sub(existing_tabs.len());
    let surplus = existing_tabs.len().saturating_sub(template.tabs.len());
    style::info(&format!("対象ワークスペース: {workspace_id}"));
    style::info(&format!(
        "テンプレート {name}: タブ {count} 個（不足 {missing} / 余剰 {surplus} / 全 pane に cwd {cwd_str} を設定）",
        name = entry.name,
        count = template.tabs.len()
    ));
    style::warn("反映により既存 pane の実行中プロセス・スクロールバック・PTY は失われます");
    if let Some(tab_id) = &self_tab_id {
        style::warn(&format!(
            "実行中の pane（タブ {tab_id}）も置換対象のため、このプロセスは反映の最後に終了します"
        ));
    }
    if !request_confirmation("この内容で反映を実行しますか?")? {
        style::outro("中止しました");
        return Ok(());
    }

    let applied = apply_layouts(
        &socket,
        &workspace_id,
        &template,
        &cwd_str,
        &existing_tabs,
        self_tab_id.as_deref(),
    )?;
    match close_surplus(
        &socket,
        &existing_tabs,
        template.tabs.len(),
        self_tab_id.as_deref(),
    ) {
        Ok(_) => {}
        Err(e) => bail!("{e}（反映済み: {} タブ）", applied.len()),
    }
    if let Err(e) = restore_focus(&socket, &workspace_id, &template, &applied) {
        style::warn(&format!("active tab / pane の復元に失敗しました: {e}"));
    }

    style::outro(&format!(
        "✅ テンプレート {} を反映しました（タブ {} 個）",
        entry.name,
        applied.len()
    ));
    Ok(())
}

/// 実行中の pane が対象ワークスペース内にある場合、その pane のタブ ID を返す。
/// herdr は pane 内プロセスに HERDR_ENV=1 / HERDR_WORKSPACE_ID / HERDR_TAB_ID を注入するため、
/// これらが対象ワークスペースと一致するかで判定する。
fn running_pane_tab_id(workspace_id: &str) -> Option<String> {
    if std::env::var("HERDR_ENV").as_deref() != Ok("1") {
        return None;
    }
    let env_ws = std::env::var("HERDR_WORKSPACE_ID").ok()?;
    if env_ws.trim() != workspace_id {
        return None;
    }
    std::env::var("HERDR_TAB_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// テンプレートを正として既存タブを同順で置換し、不足分は新規作成する。
/// 途中失敗はロールバックせず、適用済み件数付きのエラーを返す。
/// `last_tab_id` が指定された場合、そのタブの置換を最後に実行する
/// （実行中 pane が置換されてプロセスが終了しても、他の反映が完了済みになるように）。
fn apply_layouts(
    socket: &HerdrSocket,
    workspace_id: &str,
    template: &Template,
    cwd: &str,
    existing_tabs: &[TabInfo],
    last_tab_id: Option<&str>,
) -> anyhow::Result<Vec<String>> {
    let mut applied = Vec::with_capacity(template.tabs.len());
    let mut order: Vec<usize> = (0..template.tabs.len()).collect();
    if let Some(last) = last_tab_id
        && let Some(pos) = existing_tabs.iter().position(|t| t.tab_id == last)
    {
        order.retain(|&i| i != pos);
        order.push(pos);
    }
    for i in order {
        let tab = &template.tabs[i];
        let root = inject_cwd(&tab.root, cwd);
        let result = match existing_tabs.get(i) {
            Some(existing) => socket.layout_apply_replace(&existing.tab_id, &root),
            None => socket.layout_apply_create(workspace_id, &tab.label, &root),
        };
        match result {
            Ok(layout) => applied.push(layout.tab_id),
            Err(e) => bail!(
                "タブ {}（{}）の反映に失敗しました: {e}（適用済み: {} タブ）",
                i + 1,
                tab.label,
                applied.len()
            ),
        }
    }
    Ok(applied)
}

/// テンプレートより多い余剰タブを閉じる。
/// `last_tab_id` が指定された場合、そのタブを最後に閉じる。
fn close_surplus(
    socket: &HerdrSocket,
    existing_tabs: &[TabInfo],
    keep: usize,
    last_tab_id: Option<&str>,
) -> anyhow::Result<()> {
    let mut extras: Vec<&TabInfo> = existing_tabs.iter().skip(keep).collect();
    if let Some(last) = last_tab_id {
        extras.sort_by_key(|t| if t.tab_id == last { 1 } else { 0 });
    }
    for extra in extras {
        socket
            .tab_close(&extra.tab_id)
            .with_context(|| format!("余剰タブ {} を閉じるのに失敗しました", extra.tab_id))?;
    }
    Ok(())
}

/// active tab を focus し、active pane を保存した tree path から新しい pane ID へ
/// 対応付けて focus する。
fn restore_focus(
    socket: &HerdrSocket,
    workspace_id: &str,
    template: &Template,
    applied_tab_ids: &[String],
) -> anyhow::Result<()> {
    let tab_id = applied_tab_ids
        .get(template.active_tab_index)
        .with_context(|| {
            format!(
                "active_tab_index {} に対応する反映後のタブがありません",
                template.active_tab_index
            )
        })?;
    socket.tab_focus(tab_id)?;
    if let Some(path) = &template.active_pane_path {
        let layout = socket.layout_export(workspace_id, tab_id)?;
        match layout.root.pane_id_at_path(path) {
            Some(pane_id) => socket.pane_focus(&pane_id)?,
            None => {
                style::warn(&format!(
                    "active pane の復元をスキップしました（path {path:?} が pane に解決しません）"
                ));
            }
        }
    }
    Ok(())
}

/// 全 pane ノードに反映時 cwd を注入した wire tree を作る。pane_id / command / env は送らない。
fn inject_cwd(node: &TemplateNode, cwd: &str) -> WireNode {
    match node {
        TemplateNode::Pane { label } => WireNode::Pane {
            pane_id: None,
            cwd: Some(cwd.to_string()),
            command: None,
            env: None,
            label: label.clone(),
        },
        TemplateNode::Split {
            direction,
            ratio,
            first,
            second,
        } => WireNode::Split {
            direction: *direction,
            ratio: *ratio,
            first: Box::new(inject_cwd(first, cwd)),
            second: Box::new(inject_cwd(second, cwd)),
        },
    }
}

// ---- delete ----

pub fn delete() -> anyhow::Result<()> {
    style::intro("herdr ワークスペーステンプレート削除");
    // 対象ワークスペースの明示契約（推測しない）。テンプレート削除に herdr 接続は不要。
    let _ = resolve_workspace_id()?;
    require_tty("delete")?;

    let entries = list_templates()?;
    let selection = select_template(&entries, "削除するテンプレートを選択")?;
    let entry = &entries[selection];

    if !request_confirmation(&format!("テンプレート {} を削除しますか?", entry.name))?
    {
        style::outro("中止しました");
        return Ok(());
    }
    delete_template(&entry.path)?;
    style::success(&format!("テンプレート {} を削除しました", entry.name));
    Ok(())
}

// ---- 共通の対話ヘルパ ----

fn select_template(entries: &[TemplateEntry], prompt: &str) -> anyhow::Result<usize> {
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    dialoguer::Select::new()
        .with_prompt(prompt)
        .items(&names)
        .default(0)
        .interact()
        .context("テンプレートの選択に失敗しました")
}

fn request_confirmation(prompt: &str) -> anyhow::Result<bool> {
    dialoguer::Confirm::new()
        .with_prompt(prompt)
        .default(false)
        .interact()
        .context("確認入力に失敗しました")
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::herdr::socket::{HerdrError, SplitDirection};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// モック herdr サーバーを立て、リクエスト記録と socket を返す（test_support 参照）。
    fn mock_socket(
        handler: impl Fn(&serde_json::Value) -> serde_json::Value + Send + Sync + 'static,
    ) -> crate::test_support::MockHerdr {
        crate::test_support::MockHerdr::start(handler)
    }

    fn request_method(request: &serde_json::Value) -> String {
        request
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    fn respond(request: &serde_json::Value, result: serde_json::Value) -> serde_json::Value {
        json!({ "id": request.get("id"), "result": result })
    }

    fn valid_template() -> Template {
        Template {
            tabs: vec![
                TemplateTab {
                    label: "work".to_string(),
                    root: TemplateNode::Split {
                        direction: SplitDirection::Right,
                        ratio: 0.5,
                        first: Box::new(TemplateNode::Pane { label: None }),
                        second: Box::new(TemplateNode::Pane {
                            label: Some("editor".to_string()),
                        }),
                    },
                },
                TemplateTab {
                    label: "shell".to_string(),
                    root: TemplateNode::Pane { label: None },
                },
            ],
            active_tab_index: 0,
            active_pane_path: Some(vec![1]),
        }
    }

    fn tab(tab_id: &str, workspace_id: &str, number: u32, label: &str) -> TabInfo {
        TabInfo {
            tab_id: tab_id.to_string(),
            workspace_id: workspace_id.to_string(),
            number,
            label: label.to_string(),
        }
    }

    fn pane_wire(pane_id: &str, cwd: &str) -> serde_json::Value {
        json!({ "type": "pane", "pane_id": pane_id, "cwd": cwd })
    }

    // ---- create ----

    #[test]
    fn test_export_workspace_builds_template() {
        let mock = mock_socket(|request| match request_method(request).as_str() {
            "workspace.get" => respond(
                request,
                json!({
                    "type": "workspace_info",
                    "workspace": {
                        "workspace_id": "w1",
                        "number": 1,
                        "label": "test",
                        "focused": true,
                        "pane_count": 3,
                        "tab_count": 2,
                        "active_tab_id": "w1:t1",
                        "agent_status": "unknown"
                    }
                }),
            ),
            "tab.list" => respond(
                request,
                json!({
                    "type": "tab_list",
                    "tabs": [
                        {"tab_id": "w1:t1", "workspace_id": "w1", "number": 1, "label": "main", "focused": false, "pane_count": 2, "agent_status": "unknown"},
                        {"tab_id": "w1:t2", "workspace_id": "w1", "number": 2, "label": "notes", "focused": false, "pane_count": 1, "agent_status": "unknown"}
                    ]
                }),
            ),
            "layout.export" => {
                let tab_id = request
                    .get("params")
                    .and_then(|p| p.get("tab_id"))
                    .and_then(|v| v.as_str())
                    .unwrap()
                    .to_string();
                let (root, focused) = if tab_id == "w1:t1" {
                    (
                        json!({
                            "type": "split",
                            "direction": "right",
                            "ratio": 0.5,
                            "first": pane_wire("w1:p1", "/tmp/a"),
                            "second": {"type": "pane", "pane_id": "w1:p2", "cwd": "/tmp/b", "command": ["vim"], "label": "editor"}
                        }),
                        "w1:p2",
                    )
                } else {
                    (pane_wire("w1:p3", "/tmp/c"), "w1:p3")
                };
                respond(
                    request,
                    json!({
                        "type": "layout_export",
                        "layout": {
                            "workspace_id": "w1",
                            "tab_id": tab_id,
                            "zoomed": false,
                            "focused_pane_id": focused,
                            "root": root
                        }
                    }),
                )
            }
            other => panic!("想定外の method: {other}"),
        });

        let template = export_workspace(&mock.socket, "w1").unwrap();
        assert_eq!(template.tabs.len(), 2);
        assert_eq!(template.tabs[0].label, "main");
        assert_eq!(template.tabs[1].label, "notes");
        assert_eq!(template.active_tab_index, 0);
        assert_eq!(template.active_pane_path, Some(vec![1]));

        // active pane は左側 first の pane ではなく second の pane を指す
        let TemplateNode::Split { first, second, .. } = &template.tabs[0].root else {
            panic!("split のはず");
        };
        assert_eq!(first.as_ref(), &TemplateNode::Pane { label: None });
        assert_eq!(
            second.as_ref(),
            &TemplateNode::Pane {
                label: Some("editor".to_string())
            }
        );
        assert_eq!(template.tabs[1].root, TemplateNode::Pane { label: None });
        template.validate().unwrap();
    }

    #[test]
    fn test_export_workspace_missing_workspace() {
        let mock = mock_socket(|request| {
            json!({
                "id": request.get("id"),
                "error": {"code": "workspace_not_found", "message": "workspace w9 not found"}
            })
        });

        let err = export_workspace(&mock.socket, "w9").unwrap_err();
        let herdr_err = err
            .chain()
            .find_map(|cause| cause.downcast_ref::<HerdrError>());
        assert!(herdr_err.is_some(), "{err}");
        assert!(err.to_string().contains("HERDR_WORKSPACE_ID"), "{err}");
    }

    // ---- apply ----

    #[test]
    fn test_apply_layouts_replaces_existing_and_creates_missing() {
        let existing = vec![tab("w1:t1", "w1", 1, "a"), tab("w1:t2", "w1", 2, "b")];
        let template = Template {
            tabs: vec![
                TemplateTab {
                    label: "x".to_string(),
                    root: TemplateNode::Pane { label: None },
                },
                TemplateTab {
                    label: "y".to_string(),
                    root: TemplateNode::Split {
                        direction: SplitDirection::Down,
                        ratio: 0.3,
                        first: Box::new(TemplateNode::Pane { label: None }),
                        second: Box::new(TemplateNode::Pane { label: None }),
                    },
                },
                TemplateTab {
                    label: "z".to_string(),
                    root: TemplateNode::Pane { label: None },
                },
            ],
            active_tab_index: 0,
            active_pane_path: Some(vec![]),
        };

        let mock = mock_socket(|request| {
            assert_eq!(request_method(request), "layout.apply");
            let params = request.get("params").unwrap();
            let tab_id = params
                .get("tab_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let label = params.get("tab_label").unwrap().as_str().unwrap();
                    format!("w1:new-{label}")
                });
            respond(
                request,
                json!({
                    "type": "layout_apply",
                    "layout": {
                        "workspace_id": "w1",
                        "tab_id": tab_id,
                        "zoomed": false,
                        "focused_pane_id": "w1:p9",
                        "root": {"type": "pane", "pane_id": "w1:p9", "cwd": "/cwd"}
                    }
                }),
            )
        });

        let cwd = std::env::current_dir().unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let applied =
            apply_layouts(&mock.socket, "w1", &template, &cwd_str, &existing, None).unwrap();
        assert_eq!(applied, vec!["w1:t1", "w1:t2", "w1:new-z"]);

        // 1・2 番目は tab_id 指定の置換、3 番目は tab_label 指定の新規作成
        let requests = mock.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[0].get("params").unwrap().get("tab_id").unwrap(),
            "w1:t1"
        );
        assert_eq!(
            requests[0].get("params").unwrap().get("workspace_id"),
            None,
            "置換時は workspace_id を送らない"
        );
        assert_eq!(
            requests[1].get("params").unwrap().get("tab_id").unwrap(),
            "w1:t2"
        );
        assert_eq!(requests[1].get("params").unwrap().get("workspace_id"), None);
        assert_eq!(requests[1].get("params").unwrap().get("tab_label"), None);
        let third = requests[2].get("params").unwrap();
        assert_eq!(third.get("tab_id"), None);
        assert_eq!(third.get("tab_label").unwrap(), "z");

        // 全 pane ノードに cwd が注入され、command / env / pane_id は送られない
        // （x と z は単一 pane、y は split ツリー）
        let first_root = requests[0].get("params").unwrap().get("root").unwrap();
        assert_eq!(first_root.get("type").unwrap(), "pane");
        assert_eq!(first_root.get("cwd").unwrap(), &cwd_str);
        assert_eq!(first_root.get("command"), None);
        assert_eq!(first_root.get("env"), None);
        assert_eq!(first_root.get("pane_id"), None);

        let second_root = requests[1].get("params").unwrap().get("root").unwrap();
        assert_eq!(second_root.get("type").unwrap(), "split");
        let first = second_root.get("first").unwrap();
        let second = second_root.get("second").unwrap();
        assert_eq!(first.get("cwd").unwrap(), &cwd_str);
        assert_eq!(second.get("cwd").unwrap(), &cwd_str);
        assert_eq!(first.get("command"), None);
        assert_eq!(first.get("env"), None);
        assert_eq!(first.get("pane_id"), None);

        let third_root = requests[2].get("params").unwrap().get("root").unwrap();
        assert_eq!(third_root.get("type").unwrap(), "pane");
        assert_eq!(third_root.get("cwd").unwrap(), &cwd_str);
    }

    #[test]
    fn test_apply_layouts_partial_failure_reports_applied_count() {
        let existing = vec![tab("w1:t1", "w1", 1, "a"), tab("w1:t2", "w1", 2, "b")];
        let template = Template {
            tabs: vec![
                TemplateTab {
                    label: "x".to_string(),
                    root: TemplateNode::Pane { label: None },
                },
                TemplateTab {
                    label: "y".to_string(),
                    root: TemplateNode::Pane { label: None },
                },
                TemplateTab {
                    label: "z".to_string(),
                    root: TemplateNode::Pane { label: None },
                },
            ],
            active_tab_index: 0,
            active_pane_path: None,
        };

        let applied_count = std::sync::atomic::AtomicUsize::new(0);
        let mock = mock_socket(move |request| {
            let n = applied_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 2 {
                json!({
                    "id": request.get("id"),
                    "error": {"code": "layout_not_found", "message": "layout target not found"}
                })
            } else {
                respond(
                    request,
                    json!({
                        "type": "layout_apply",
                        "layout": {
                            "workspace_id": "w1",
                            "tab_id": format!("w1:t{}", n + 1),
                            "zoomed": false,
                            "focused_pane_id": "p",
                            "root": {"type": "pane", "pane_id": "p"}
                        }
                    }),
                )
            }
        });

        let cwd = "/cwd";
        let err = apply_layouts(&mock.socket, "w1", &template, cwd, &existing, None).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("タブ 3"), "失敗位置が含まれるべき: {msg}");
        assert!(
            msg.contains("適用済み: 2"),
            "適用済み件数が含まれるべき: {msg}"
        );
    }

    #[test]
    fn test_close_surplus_closes_extras_only() {
        let existing = vec![
            tab("w1:t1", "w1", 1, "a"),
            tab("w1:t2", "w1", 2, "b"),
            tab("w1:t3", "w1", 3, "c"),
            tab("w1:t4", "w1", 4, "d"),
        ];
        let mock = mock_socket(|request| {
            assert_eq!(request_method(request), "tab.close");
            let tab_id = request
                .get("params")
                .unwrap()
                .get("tab_id")
                .unwrap()
                .as_str()
                .unwrap()
                .to_string();
            assert!(tab_id == "w1:t3" || tab_id == "w1:t4", "{tab_id}");
            respond(request, json!({ "type": "ok" }))
        });

        close_surplus(&mock.socket, &existing, 2, None).unwrap();
        let closed: Vec<String> = mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| {
                r.get("params")
                    .unwrap()
                    .get("tab_id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(closed, vec!["w1:t3", "w1:t4"]);
    }

    #[test]
    fn test_restore_focus_focuses_active_tab_and_pane() {
        let mock = mock_socket(|request| match request_method(request).as_str() {
            "tab.focus" => {
                let tab_id = request
                    .get("params")
                    .unwrap()
                    .get("tab_id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string();
                assert_eq!(tab_id, "w1:t9");
                respond(request, json!({ "type": "ok" }))
            }
            "layout.export" => respond(
                request,
                json!({
                    "type": "layout_export",
                    "layout": {
                        "workspace_id": "w1",
                        "tab_id": "w1:t9",
                        "zoomed": false,
                        "focused_pane_id": "w1:p9",
                        "root": {
                            "type": "split",
                            "direction": "right",
                            "ratio": 0.5,
                            "first": {"type": "pane", "pane_id": "w1:p8"},
                            "second": {"type": "pane", "pane_id": "w1:p9"}
                        }
                    }
                }),
            ),
            "pane.focus" => {
                let pane_id = request
                    .get("params")
                    .unwrap()
                    .get("pane_id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string();
                assert_eq!(
                    pane_id, "w1:p9",
                    "保存した tree path [1] が新しい pane ID に対応する"
                );
                respond(request, json!({ "type": "ok" }))
            }
            other => panic!("想定外の method: {other}"),
        });

        let template = valid_template();
        restore_focus(&mock.socket, "w1", &template, &["w1:t9".to_string()]).unwrap();

        let methods: Vec<String> = mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(request_method)
            .collect();
        assert_eq!(methods, vec!["tab.focus", "layout.export", "pane.focus"]);
    }

    #[test]
    fn test_restore_focus_skips_pane_when_path_does_not_resolve() {
        let mock = mock_socket(|request| match request_method(request).as_str() {
            "tab.focus" => respond(request, json!({ "type": "ok" })),
            "layout.export" => respond(
                request,
                json!({
                    "type": "layout_export",
                    "layout": {
                        "workspace_id": "w1",
                        "tab_id": "w1:t9",
                        "zoomed": false,
                        "focused_pane_id": "w1:p9",
                        "root": {"type": "pane", "pane_id": "w1:p9"}
                    }
                }),
            ),
            other => panic!("想定外の method: {other}"),
        });

        let mut template = valid_template();
        template.active_pane_path = Some(vec![0, 1]);
        restore_focus(&mock.socket, "w1", &template, &["w1:t9".to_string()]).unwrap();

        let methods: Vec<String> = mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(request_method)
            .collect();
        assert_eq!(
            methods,
            vec!["tab.focus", "layout.export"],
            "pane.focus は呼ばれない"
        );
    }

    #[test]
    fn test_inject_cwd_all_panes() {
        let template = valid_template();
        let wire = inject_cwd(&template.tabs[0].root, "/abs/cwd");
        let WireNode::Split { first, second, .. } = wire else {
            panic!("split のはず");
        };
        match (first.as_ref(), second.as_ref()) {
            (
                WireNode::Pane {
                    cwd: Some(a),
                    command: None,
                    env: None,
                    pane_id: None,
                    ..
                },
                WireNode::Pane {
                    cwd: Some(b),
                    label: Some(l),
                    ..
                },
            ) => {
                assert_eq!(a, "/abs/cwd");
                assert_eq!(b, "/abs/cwd");
                assert_eq!(l, "editor");
            }
            other => panic!("想定外のツリー: {other:?}"),
        }
    }

    // ---- resolve_workspace_id ----

    #[test]
    fn test_resolve_workspace_id_from_env() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            std::env::set_var("HERDR_WORKSPACE_ID", " w1 ");
        }
        assert_eq!(resolve_workspace_id().unwrap(), "w1");
        unsafe {
            std::env::set_var("HERDR_WORKSPACE_ID", "");
        }
        assert!(resolve_workspace_id().is_err());
        unsafe {
            std::env::remove_var("HERDR_WORKSPACE_ID");
        }
        let err = resolve_workspace_id().unwrap_err();
        assert!(err.to_string().contains("HERDR_WORKSPACE_ID"), "{err}");
    }

    // ---- running_pane_tab_id ----

    #[test]
    fn test_running_pane_tab_id_detects_self_in_target_workspace() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            std::env::set_var("HERDR_ENV", "1");
            std::env::set_var("HERDR_WORKSPACE_ID", "w1");
            std::env::set_var("HERDR_TAB_ID", "w1:t2");
        }
        assert_eq!(running_pane_tab_id("w1").as_deref(), Some("w1:t2"));

        // 対象ワークスペースが異なる場合は検出しない
        assert_eq!(running_pane_tab_id("w2"), None);

        // pane 外（HERDR_ENV なし）では検出しない
        unsafe {
            std::env::remove_var("HERDR_ENV");
        }
        assert_eq!(running_pane_tab_id("w1"), None);

        // タブ ID が未設定の場合も検出しない
        unsafe {
            std::env::set_var("HERDR_ENV", "1");
            std::env::remove_var("HERDR_TAB_ID");
        }
        assert_eq!(running_pane_tab_id("w1"), None);

        unsafe {
            std::env::remove_var("HERDR_ENV");
            std::env::remove_var("HERDR_WORKSPACE_ID");
        }
    }

    #[test]
    fn test_apply_layouts_replaces_self_tab_last() {
        let existing = vec![tab("w1:t1", "w1", 1, "a"), tab("w1:t2", "w1", 2, "b")];
        let template = Template {
            tabs: vec![
                TemplateTab {
                    label: "x".to_string(),
                    root: TemplateNode::Pane { label: None },
                },
                TemplateTab {
                    label: "y".to_string(),
                    root: TemplateNode::Pane { label: None },
                },
            ],
            active_tab_index: 0,
            active_pane_path: None,
        };

        let mock = mock_socket(|request| {
            assert_eq!(request_method(request), "layout.apply");
            let params = request.get("params").unwrap();
            let tab_id = params
                .get("tab_id")
                .and_then(|v| v.as_str())
                .unwrap_or("new");
            respond(
                request,
                json!({
                    "type": "layout_apply",
                    "layout": {
                        "workspace_id": "w1",
                        "tab_id": format!("w1:new-{tab_id}"),
                        "zoomed": false,
                        "focused_pane_id": "p",
                        "root": {"type": "pane", "pane_id": "p"}
                    }
                }),
            )
        });

        // 自分が w1:t1 にいる場合、置換順序は t2 → t1 になる
        let cwd = "/cwd";
        let applied =
            apply_layouts(&mock.socket, "w1", &template, cwd, &existing, Some("w1:t1")).unwrap();
        assert_eq!(applied, vec!["w1:new-w1:t2", "w1:new-w1:t1"]);

        let requests = mock.requests.lock().unwrap();
        let ids: Vec<String> = requests
            .iter()
            .map(|r| {
                r.get("params")
                    .unwrap()
                    .get("tab_id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(ids, vec!["w1:t2", "w1:t1"]);
    }

    #[test]
    fn test_close_surplus_closes_self_tab_last() {
        let existing = vec![
            tab("w1:t1", "w1", 1, "a"),
            tab("w1:t2", "w1", 2, "b"),
            tab("w1:t3", "w1", 3, "c"),
        ];
        let mock = mock_socket(|request| {
            assert_eq!(request_method(request), "tab.close");
            respond(request, json!({ "type": "ok" }))
        });

        // 自分が余剰タブ w1:t3 にいる場合、t2 → t3 の順で閉じる
        close_surplus(&mock.socket, &existing, 1, Some("w1:t3")).unwrap();
        let closed: Vec<String> = mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| {
                r.get("params")
                    .unwrap()
                    .get("tab_id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(closed, vec!["w1:t2", "w1:t3"]);
    }
}
