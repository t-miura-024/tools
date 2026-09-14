//! difit サブコマンド群の共有基盤。
//!
//! `.difit/` ディレクトリ管理、`difit-review.json` の読み書き、difit サーバの
//! 起動・停止・復旧、コメントの変換を含む。taxonomy 分類とゲート判定は
//! `gate.rs`、サーバ HTTP API との通信と選択キーの固定は `client.rs` が担う。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};

use anyhow::{Context, bail};
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};

use super::client::{self, CommentSelection};
use super::gate::Thread;

// ---------------------------------------------------------------------------
// .difit/ ディレクトリ & difit-review.json
// ---------------------------------------------------------------------------

/// `difit-review.json` のスキーマ。
///
/// レビュー表示は URL 提示のみ（ADR-0027）のため、表示ツールの情報は持たない。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewState {
    /// difit サーバのポート番号
    pub port: u16,
    /// difit サーバのプロセス ID
    pub pid: i32,
    /// 注入済みコメント（import 形式の JSON 配列）。stale 復旧時の再注入に使う。
    pub comments: Vec<serde_json::Value>,
    /// difit に渡した引数（working, HEAD~3 等）。stale 復旧時の再起動に使う。
    pub difit_args: Vec<String>,
    /// difit がコメントセッションを識別する解決済みの diff 選択。
    ///
    /// サーバ起動直後に `/api/diff` から取得して保存し、以降のコメント読み書きを
    /// この選択で固定する（ブラウザ UI のリビジョン切替で別セッションを読まない）。
    /// 記録のない state（選択固定前の旧形式）はゲート判定を固定できないため、
    /// `check` は fail-closed で停止する。
    #[serde(default)]
    pub selection: Option<CommentSelection>,
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

/// `.difit/` ディレクトリのパスを返す。
pub fn difit_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".difit")
}

/// `difit-review.json` のパスを返す。
pub fn review_state_path(repo_root: &Path) -> PathBuf {
    difit_dir(repo_root).join("difit-review.json")
}

/// 状態書き込み中の一時ファイルのパスを返す。
///
/// 固定名（`difit-review.json.tmp`）を clone 先リポジトリに symlink として
/// 仕込まれると、create + truncate でリンク先の任意ファイルを破壊され得る。
/// 予測できないプロセス固有の名前を生成し、書き込みは `create_new`（O_EXCL）で
/// 行うことで、事前配置された symlink を開かない。
fn review_state_tmp_path(repo_root: &Path) -> PathBuf {
    difit_dir(repo_root).join(format!(
        "difit-review.json.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ))
}

/// symlink を追従しない新規ファイル書き込み（O_CREAT | O_EXCL）。
///
/// `fs::write` は既存パスを open(2) で開くため、symlink が仕込まれていると
/// リンク先を truncate する。`create_new(true)` は既存パス（symlink 含む）が
/// あれば必ず失敗し、リンク先を一切開かない。
fn write_new_file(path: &Path, contents: &str) -> anyhow::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("{} の作成に失敗しました", path.display()))?;
    file.write_all(contents.as_bytes())
        .with_context(|| format!("{} の書き込みに失敗しました", path.display()))
}

/// `.difit/` ディレクトリを idempotent に作成する。
///
/// `.difit` 自体の symlink（dangling 含む）は fail-closed で拒否する。ルート
/// `.gitignore` の `.difit/` は末尾スラッシュのため通常ディレクトリのみを無視し、
/// `.difit` という symlink は無視対象外で commit できる。さらに `exists()` は
/// リンク先へ追従して true を返すため、検査なしでは `.gitignore` の生成・state の
/// 書き込み・削除がすべてリンク先ディレクトリで実行され、別 worktree の state
/// 上書きやリポジトリ外への書き込みが成立する。
pub fn ensure_difit_dir(repo_root: &Path) -> anyhow::Result<()> {
    let dir = difit_dir(repo_root);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() => bail!(
            "{} が symlink のため書き込みを拒否しました（clone 先に仕込まれた細工の可能性があります）",
            dir.display()
        ),
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => bail!("{} がディレクトリではありません", dir.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // `create_dir_all` は symlink を追従して成功し得るため、検査後も
            // 既存パス（symlink 含む）には必ず失敗する `create_dir` で作る。
            fs::create_dir(&dir)
                .with_context(|| format!("{} の作成に失敗しました", dir.display()))?;
        }
        Err(error) => {
            return Err(error).with_context(|| format!("{} の確認に失敗しました", dir.display()));
        }
    }

    // `.difit/` 配下を git 管理対象外にするための自己 .gitignore を生成する。
    // 外部リポジトリの .gitignore 設定に依存せず、ディレクトリ内で完結させる。
    ensure_gitignore(&dir.join(".gitignore"))
}

