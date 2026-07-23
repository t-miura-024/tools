//! `mt doctor` 本体: システム全体の健全性チェックをセクション単位で実行する。
//!
//! チェックセクション（順に実行）:
//! 1. chezmoi チェック — `mt chezmoi doctor` のロジック
//!    ([`crate::chezmoi::doctor::run_checks`]) を関数呼び出しで再利用する
//! 2. Docker サービス — デーモン稼働 + コンテナ稼働状態（`docker ps`）+ HTTP ヘルスチェック
//! 3. ツールインストール状態 / drift — `mt tool verify` のロジック
//!    ([`crate::tool::verify::verify`]) を関数呼び出しで再利用する
//!
//! 終了コード: 0 = 全 OK、1 = 致命的エラー（後続チェックをスキップ）、2 = 一部 warn。

use std::process::{Command, Stdio};
use std::time::Duration;

use crate::cli::style;

/// HTTP ヘルスチェックのタイムアウト。
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

/// チェックセクションの重大度。`Ord` 導出により Ok < Warn < Fatal の順となり、
/// `max` で最も深刻な結果を保持できる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Severity {
    /// チェック合格。
    Ok,
    /// チェック失敗だが致命的ではない（終了コード 2）。
    Warn,
    /// 致命的エラー（終了コード 1、後続チェックをスキップ）。
    Fatal,
}

/// ヘルスチェック対象の Docker サービス。
struct DockerService {
    /// コンテナ名（docker-compose の `container_name` に対応）。
    name: &'static str,
    /// HTTP ヘルスチェックのエンドポイント。
    health_url: &'static str,
}

/// チェック対象の Docker サービス群（docker/README.md のサービス一覧に対応）。
const DOCKER_SERVICES: &[DockerService] = &[
    DockerService {
        name: "searxng",
        health_url: "http://localhost:8080/healthz",
    },
    DockerService {
        name: "qdrant",
        health_url: "http://localhost:6333/healthz",
    },
];

/// `mt doctor` を実行する。
pub fn run() -> anyhow::Result<()> {
    style::intro("mt doctor");
    let mut worst = Severity::Ok;

    // ── セクション 1: chezmoi チェック（mt chezmoi doctor のロジックを再利用）──
    let chezmoi_sev = match crate::chezmoi::doctor::run_checks() {
        Ok(code) => severity_from_chezmoi_exit_code(code),
        Err(err) => {
            style::error(&format!("chezmoi チェックを実行できませんでした: {err}"));
            Severity::Fatal
        }
    };
    worst = worst.max(chezmoi_sev);
    if worst == Severity::Fatal {
        fatal_exit();
    }

    // ── セクション 2: Docker サービス ──────────────────────────────
    style::intro("Docker サービス");
    if let Err(err) = check_docker_daemon() {
        style::error(&format!("Docker デーモンが起動していません: {err}"));
        style::info(
            "Docker Desktop を起動してから `mise run docker-up` を実行してください。後続チェックをスキップします",
        );
        fatal_exit();
    }
    style::success("Docker デーモン: 稼働中");
    for service in DOCKER_SERVICES {
        worst = worst.max(check_docker_service(service));
    }

    // ── セクション 3: ツールインストール状態 / drift（mt tool verify のロジックを再利用）──
    // verify() がマニフェスト（Brewfile / mise.toml / bun-global.yml）宣言と
    // インストール状態の突合を行い、自身の intro/outro でセクションを区切る。
    if let Err(err) = crate::tool::verify::verify() {
        style::warn(&format!("ツールインストール状態 / drift: {err}"));
        worst = worst.max(Severity::Warn);
    }

    // ── まとめ ─────────────────────────────────────────────────
    let code = final_exit_code(worst);
    if code == 0 {
        style::outro("doctor: すべてのチェック OK");
        return Ok(());
    }
    style::outro("doctor: 一部のチェックに問題があります。上のメッセージを参照してください");
    std::process::exit(code);
}

