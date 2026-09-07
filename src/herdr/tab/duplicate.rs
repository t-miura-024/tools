use std::io::IsTerminal;

use anyhow::{Context, bail};
use dialoguer::Confirm;

use crate::cli::style;
use crate::herdr::socket::{HerdrSocket, WireNode};

pub fn duplicate() -> anyhow::Result<()> {
    style::intro("herdr タブ複製");
    let (workspace_id, tab_id) = resolve_ids()?;
    require_tty()?;

    let socket = HerdrSocket::resolve()?;
    let pong = socket.ensure_capabilities()?;
    style::info(&format!(
        "herdr v{} (protocol {}) に接続しました",
        pong.version, pong.protocol
    ));

    let tabs = socket
        .tab_list(&workspace_id)
        .with_context(|| format!("ワークスペース {workspace_id} のタブ一覧を取得できません"))?;
    let source = tabs
        .iter()
        .find(|t| t.tab_id == tab_id)
        .with_context(|| {
            format!("タブ {tab_id} がワークスペース {workspace_id} に見つかりません（HERDR_TAB_ID を確認してください）")
        })?;
    let layout = socket
        .layout_export(&workspace_id, &tab_id)
        .with_context(|| format!("タブ {} のレイアウト取得に失敗しました", source.label))?;
    let pane_count = wire_pane_count(&layout.root);
    let portable = portable_copy(&layout.root);

    style::info(&format!("複製元: {} ({})", source.label, tab_id));
    style::info(&format!(
        "ペーン {pane_count} 個を同一ワークスペース内に再構成します"
    ));
    style::warn("複製先タブへフォーカスが移動します");
    if !Confirm::new()
        .with_prompt("この内容で複製を実行しますか?")
        .default(false)
        .interact()
        .context("確認入力に失敗しました")?
    {
        style::outro("中止しました");
        return Ok(());
    }

    let created = socket
        .layout_apply_create(&workspace_id, &source.label, &portable)
        .with_context(|| format!("タブ {} の複製に失敗しました", source.label))?;
    if let Err(e) = socket.tab_focus(&created.tab_id) {
        style::warn(&format!("複製先タブへのフォーカス移動に失敗しました: {e}"));
    }
    style::outro(&format!(
        "✅ タブ {} を複製しました: {}",
        source.label, created.tab_id
    ));
    Ok(())
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

fn require_tty() -> anyhow::Result<()> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        bail!(
            "mt herdr tab duplicate は対話が必要なため TTY 環境でのみ実行できます（非対話用引数や --yes はありません）"
        );
    }
    Ok(())
}

/// cwd・label を維持し、pane_id / command / env を除いた複製用 tree を作る。
fn portable_copy(node: &WireNode) -> WireNode {
    match node {
        WireNode::Pane { cwd, label, .. } => WireNode::Pane {
            pane_id: None,
            cwd: cwd.clone(),
            command: None,
            env: None,
            label: label.clone(),
        },
        WireNode::Split {
            direction,
            ratio,
            first,
            second,
        } => WireNode::Split {
            direction: *direction,
            ratio: *ratio,
            first: Box::new(portable_copy(first)),
            second: Box::new(portable_copy(second)),
        },
    }
}

fn wire_pane_count(node: &WireNode) -> usize {
    match node {
        WireNode::Pane { .. } => 1,
        WireNode::Split { first, second, .. } => wire_pane_count(first) + wire_pane_count(second),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::socket::SplitDirection;

    fn pane(cwd: &str, label: Option<&str>) -> WireNode {
        WireNode::Pane {
            pane_id: Some("w1:p1".to_string()),
            cwd: Some(cwd.to_string()),
            command: Some(vec!["vim".to_string()]),
            env: Some([("A".to_string(), "1".to_string())].into_iter().collect()),
            label: label.map(str::to_string),
        }
    }

    #[test]
    fn test_portable_copy_keeps_cwd_and_label_drops_execution_state() {
        let root = WireNode::Split {
            direction: SplitDirection::Right,
            ratio: 0.5,
            first: Box::new(pane("/tmp/a", Some("editor"))),
            second: Box::new(pane("/tmp/b", None)),
        };
        let copied = portable_copy(&root);
        let WireNode::Split { first, second, .. } = copied else {
            panic!("split のはず");
        };
        match (first.as_ref(), second.as_ref()) {
            (
                WireNode::Pane {
                    pane_id: None,
                    cwd: Some(a),
                    command: None,
                    env: None,
                    label: Some(l),
                },
                WireNode::Pane {
                    cwd: Some(b),
                    label: None,
                    ..
                },
            ) => {
                assert_eq!(a, "/tmp/a");
                assert_eq!(l, "editor");
                assert_eq!(b, "/tmp/b");
            }
            other => panic!("想定外のツリー: {other:?}"),
        }
        assert_eq!(wire_pane_count(&root), 2);
    }
}
