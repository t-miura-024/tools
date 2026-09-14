use std::io::BufRead;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::thread;

use serde_json::Value;

pub(crate) fn git_command() -> Command {
    crate::git::common::command_with_clean_git_context("git")
}

/// 外部表示ツール（herdr / terminal-browser）が呼ばれないことを検証するフェイク環境。
///
/// difit レビューの表示は URL 提示のみ（ADR-0027）であり、herdr のタブ作成や
/// terminal-browser の起動を行わない。PATH 先頭に同名のフェイクを差し込み、
/// 呼び出された場合は引数をログへ記録する（呼び出し自体をテストの失敗として
/// 検出する）。フェイクは exit 0 するため、仮に呼ばれても start 自体は成功し得る。
pub(crate) struct DisplayToolProbe {
    _bin_dir: tempfile::TempDir,
    _work_dir: tempfile::TempDir,
    path_value: String,
    log_path: PathBuf,
}

const FAKE_HERDR_PROBE: &str = r#"#!/bin/sh
if [ -n "$FAKE_DISPLAY_TOOL_LOG" ]; then
  printf 'herdr %s\n' "$*" >> "$FAKE_DISPLAY_TOOL_LOG"
fi
exit 0
"#;

const FAKE_TERMINAL_BROWSER_PROBE: &str = r#"#!/bin/sh
if [ -n "$FAKE_DISPLAY_TOOL_LOG" ]; then
  printf 'terminal-browser %s\n' "$*" >> "$FAKE_DISPLAY_TOOL_LOG"
fi
exit 0
"#;

fn write_executable(path: &Path, content: &str) {
    use std::os::unix::fs::PermissionsExt;

    std::fs::write(path, content).expect("fake バイナリの書き込み");
    let mut permissions = std::fs::metadata(path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions).expect("実行権限の付与");
}

impl DisplayToolProbe {
    pub(crate) fn new() -> Self {
        let bin_dir = tempfile::tempdir().expect("tempdir");
        let work_dir = tempfile::tempdir().expect("tempdir");
        write_executable(&bin_dir.path().join("herdr"), FAKE_HERDR_PROBE);
        write_executable(
            &bin_dir.path().join("terminal-browser"),
            FAKE_TERMINAL_BROWSER_PROBE,
        );

        let original_path = std::env::var_os("PATH").unwrap_or_default();
        let path_value = format!(
            "{}:{}",
            bin_dir.path().display(),
            original_path.to_string_lossy()
        );

        Self {
            path_value,
            log_path: work_dir.path().join("display-tools.log"),
            _bin_dir: bin_dir,
            _work_dir: work_dir,
        }
    }

    /// mt サブプロセスへ渡す環境変数（PATH を含む）。
    pub(crate) fn envs(&self) -> Vec<(String, String)> {
        vec![
            ("PATH".to_string(), self.path_value.clone()),
            (
                "FAKE_DISPLAY_TOOL_LOG".to_string(),
                self.log_path.display().to_string(),
            ),
        ]
    }

    /// フェイクが記録した呼び出し（空なら外部表示ツールは呼ばれていない）。
    pub(crate) fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log_path)
            .unwrap_or_default()
            .lines()
            .map(|line| line.to_string())
            .collect()
    }
}

/// difit 統合テスト用の直列化 Mutex（ポート競合防止）。
static DIFIT_TEST_LOCK: Mutex<()> = Mutex::new(());

/// difit 統合テストの直列化ロックを取得する。
///
/// テスト失敗で Mutex が poison されても後続テストを巻き込まないよう、
/// poison 状態では内部値をそのまま取り出す。
pub(crate) fn difit_test_lock() -> std::sync::MutexGuard<'static, ()> {
    DIFIT_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// テスト用の一時 Git リポジトリを作成する（difit 統合テスト共通）。
pub(crate) fn make_temp_git_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().to_path_buf();
    git_command()
        .args(["init", "-q", "-b", "main"])
        .current_dir(&path)
        .status()
        .expect("git init");
    git_command()
        .args(["config", "user.email", "test@test.local"])
        .current_dir(&path)
        .status()
        .expect("git config");
    git_command()
        .args(["config", "user.name", "test"])
        .current_dir(&path)
        .status()
        .expect("git config");
    std::fs::write(path.join("README.md"), "hello\n").unwrap();
    git_command()
        .args(["add", "."])
        .current_dir(&path)
        .status()
        .expect("git add");
    git_command()
        .args(["commit", "-qm", "initial"])
        .current_dir(&path)
        .status()
        .expect("git commit");
    (tmp, path)
}

