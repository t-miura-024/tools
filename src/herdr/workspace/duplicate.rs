use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use dialoguer::Confirm;
use serde::Deserialize;

use crate::cli::style;
use crate::config;
use crate::git::common::{ensure_fzf_available, run_fzf};
use crate::git::repo::repo_discover::parse_repo_selection;
use crate::herdr::client;
use crate::herdr::socket::{HerdrSocket, WireNode};

#[derive(Deserialize)]
struct Snapshot {
    focused_workspace_id: Option<String>,
    workspaces: Vec<WorkspaceInfo>,
}

#[derive(Deserialize)]
struct WorkspaceInfo {
    workspace_id: String,
    label: String,
    active_tab_id: Option<String>,
}

pub fn duplicate(target: Option<String>) -> anyhow::Result<()> {
    style::intro("herdr ワークスペース複製");

    let socket = HerdrSocket::resolve()?;
    let pong = socket.ensure_capabilities()?;
    style::info(&format!(
        "herdr v{} (protocol {}) に接続しました",
        pong.version, pong.protocol
    ));

    let snapshot_value = client::api_snapshot()?;
    let snapshot: Snapshot =
        serde_json::from_value(snapshot_value).context("snapshot の解析に失敗しました")?;

    let source_ws_id = snapshot
        .focused_workspace_id
        .as_deref()
        .context("フォーカス中のワークスペースがありません")?
        .to_string();
    let source_ws = snapshot
        .workspaces
        .iter()
        .find(|w| w.workspace_id == source_ws_id)
        .context("フォーカス中ワークスペースが snapshot に見つかりません")?;

    // socket 経由でタブとレイアウトを取得（pane label を含む portable tree）
    let tabs = socket
        .tab_list(&source_ws_id)
        .with_context(|| format!("ワークスペース {source_ws_id} のタブ一覧を取得できません"))?;
    if tabs.is_empty() {
        bail!("複製元ワークスペースにタブがありません");
    }

    let mut layouts = Vec::with_capacity(tabs.len());
    for tab in &tabs {
        let layout = socket
            .layout_export(&source_ws_id, &tab.tab_id)
            .with_context(|| format!("タブ {} のレイアウト取得に失敗しました", tab.label))?;
        layouts.push(layout);
    }

    let source_root = find_source_root_from_layouts(&layouts)?;

    let target_dir = resolve_target_dir(target, &source_root)?;
    let target_label = target_dir
        .file_name()
        .and_then(|s| s.to_str())
        .context("複製先ディレクトリ名を取得できませんでした")?
        .to_string();

    // ---- 確認 ----
    let pane_count: usize = layouts.iter().map(|l| wire_pane_count(&l.root)).sum();

    style::info(&format!("複製元: {} ({})", source_ws.label, source_ws_id));
    style::info(&format!(
        "複製先: {} ({})",
        target_dir.display(),
        target_label
    ));
    style::info(&format!(
        "タブ {} 個 / ペーン {} 個を再構成します",
        tabs.len(),
        pane_count
    ));

    if !Confirm::new()
        .with_prompt("この内容で複製を実行しますか?")
        .default(false)
        .interact()
        .context("確認入力に失敗しました")?
    {
        style::outro("中止しました");
        return Ok(());
    }

    // ---- 複製実行 (layout.export/apply 方式) ----
    // 各タブの WireNode の cwd を写像しつつ label は保持する
    let mapped_roots: Vec<WireNode> = layouts
        .iter()
        .map(|l| map_cwd_in_wire(&l.root, &source_root, &target_dir))
        .collect();

    // active tab / pane の復元用
    let active_tab_index = source_ws
        .active_tab_id
        .as_deref()
        .and_then(|aid| tabs.iter().position(|t| t.tab_id == aid));
    let active_pane_path = active_tab_index
        .and_then(|idx| layouts.get(idx))
        .and_then(|l| l.root.pane_path(&l.focused_pane_id));

    let spinner = style::spinner("ワークスペースを作成中...");
    let first_cwd = wire_first_cwd(&mapped_roots[0])
        .unwrap_or_else(|| target_dir.to_string_lossy().to_string());
    let new_ws_id = client::workspace_create(&first_cwd, &target_label)?;

    // workspace_create が作った初期タブを取得
    let initial_tab_id = socket
        .workspace_active_tab(&new_ws_id)
        .context("作成したワークスペースのアクティブタブが取得できません")?;

    let mut recreated: Vec<String> = Vec::with_capacity(tabs.len());

    // 最初のタブは初期タブを置換する
    spinner.set_message(format!("タブ {} を再構成中...", tabs[0].label));
    let layout0 = socket
        .layout_apply_replace(&initial_tab_id, &tabs[0].label, &mapped_roots[0])
        .with_context(|| format!("タブ {} の再構成に失敗しました", tabs[0].label))?;
    recreated.push(layout0.tab_id);

    // 残りのタブを作成
    for (tab, mapped) in tabs.iter().skip(1).zip(mapped_roots.iter().skip(1)) {
        spinner.set_message(format!("タブ {} を作成中...", tab.label));
        let layout = socket
            .layout_apply_create(&new_ws_id, &tab.label, mapped)
            .with_context(|| format!("タブ {} の作成に失敗しました", tab.label))?;
        recreated.push(layout.tab_id);
    }

    // アクティブタブ・ペーンの復元
    if let Some(idx) = active_tab_index
        && let Some(new_active) = recreated.get(idx)
    {
        if let Err(e) = socket.tab_focus(new_active) {
            style::warn(&format!("active tab の復元に失敗しました: {e}"));
        } else if let Some(path) = &active_pane_path {
            // 新しいレイアウトから tree path に対応する pane_id を解決して focus
            match socket.layout_export(&new_ws_id, new_active) {
                Ok(new_layout) => match new_layout.root.pane_id_at_path(path) {
                    Some(pane_id) => {
                        if let Err(e) = socket.pane_focus(&pane_id) {
                            style::warn(&format!("active pane の復元に失敗しました: {e}"));
                        }
                    }
                    None => {
                        style::warn(&format!(
                            "active pane の復元をスキップしました（path {path:?} が pane に解決しません）"
                        ));
                    }
                },
                Err(e) => {
                    style::warn(&format!("active pane の解決に失敗しました: {e}"));
                }
            }
        }
    }

    spinner.finish_with_message("ワークスペースの複製が完了しました");
    style::outro(&format!(
        "✅ {} を作成し、フォーカスを移動しました: {}",
        target_label,
        target_dir.display()
    ));
    Ok(())
}

