//! difit サブコマンド群の共有基盤。
//!
//! `.difit/` ディレクトリ管理、`difit-review.json` の読み書き、
//! プロセス生存確認、コメント形式変換、taxonomy 分類を含む。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// .difit/ ディレクトリ & difit-review.json
// ---------------------------------------------------------------------------

/// `difit-review.json` のスキーマ。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewState {
    /// difit サーバのポート番号
    pub port: u16,
    /// difit サーバのプロセス ID
    pub pid: i32,
    /// 注入済みコメント（import 形式の JSON 配列）。クラッシュ復旧時の再注入に使う。
    pub comments: Vec<serde_json::Value>,
    /// difit に渡した引数（working, HEAD~3 等）。stale 復旧時の再起動に使う。
    pub difit_args: Vec<String>,
}

/// Git リポジトリルートを返す。
pub fn git_repo_root() -> anyhow::Result<PathBuf> {
    git_repo_root_in(&std::env::current_dir()?)
}

/// 指定ディレクトリを起点に Git リポジトリルートを返す。
pub fn git_repo_root_in(cwd: &Path) -> anyhow::Result<PathBuf> {
    let output = Command::new("git")
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

/// `.difit/` ディレクトリのパスを返す。
pub fn difit_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".difit")
}

/// `difit-review.json` のパスを返す。
pub fn review_state_path(repo_root: &Path) -> PathBuf {
    difit_dir(repo_root).join("difit-review.json")
}

/// `.difit/` ディレクトリを idempotent に作成する。
pub fn ensure_difit_dir(repo_root: &Path) -> anyhow::Result<()> {
    let dir = difit_dir(repo_root);
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .with_context(|| format!("{} の作成に失敗しました", dir.display()))?;
    }
    Ok(())
}