/// difit バイナリが利用可能かどうかを確認する。
fn difit_available() -> bool {
    crate::git::common::command_with_clean_git_context("difit")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 実 difit バイナリ契約テストの strict モード環境変数。
///
/// 未設定・空文字・`0` なら既定（skip）、それ以外（`1` 等）なら difit 不在を
/// 失敗にする。検証を主張する実行（src/README.md の検証手順）では
/// `MT_REQUIRE_DIFIT=1` を設定し、skip 0 件で契約テストを実行する。
const REQUIRE_DIFIT_ENV: &str = "MT_REQUIRE_DIFIT";

/// difit 不在で skip した契約テストの件数。
static DIFIT_SKIP_COUNT: AtomicUsize = AtomicUsize::new(0);

/// skip 集計レポータの atexit 登録（初回 skip のときだけ）。
static DIFIT_SKIP_REPORT: Once = Once::new();

/// 実 difit バイナリが必要なテストの前提を検証する。
///
/// 戻り値が false のとき、呼び出し側はテスト本体を skip する。
///
/// - difit 利用可能: true
/// - difit 不在 + strict（`MT_REQUIRE_DIFIT` が `0` / 空以外）: panic して
///   テストを失敗させる（検証を主張する実行で無音 skip の green を作らない）
/// - difit 不在 + 既定: skip 件数を集計し、libtest の出力キャプチャを迂回して
///   実 stderr へ「difit 不在」を明示する。プロセス終了時に skip 件数の集計を
///   報告する（`cargo test` の出力に隠れず、検証ゼロの green を区別できる）。
pub(crate) fn require_difit() -> bool {
    if difit_available() {
        return true;
    }

    if strict_require_difit() {
        panic!(
            "difit が見つかりません（{REQUIRE_DIFIT_ENV}={}）。difit をインストールするか、\
             契約テストを skip する場合は {REQUIRE_DIFIT_ENV} を未設定にしてください",
            std::env::var(REQUIRE_DIFIT_ENV).unwrap_or_default()
        );
    }

    let count = DIFIT_SKIP_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
    DIFIT_SKIP_REPORT.call_once(|| unsafe {
        // テスト完了後（プロセス終了時）に skip 集計を報告する。
        nix::libc::atexit(report_difit_skips);
    });
    write_real_stderr(&format!(
        "mt difit tests: SKIP: difit が見つかりません（{count} 件目）。\
         検証する場合は {REQUIRE_DIFIT_ENV}=1 で再実行してください\n"
    ));
    false
}

/// strict モード（difit 不在を skip ではなく失敗にする）かどうか。
fn strict_require_difit() -> bool {
    matches!(
        std::env::var(REQUIRE_DIFIT_ENV).ok().as_deref(),
        Some(value) if !value.is_empty() && value != "0"
    )
}

/// テストプロセス終了時に skip 集計を実 stderr へ報告する。
extern "C" fn report_difit_skips() {
    let count = DIFIT_SKIP_COUNT.load(Ordering::SeqCst);
    write_real_stderr(&format!(
        "mt difit tests: difit 不在のため実 difit 契約テスト {count} 件を skip しました\
         （この実行の E2E 検証は成立していません）。検証を主張する場合は \
         {REQUIRE_DIFIT_ENV}=1 で再実行してください\n"
    ));
}

/// libtest の出力キャプチャに隠れないよう、実 stderr へ直接書き込む。
///
/// `eprintln!` はキャプチャされ、成功したテストの出力は表示されない。
/// `/dev/stderr` を直接開けば実際の fd 2 へ届き、skip の事実が可視になる。
fn write_real_stderr(message: &str) {
    use std::io::Write;

    if let Ok(mut stderr) = std::fs::OpenOptions::new().append(true).open("/dev/stderr") {
        let _ = stderr.write_all(message.as_bytes());
    }
}

/// 127.0.0.1 の空きポートで LISTEN し、接続へ HTTP 500 を返す子プロセス（nc）。
///
/// 「記録 pid が記録 port を LISTEN しているが difit として応答しない」旧サーバを
/// 再現する。`nc` が無い環境では [`UnresponsiveListener::spawn`] が None を返す
/// （呼び出し側で SKIP）。
pub(crate) struct UnresponsiveListener {
    child: std::process::Child,
    /// nc の stdin。閉じると nc が終了し得るため保持し続ける。
    _stdin: std::process::ChildStdin,
    pub(crate) pid: i32,
    pub(crate) port: u16,
}

impl UnresponsiveListener {
    pub(crate) fn spawn() -> Option<Self> {
        use std::io::Write;
        use std::process::Stdio;

        // 空きポートを確保して即座に解放する（nc が同じポートを bind する）。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
        let port = listener.local_addr().ok()?.port();
        drop(listener);

        let mut child = Command::new("nc")
            .args(["-k", "-l", "127.0.0.1", &port.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;

        // probe（GET /api/diff）へ即座に 500 を返す。データはパイプに溜まり、
        // 接続時に nc が転送する。
        let mut stdin = child.stdin.take().expect("nc の stdin");
        stdin
            .write_all(
                b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .ok()?;

        // LISTEN 開始を待つ（OS 情報の照合が成功したら準備完了）。
        for _ in 0..100 {
            if crate::difit::shared::is_pid_listening_on_port(child.id() as i32, port) {
                return Some(Self {
                    pid: child.id() as i32,
                    port,
                    child,
                    _stdin: stdin,
                });
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        let _ = child.kill();
        let _ = child.wait();
        None
    }

    /// 応答しない孤児候補が kill されずに生存しているか。
    pub(crate) fn is_alive(&self) -> bool {
        crate::difit::shared::is_process_alive(self.pid)
    }
}

impl Drop for UnresponsiveListener {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 実 `mt` バイナリを fake 環境付きで実行する（stdin は指定入力）。
pub(crate) fn run_mt_with_env(
    path: &Path,
    args: &[&str],
    stdin_input: &str,
    envs: &[(String, String)],
) -> std::process::Output {
    use std::io::Write;
    use std::process::Stdio;

    let mut command = Command::new(assert_cmd::cargo::cargo_bin("mt"));
    crate::git::common::clear_git_context(&mut command);
    command.args(args).current_dir(path).env("NO_COLOR", "1");
    for (key, value) in envs {
        command.env(key, value);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("mt の実行");
    child
        .stdin
        .take()
        .expect("stdin pipe")
        .write_all(stdin_input.as_bytes())
        .expect("stdin への書き込み");
    child.wait_with_output().expect("mt の出力")
}

/// テスト用のモック herdr サーバー。
///
/// リクエスト 1 件につき 1 接続を処理し（実 herdr と同じ）、受信したリクエスト JSON を
/// `requests` に記録したうえで handler の応答 JSON を 1 行書き込んで接続を閉じる。
/// Unreal: 実サーバーなしで raw socket クライアントの振る舞いを検証するためのテスト境界。
pub struct MockHerdr {
    pub socket: crate::herdr::socket::HerdrSocket,
    pub requests: Arc<Mutex<Vec<Value>>>,
    _dir: tempfile::TempDir,
}

impl MockHerdr {
    pub fn start(handler: impl Fn(&Value) -> Value + Send + Sync + 'static) -> MockHerdr {
        let dir = tempfile::tempdir().expect("tempdir の作成に失敗");
        let path = dir.path().join("herdr.sock");
        let listener = UnixListener::bind(&path).expect("テスト用 unix socket の作成に失敗");
        let requests: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let requests_for_thread = Arc::clone(&requests);

        thread::spawn(move || {
            loop {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(_) => break,
                };
                let mut reader =
                    std::io::BufReader::new(stream.try_clone().expect("socket の複製に失敗"));
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let request: Value = match serde_json::from_str(&line) {
                    Ok(request) => request,
                    Err(_) => continue,
                };
                requests_for_thread
                    .lock()
                    .expect("requests lock")
                    .push(request.clone());
                let response = handler(&request);
                let mut line_out =
                    serde_json::to_string(&response).expect("応答のシリアライズに失敗");
                line_out.push('\n');
                let _ = std::io::Write::write_all(&mut stream, line_out.as_bytes());
            }
        });

        MockHerdr {
            socket: crate::herdr::socket::HerdrSocket::at(&path),
            requests,
            _dir: dir,
        }
    }
}
