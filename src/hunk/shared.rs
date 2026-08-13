//! hunk サブコマンド群の共有基盤。
//!
//! `.hunk/` ディレクトリ管理、`hunk-review.json` の読み書き、
//! hunk live セッションの検出（`hunk session get --repo`）、
//! コメントの適用・取得（`hunk session comment *`）、ゲート判定を含む。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// .hunk/ ディレクトリ & hunk-review.json
// ---------------------------------------------------------------------------

/// `hunk-review.json` のスキーマ。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewState {
    /// 適用済みコメント（comment apply 形式）。status 表示用のスナップショット。
    pub comments: Vec<serde_json::Value>,
}

/// Git リポジトリルートを返す。
pub fn git_repo_root() -> anyhow::Result<PathBuf> {
    git_repo_root_in(&std::env::current_dir()?)
}

/// 指定ディレクトリを起点に Git リポジトリルートを返す。
pub fn git_repo_root_in(cwd: &Path) -> anyhow::Result<PathBuf> {
    let output = crate::git::common::command_with_clean_git_context("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .context("git の実行に失敗しました")?;

    if !output.status.success() {
        bail!("Git リポジトリのルートが見つかりません。Git リポジトリ内で実行してください");
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(PathBuf::from(root))
}

/// `.hunk/` ディレクトリのパスを返す。
pub fn hunk_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".hunk")
}

/// `hunk-review.json` のパスを返す。
pub fn review_state_path(repo_root: &Path) -> PathBuf {
    hunk_dir(repo_root).join("hunk-review.json")
}

/// `.hunk/` ディレクトリを idempotent に作成する。
pub fn ensure_hunk_dir(repo_root: &Path) -> anyhow::Result<()> {
    let dir = hunk_dir(repo_root);
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .with_context(|| format!("{} の作成に失敗しました", dir.display()))?;
    }

    // `.hunk/` 配下を git 管理対象外にするための自己 .gitignore を生成する。
    // 外部リポジトリの .gitignore 設定に依存せず、ディレクトリ内で完結させる。
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, "*\n")
            .with_context(|| format!("{} の作成に失敗しました", gitignore.display()))?;
    }
    Ok(())
}