/// `.difit/.gitignore` を symlink を追従せずに生成する。
///
/// `exists()` は dangling symlink を false とするため、存在確認だけでは
/// symlink を経由してリンク先の任意パスへ `*\n` を新規作成できてしまう。
/// `symlink_metadata` で symlink を検出したら拒否し、新規作成は `create_new`
/// で行う（確認と作成の間に差し込まれた symlink も open されない）。
fn ensure_gitignore(path: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => bail!(
            "{} が symlink のため書き込みを拒否しました（clone 先に仕込まれた細工の可能性があります）",
            path.display()
        ),
        // 既存の通常ファイル等には触らない（従来どおり idempotent）。
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => write_new_file(path, "*\n"),
        Err(error) => {
            Err(error).with_context(|| format!("{} の確認に失敗しました", path.display()))
        }
    }
}

/// `difit-review.json` を読み込む。存在しない場合は `None`。
///
/// `.difit` ディレクトリ自体や state ファイルが symlink の場合は追従せず、
/// セッションなし（`None`）として扱う。書き込み系（`ensure_difit_dir`）と同じ
/// fail-closed に揃え、リンク先の任意ファイルを state としてパースしない。
///
/// `pid` / `port` はリポジトリ内の通常ファイルに書かれた値で、`kill` の引数に
/// 直接使うと `pid <= 0`（プロセスグループ / 全プロセス指定）や PID 再利用で
/// 無関係プロセスを巻き込む。値域検査は読み込み時に行い、不正なら stale として
/// `None` を返し kill 経路へ渡さない。
pub fn read_review_state(repo_root: &Path) -> Option<ReviewState> {
    let dir = difit_dir(repo_root);
    if matches!(fs::symlink_metadata(&dir), Ok(meta) if meta.file_type().is_symlink()) {
        eprintln!(
            "mt difit: {} が symlink のため、セッション状態を読みません（clone 先に仕込まれた細工の可能性があります）",
            dir.display()
        );
        return None;
    }

    let path = review_state_path(repo_root);
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.file_type().is_file() {
        // symlink / ディレクトリ等は state として扱わない（リンク先を読まない）。
        return None;
    }
    let state: ReviewState = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())?;
    if state.pid <= 0 || state.port == 0 {
        eprintln!(
            "mt difit: {} の pid / port が不正なため、セッションなしとして扱います (port={}, pid={})",
            path.display(),
            state.port,
            state.pid
        );
        return None;
    }
    Some(state)
}

/// state のコメント選択キーを取り出す。未記録なら fail-closed エラーを返す。
///
/// 選択キーがない state（選択固定前の旧形式）では、どのコメントセッションが
/// ゲート・resolve の対象か確定できない。無音 pass / 別セッションへの書き込みを
/// 避けるため、読み取り・resolve の各経路がこのガードを通る。
pub fn require_selection(state: &ReviewState) -> anyhow::Result<&CommentSelection> {
    state.selection.as_ref().context(
        "difit レビューセッションのコメント選択キーが記録されていません。mt difit start でセッションを開始し直してください",
    )
}

