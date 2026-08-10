use std::io::BufRead;
use std::os::unix::net::UnixListener;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::Value;

pub(crate) fn git_command() -> Command {
    crate::git::common::command_with_clean_git_context("git")
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