/// WireNode の cwd を複製先へ写像しつつ label を保持した新しい木を作る
fn map_cwd_in_wire(node: &WireNode, source_root: &Path, target_dir: &Path) -> WireNode {
    match node {
        WireNode::Pane {
            pane_id: _,
            cwd,
            command: _,
            env: _,
            label,
        } => WireNode::Pane {
            pane_id: None,
            cwd: cwd
                .as_deref()
                .map(|c| map_cwd(source_root, target_dir, c))
                .or_else(|| Some(target_dir.to_string_lossy().to_string())),
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
            first: Box::new(map_cwd_in_wire(first, source_root, target_dir)),
            second: Box::new(map_cwd_in_wire(second, source_root, target_dir)),
        },
    }
}

fn wire_first_cwd(node: &WireNode) -> Option<String> {
    match node {
        WireNode::Pane { cwd, .. } => cwd.clone(),
        WireNode::Split { first, second, .. } => {
            wire_first_cwd(first).or_else(|| wire_first_cwd(second))
        }
    }
}

fn wire_collect_cwds(node: &WireNode, out: &mut Vec<String>) {
    match node {
        WireNode::Pane { cwd: Some(c), .. } => out.push(c.clone()),
        WireNode::Pane { cwd: None, .. } => {}
        WireNode::Split { first, second, .. } => {
            wire_collect_cwds(first, out);
            wire_collect_cwds(second, out);
        }
    }
}

fn wire_pane_count(node: &WireNode) -> usize {
    match node {
        WireNode::Pane { .. } => 1,
        WireNode::Split { first, second, .. } => wire_pane_count(first) + wire_pane_count(second),
    }
}

/// layouts から pane cwd を使って git ルートを解決する
fn find_source_root_from_layouts(
    layouts: &[crate::herdr::socket::LayoutDescription],
) -> anyhow::Result<PathBuf> {
    for layout in layouts {
        let mut cwds = Vec::new();
        wire_collect_cwds(&layout.root, &mut cwds);
        // wire_first_cwd を優先しつつ、全 pane を走査して最初に見つかった git ルートを採用
        if let Some(cwd) = wire_first_cwd(&layout.root) {
            cwds.retain(|c| c != &cwd);
            cwds.insert(0, cwd);
        }
        for cwd in cwds {
            if let Some(root) = find_repo_root(Path::new(&cwd)) {
                return Ok(root);
            }
        }
    }
    bail!("複製元ワークスペースの git ルートを特定できませんでした");
}

