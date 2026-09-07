//! `mt herdr tab template create|apply|delete` の実装。
//!
//! - 対象タブは `HERDR_WORKSPACE_ID` + `HERDR_TAB_ID` 環境変数のみから解決し、推測しない。
//! - create は `layout.export` で単一タブを取得し、cwd / command / env を除いた
//!   タブテンプレートへ変換して `~/.config/mt/herdr/templates/tabs/<name>.json` に保存する。
//! - apply は検証・確認の後に対象タブを置換し、反映時 cwd の注入・active pane の復元を行う。
//! - delete は一覧選択・確認（default false）の後に JSON を削除する。

use std::io::IsTerminal;

use anyhow::{Context, bail};
use clap::Subcommand;

use crate::cli::style;
use crate::herdr::socket::{HerdrSocket, WireNode};
use crate::herdr::template::{
    TabTemplate, TabTemplateEntry, TemplateNode, delete_template, list_tab_templates,
    save_tab_template, validate_name,
};

#[derive(Subcommand)]
pub enum HerdrTabTemplateCommands {
    /// 実行中タブのペーン構成を名前付きタブテンプレートとして保存
    Create,
    /// タブテンプレートを実行中タブに反映（置換・cwd 注入・active pane 復元）
    Apply,
    /// 保存済みタブテンプレートを一覧から選択して削除
    Delete,
}

pub fn run(cmd: HerdrTabTemplateCommands) -> anyhow::Result<()> {
    match cmd {
        HerdrTabTemplateCommands::Create => create(),
        HerdrTabTemplateCommands::Apply => apply(),
        HerdrTabTemplateCommands::Delete => delete(),
    }
}

fn resolve_ids() -> anyhow::Result<(String, String)> {
    let workspace_id = match std::env::var("HERDR_WORKSPACE_ID") {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => bail!(
            "HERDR_WORKSPACE_ID 環境変数が未設定または空です。対象ワークスペース ID を指定してください（推測はしません）"
        ),
    };
    let tab_id = match std::env::var("HERDR_TAB_ID") {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => bail!(
            "HERDR_TAB_ID 環境変数が未設定または空です。対象タブ ID を指定してください（推測はしません）"
        ),
    };
    Ok((workspace_id, tab_id))
}

/// 対話が必要なコマンドの TTY ガード。非 TTY では実行せずエラーにする。
fn require_tty(command: &str) -> anyhow::Result<()> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        bail!(
            "mt herdr tab template {command} は対話が必要なため TTY 環境でのみ実行できます（非対話用引数や --yes はありません）"
        );
    }
    Ok(())
}

// ---- create ----

pub fn create() -> anyhow::Result<()> {
    style::intro("herdr タブテンプレート作成");
    let (workspace_id, tab_id) = resolve_ids()?;
    require_tty("create")?;

    let socket = HerdrSocket::resolve()?;
    let pong = socket.ensure_capabilities()?;
    style::info(&format!(
        "herdr v{} (protocol {}) に接続しました",
        pong.version, pong.protocol
    ));

    let template = export_tab(&socket, &workspace_id, &tab_id)?;
    style::info(&format!(
        "タブ {} をエクスポートしました（cwd / command / env は保存しません）",
        template.label
    ));

    let name: String = dialoguer::Input::new()
        .with_prompt("タブテンプレート名")
        .allow_empty(false)
        .interact_text()
        .context("タブテンプレート名の入力に失敗しました")?;
    let name = validate_name(&name)?;

    let path = save_tab_template(&template, &name)?;
    style::success(&format!(
        "タブテンプレート {name} を保存しました: {}",
        path.display()
    ));
    Ok(())
}

/// 単一タブをエクスポートしてタブテンプレート形式へ変換する（create の中核）。
/// active pane は tree path として記録する。
fn export_tab(
    socket: &HerdrSocket,
    workspace_id: &str,
    tab_id: &str,
) -> anyhow::Result<TabTemplate> {
    let tabs = socket.tab_list(workspace_id)?;
    let tab = tabs.iter().find(|t| t.tab_id == tab_id).with_context(|| {
        format!("タブ {tab_id} がワークスペース {workspace_id} に見つかりません（HERDR_TAB_ID を確認してください）")
    })?;
    let layout = socket.layout_export(workspace_id, tab_id)?;
    let template = TabTemplate {
        label: tab.label.clone(),
        root: TemplateNode::from_wire(&layout.root),
        active_pane_path: layout.root.pane_path(&layout.focused_pane_id),
    };
    template.validate()?;
    Ok(template)
}

// ---- apply ----

