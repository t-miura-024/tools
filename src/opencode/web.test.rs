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