/// ペーン cwd の git ルート（worktree or 通常 repo のトップ）を探す
fn find_repo_root(cwd: &Path) -> Option<PathBuf> {
    let mut dir = cwd.to_path_buf();
    loop {
        let git = dir.join(".git");
        if git.is_file() || git.is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// cwd を複製元ルート配下から複製先ルート配下へ写像する。
/// ルート配下以外の cwd（/tmp 以下など）はそのまま維持する。
fn map_cwd(source_root: &Path, target_root: &Path, cwd: &str) -> String {
    let path = Path::new(cwd);
    if let Ok(relative) = path.strip_prefix(source_root) {
        if relative.as_os_str().is_empty() {
            return target_root.to_string_lossy().to_string();
        }
        let joined = target_root.join(relative);
        joined.to_string_lossy().to_string()
    } else {
        cwd.to_string()
    }
}

/// fzf で複製先ディレクトリを選択する
fn resolve_target_dir(target: Option<String>, source_root: &Path) -> anyhow::Result<PathBuf> {
    if let Some(raw) = target {
        let path = PathBuf::from(raw);
        let canonical = fs::canonicalize(&path)
            .with_context(|| format!("指定された複製先 {} を解決できません", path.display()))?;
        if !canonical.is_dir() {
            bail!(
                "指定された複製先はディレクトリではありません: {}",
                canonical.display()
            );
        }
        if !is_worktree_root(&canonical) {
            bail!(
                "指定された複製先は linked worktree ではありません: {}",
                canonical.display()
            );
        }
        return Ok(canonical);
    }

    // 既に他のワークスペースで開いている worktree は除外対象にする
    let open_roots: HashSet<PathBuf> = client::worktree_list()?
        .into_iter()
        .filter(|w| w.open_workspace_id.is_some())
        .map(|w| PathBuf::from(w.path))
        .collect();

    let mut available: Vec<(String, String, String, String)> = Vec::new();
    for root in config::REPO_ROOTS {
        let base = config::home_dir().join(root);
        if !base.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&base)
            .with_context(|| format!("{} の読み取りに失敗しました", base.display()))?
        {
            let path = entry?.path();
            if !is_worktree_root(&path) {
                continue;
            }
            if path == source_root || open_roots.contains(&path) {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let branch = branch_of(&path);
            available.push((
                root.to_string(),
                name,
                branch,
                path.to_string_lossy().to_string(),
            ));
        }
    }

    available.sort_by(|a, b| a.1.cmp(&b.1));

    if available.is_empty() {
        bail!(
            "複製先の候補が見つかりません (~/doc, ~/src 配下の未使用 linked worktree がありません)"
        );
    }

    ensure_fzf_available()?;
    let input = format_rows(&available);
    let selected = run_fzf(
        input,
        &[
            "--ansi",
            "--delimiter",
            "\t",
            "--with-nth",
            "1,2,3",
            "--header-lines",
            "1",
            "--prompt",
            "duplicate target> ",
        ],
    )?;
    let path_str = parse_repo_selection(selected.trim_end())?;
    Ok(PathBuf::from(path_str))
}

/// fzf 選択行を作る（category / name / branch の3列 + \t + 絶対パス）
fn format_rows(rows: &[(String, String, String, String)]) -> String {
    let category_w = cols_width(rows, 0).max("category".len());
    let name_w = cols_width(rows, 1).max("name".len());
    let branch_w = cols_width(rows, 2).max("branch".len());

    let mut out = format!(
        "{:<cw$}  {:<nw$}  {:<bw$}\tpath\n",
        "category",
        "name",
        "branch",
        cw = category_w,
        nw = name_w,
        bw = branch_w
    );
    for (category, name, branch, path) in rows {
        out.push_str(&format!(
            "{:<cw$}  {:<nw$}  {:<bw$}\t{}\n",
            category,
            name,
            branch,
            path,
            cw = category_w,
            nw = name_w,
            bw = branch_w
        ));
    }
    out
}

fn cols_width(rows: &[(String, String, String, String)], idx: usize) -> usize {
    rows.iter()
        .map(|r| match idx {
            0 => r.0.len(),
            1 => r.1.len(),
            2 => r.2.len(),
            _ => 0,
        })
        .max()
        .unwrap_or(0)
}

fn is_worktree_root(dir: &Path) -> bool {
    dir.join(".git").is_file()
}

/// worktree の HEAD ブランチ名を取得する
fn branch_of(root: &Path) -> String {
    let gitdir = fs::read_to_string(root.join(".git")).ok().and_then(|s| {
        s.lines()
            .find_map(|l| l.strip_prefix("gitdir: "))
            .map(str::to_string)
    });
    let head = gitdir
        .map(|d| PathBuf::from(d).join("HEAD"))
        .unwrap_or_else(|| root.join(".git/HEAD"));
    fs::read_to_string(head)
        .ok()
        .map(|s| {
            let t = s.trim();
            t.strip_prefix("ref: refs/heads/")
                .map(str::to_string)
                .unwrap_or_else(|| t.chars().take(7).collect())
        })
        .unwrap_or_else(|| "?".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::socket::{SplitDirection, WireNode};

    fn pane(cwd: &str, label: Option<&str>) -> WireNode {
        WireNode::Pane {
            pane_id: None,
            cwd: Some(cwd.to_string()),
            command: None,
            env: None,
            label: label.map(|s| s.to_string()),
        }
    }

    #[test]
    fn test_map_cwd_in_wire_preserves_label_and_maps_cwd() {
        let source_root = Path::new("/src/tools-wt-1");
        let target_dir = Path::new("/src/tools-wt-2");
        let root = WireNode::Split {
            direction: SplitDirection::Right,
            ratio: 0.5,
            first: Box::new(pane("/src/tools-wt-1/src", Some("🐶AGENT"))),
            second: Box::new(WireNode::Split {
                direction: SplitDirection::Down,
                ratio: 0.3,
                first: Box::new(pane("/src/tools-wt-1", Some("🪐EDITOR"))),
                second: Box::new(pane("/tmp/other", None)),
            }),
        };

        let mapped = map_cwd_in_wire(&root, source_root, target_dir);
        match mapped {
            WireNode::Split { first, second, .. } => {
                match first.as_ref() {
                    WireNode::Pane { cwd, label, .. } => {
                        assert_eq!(cwd.as_deref(), Some("/src/tools-wt-2/src"));
                        assert_eq!(label.as_deref(), Some("🐶AGENT"));
                    }
                    _ => panic!("first は pane"),
                }
                match second.as_ref() {
                    WireNode::Split { first, second, .. } => {
                        match first.as_ref() {
                            WireNode::Pane { cwd, label, .. } => {
                                assert_eq!(cwd.as_deref(), Some("/src/tools-wt-2"));
                                assert_eq!(label.as_deref(), Some("🪐EDITOR"));
                            }
                            _ => panic!("second.first は pane"),
                        }
                        match second.as_ref() {
                            WireNode::Pane { cwd, label, .. } => {
                                // source_root 外はそのまま
                                assert_eq!(cwd.as_deref(), Some("/tmp/other"));
                                assert_eq!(label, &None);
                            }
                            _ => panic!("second.second は pane"),
                        }
                    }
                    _ => panic!("second は split"),
                }
            }
            _ => panic!("root は split"),
        }
    }

    #[test]
    fn test_wire_first_cwd_and_pane_count() {
        let root = WireNode::Split {
            direction: SplitDirection::Right,
            ratio: 0.5,
            first: Box::new(pane("/a", None)),
            second: Box::new(WireNode::Split {
                direction: SplitDirection::Down,
                ratio: 0.5,
                first: Box::new(pane("/b", None)),
                second: Box::new(pane("/c", None)),
            }),
        };
        assert_eq!(wire_first_cwd(&root).as_deref(), Some("/a"));
        assert_eq!(wire_pane_count(&root), 3);
    }

    #[test]
    fn test_map_cwd() {
        assert_eq!(
            map_cwd(Path::new("/src/a"), Path::new("/src/b"), "/src/a/foo/bar"),
            "/src/b/foo/bar"
        );
        assert_eq!(
            map_cwd(Path::new("/src/a"), Path::new("/src/b"), "/tmp/x"),
            "/tmp/x"
        );
    }
}
