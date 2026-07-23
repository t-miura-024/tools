use super::*;

#[test]
fn test_parse_docker_ps_running_detects_running() {
    assert!(parse_docker_ps_running("running\n"));
    assert!(parse_docker_ps_running("running"));
    assert!(parse_docker_ps_running("  running  \n"));
    assert!(parse_docker_ps_running("exited\nrunning\n"));
}

#[test]
fn test_parse_docker_ps_running_rejects_non_running() {
    assert!(!parse_docker_ps_running(""));
    assert!(!parse_docker_ps_running("exited\n"));
    assert!(!parse_docker_ps_running("created\npaused\n"));
    assert!(!parse_docker_ps_running("not-running\n"));
}

#[test]
fn test_severity_from_chezmoi_exit_code() {
    assert_eq!(severity_from_chezmoi_exit_code(0), Severity::Ok);
    assert_eq!(severity_from_chezmoi_exit_code(1), Severity::Fatal);
    assert_eq!(severity_from_chezmoi_exit_code(2), Severity::Warn);
    assert_eq!(severity_from_chezmoi_exit_code(3), Severity::Warn);
}

#[test]
fn test_final_exit_code_mapping() {
    // 完了条件 6: 全 OK → 0、一部 warn → 2、致命的エラー → 1
    assert_eq!(final_exit_code(Severity::Ok), 0);
    assert_eq!(final_exit_code(Severity::Fatal), 1);
    assert_eq!(final_exit_code(Severity::Warn), 2);
}

#[test]
fn test_severity_ordering_keeps_worst() {
    assert_eq!(Severity::Ok.max(Severity::Warn), Severity::Warn);
    assert_eq!(Severity::Warn.max(Severity::Ok), Severity::Warn);
    assert_eq!(Severity::Warn.max(Severity::Fatal), Severity::Fatal);
    assert_eq!(Severity::Fatal.max(Severity::Warn), Severity::Fatal);
    assert_eq!(Severity::Ok.max(Severity::Ok), Severity::Ok);
}

#[test]
fn test_docker_services_cover_searxng_and_qdrant() {
    // 完了条件 2: SearXNG / Qdrant の両方がヘルスチェック対象
    let names: Vec<&str> = DOCKER_SERVICES.iter().map(|s| s.name).collect();
    assert!(
        names.contains(&"searxng"),
        "searxng が対象であるべき: {names:?}"
    );
    assert!(
        names.contains(&"qdrant"),
        "qdrant が対象であるべき: {names:?}"
    );
    for service in DOCKER_SERVICES {
        assert!(
            service.health_url.starts_with("http://localhost:"),
            "ヘルス URL は localhost 向きであるべき: {}",
            service.health_url
        );
        assert!(
            service.health_url.ends_with("/healthz"),
            "ヘルス URL は /healthz であるべき: {}",
            service.health_url
        );
    }
}