/// `mt chezmoi doctor` の終了コード（0=OK / 1=致命的 / 2=一部未設定）を `Severity` へ変換する。
fn severity_from_chezmoi_exit_code(code: i32) -> Severity {
    match code {
        0 => Severity::Ok,
        1 => Severity::Fatal,
        _ => Severity::Warn,
    }
}

/// 最も深刻な結果から最終終了コードを決定する: 0=全 OK、1=致命的エラー、2=一部 warn。
fn final_exit_code(worst: Severity) -> i32 {
    match worst {
        Severity::Ok => 0,
        Severity::Fatal => 1,
        Severity::Warn => 2,
    }
}

/// 致命的エラー時のまとめを表示して終了コード 1 で終了する。
fn fatal_exit() -> ! {
    style::outro("doctor: 致命的なエラーを検出しました。上のメッセージを参照してください");
    std::process::exit(1);
}

/// Docker デーモンの稼働を確認する。`docker ps` を実行できなければエラー。
fn check_docker_daemon() -> anyhow::Result<()> {
    let status = Command::new("docker")
        .args(["ps", "--format", "{{.Names}}"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| anyhow::anyhow!("docker コマンドの実行に失敗しました: {e}"))?;
    if !status.success() {
        anyhow::bail!("docker ps が失敗しました（Docker デーモン未起動の可能性）");
    }
    Ok(())
}

/// 単一の Docker サービスをチェックする: コンテナ稼働状態 + HTTP ヘルスチェック。
fn check_docker_service(service: &DockerService) -> Severity {
    match container_running(service.name) {
        Err(err) => {
            style::warn(&format!(
                "{}: コンテナ状態を取得できません: {err}",
                service.name
            ));
            return Severity::Warn;
        }
        Ok(false) => {
            style::warn(&format!(
                "{}: コンテナが起動していません（`mise run docker-up` で起動）",
                service.name
            ));
            return Severity::Warn;
        }
        Ok(true) => {}
    }

    match http_health_status(service.health_url) {
        Ok(200) => {
            style::success(&format!(
                "{}: コンテナ稼働中 + ヘルスチェック OK ({})",
                service.name, service.health_url
            ));
            Severity::Ok
        }
        Ok(code) => {
            style::warn(&format!(
                "{}: ヘルスチェックが HTTP {code} を返しました ({})",
                service.name, service.health_url
            ));
            Severity::Warn
        }
        Err(err) => {
            style::warn(&format!(
                "{}: ヘルスチェックに失敗しました: {err} ({})",
                service.name, service.health_url
            ));
            Severity::Warn
        }
    }
}

/// `docker ps` で指定コンテナを照会し、稼働中かどうかを返す。
fn container_running(name: &str) -> anyhow::Result<bool> {
    let output = Command::new("docker")
        .args([
            "ps",
            "--filter",
            &format!("name=^{name}$"),
            "--format",
            "{{.State}}",
        ])
        .output()
        .map_err(|e| anyhow::anyhow!("docker ps の実行に失敗しました: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("docker ps が失敗しました: {}", stderr.trim());
    }
    Ok(parse_docker_ps_running(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// `docker ps --format '{{.State}}'` の出力に "running" 行があるかを判定する。
fn parse_docker_ps_running(output: &str) -> bool {
    output.lines().any(|line| line.trim() == "running")
}

/// 指定 URL を HTTP GET し、ステータスコードを返す。接続失敗などは `Err`。
/// ureq は非 2xx レスポンスを `Err(Status)` として返すため、コードを抽出して返す。
fn http_health_status(url: &str) -> anyhow::Result<u16> {
    let agent = ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build();
    match agent.get(url).call() {
        Ok(response) => Ok(response.status()),
        Err(ureq::Error::Status(code, _)) => Ok(code),
        Err(err) => anyhow::bail!("{err}"),
    }
}

#[cfg(test)]
#[path = "check.test.rs"]
mod tests;