pub fn apply() -> anyhow::Result<()> {
    style::intro("herdr タブテンプレート反映");
    let (workspace_id, tab_id) = resolve_ids()?;
    require_tty("apply")?;

    let entries = list_tab_templates()?;
    let selection = select_template(&entries, "反映するタブテンプレートを選択")?;
    let entry = &entries[selection];
    entry
        .template
        .validate()
        .with_context(|| format!("タブテンプレート {} が不正です", entry.name))?;
    let template = entry.template.clone();

    let socket = HerdrSocket::resolve()?;
    let pong = socket.ensure_capabilities()?;
    style::info(&format!(
        "herdr v{} (protocol {}) に接続しました",
        pong.version, pong.protocol
    ));
    let tabs = socket.tab_list(&workspace_id)?;
    if !tabs.iter().any(|t| t.tab_id == tab_id) {
        bail!(
            "タブ {tab_id} がワークスペース {workspace_id} に見つかりません（HERDR_TAB_ID を確認してください）"
        );
    }

    // 反映時 cwd: 保存された cwd は存在しないものとして扱い、実行時 cwd を使う
    let cwd = std::env::current_dir().context("反映時 cwd を取得できません")?;
    let cwd_str = cwd.to_string_lossy().to_string();

    style::info(&format!("対象タブ: {tab_id}"));
    style::info(&format!(
        "タブテンプレート {name}: 全 pane に cwd {cwd_str} を設定",
        name = entry.name
    ));
    style::warn("反映により既存 pane の実行中プロセス・スクロールバック・PTY は失われます");
    style::warn("実行中の pane も置換対象のため、このプロセスは反映により終了します");
    if !request_confirmation("この内容で反映を実行しますか?")? {
        style::outro("中止しました");
        return Ok(());
    }

    let root = inject_cwd(&template.root, &cwd_str);
    let applied = socket
        .layout_apply_replace(&tab_id, &template.label, &root)
        .with_context(|| format!("タブ {tab_id} の反映に失敗しました"))?;
    if let Err(e) = restore_pane_focus(&socket, &workspace_id, &applied.tab_id, &template) {
        style::warn(&format!("active pane の復元に失敗しました: {e}"));
    }

    style::outro(&format!(
        "✅ タブテンプレート {} を反映しました",
        entry.name
    ));
    Ok(())
}

