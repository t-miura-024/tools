use std::collections::{HashMap, HashSet};
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

#[derive(Deserialize)]
struct Snapshot {
    focused_workspace_id: Option<String>,
    workspaces: Vec<WorkspaceInfo>,
    tabs: Vec<TabInfo>,
    panes: Vec<PaneInfo>,
    layouts: Vec<TabLayout>,
}

#[derive(Deserialize)]
struct WorkspaceInfo {
    workspace_id: String,
    label: String,
    active_tab_id: Option<String>,
}

#[derive(Deserialize)]
struct TabInfo {
    tab_id: String,
    workspace_id: String,
    label: String,
    number: u32,
}

#[derive(Deserialize)]
struct PaneInfo {
    pane_id: String,
    workspace_id: String,
    tab_id: String,
    cwd: String,
}

#[derive(Deserialize)]
struct TabLayout {
    workspace_id: String,
    tab_id: String,
    area: Rect,
    panes: Vec<LayoutPane>,
    splits: Vec<SplitInfo>,
}

#[derive(Deserialize)]
struct LayoutPane {
    pane_id: String,
    rect: Rect,
}

#[derive(Deserialize)]
struct SplitInfo {
    id: String,
    direction: String,
    ratio: f64,
    rect: Rect,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
struct Rect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl Rect {
    fn contains(&self, x: u32, y: u32) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }

    /// other を完全に包含するか（辺が一致する場合を含む）
    fn encloses(&self, other: &Rect) -> bool {
        self.x <= other.x
            && self.y <= other.y
            && self.x + self.width >= other.x + other.width
            && self.y + self.height >= other.y + other.height
    }

    fn intersects(&self, other: &Rect) -> bool {
        self.x < other.x + other.width
            && other.x < self.x + self.width
            && self.y < other.y + other.height
            && other.y < self.y + self.height
    }
}

pub fn duplicate(target: Option<String>) -> anyhow::Result<()> {
    style::intro("herdr ワークスペース複製");

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

    let source_root = find_source_root(&snapshot, &source_ws_id)?;

    let target_dir = resolve_target_dir(target, &source_root)?;
    let target_label = target_dir
        .file_name()
        .and_then(|s| s.to_str())
        .context("複製先ディレクトリ名を取得できませんでした")?
        .to_string();

    // ---- 確認 ----
    let mut source_tabs = snapshot
        .tabs
        .iter()
        .filter(|t| t.workspace_id == source_ws_id)
        .collect::<Vec<_>>();
    source_tabs.sort_by_key(|t| t.number);
    let source_pane_count = snapshot
        .panes
        .iter()
        .filter(|p| p.workspace_id == source_ws_id)
        .count();

    style::info(&format!("複製元: {} ({})", source_ws.label, source_ws_id));
    style::info(&format!(
        "複製先: {} ({})",
        target_dir.display(),
        target_label
    ));
    style::info(&format!(
        "タブ {} 個 / ペーン {} 個を再構成します",
        source_tabs.len(),
        source_pane_count
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

    // ---- 複製実行 ----
    let first_tab = source_tabs.first().context("複製元にタブがありません")?;
    let first_layout = source_layout(&snapshot, &first_tab.tab_id)
        .context("最初のタブのレイアウトが見つかりません")?;
    let first_root_cwd = map_cwd(
        &source_root,
        &target_dir,
        &pane_cwd_at(first_layout, &snapshot, &first_layout.area)?,
    );

    let spinner = style::spinner("ワークスペースを作成中...");
    let new_ws_id = client::workspace_create(&first_root_cwd, &target_label)?;

    // 最初のタブは workspace create が自動作成したものを利用する
    let initial = initial_tab_state(&new_ws_id)?;
    let mut recreated: Vec<String> = vec![initial.tab_id.clone()];

    // 最初のタブのラベルを複製元にあわせてリネームし、分割を再構成
    client::tab_rename(&initial.tab_id, &first_tab.label)?;
    rebuild_splits_in_tab(
        &initial.root_pane_id,
        first_layout,
        &snapshot,
        &source_root,
        &target_dir,
    )?;

    // 残りのタブを作成し、同じく分割を再構成
    for tab in source_tabs.iter().skip(1) {
        let layout =
            source_layout(&snapshot, &tab.tab_id).context("タブのレイアウトが見つかりません")?;
        let tab_cwd = map_cwd(
            &source_root,
            &target_dir,
            &pane_cwd_at(layout, &snapshot, &layout.area)?,
        );
        spinner.set_message(format!("タブ {} を作成中...", tab.label));
        let (tab_id, root_pane_id) = client::tab_create(&new_ws_id, &tab_cwd, &tab.label)?;
        rebuild_splits_in_tab(&root_pane_id, layout, &snapshot, &source_root, &target_dir)?;
        recreated.push(tab_id);
    }

    // アクティブタブの復元
    if let Some(active_tab_id) = &source_ws.active_tab_id
        && let Some(idx) = source_tabs.iter().position(|t| &t.tab_id == active_tab_id)
        && let Some(new_active) = recreated.get(idx)
    {
        client::tab_focus(new_active)?;
    }

    spinner.finish_with_message("ワークスペースの複製が完了しました");
    style::outro(&format!(
        "✅ {} を作成し、フォーカスを移動しました: {}",
        target_label,
        target_dir.display()
    ));
    Ok(())
}

fn source_layout<'a>(snapshot: &'a Snapshot, tab_id: &str) -> Option<&'a TabLayout> {
    snapshot.layouts.iter().find(|l| l.tab_id == tab_id)
}