/// `difit-review.json` を書き込む。
///
/// 一時ファイルへ書いてから rename で置き換える（同一ディレクトリ内なので
/// アトミック）。state は未 resolve コメント・人間 reply の唯一の永続記録で
/// あり、書き込み途中の破損で復旧源を失わないようにする。
pub fn write_review_state(repo_root: &Path, state: &ReviewState) -> anyhow::Result<()> {
    ensure_difit_dir(repo_root)?;
    let path = review_state_path(repo_root);
    let json = serde_json::to_string_pretty(state).context("ReviewState のシリアライズに失敗")?;
    let tmp_path = review_state_tmp_path(repo_root);

    // 一時ファイルは予測不能な名前 + create_new（O_EXCL）で作り、symlink を
    // 一切追従しない。失敗時は部分書き込みの残骸を片付ける。
    if let Err(error) = write_new_file(&tmp_path, &(json + "\n")) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }

    if let Err(error) = fs::rename(&tmp_path, &path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error).with_context(|| format!("{} の置き換えに失敗しました", path.display()));
    }
    Ok(())
}

/// `difit-review.json` を削除する（書き込み途中の一時ファイルも残さない）。
///
/// `.difit` ディレクトリ自体が symlink の場合はリンク先を走査・削除しない
/// （書き込み系と同じ fail-closed。リンク先の state 相当ファイルや一時ファイルを
/// 巻き込まない）。state ファイル・一時ファイルが symlink の場合も `remove_file`
/// はリンク自体を消すだけでリンク先には触れない。
pub fn delete_review_state(repo_root: &Path) {
    let dir = difit_dir(repo_root);
    if matches!(fs::symlink_metadata(&dir), Ok(meta) if meta.file_type().is_symlink()) {
        return;
    }
    let path = review_state_path(repo_root);
    let _ = fs::remove_file(&path);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("difit-review.json.") && name.ends_with(".tmp") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// ポート番号に対応する difit の URL を返す。
pub fn url_for_port(port: u16) -> String {
    format!("http://localhost:{port}")
}

// ---------------------------------------------------------------------------
// プロセス管理
// ---------------------------------------------------------------------------

/// PID のプロセスが生存しているか確認する。
///
/// `pid <= 0` は `kill(2)` でプロセスグループ（0）や「送信可能な全プロセス」
/// （-1）を指すため、常に false を返して生存判定の根拠にしない。
pub fn is_process_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    kill(Pid::from_raw(pid), None).is_ok()
}