/// active pane を保存した tree path から新しい pane ID へ対応付けて focus する。
fn restore_pane_focus(
    socket: &HerdrSocket,
    workspace_id: &str,
    tab_id: &str,
    template: &TabTemplate,
) -> anyhow::Result<()> {
    let Some(path) = &template.active_pane_path else {
        return Ok(());
    };
    let layout = socket.layout_export(workspace_id, tab_id)?;
    match layout.root.pane_id_at_path(path) {
        Some(pane_id) => socket.pane_focus(&pane_id)?,
        None => {
            style::warn(&format!(
                "active pane の復元をスキップしました（path {path:?} が pane に解決しません）"
            ));
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
    style::intro("herdr タブテンプレート削除");
    // 対象タブの明示契約（推測しない）。タブテンプレート削除に herdr 接続は不要。
    let _ = resolve_ids()?;
    require_tty("delete")?;

    let entries = list_tab_templates()?;
    let selection = select_template(&entries, "削除するタブテンプレートを選択")?;
    let entry = &entries[selection];

    if !request_confirmation(&format!("タブテンプレート {} を削除しますか?", entry.name))?
    {
        style::outro("中止しました");
        return Ok(());
    }
    delete_template(&entry.path)?;
    style::success(&format!("タブテンプレート {} を削除しました", entry.name));
    Ok(())
}

// ---- 共通の対話ヘルパ ----

fn select_template(entries: &[TabTemplateEntry], prompt: &str) -> anyhow::Result<usize> {
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    dialoguer::Select::new()
        .with_prompt(prompt)
        .items(&names)
        .default(0)
        .interact()
        .context("タブテンプレートの選択に失敗しました")
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

    fn pane_wire(pane_id: &str, cwd: &str) -> serde_json::Value {
        json!({ "type": "pane", "pane_id": pane_id, "cwd": cwd })
    }

    #[test]
    fn test_export_tab_builds_template() {
        let mock = mock_socket(|request| match request_method(request).as_str() {
            "tab.list" => respond(
                request,
                json!({
                    "type": "tab_list",
                    "tabs": [
                        {"tab_id": "w1:t1", "workspace_id": "w1", "number": 1, "label": "main", "focused": true, "pane_count": 2, "agent_status": "unknown"},
                        {"tab_id": "w1:t2", "workspace_id": "w1", "number": 2, "label": "notes", "focused": false, "pane_count": 1, "agent_status": "unknown"}
                    ]
                }),
            ),
            "layout.export" => respond(
                request,
                json!({
                    "type": "layout_export",
                    "layout": {
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "zoomed": false,
                        "focused_pane_id": "w1:p2",
                        "root": {
                            "type": "split",
                            "direction": "right",
                            "ratio": 0.5,
                            "first": pane_wire("w1:p1", "/tmp/a"),
                            "second": {"type": "pane", "pane_id": "w1:p2", "cwd": "/tmp/b", "command": ["vim"], "label": "editor"}
                        }
                    }
                }),
            ),
            other => panic!("想定外の method: {other}"),
        });

        let template = export_tab(&mock.socket, "w1", "w1:t1").unwrap();
        assert_eq!(template.label, "main");
        assert_eq!(template.active_pane_path, Some(vec![1]));
        let TemplateNode::Split { first, second, .. } = &template.root else {
            panic!("split のはず");
        };
        assert_eq!(first.as_ref(), &TemplateNode::Pane { label: None });
        assert_eq!(
            second.as_ref(),
            &TemplateNode::Pane {
                label: Some("editor".to_string())
            }
        );
        template.validate().unwrap();
    }

    #[test]
    fn test_export_tab_missing_tab() {
        let mock = mock_socket(|request| match request_method(request).as_str() {
            "tab.list" => respond(
                request,
                json!({
                    "type": "tab_list",
                    "tabs": [
                        {"tab_id": "w1:t1", "workspace_id": "w1", "number": 1, "label": "main"}
                    ]
                }),
            ),
            other => panic!("想定外の method: {other}"),
        });

        let err = export_tab(&mock.socket, "w1", "w1:t9").unwrap_err();
        assert!(err.to_string().contains("HERDR_TAB_ID"), "{err}");
    }

    #[test]
    fn test_export_tab_missing_workspace() {
        let mock = mock_socket(|request| {
            json!({
                "id": request.get("id"),
                "error": {"code": "workspace_not_found", "message": "workspace w9 not found"}
            })
        });

        let err = export_tab(&mock.socket, "w9", "w9:t1").unwrap_err();
        let herdr_err = err
            .chain()
            .find_map(|cause| cause.downcast_ref::<HerdrError>());
        assert!(herdr_err.is_some(), "{err}");
    }

    #[test]
    fn test_inject_cwd_all_panes() {
        let root = TemplateNode::Split {
            direction: SplitDirection::Right,
            ratio: 0.5,
            first: Box::new(TemplateNode::Pane { label: None }),
            second: Box::new(TemplateNode::Pane {
                label: Some("editor".to_string()),
            }),
        };
        let wire = inject_cwd(&root, "/abs/cwd");
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

    #[test]
    fn test_restore_pane_focus_focuses_saved_path() {
        let mock = mock_socket(|request| match request_method(request).as_str() {
            "layout.export" => respond(
                request,
                json!({
                    "type": "layout_export",
                    "layout": {
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
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
                assert_eq!(pane_id, "w1:p9");
                respond(request, json!({ "type": "ok" }))
            }
            other => panic!("想定外の method: {other}"),
        });

        let template = TabTemplate {
            label: "main".to_string(),
            root: TemplateNode::Split {
                direction: SplitDirection::Right,
                ratio: 0.5,
                first: Box::new(TemplateNode::Pane { label: None }),
                second: Box::new(TemplateNode::Pane { label: None }),
            },
            active_pane_path: Some(vec![1]),
        };
        restore_pane_focus(&mock.socket, "w1", "w1:t1", &template).unwrap();
        let methods: Vec<String> = mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(request_method)
            .collect();
        assert_eq!(methods, vec!["layout.export", "pane.focus"]);
    }

    #[test]
    fn test_restore_pane_focus_skips_when_no_path() {
        let mock = mock_socket(|_request| panic!("呼ばれないはず"));
        let template = TabTemplate {
            label: "main".to_string(),
            root: TemplateNode::Pane { label: None },
            active_pane_path: None,
        };
        restore_pane_focus(&mock.socket, "w1", "w1:t1", &template).unwrap();
        assert!(mock.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn test_resolve_ids_from_env() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            std::env::set_var("HERDR_WORKSPACE_ID", " w1 ");
            std::env::set_var("HERDR_TAB_ID", " w1:t1 ");
        }
        assert_eq!(
            resolve_ids().unwrap(),
            ("w1".to_string(), "w1:t1".to_string())
        );
        unsafe {
            std::env::set_var("HERDR_WORKSPACE_ID", "");
        }
        assert!(resolve_ids().is_err());
        unsafe {
            std::env::set_var("HERDR_WORKSPACE_ID", "w1");
            std::env::remove_var("HERDR_TAB_ID");
        }
        let err = resolve_ids().unwrap_err();
        assert!(err.to_string().contains("HERDR_TAB_ID"), "{err}");
        unsafe {
            std::env::remove_var("HERDR_WORKSPACE_ID");
        }
    }
}