/// 複製元ワークスペースの git ルート（worktree / repo のトップ）を解決する
fn find_source_root(snapshot: &Snapshot, source_ws_id: &str) -> anyhow::Result<PathBuf> {
    let cwd = snapshot
        .panes
        .iter()
        .find(|p| p.workspace_id == source_ws_id)
        .map(|p| p.cwd.clone())
        .context("複製元ワークスペースの cwd が取得できません")?;

    find_repo_root(Path::new(&cwd))
        .with_context(|| format!("{} から git ルートを特定できませんでした", cwd))
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

/// 最初のタブ（workspace の root pane）の情報
struct InitialTabState {
    tab_id: String,
    root_pane_id: String,
}

fn initial_tab_state(workspace_id: &str) -> anyhow::Result<InitialTabState> {
    let snapshot_value = client::api_snapshot()?;
    let snapshot: Snapshot =
        serde_json::from_value(snapshot_value).context("snapshot の再取得に失敗しました")?;

    let ws = snapshot
        .workspaces
        .iter()
        .find(|w| w.workspace_id == workspace_id)
        .context("作成したワークスペースが snapshot に見つかりません")?;
    let tab_id = ws
        .active_tab_id
        .clone()
        .context("作成したワークスペースのアクティブタブがありません")?;

    let root_pane_id = snapshot
        .layouts
        .iter()
        .find(|l| l.workspace_id == workspace_id && l.tab_id == tab_id)
        .and_then(|l| l.panes.first())
        .map(|p| p.pane_id.clone())
        .context("作成したワークスペースのルートペーンが見つかりません")?;

    Ok(InitialTabState {
        tab_id,
        root_pane_id,
    })
}

/// レイアウト内の指定矩形の最左上座標を覆うペーンの cwd を取得する
fn pane_cwd_at(layout: &TabLayout, snapshot: &Snapshot, point: &Rect) -> anyhow::Result<String> {
    let target = find_pane_covering(layout, point.x, point.y)
        .context("領域を覆うペーンがレイアウトに見つかりません")?;
    snapshot
        .panes
        .iter()
        .find(|p| p.tab_id == layout.tab_id && p.pane_id == target.pane_id)
        .map(|p| p.cwd.clone())
        .context("ペーンの cwd が見つかりません")
}

fn find_pane_covering(layout: &TabLayout, x: u32, y: u32) -> Option<&LayoutPane> {
    layout.panes.iter().find(|p| p.rect.contains(x, y))
}

/// cwd を複製元ルート配下から複製先ルート配下へ写像する。
/// ルート配下以外の cwd（/tmp 以下など）はそのまま維持する。
fn map_cwd(source_root: &Path, target_root: &Path, cwd: &str) -> String {
    let path = Path::new(cwd);
    if let Ok(relative) = path.strip_prefix(source_root) {
        let joined = target_root.join(relative);
        joined.to_string_lossy().to_string()
    } else {
        cwd.to_string()
    }
}

/// split ツリーを再構成する
fn rebuild_splits_in_tab(
    root_pane_id: &str,
    layout: &TabLayout,
    snapshot: &Snapshot,
    source_root: &Path,
    target_dir: &Path,
) -> anyhow::Result<()> {
    if layout.splits.is_empty() {
        return Ok(());
    }

    let cwd_map: HashMap<&str, &str> = snapshot
        .panes
        .iter()
        .filter(|p| p.tab_id == layout.tab_id)
        .map(|p| (p.pane_id.as_str(), p.cwd.as_str()))
        .collect();

    let root = find_root_split(layout).context("split ツリーのルートが見つかりません")?;

    apply_split_tree(
        root_pane_id,
        root,
        layout,
        &cwd_map,
        source_root,
        target_dir,
    )
}

/// ルート split（どの split にも含まれない最大領域の split）を探す
fn find_root_split(layout: &TabLayout) -> Option<&SplitInfo> {
    layout.splits.iter().find(|s| {
        !layout
            .splits
            .iter()
            .any(|o| o.id != s.id && o.rect.encloses(&s.rect))
    })
}

#[allow(clippy::too_many_arguments)]
fn apply_split_tree(
    pane_id: &str,
    node: &SplitInfo,
    layout: &TabLayout,
    cwd_map: &HashMap<&str, &str>,
    source_root: &Path,
    target_dir: &Path,
) -> anyhow::Result<()> {
    match node.direction.as_str() {
        "right" | "down" => {}
        other => bail!("未知の分割方向: {other}"),
    }

    // 新ペーン (1 - ratio 側) の領域の最左上を覆う元ペーンの cwd を使う
    let new_region = split_new_region(node);
    let new_cwd_src = region_pane_cwd(layout, cwd_map, &new_region)
        .context("分割後の新ペーンの cwd を特定できませんでした")?;
    let new_cwd = map_cwd(source_root, target_dir, &new_cwd_src);

    // 分割実行（元ペインは ratio の割合を保持する）
    let new_pane_id = client::pane_split(pane_id, &node.direction, node.ratio, &new_cwd)?;

    // 子 split（この split の領域内に含まれる次の階層の split）
    let orig_region = split_original_region(node);
    for child in direct_children(layout, node) {
        let target_pane = if orig_region.intersects(&child.rect) {
            pane_id.to_string()
        } else {
            new_pane_id.clone()
        };
        apply_split_tree(
            &target_pane,
            child,
            layout,
            cwd_map,
            source_root,
            target_dir,
        )?;
    }

    Ok(())
}

/// node の分割で「新ペイン」が占める領域（right: 右側 / down: 下側）
fn split_new_region(node: &SplitInfo) -> Rect {
    match node.direction.as_str() {
        "right" => {
            let keep = (node.rect.width as f64 * node.ratio).round() as u32;
            Rect {
                x: node.rect.x + keep,
                y: node.rect.y,
                width: node.rect.width - keep,
                height: node.rect.height,
            }
        }
        "down" => {
            let keep = (node.rect.height as f64 * node.ratio).round() as u32;
            Rect {
                x: node.rect.x,
                y: node.rect.y + keep,
                width: node.rect.width,
                height: node.rect.height - keep,
            }
        }
        _ => node.rect,
    }
}

/// node の分割で「元ペイン」が保持する領域（ratio 側）
fn split_original_region(node: &SplitInfo) -> Rect {
    match node.direction.as_str() {
        "right" => {
            let keep = (node.rect.width as f64 * node.ratio).round() as u32;
            Rect {
                x: node.rect.x,
                y: node.rect.y,
                width: keep,
                height: node.rect.height,
            }
        }
        "down" => {
            let keep = (node.rect.height as f64 * node.ratio).round() as u32;
            Rect {
                x: node.rect.x,
                y: node.rect.y,
                width: node.rect.width,
                height: keep,
            }
        }
        _ => node.rect,
    }
}

/// node の領域内に含まれる「直接の子」split 一覧
/// （node より真に小さく、かつ他の split の領域にも含まれないもの）
fn direct_children<'a>(layout: &'a TabLayout, node: &'a SplitInfo) -> Vec<&'a SplitInfo> {
    layout
        .splits
        .iter()
        .filter(|s| {
            s.id != node.id
                && node.rect.encloses(&s.rect)
                && s.rect != node.rect
                && !layout.splits.iter().any(|o| {
                    o.id != node.id
                        && o.id != s.id
                        && o.rect.encloses(&s.rect)
                        && node.rect.encloses(&o.rect)
                        && o.rect != node.rect
                })
        })
        .collect()
}

/// 領域の最左上の属するペーンの cwd を探す
fn region_pane_cwd(
    layout: &TabLayout,
    cwd_map: &HashMap<&str, &str>,
    region: &Rect,
) -> Option<String> {
    let pane = find_pane_covering(layout, region.x, region.y)?;
    cwd_map.get(pane.pane_id.as_str()).map(|s| s.to_string())
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
