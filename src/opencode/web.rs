use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::Context;
use nix::sys::signal::{SigSet, Signal, kill};
use nix::unistd::Pid;
use rand::Rng;

use crate::cli::style;
use crate::config;

fn pid_file_path() -> PathBuf {
    config::home_dir().join(".config/opencode/web-expose.pid")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PidData {
    opencode_pid: i32,
    ngrok_pid: i32,
    port: u16,
    url: String,
    repo_dir: String,
    started_at: String,
    policy_file: String,
}

#[derive(serde::Deserialize)]
struct NgrokTunnelsResponse {
    tunnels: Vec<NgrokTunnel>,
}

#[derive(serde::Deserialize)]
struct NgrokTunnel {
    public_url: Option<String>,
}

fn read_oauth_config() -> anyhow::Result<config::OAuthConfig> {
    let content = fs::read_to_string(config::oauth_config_path())
        .context("Google OAuth 設定ファイルが読み込めません")?;
    Ok(serde_json::from_str(&content)?)
}

fn read_pid_data() -> Option<PidData> {
    let path = pid_file_path();
    if !path.exists() {
        return None;
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn write_pid_data(data: &PidData) -> anyhow::Result<()> {
    let json = serde_json::to_string_pretty(data)?;
    fs::write(pid_file_path(), json + "\n").context("PID ファイルの書き込みに失敗しました")?;
    Ok(())
}

fn delete_pid_data() {
    let path = pid_file_path();
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
}

fn is_process_alive(pid: i32) -> bool {
    kill(Pid::from_raw(pid), None).is_ok()
}

fn kill_child(child: &mut Child, name: &str) {
    let pid = child.id() as i32;
    style::info(&format!("{} (PID: {}) を停止中...", name, pid));

    if kill(Pid::from_raw(pid), Some(Signal::SIGTERM)).is_err() {
        return;
    }

    for _ in 0..30 {
        if let Ok(Some(_)) = child.try_wait() {
            style::info(&format!("{} が終了しました", name));
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    style::warn(&format!(
        "{} が SIGTERM に応答しません。SIGKILL を送信します",
        name
    ));
    let _ = kill(Pid::from_raw(pid), Some(Signal::SIGKILL));
    let _ = child.wait();
    style::info(&format!("{} が終了しました", name));
}

fn kill_process(pid: i32, name: &str) {
    style::info(&format!("{} (PID: {}) を停止中...", name, pid));

    if kill(Pid::from_raw(pid), Some(Signal::SIGTERM)).is_err() {
        return;
    }

    for _ in 0..30 {
        if !is_process_alive(pid) {
            style::info(&format!("{} が終了しました", name));
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    style::warn(&format!(
        "{} が SIGTERM に応答しません。SIGKILL を送信します",
        name
    ));
    let _ = kill(Pid::from_raw(pid), Some(Signal::SIGKILL));
}

fn extract_port(line: &str) -> Option<u16> {
    let prefix = "http://127.0.0.1:";
    let suffix = "/";
    if let Some(start) = line.find(prefix) {
        let rest = &line[start + prefix.len()..];
        if let Some(end) = rest.find(suffix) {
            return rest[..end].parse().ok();
        }
    }
    None
}

fn spawn_opencode(repo_dir: &PathBuf) -> anyhow::Result<(Child, u16)> {
    let mut child = Command::new("opencode")
        .args(["web", "--port", "0"])
        .current_dir(repo_dir)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .env_remove("OPENCODE_SERVER_PASSWORD")
        .spawn()
        .context("opencode の起動に失敗しました")?;

    let stderr = child.stderr.take().context("stderr の取得に失敗しました")?;
    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(port) = extract_port(&line) {
                let _ = tx.send(port);
            }
        }
    });

    let port = rx
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| anyhow::anyhow!("opencode のポートを検出できませんでした（タイムアウト）"))?;

    Ok((child, port))
}

fn generate_policy_file(config: &config::OAuthConfig) -> anyhow::Result<String> {
    let emails_str: Vec<String> = config
        .allowed_emails
        .iter()
        .map(|e| format!("'{}'", e))
        .collect();
    let emails_joined = emails_str.join(", ");

    let yaml = format!(
        r#"on_http_request:
  - actions:
      - type: oauth
        config:
          provider: google
          client_id: '{}'
          client_secret: '{}'
          scopes:
            - https://www.googleapis.com/auth/userinfo.profile
            - https://www.googleapis.com/auth/userinfo.email
  - expressions:
      - "!(actions.ngrok.oauth.identity.email in [{}])"
    actions:
      - type: deny
"#,
        config.client_id, config.client_secret, emails_joined,
    );

    let id: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(8)
        .map(char::from)
        .collect();
    let path = format!("/tmp/opencode-ngrok-policy-{}.yml", id);
    fs::write(&path, &yaml).context("ポリシーファイルの書き込みに失敗しました")?;
    Ok(path)
}

fn check_prerequisites() -> anyhow::Result<bool> {
    let ngrok_ok = Command::new("ngrok")
        .args(["version"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok();
    if !ngrok_ok {
        style::error(
            "ngrok がインストールされていません。brew install ngrok などでインストールしてください",
        );
        return Ok(false);
    }

    let ngrok_config_ok = Command::new("ngrok")
        .args(["config", "check"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok();
    if !ngrok_config_ok {
        style::error(
            "ngrok authtoken が設定されていません。\n  ngrok config add-authtoken <token> を実行してください",
        );
        return Ok(false);
    }

    let opencode_ok = Command::new("opencode")
        .args(["version"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok();
    if !opencode_ok {
        style::error("opencode がインストールされていません");
        return Ok(false);
    }

    if !config::oauth_config_path().exists() {
        style::error(
            "Google OAuth 設定がありません。\n  mt opencode oauth setup を先に実行してください",
        );
        return Ok(false);
    }

    Ok(true)
}

fn get_ngrok_url() -> Option<String> {
    for _ in 0..10 {
        std::thread::sleep(Duration::from_secs(1));

        let output = duct::cmd!("curl", "-s", "http://127.0.0.1:4040/api/tunnels")
            .read()
            .ok()?;

        if let Ok(data) = serde_json::from_str::<NgrokTunnelsResponse>(&output)
            && let Some(tunnel) = data.tunnels.first()
            && let Some(ref url) = tunnel.public_url
        {
            return Some(url.clone());
        }
    }
    None
}

fn wait_for_signal(
    opencode_child: &mut Child,
    ngrok_child: &mut Child,
    policy_file: &str,
) -> anyhow::Result<()> {
    let policy_owned = policy_file.to_string();

    let mut sigset = SigSet::empty();
    sigset.add(Signal::SIGINT);
    sigset.add(Signal::SIGTERM);
    sigset
        .thread_block()
        .context("シグナルマスクの設定に失敗しました")?;

    style::info("Ctrl+C で停止できます");

    sigset.wait().context("シグナル待ちに失敗しました")?;

    style::info("\n終了中...");

    kill_child(opencode_child, "opencode web");
    kill_child(ngrok_child, "ngrok");

    delete_pid_data();
    let _ = fs::remove_file(&policy_owned);

    Ok(())
}

pub fn expose() -> anyhow::Result<()> {
    style::intro("OpenCode Web 公開");

    if let Some(existing) = read_pid_data() {
        let opencode_alive = is_process_alive(existing.opencode_pid);
        let ngrok_alive = is_process_alive(existing.ngrok_pid);
        if opencode_alive || ngrok_alive {
            style::error("既に OpenCode Web が起動中です:");
            style::info(&format!("  URL:              {}", existing.url));
            style::info(&format!("  opencode (PID):   {}", existing.opencode_pid));
            style::info(&format!("  ngrok (PID):      {}", existing.ngrok_pid));
            style::info(&format!("  起動ディレクトリ: {}", existing.repo_dir));
            style::info("  停止するには mt opencode web stop を実行してください");
            style::outro("起動を中止しました");
            return Ok(());
        }

        let _ = fs::remove_file(&existing.policy_file);
        delete_pid_data();
    }

    if !check_prerequisites()? {
        return Ok(());
    }

    let oauth_config = read_oauth_config()?;
    let repo_dir = std::env::current_dir().context("カレントディレクトリの取得に失敗しました")?;

    style::info("opencode web を起動中...");
    let (mut opencode_child, port) = spawn_opencode(&repo_dir)?;
    style::info(&format!("opencode web がポート {} で起動しました", port));

    style::info("トラフィックポリシーを生成中...");
    let policy_file = generate_policy_file(&oauth_config)?;

    style::info("ngrok を起動中...");
    let mut ngrok_child = Command::new("ngrok")
        .args([
            "http",
            &port.to_string(),
            "--traffic-policy-file",
            &policy_file,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .context("ngrok の起動に失敗しました")?;

    style::info("ngrok の URL を取得中...");
    let url =
        get_ngrok_url().ok_or_else(|| anyhow::anyhow!("ngrok の URL を取得できませんでした"))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let pid_data = PidData {
        opencode_pid: opencode_child.id() as i32,
        ngrok_pid: ngrok_child.id() as i32,
        port,
        url: url.clone(),
        repo_dir: repo_dir.to_string_lossy().to_string(),
        started_at: now,
        policy_file: policy_file.clone(),
    };
    write_pid_data(&pid_data)?;

    style::outro(&format!(
        "✅ OpenCode Web が公開されました\n\n  URL: {}\n  Ctrl+C で停止できます",
        url
    ));

    wait_for_signal(&mut opencode_child, &mut ngrok_child, &policy_file)?;

    style::outro("✅ セッションを停止しました");
    Ok(())
}

pub fn stop() -> anyhow::Result<()> {
    style::intro("OpenCode Web 停止");

    let data = match read_pid_data() {
        Some(d) => d,
        None => {
            style::info("起動中のセッションはありません");
            style::outro("完了");
            return Ok(());
        }
    };

    let opencode_alive = is_process_alive(data.opencode_pid);
    let ngrok_alive = is_process_alive(data.ngrok_pid);

    if !opencode_alive && !ngrok_alive {
        style::info("セッションは既に終了していました。PID ファイルを削除します");
        delete_pid_data();
        let _ = fs::remove_file(&data.policy_file);
        style::outro("完了");
        return Ok(());
    }

    if opencode_alive {
        kill_process(data.opencode_pid, "opencode web");
    }
    if ngrok_alive {
        kill_process(data.ngrok_pid, "ngrok");
    }

    delete_pid_data();
    let _ = fs::remove_file(&data.policy_file);

    style::outro("✅ セッションを停止しました");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_port_found() {
        let line = "  http://127.0.0.1:8080/  ";
        assert_eq!(extract_port(line), Some(8080));
    }

    #[test]
    fn test_extract_port_multiple() {
        let line = "first http://127.0.0.1:3000/ then http://127.0.0.1:4000/";
        assert_eq!(extract_port(line), Some(3000));
    }

    #[test]
    fn test_extract_port_no_match() {
        assert_eq!(extract_port("no port here"), None);
        assert_eq!(extract_port("http://localhost:8080/"), None);
        assert_eq!(extract_port(""), None);
    }

    #[test]
    fn test_pid_data_serde_roundtrip() {
        let data = PidData {
            opencode_pid: 12345,
            ngrok_pid: 67890,
            port: 8080,
            url: "https://abc.ngrok.io".into(),
            repo_dir: "/Users/mt/src/tools".into(),
            started_at: "1234567890".into(),
            policy_file: "/tmp/opencode-ngrok-policy-abc123.yml".into(),
        };

        let json = serde_json::to_string_pretty(&data).unwrap();
        let deserialized: PidData = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.opencode_pid, 12345);
        assert_eq!(deserialized.ngrok_pid, 67890);
        assert_eq!(deserialized.port, 8080);
        assert_eq!(deserialized.url, "https://abc.ngrok.io");
    }
}