/// `difit-review.json` を読み込む。存在しなければ `None`。
pub fn read_review_state(repo_root: &Path) -> Option<ReviewState> {
    let path = review_state_path(repo_root);
    if !path.exists() {
        return None;
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// `difit-review.json` を書き込む。
pub fn write_review_state(repo_root: &Path, state: &ReviewState) -> anyhow::Result<()> {
    ensure_difit_dir(repo_root)?;
    let path = review_state_path(repo_root);
    let json = serde_json::to_string_pretty(state).context("ReviewState のシリアライズに失敗")?;
    fs::write(&path, json + "\n")
        .with_context(|| format!("{} の書き込みに失敗しました", path.display()))?;
    Ok(())
}

/// `difit-review.json` を削除する。
pub fn delete_review_state(repo_root: &Path) {
    let path = review_state_path(repo_root);
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
}

// ---------------------------------------------------------------------------
// プロセス管理
// ---------------------------------------------------------------------------

/// PID のプロセスが生存しているか確認する。
pub fn is_process_alive(pid: i32) -> bool {
    kill(Pid::from_raw(pid), None).is_ok()
}

/// difit サーバを kill する（SIGTERM → 待機 → SIGKILL）。
pub fn kill_server(pid: i32) {
    if !is_process_alive(pid) {
        return;
    }

    if kill(Pid::from_raw(pid), Some(Signal::SIGTERM)).is_err() {
        return;
    }

    for _ in 0..30 {
        if !is_process_alive(pid) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    let _ = kill(Pid::from_raw(pid), Some(Signal::SIGKILL));
}

// ---------------------------------------------------------------------------
// difit サーバ起動
// ---------------------------------------------------------------------------

/// `difit --background` の stdout JSON。
#[derive(Debug, Deserialize)]
pub struct DifitBackgroundOutput {
    pub port: u16,
    #[allow(dead_code)]
    pub url: String,
    pub pid: i32,
}

/// difit サーバを起動し、バックグラウンド出力をパースして返す。
///
/// `difit --background` はプロセスがフォアグラウンドで走り続けるため、
/// `spawn()` で起動し stdout の最初の行（JSON）を読み取って返す。
/// サーバプロセスはバックグラウンドで生存し続ける。
///
/// `comments` は import 形式の JSON 配列。空の場合は `--comment` を付けない。
pub fn spawn_difit_server(
    cwd: &Path,
    difit_args: &[String],
    comments: &[serde_json::Value],
) -> anyhow::Result<DifitBackgroundOutput> {
    use std::io::BufRead;

    let mut cmd = Command::new("difit");
    cmd.args(["--background", "--no-open", "--keep-alive"]);

    for comment in comments {
        cmd.arg("--comment");
        cmd.arg(comment.to_string());
    }

    cmd.args(difit_args);
    cmd.current_dir(cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().context("difit の起動に失敗しました")?;

    // stdout から JSON 行を読み取る。
    // ポート競合時に "Port X is busy, trying Y..." が先行する場合があるため、
    // `{` で始まる行が見つかるまで読み飛ばす。
    let stdout = child.stdout.take().context("difit の stdout を開けませんでした")?;
    let mut reader = std::io::BufReader::new(stdout);
    let mut json_line = String::new();

    for _ in 0..10 {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .context("difit の出力読み取りに失敗しました")?;
        if n == 0 {
            break; // EOF
        }
        let trimmed = line.trim();
        if trimmed.starts_with('{') {
            json_line = trimmed.to_string();
            break;
        }
        // "Port X is busy..." 等の非 JSON 行はスキップ
    }

    if json_line.is_empty() {
        let mut stderr_buf = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            use std::io::Read;
            let _ = stderr.read_to_string(&mut stderr_buf);
        }
        bail!(
            "difit の起動に失敗しました（JSON 出力なし）{}",
            if stderr_buf.is_empty() {
                String::new()
            } else {
                format!(": {}", stderr_buf.trim())
            }
        );
    }

    let parsed: DifitBackgroundOutput =
        serde_json::from_str(&json_line).context("difit の出力をパースできませんでした")?;

    // Child を drop してもプロセスは kill されない（Rust の仕様）。
    // difit サーバはバックグラウンドで生存し続ける。
    drop(child);

    Ok(parsed)
}

// ---------------------------------------------------------------------------
// コメント形式変換（方針 4）
// ---------------------------------------------------------------------------

/// `difit comment get --format json` のレスポンス。
#[derive(Debug, Deserialize)]
pub struct CommentGetResponse {
    #[allow(dead_code)]
    pub version: u64,
    pub threads: Vec<Thread>,
}

/// スレッド（親メッセージ + reply 群）。
#[derive(Debug, Deserialize)]
pub struct Thread {
    pub id: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub position: serde_json::Value,
    pub messages: Vec<Message>,
}

/// スレッド内のメッセージ。
#[derive(Debug, Deserialize)]
pub struct Message {
    #[allow(dead_code)]
    pub id: String,
    pub body: String,
}

/// `comment get` のスレッド群を import 形式の JSON 配列に変換する。
///
/// - `threads[].messages[0]` → `{"type":"thread", "id":..., ...}`
/// - `threads[].messages[1..]` → `{"type":"reply", "filePath":..., "position":..., ...}`
///
/// `id` フィールドを指定してスレッド ID を維持する（方針 5）。
/// reply は `filePath` + `position` で親スレッドにマッチされる（difit import スキーマ）。
pub fn threads_to_import_comments(threads: &[Thread]) -> Vec<serde_json::Value> {
    let mut result = Vec::new();

    for thread in threads {
        let Some(first) = thread.messages.first() else {
            continue;
        };

        result.push(serde_json::json!({
            "type": "thread",
            "id": thread.id,
            "filePath": thread.file_path,
            "position": thread.position,
            "body": first.body,
        }));

        for msg in &thread.messages[1..] {
            result.push(serde_json::json!({
                "type": "reply",
                "filePath": thread.file_path,
                "position": thread.position,
                "body": msg.body,
            }));
        }
    }

    result
}

/// 指定ポートの difit サーバからコメントを取得する。
pub fn fetch_comments(port: u16) -> anyhow::Result<CommentGetResponse> {
    let output = Command::new("difit")
        .args(["comment", "get", "--port", &port.to_string(), "--format", "json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("difit comment get の実行に失敗しました")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("difit comment get が失敗しました: {}", stderr.trim());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).context("difit comment get の出力をパースできませんでした")
}

// ---------------------------------------------------------------------------
// taxonomy 分類 & ゲート判定（完了条件 2）
// ---------------------------------------------------------------------------

/// コメントの taxonomy 分類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Taxonomy {
    /// `[issue]` プレフィックス — AI 発見の問題点（ブロッキング）
    Issue,
    /// `[question]` プレフィックス — AI が人間に判断を仰ぐ（ブロッキング）
    Question,
    /// `[context]` プレフィックス — 人間向け解説（ノンブロッキング）
    Context,
    /// プレフィックスなし — 人間のコメント（ブロッキング）
    Human,
}

/// メッセージ body の taxonomy を分類する。
pub fn classify_body(body: &str) -> Taxonomy {
    let trimmed = body.trim();
    if trimmed.starts_with("[issue]") {
        Taxonomy::Issue
    } else if trimmed.starts_with("[question]") {
        Taxonomy::Question
    } else if trimmed.starts_with("[context]") {
        Taxonomy::Context
    } else {
        Taxonomy::Human
    }
}

/// taxonomy がゲートをブロックするかどうか。
pub fn is_blocking(taxonomy: Taxonomy) -> bool {
    taxonomy != Taxonomy::Context
}

/// 全スレッドのゲート判定を行う。
///
/// 未解決スレッド親の taxonomy が `[context]` のみ → `true`（通過）。
/// `[issue]` / `[question]` / プレフィックスなしが 1 つでもあれば → `false`（ブロック）。
pub fn gate_passes(threads: &[Thread]) -> bool {
    threads.iter().all(|thread| {
        thread
            .messages
            .first()
            .map(|m| !is_blocking(classify_body(&m.body)))
            .unwrap_or(true) // メッセージなしスレッドはブロックしない
    })
}

/// difit 統合テスト用の直列化 Mutex（ポート競合防止）。
#[cfg(test)]
pub static DIFIT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ---------------------------------------------------------------------------
// テスト用ヘルパー（start.test.rs / check.test.rs / shared.test.rs 共通）
// ---------------------------------------------------------------------------

/// テスト用の一時 Git リポジトリを作成する。
#[cfg(test)]
pub(crate) fn make_temp_git_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().to_path_buf();
    Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .current_dir(&path)
        .status()
        .expect("git init");
    Command::new("git")
        .args(["config", "user.email", "test@test.local"])
        .current_dir(&path)
        .status()
        .expect("git config");
    Command::new("git")
        .args(["config", "user.name", "test"])
        .current_dir(&path)
        .status()
        .expect("git config");
    std::fs::write(path.join("README.md"), "hello\n").unwrap();
    Command::new("git")
        .args(["add", "."])
        .current_dir(&path)
        .status()
        .expect("git add");
    Command::new("git")
        .args(["commit", "-qm", "initial"])
        .current_dir(&path)
        .status()
        .expect("git commit");
    (tmp, path)
}

/// difit バイナリが利用可能かどうかを確認する。
#[cfg(test)]
pub(crate) fn difit_available() -> bool {
    Command::new("difit")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
#[path = "shared.test.rs"]
mod tests;