/// difit サーバを kill する（SIGTERM → 待機 → SIGKILL）。
///
/// `pid <= 0` はグループ / 全プロセス指定になるため受け付けない。
pub fn kill_server(pid: i32) {
    if pid <= 0 {
        return;
    }
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

/// 記録された pid が指定ポートを LISTEN しているかを OS 情報で照合する。
///
/// `difit-review.json` はリポジトリ内の通常ファイルで、clone 先に仕込まれた
/// 細工や PID 再利用により、記録 pid が無関係プロセスを指し得る。記録 pid を
/// そのまま `kill` の対象にしないための事前照合で、「その pid がそのポートの
/// TCP リスナーである」ことを確認する。照合手段がない場合（lsof 不在・
/// `/proc` 読み取り失敗等）は false（fail-closed）を返す。
pub fn is_pid_listening_on_port(pid: i32, port: u16) -> bool {
    if pid <= 0 || port == 0 {
        return false;
    }
    platform::is_pid_listening_on_port(pid, port)
}

/// 記録された pid が記録 port の LISTEN であることを検証する（照合不能はエラー）。
///
/// stale 復旧を行わない read-only 照会（`check --dry-run` / `threads --json`）が
/// 使う共通ガード。照合を省くと、記録 port で応答する別プロセス（PID 再利用・
/// clone 先に仕込まれた state）から空セッションを読み、未 resolve を残したまま
/// 無音で pass し得る。サーバは変更せず fail-closed で止める。
pub fn require_server_identity(state: &ReviewState) -> anyhow::Result<()> {
    if is_pid_listening_on_port(state.pid, state.port) {
        return Ok(());
    }
    bail!(
        "difit サーバの同一性を確認できません（pid {} が port {} を LISTEN していません）。\
         state が stale か、記録 port で別のプロセスが応答している可能性があります。\
         mt difit start でセッションを復旧してください",
        state.pid,
        state.port
    )
}

/// pid と port の対応を OS 情報で照合するプラットフォーム実装。
mod platform {
    /// 照合手段のないプラットフォームでは常に false（fail-closed）。
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub(super) fn is_pid_listening_on_port(_pid: i32, _port: u16) -> bool {
        false
    }

    /// macOS: `lsof -t` は該当 pid のみを出力する（該当なしは空出力・exit 1）。
    #[cfg(target_os = "macos")]
    pub(super) fn is_pid_listening_on_port(pid: i32, port: u16) -> bool {
        use std::process::{Command, Stdio};

        let Ok(output) = Command::new("lsof")
            .args(["-nP", "-sTCP:LISTEN", "-t"])
            .arg(format!("-iTCP:{port}"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        else {
            // lsof 不在・実行失敗は照合不能として扱い、kill の根拠にしない。
            return false;
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<i32>().ok())
            .any(|listener_pid| listener_pid == pid)
    }

    /// Linux: プロセスの socket inode が当該ポートの LISTEN ソケットと一致するか。
    #[cfg(target_os = "linux")]
    pub(super) fn is_pid_listening_on_port(pid: i32, port: u16) -> bool {
        use std::fs;

        let Ok(fd_dir) = fs::read_dir(format!("/proc/{pid}/fd")) else {
            return false;
        };
        let socket_inodes: Vec<String> = fd_dir
            .flatten()
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .filter_map(|target| {
                let target = target.to_str()?;
                Some(
                    target
                        .strip_prefix("socket:[")?
                        .strip_suffix(']')?
                        .to_string(),
                )
            })
            .collect();
        if socket_inodes.is_empty() {
            return false;
        }

        // `/proc/net/tcp{,6}` の行: sl local_address rem_address st ... inode(10 列目)。
        // st == "0A" が LISTEN、local_address の末尾が 16 進のポート番号。
        ["/proc/net/tcp", "/proc/net/tcp6"].iter().any(|table| {
            let Ok(content) = fs::read_to_string(table) else {
                return false;
            };
            content.lines().skip(1).any(|line| {
                let mut fields = line.split_whitespace();
                let _index = fields.next();
                let Some(local) = fields.next() else {
                    return false;
                };
                let _remote = fields.next();
                let Some(state) = fields.next() else {
                    return false;
                };
                let Some(inode) = line.split_whitespace().nth(9) else {
                    return false;
                };
                state == "0A"
                    && local
                        .rsplit(':')
                        .next()
                        .and_then(|hex| u16::from_str_radix(hex, 16).ok())
                        == Some(port)
                    && socket_inodes
                        .iter()
                        .any(|socket_inode| socket_inode == inode)
            })
        })
    }
}

/// 記録 pid が記録 port の difit であると照合できず、停止対象にしないことを残す。
///
/// 無関係プロセスへの `kill` を避ける（fail-closed）代わりに difit が孤児として
/// 残り得るため、人間が判別して手動停止できるよう警告を出す。
pub fn warn_server_identity_unverified(pid: i32, port: u16) {
    eprintln!(
        "mt difit: 記録された pid {pid} が port {port} を LISTEN していることを確認できないため、\
         このプロセスは停止対象にしません（無関係プロセスを停止しないため。\
         difit が孤児として残っている場合は手動で停止してください）"
    );
}

/// LISTEN の照合は取れたが difit として応答しない旧サーバを、停止せず孤児として
/// 残すことを警告する。
///
/// 記録 pid が記録 port を LISTEN していることは OS 情報で照合できており、
/// `kill_verified_server` と同じ同一性判定を満たす。それでも復旧経路
/// （`ensure_server_running` / `restart_session`）で停止しないのは、probe / fetch に
/// 失敗した旧サーバ上にだけ存在する未回収のコメントを失わないためである
/// （新しいサーバ・state の確立後も旧サーバは残る）。終了経路の
/// `kill_verified_server` は直前にコメントを回収済みか、明示的な破棄終了
/// （`done`）であるため停止できる。人間が孤児を判別して手動停止できるよう、
/// pid と停止コマンドを警告に含める。
pub fn warn_server_unresponsive_orphan(pid: i32, port: u16) {
    eprintln!(
        "mt difit: 警告: 記録された pid {pid} は port {port} を LISTEN していますが、\
         difit として応答しないため停止対象にしません（未回収のコメントが残っている\
         可能性があるため）。新しい difit サーバで復旧します。このプロセスが孤児として\
         残っている場合は手動で停止してください: kill {pid}"
    );
}

/// 記録された difit サーバを、同一性を OS 情報で照合できた場合のみ停止する。
///
/// state ファイル由来の pid / port は細工や PID 再利用で実際のサーバとずれ得る。
/// 照合できない場合は kill せず、警告を残して人間の判断に委ねる（fail-closed）。
///
/// これは明示的な終了・置き換え経路（`close_session`）専用の判断で、直前に
/// コメントを回収済みか、明示的な破棄終了であることが前提。応答しない旧サーバを
/// 保持したまま新サーバで復旧する経路（`ensure_server_running` /
/// `restart_session`）は未回収コメントを失わないため kill せず、
/// [`warn_server_unresponsive_orphan`] を出す。
pub fn kill_verified_server(pid: i32, port: u16) {
    if is_pid_listening_on_port(pid, port) {
        kill_server(pid);
    } else {
        warn_server_identity_unverified(pid, port);
    }
}

// ---------------------------------------------------------------------------
// difit サーバ起動・復旧
// ---------------------------------------------------------------------------

/// `difit --background` の stdout JSON。
#[derive(Debug, Deserialize)]
pub struct DifitBackgroundOutput {
    pub port: u16,
    #[allow(dead_code)]
    pub url: String,
    pub pid: i32,
}

/// 起動 stdout の JSON を待つ期限。無出力のまま difit がハングしても恒久停止しない。
const STARTUP_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 起動 stdout の読み取り期限を返す。
///
/// テストや低速環境では `MT_DIFIT_STARTUP_TIMEOUT_SECS` で上書きできる。
fn startup_read_timeout() -> std::time::Duration {
    std::env::var("MT_DIFIT_STARTUP_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(std::time::Duration::from_secs)
        .unwrap_or(STARTUP_READ_TIMEOUT)
}

/// difit サーバを起動し、バックグラウンド出力をパースして返す。
///
/// `difit --background` はプロセスがフォアグラウンドで走り続けるため、
/// `spawn()` で起動し stdout の最初の JSON 行を読み取って返す。
/// サーバプロセスはバックグラウンドで生存し続ける。
///
/// 読み取りには期限を設け、超過時は子プロセスを停止してエラーにする。
/// `read_line` は改行到着か EOF までブロックするため、difit が無出力のまま
/// 生き続けると `mt difit start` / stale 復旧が恒久的に返らなくなる。
///
/// コメントは argv（`--comment <json>`）では渡さない。コメント全量は OS の
/// 引数長上限（macOS は argv 合計 約 1 MiB、Linux は 1 引数 128 KiB）で E2BIG に
/// なり、読み取り側が許容する量（16 MiB）を書き戻せなくなる。起動後に
/// [`start_difit_server`] が選択キーを確定してから HTTP（`/api/comment-imports`）で
/// 注入する。
pub fn spawn_difit_server(
    cwd: &Path,
    difit_args: &[String],
) -> anyhow::Result<DifitBackgroundOutput> {
    let mut cmd = crate::git::common::command_with_clean_git_context("difit");
    cmd.args(["--background", "--no-open", "--keep-alive"]);
    cmd.args(difit_args);
    cmd.current_dir(cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().context("difit の起動に失敗しました")?;

    // stdout から JSON 行を読み取る。
    // ポート競合時に "Port X is busy, trying Y..." が先行する場合があるため、
    // `{` で始まる行が見つかるまで読み飛ばす。
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            stop_child(&mut child);
            bail!("difit の stdout を開けませんでした");
        }
    };

    // 読み取りは別スレッドに任せ、期限付きで待つ。期限超過時に stop_child で
    // 子プロセスを停止しても、読み取りスレッドは EOF で終了する。
    let (sender, receiver) = std::sync::mpsc::channel::<Result<Option<String>, std::io::Error>>();
    std::thread::spawn(move || {
        use std::io::BufRead;

        let mut reader = std::io::BufReader::new(stdout);
        let mut json_line: Option<String> = None;
        for _ in 0..10 {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.starts_with('{') {
                        json_line = Some(trimmed.to_string());
                        break;
                    }
                    // "Port X is busy..." 等の非 JSON 行はスキップ
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                    return;
                }
            }
        }
        let _ = sender.send(Ok(json_line));
    });

    let timeout = startup_read_timeout();
    let json_line = match receiver.recv_timeout(timeout) {
        Ok(Ok(Some(json_line))) => json_line,
        Ok(Ok(None)) => {
            let stderr_buf = stop_child(&mut child);
            bail!(
                "difit の起動に失敗しました（JSON 出力なし）{}",
                format_stderr_suffix(&stderr_buf)
            );
        }
        Ok(Err(error)) => {
            stop_child(&mut child);
            return Err(error).context("difit の出力読み取りに失敗しました");
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            let stderr_buf = stop_child(&mut child);
            bail!(
                "difit の起動応答がタイムアウトしました（{} 秒）{}",
                timeout.as_secs(),
                format_stderr_suffix(&stderr_buf)
            );
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let stderr_buf = stop_child(&mut child);
            bail!(
                "difit の出力読み取りが中断されました{}",
                format_stderr_suffix(&stderr_buf)
            );
        }
    };

    let parsed: DifitBackgroundOutput = match serde_json::from_str(&json_line) {
        Ok(parsed) => parsed,
        Err(error) => {
            stop_child(&mut child);
            return Err(error).context("difit の出力をパースできませんでした");
        }
    };

    // Child を drop してもプロセスは kill されない（Rust の仕様）。
    // difit サーバはバックグラウンドで生存し続ける。
    drop(child);

    Ok(parsed)
}

/// エラーメッセージへ stderr を付記する（空なら何も付けない）。
fn format_stderr_suffix(stderr_buf: &str) -> String {
    if stderr_buf.is_empty() {
        String::new()
    } else {
        format!(": {}", stderr_buf.trim())
    }
}

/// 起動後のエラー時に子プロセスを停止し、stderr を回収する。
///
/// `Child` の Drop はプロセスを停止しないため、stdout の読み取りや JSON の
/// パースに失敗してもサーバが残らないよう、kill と wait を明示的に行う。
/// kill 後に stderr を読み切ってから wait することで、stderr のパイプが詰まった
/// 子プロセスにも対応する。
fn stop_child(child: &mut Child) -> String {
    use std::io::Read;

    let _ = child.kill();
    let mut stderr_buf = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut stderr_buf);
    }
    let _ = child.wait();
    stderr_buf
}