/// `hunk-review.json` を読み込む。存在しなければ `None`。
pub fn read_review_state(repo_root: &Path) -> Option<ReviewState> {
    let path = review_state_path(repo_root);
    if !path.exists() {
        return None;
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// `hunk-review.json` を書き込む。
pub fn write_review_state(repo_root: &Path, state: &ReviewState) -> anyhow::Result<()> {
    ensure_hunk_dir(repo_root)?;
    let path = review_state_path(repo_root);
    let json = serde_json::to_string_pretty(state).context("ReviewState のシリアライズに失敗")?;
    fs::write(&path, json + "\n")
        .with_context(|| format!("{} の書き込みに失敗しました", path.display()))?;
    Ok(())
}

/// `hunk-review.json` を削除する。
pub fn delete_review_state(repo_root: &Path) {
    let path = review_state_path(repo_root);
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
}

// ---------------------------------------------------------------------------
// hunk live セッション検出（方針 2）
// ---------------------------------------------------------------------------

/// `hunk session get --repo --json` のレスポンス。
#[derive(Debug, Deserialize)]
pub struct SessionGetResponse {
    pub session: SessionInfo,
}

/// hunk セッション情報。
#[derive(Debug, Deserialize)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

/// リポジトリに対応するアクティブな hunk セッションを検出する。
///
/// セッションがなければエラーを返す（stale state の検出に使う）。
pub fn find_session(repo_root: &Path) -> anyhow::Result<SessionInfo> {
    let output = crate::git::common::command_with_clean_git_context("hunk")
        .args(["session", "get", "--repo"])
        .arg(repo_root.as_os_str())
        .arg("--json")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("hunk session get の実行に失敗しました")?;

    if !output.status.success() {
        bail!(
            "アクティブな hunk セッションが見つかりません。リポジトリで hunk diff / hunk show を起動してください"
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: SessionGetResponse = serde_json::from_str(stdout.trim())
        .context("hunk session get の出力をパースできませんでした")?;
    Ok(parsed.session)
}

// ---------------------------------------------------------------------------
// コメント適用・取得（方針 3, 5）
// ---------------------------------------------------------------------------

/// コメントを `hunk session comment apply --stdin` で適用する。
///
/// `comments` は apply 形式（`{filePath, newLine|oldLine, summary}`）の JSON 配列。
pub fn apply_comments(repo_root: &Path, comments: &[serde_json::Value]) -> anyhow::Result<()> {
    use std::io::Write;
    use std::process::Stdio;

    let payload = serde_json::json!({ "comments": comments });
    let mut child = crate::git::common::command_with_clean_git_context("hunk")
        .args(["session", "comment", "apply", "--repo"])
        .arg(repo_root.as_os_str())
        .args(["--stdin", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("hunk session comment apply の起動に失敗しました")?;

    child
        .stdin
        .take()
        .context("hunk の stdin を開けませんでした")?
        .write_all(payload.to_string().as_bytes())
        .context("hunk へのコメント書き込みに失敗しました")?;

    let output = child
        .wait_with_output()
        .context("hunk session comment apply の実行に失敗しました")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "hunk session comment apply が失敗しました: {}",
            stderr.trim()
        );
    }
    Ok(())
}

/// `hunk session comment list --type all --json` のレスポンス。
#[derive(Debug, Deserialize)]
pub struct CommentListResponse {
    pub comments: Vec<HunkComment>,
}

/// hunk のインラインコメント。
#[derive(Debug, Clone, Deserialize)]
pub struct HunkComment {
    #[serde(rename = "noteId")]
    pub note_id: String,
    /// コメントの出所（"agent" = AI 適用, "user" = 人間）
    pub source: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub body: String,
    #[serde(rename = "oldRange")]
    pub old_range: Option<[u64; 2]>,
    #[serde(rename = "newRange")]
    pub new_range: Option<[u64; 2]>,
}

/// リポジトリのセッションから全コメント（AI + 人間）を取得する。
pub fn fetch_comments(repo_root: &Path) -> anyhow::Result<Vec<HunkComment>> {
    let output = crate::git::common::command_with_clean_git_context("hunk")
        .args(["session", "comment", "list", "--repo"])
        .arg(repo_root.as_os_str())
        .args(["--type", "all", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("hunk session comment list の実行に失敗しました")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "hunk session comment list が失敗しました: {}",
            stderr.trim()
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: CommentListResponse = serde_json::from_str(stdout.trim())
        .context("hunk session comment list の出力をパースできませんでした")?;
    Ok(parsed.comments)
}

// ---------------------------------------------------------------------------
// taxonomy 分類 & ゲート判定（完了条件 3）
// ---------------------------------------------------------------------------

/// コメントが want 指摘（`[question] (want)`）かどうか。
///
/// want コメントはゲートをブロックしない（CONTEXT.md の want コメント定義）。
pub fn is_want(body: &str) -> bool {
    let trimmed = body.trim();
    trimmed.starts_with("[question]") && trimmed.contains("(want)")
}

/// 全コメントのゲート判定を行う。
///
/// - source が "user"（人間コメント）→ ブロック
/// - それ以外（AI コメント）→ want 指摘のみ通過、他はブロック
/// - コメントなし → 通過
pub fn gate_passes(comments: &[HunkComment]) -> bool {
    comments
        .iter()
        .all(|comment| match comment.source.as_str() {
            "user" => false,
            _ => is_want(&comment.body),
        })
}

/// hunk 統合テスト用の直列化 Mutex（daemon との競合防止）。
#[cfg(test)]
pub static HUNK_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ---------------------------------------------------------------------------
// テスト用ヘルパー（start.test.rs / check.test.rs / shared.test.rs 共通）
// ---------------------------------------------------------------------------

/// テスト用の一時 Git リポジトリを作成する。
#[cfg(test)]
pub(crate) fn make_temp_git_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().to_path_buf();
    crate::test_support::git_command()
        .args(["init", "-q", "-b", "main"])
        .current_dir(&path)
        .status()
        .expect("git init");
    crate::test_support::git_command()
        .args(["config", "user.email", "test@test.local"])
        .current_dir(&path)
        .status()
        .expect("git config");
    crate::test_support::git_command()
        .args(["config", "user.name", "test"])
        .current_dir(&path)
        .status()
        .expect("git config");
    std::fs::write(path.join("README.md"), "hello\n").unwrap();
    crate::test_support::git_command()
        .args(["add", "."])
        .current_dir(&path)
        .status()
        .expect("git add");
    crate::test_support::git_command()
        .args(["commit", "-qm", "initial"])
        .current_dir(&path)
        .status()
        .expect("git commit");
    (tmp, path)
}

/// hunk バイナリが利用可能かどうかを確認する。
#[cfg(test)]
pub(crate) fn hunk_available() -> bool {
    crate::git::common::command_with_clean_git_context("hunk")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// テスト用に hunk TUI セッションを起動し、daemon に登録されるまで待つ。
///
/// `script -q /dev/null hunk diff --no-line-numbers` を spawn する。
/// hunk が無い場合やセッションが検出できない場合は `None` を返す（テスト側でスキップ）。
/// 返した `Child` はテスト終了時に kill してセッションを破棄する。
#[cfg(test)]
pub(crate) fn spawn_hunk_session(repo: &Path) -> Option<std::process::Child> {
    use std::time::{Duration, Instant};

    if !hunk_available() {
        eprintln!("SKIP: hunk がインストールされていません");
        return None;
    }

    let mut child = std::process::Command::new("script")
        .args(["-q", "/dev/null", "hunk", "diff", "--no-line-numbers"])
        .current_dir(repo)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("hunk TUI の起動");

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if find_session(repo).is_ok() {
            return Some(child);
        }
        // 子プロセスが死んだら失敗
        if let Some(status) = child.try_wait().ok().flatten() {
            eprintln!("hunk TUI が早期終了しました: {status}");
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    eprintln!("hunk TUI セッションが 10 秒以内に検出できませんでした");
    None
}

/// テスト用に起動した hunk TUI を終了する（セッションも消える）。
#[cfg(test)]
pub(crate) fn stop_hunk_session(mut child: std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
#[path = "shared.test.rs"]
mod tests;