/// セッションの difit サーバが生存し、記録されたポートで difit として応答するか。
///
/// `kill(pid, 0)` の成否だけでは PID 再利用（無関係プロセスが同じ PID を引き継ぐ）
/// や細工した state を検出できない。記録 pid が記録ポートを LISTEN していることを
/// OS 情報（`is_pid_listening_on_port`）で照合し、difit の `/api/diff` が応答する
/// ことでサーバ同一性を確認する。
///
/// 生存判定は軽量プローブ（`/api/diff` の GET のみ）に限定する。未 resolve
/// スレッド全件の取得（`/api/comments-json`）はゲート判定・verdict 生成の経路
/// （`check` / `threads` / `start` の再利用）だけが行い、生存確認で先に読んで
/// 同じ内容を二重取得しない。照合できない場合は false とし、呼び出し側は
/// stale / 修復対象として扱う（kill はしない）。
pub fn is_server_live(state: &ReviewState) -> bool {
    is_pid_listening_on_port(state.pid, state.port) && client::probe_selection(state.port).is_ok()
}

/// 起動済み difit サーバのポート・PID・コメント選択キー。
#[derive(Debug, Clone)]
pub struct StartedServer {
    pub port: u16,
    pub pid: i32,
    pub selection: CommentSelection,
}

/// difit サーバを起動し、コメントセッションの選択キーを確定してコメントを注入する。
///
/// `spawn_difit_server` の成功後に `/api/diff` から解決済み選択を取得し、その選択
/// クエリで `/api/comment-imports` へコメントを注入する（`start` の再利用経路と
/// 同一の `add_comments` 機構）。コメントを argv に載せないため、コメント全量が
/// OS の引数長上限を超えても起動・復旧できる。
///
/// 選択キーを確定できないサーバはゲート判定とコメント追加を固定できず、無音
/// pass の経路になる。また注入に失敗したサーバは state と齟齬が出るため、
/// mt が起動した子プロセスを停止してエラーにする（fail-closed）。
pub fn start_difit_server(
    cwd: &Path,
    difit_args: &[String],
    comments: &[serde_json::Value],
) -> anyhow::Result<StartedServer> {
    let bg = spawn_difit_server(cwd, difit_args)?;

    let selection = match client::probe_selection(bg.port) {
        Ok(selection) => selection,
        Err(error) => {
            // 起動直後の子プロセスは mt が spawn した difit そのものなので、
            // 同一性確認なしで停止してよい。
            kill_server(bg.pid);
            return Err(error.context(
                "difit のコメント選択キーを取得できなかったため、起動したサーバを停止しました",
            ));
        }
    };

    if let Err(error) = client::add_comments(bg.port, Some(&selection), comments) {
        kill_server(bg.pid);
        return Err(
            error.context("difit にコメントを注入できなかったため、起動したサーバを停止しました")
        );
    }

    Ok(StartedServer {
        port: bg.port,
        pid: bg.pid,
        selection,
    })
}

/// サーバが死んでいれば保存済みコメントで復旧し、状態を更新する。
///
/// 生存判定は `is_server_live`（記録 pid が記録ポートを LISTEN + difit としての
/// 応答）で行う。応答しない旧 pid はサーバ同一性を確認できないため kill しない
/// （誤って無関係プロセスへ SIGTERM を送るより、孤児を残して新サーバで復旧する）。
/// 生存しているのに同一性を確認できない pid は警告を残し、人間が孤児を判別できる
/// ようにする。同一性は確認できる（LISTEN）が probe に失敗した pid も、未回収の
/// コメントを失わないため停止せず、専用の孤児警告
/// （`warn_server_unresponsive_orphan`）を残す。
///
/// 復旧時は新しいサーバの選択キーを state へ記録する（再起動で diff の解決が
/// 変わり得るため、古い選択を引き継がない）。
pub fn ensure_server_running(
    repo_root: &Path,
    mut state: ReviewState,
) -> anyhow::Result<ReviewState> {
    if is_server_live(&state) {
        return Ok(state);
    }

    if is_process_alive(state.pid) {
        if is_pid_listening_on_port(state.pid, state.port) {
            warn_server_unresponsive_orphan(state.pid, state.port);
        } else {
            warn_server_identity_unverified(state.pid, state.port);
        }
    }

    let comments = synthesize_missing_positions(state.comments.clone());
    let server = start_difit_server(repo_root, &state.difit_args, &comments)?;
    state.port = server.port;
    state.pid = server.pid;
    state.selection = Some(server.selection);
    state.comments = comments;

    if let Err(error) = write_review_state(repo_root, &state) {
        // 復旧後の状態を保存できない限り新サーバを残さない（旧 state が復旧源）。
        kill_server(state.pid);
        return Err(error.context(
            "復旧した difit セッションの状態を保存できなかったため、起動したサーバを停止しました",
        ));
    }
    Ok(state)
}

// ---------------------------------------------------------------------------
// コメント変換
// ---------------------------------------------------------------------------

/// `comment get` のスレッド群を import 形式の JSON 配列に変換する。
///
/// - `threads[].messages[0]` → `{"type":"thread", "id":..., ...}`
/// - `threads[].messages[1..]` → `{"type":"reply", "filePath":..., "position":..., ...}`
///
/// `id` フィールドを指定してスレッド ID を維持する。
/// reply は `filePath` + `position` で親スレッドにマッチされる（difit import スキーマ）。
/// `author` は保持し、人間（`"User"`）の投稿が復旧時の再注入で author を失わないようにする。
/// import スキーマ上 author は任意文字列で、`null` は拒否されるため未設定時は出力しない。
pub fn threads_to_import_comments(threads: &[Thread]) -> Vec<serde_json::Value> {
    let mut result = Vec::new();

    for thread in threads {
        let Some(first) = thread.messages.first() else {
            continue;
        };

        let mut root = serde_json::json!({
            "type": "thread",
            "id": thread.id,
            "filePath": thread.file_path,
            "position": thread.position,
            "body": first.body,
        });
        if let Some(author) = &first.author {
            root["author"] = serde_json::json!(author);
        }
        result.push(root);

        for msg in &thread.messages[1..] {
            let mut reply = serde_json::json!({
                "type": "reply",
                "filePath": thread.file_path,
                "position": thread.position,
                "body": msg.body,
            });
            if let Some(author) = &msg.author {
                reply["author"] = serde_json::json!(author);
            }
            result.push(reply);
        }
    }

    result
}

/// position キーを持たないコメントエントリに `{"side":"new","line":1}` を合成する。
///
/// difit の `normalizeCommentImportEntry` は position（side + line）を必須として
/// おり、欠落時は throw して起動が失敗する。position なし（ファイルレベル）の
/// コメントエントリを difit に渡す前に line:1 に正規化する（ADR-0011）。
///
/// 合成は position キーが**存在しない**エントリにのみ適用される。position を持つ
/// エントリ（thread / reply）は一切変更しない。非オブジェクトのエントリも変更しない。
/// 適用後に再適用しても結果は変わらない（冪等）。
pub fn synthesize_missing_positions(comments: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    comments
        .into_iter()
        .map(|entry| match entry {
            serde_json::Value::Object(mut obj) if !obj.contains_key("position") => {
                obj.insert(
                    "position".to_string(),
                    serde_json::json!({"side": "new", "line": 1}),
                );
                serde_json::Value::Object(obj)
            }
            other => other,
        })
        .collect()
}

/// difit レビューセッションの後始末（サーバ停止・状態削除）。
///
/// `check` の通過時と `done` の終了時に共用する唯一の後始末経路。契約:
/// - `mt difit check`: 通過時のみ後始末し、ブロック時はサーバ・状態を残して
///   次ラウンドで再利用する
/// - `mt difit done`: ゲート結果にかかわらず常に後始末する（standalone 終了）
///
/// `server` はサーバ同一性を確認できた場合のみ `Some((pid, port))` を渡す。復旧失敗
/// などで確認できない場合は `None` を渡し、無関係プロセスへの kill を避ける。
/// `Some` の場合も kill 直前に pid が当該 port を LISTEN していることを再照合し、
/// 照合できない場合は kill をスキップする（fail-closed）。
pub fn close_session(repo_root: &Path, server: Option<(i32, u16)>) {
    if let Some((pid, port)) = server {
        kill_verified_server(pid, port);
    }
    delete_review_state(repo_root);
}

#[cfg(test)]
#[path = "shared.test.rs"]
mod tests;
