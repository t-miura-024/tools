//! Herdr の raw socket API クライアント。
//!
//! newline-delimited JSON で `layout.export` / `layout.apply` / `tab.*` / `pane.*` 等の
//! method を呼び出す。transport は Unix domain socket 1 リクエスト = 1 接続で、
//! サーバーは応答後に接続を閉じる（実サーバー挙動）。
//!
//! socket パスは公式の解決規則に従う: `HERDR_SOCKET_PATH` があればそれ、
//! なければ `<XDG_CONFIG_HOME|~/.config>/herdr/herdr.sock`。

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config;

/// `layout.export` / `layout.apply` / `tab.focus` 等が必要とする最低 protocol バージョン。
/// method の availability は protocol バージョンで決まるため、capability 検査として使う。
pub const REQUIRED_PROTOCOL: u32 = 19;

/// Herdr が返す method error（`{"code": ..., "message": ...}`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for HerdrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "herdr API error [{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for HerdrError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Right,
    Down,
}

/// layout ツリーの wire 表現（`layout.export` の応答と `layout.apply` のリクエストで共用）。
/// pane ノードの `pane_id` / `cwd` / `command` / `env` は省略可能で、リクエスト時は
/// 指定したフィールドのみ送信される。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WireNode {
    #[serde(rename = "pane")]
    Pane {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<std::collections::BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename = "split")]
    Split {
        direction: SplitDirection,
        ratio: f64,
        first: Box<WireNode>,
        second: Box<WireNode>,
    },
}

impl WireNode {
    /// root から `pane_id` を持つ pane への tree path（split の子 index 列）を求める。
    pub fn pane_path(&self, pane_id: &str) -> Option<Vec<usize>> {
        fn walk(node: &WireNode, target: &str, path: &mut Vec<usize>) -> Option<Vec<usize>> {
            match node {
                WireNode::Pane { pane_id, .. } if pane_id.as_deref() == Some(target) => {
                    Some(path.clone())
                }
                WireNode::Pane { .. } => None,
                WireNode::Split { first, second, .. } => {
                    path.push(0);
                    if let Some(found) = walk(first, target, path) {
                        return Some(found);
                    }
                    path.pop();
                    path.push(1);
                    if let Some(found) = walk(second, target, path) {
                        return Some(found);
                    }
                    path.pop();
                    None
                }
            }
        }
        walk(self, pane_id, &mut Vec::new())
    }

    /// tree path が指すノードの pane_id を返す（pane ノードでない / 範囲外は None）。
    pub fn pane_id_at_path(&self, path: &[usize]) -> Option<String> {
        let mut node = self;
        for &idx in path {
            match node {
                WireNode::Split { first, second, .. } if idx == 0 => node = first,
                WireNode::Split {
                    first: _, second, ..
                } if idx == 1 => node = second,
                _ => return None,
            }
        }
        match node {
            WireNode::Pane { pane_id, .. } => pane_id.clone(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PongInfo {
    pub version: String,
    pub protocol: u32,
}

#[derive(Debug, Clone)]
pub struct HerdrSocket {
    path: PathBuf,
}

impl HerdrSocket {
    /// `HERDR_SOCKET_PATH` があればそれを、なければ
    /// `<XDG_CONFIG_HOME|~/.config>/herdr/herdr.sock` を使う。
    pub fn resolve() -> anyhow::Result<Self> {
        let path = match std::env::var("HERDR_SOCKET_PATH") {
            Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => {
                let config_home = std::env::var("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| config::home_dir().join(".config"));
                config_home.join("herdr").join("herdr.sock")
            }
        };
        Ok(Self { path })
    }

    /// テスト用: socket パスを直接指定する。
    #[cfg(test)]
    pub fn at(path: impl AsRef<std::path::Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    /// 1 リクエスト = 1 接続で method を呼び、`result` オブジェクトを返す。
    pub fn rpc(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let request = json!({ "id": id, "method": method, "params": params });
        let mut line =
            serde_json::to_string(&request).context("リクエストのシリアライズに失敗しました")?;
        line.push('\n');

        let stream = UnixStream::connect(&self.path).with_context(|| {
            format!(
                "herdr サーバーソケット {} に接続できません（herdr が起動していません）",
                self.path.display()
            )
        })?;
        let mut reader = BufReader::new(stream.try_clone().context("socket の複製に失敗しました")?);
        let mut writer = stream;

        writer
            .write_all(line.as_bytes())
            .context("herdr へのリクエスト送信に失敗しました")?;
        writer
            .flush()
            .context("herdr へのリクエスト送信に失敗しました")?;

        let mut response = String::new();
        reader
            .read_line(&mut response)
            .context("herdr からの応答の読み取りに失敗しました")?;
        let value: Value = serde_json::from_str(&response).with_context(|| {
            format!("herdr の応答を JSON として解釈できませんでした: {response}")
        })?;

        let resp_id = value
            .get("id")
            .and_then(|v| v.as_str())
            .context("herdr の応答に id がありません")?;
        if resp_id != id {
            bail!("herdr の応答 id がリクエストと一致しません（{resp_id} != {id}）");
        }

        if let Some(error) = value.get("error") {
            let code = error
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let message = error
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error")
                .to_string();
            return Err(anyhow::Error::new(HerdrError { code, message }));
        }

        value
            .get("result")
            .cloned()
            .context("herdr の応答に result がありません")
    }

    /// ping でサーバー情報（バージョン / protocol）を取得する。
    pub fn ping(&self) -> anyhow::Result<PongInfo> {
        let result = self.rpc("ping", json!({}))?;
        if result.get("type").and_then(|v| v.as_str()) != Some("pong") {
            bail!("ping の応答が pong ではありません: {result}");
        }
        let protocol = result
            .get("protocol")
            .and_then(|v| v.as_u64())
            .context("pong の応答に protocol がありません")? as u32;
        let version = result
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        Ok(PongInfo { version, protocol })
    }

    /// `layout.export` / `layout.apply` 等に必要な protocol capability を検査する。
    /// 不足時は旧 snapshot 再構成へ切り替えずエラーにする。
    pub fn ensure_capabilities(&self) -> anyhow::Result<PongInfo> {
        let pong = self.ping()?;
        if pong.protocol < REQUIRED_PROTOCOL {
            bail!(
                "herdr サーバーの protocol {} は layout.export / layout.apply が必要とする protocol {} 未満です（herdr の更新が必要です）",
                pong.protocol,
                REQUIRED_PROTOCOL
            );
        }
        Ok(pong)
    }

    // ---- テンプレート機能が使う API ----

    /// workspace.get でワークスペースのアクティブタブ ID を取得する。
    /// ワークスペースが存在しない場合は herdr のエラーがそのまま返る。
    pub fn workspace_active_tab(&self, workspace_id: &str) -> anyhow::Result<String> {
        let result = self.rpc("workspace.get", json!({ "workspace_id": workspace_id }))?;
        let workspace = result
            .get("workspace")
            .context("workspace.get の応答に workspace がありません")?;
        workspace
            .get("active_tab_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .context("workspace.get の応答に active_tab_id がありません")
    }

    /// tab.list でワークスペースのタブを番号順に取得する。
    pub fn tab_list(&self, workspace_id: &str) -> anyhow::Result<Vec<TabInfo>> {
        let result = self.rpc("tab.list", json!({ "workspace_id": workspace_id }))?;
        let tabs = result
            .get("tabs")
            .and_then(|v| v.as_array())
            .context("tab.list の応答に tabs がありません")?;
        let mut tabs: Vec<TabInfo> = tabs
            .iter()
            .map(|t| serde_json::from_value(t.clone()).context("tab エントリの解析に失敗しました"))
            .collect::<anyhow::Result<_>>()?;
        tabs.sort_by_key(|t| t.number);
        Ok(tabs)
    }

    /// layout.export でタブの portable layout tree を取得する。
    pub fn layout_export(
        &self,
        workspace_id: &str,
        tab_id: &str,
    ) -> anyhow::Result<LayoutDescription> {
        let result = self.rpc(
            "layout.export",
            json!({ "workspace_id": workspace_id, "tab_id": tab_id }),
        )?;
        let layout = result
            .get("layout")
            .context("layout.export の応答に layout がありません")?;
        serde_json::from_value(layout.clone()).context("layout.export の応答の解析に失敗しました")
    }

    /// layout.apply で既存タブを置換する。応答の layout に適用後のタブ ID が入る。
    /// tab_id と workspace_id を同時に指定できないため、置換は tab_id のみ送る。
    /// tab_label を指定しないと herdr が旧タブ名を引き継ぐため、テンプレートのタブ名を渡す。
    pub fn layout_apply_replace(
        &self,
        tab_id: &str,
        tab_label: &str,
        root: &WireNode,
    ) -> anyhow::Result<LayoutDescription> {
        self.layout_apply(json!({
            "tab_id": tab_id,
            "tab_label": tab_label,
            "root": root,
            "focus": false,
        }))
    }

    /// layout.apply で新規タブを追加する（tab_label が新しいタブのラベルになる）。
    pub fn layout_apply_create(
        &self,
        workspace_id: &str,
        tab_label: &str,
        root: &WireNode,
    ) -> anyhow::Result<LayoutDescription> {
        self.layout_apply(json!({
            "workspace_id": workspace_id,
            "tab_label": tab_label,
            "root": root,
            "focus": false,
        }))
    }

    fn layout_apply(&self, params: Value) -> anyhow::Result<LayoutDescription> {
        let result = self.rpc("layout.apply", params)?;
        let layout = result
            .get("layout")
            .context("layout.apply の応答に layout がありません")?;
        serde_json::from_value(layout.clone()).context("layout.apply の応答の解析に失敗しました")
    }

    pub fn tab_focus(&self, tab_id: &str) -> anyhow::Result<()> {
        self.rpc("tab.focus", json!({ "tab_id": tab_id }))?;
        Ok(())
    }

    pub fn tab_close(&self, tab_id: &str) -> anyhow::Result<()> {
        self.rpc("tab.close", json!({ "tab_id": tab_id }))?;
        Ok(())
    }

    pub fn pane_focus(&self, pane_id: &str) -> anyhow::Result<()> {
        self.rpc("pane.focus", json!({ "pane_id": pane_id }))?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TabInfo {
    pub tab_id: String,
    pub workspace_id: String,
    pub number: u32,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LayoutDescription {
    pub workspace_id: String,
    pub tab_id: String,
    pub zoomed: bool,
    pub focused_pane_id: String,
    pub root: WireNode,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::MockHerdr;

    /// テスト用のモック herdr サーバー（crate::test_support::MockHerdr）。
    fn mock_socket(handler: impl Fn(&Value) -> Value + Send + Sync + 'static) -> MockHerdr {
        MockHerdr::start(handler)
    }

    /// リクエスト id をエコーする汎用応答ビルダー。
    fn respond(request: &Value, result: Value) -> Value {
        json!({ "id": request.get("id"), "result": result })
    }

    fn method(request: &Value) -> String {
        request
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    #[test]
    fn test_rpc_round_trip() {
        let mock = mock_socket(|request| {
            assert_eq!(method(request), "layout.export");
            respond(
                request,
                json!({
                    "type": "layout_export",
                    "layout": {
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "zoomed": false,
                        "focused_pane_id": "w1:p1",
                        "root": {
                            "type": "split",
                            "direction": "right",
                            "ratio": 0.5,
                            "first": {"type": "pane", "pane_id": "w1:p1", "cwd": "/tmp"},
                            "second": {"type": "pane", "pane_id": "w1:p2", "label": "editor"}
                        }
                    }
                }),
            )
        });

        let layout = mock.socket.layout_export("w1", "w1:t1").unwrap();
        assert_eq!(layout.tab_id, "w1:t1");
        assert_eq!(layout.focused_pane_id, "w1:p1");
        let WireNode::Split {
            direction,
            ratio,
            first,
            second,
        } = &layout.root
        else {
            panic!("root は split のはず");
        };
        assert_eq!(*direction, SplitDirection::Right);
        assert_eq!(*ratio, 0.5);
        assert!(matches!(first.as_ref(), WireNode::Pane { cwd: Some(c), .. } if c == "/tmp"));
        assert!(matches!(
            second.as_ref(),
            WireNode::Pane { label: Some(l), .. } if l == "editor"
        ));

        let requests = mock.requests.lock().unwrap();
        let params = requests[0].get("params").unwrap();
        assert_eq!(params.get("workspace_id").unwrap(), "w1");
        assert_eq!(params.get("tab_id").unwrap(), "w1:t1");
    }

    #[test]
    fn test_rpc_error_response() {
        let mock = mock_socket(|request| {
            json!({
                "id": request.get("id"),
                "error": {"code": "layout_not_found", "message": "layout target not found"}
            })
        });

        let err = mock.socket.layout_export("w9", "w9:t9").unwrap_err();
        let herdr_err = err.downcast_ref::<HerdrError>().expect("HerdrError のはず");
        assert_eq!(herdr_err.code, "layout_not_found");
        assert_eq!(herdr_err.message, "layout target not found");
        assert!(err.to_string().contains("layout_not_found"));
    }

    #[test]
    fn test_rpc_parse_error() {
        let mock = mock_socket(|_request| json!({ "unexpected": true }));

        let err = mock.socket.ping().unwrap_err();
        assert!(err.to_string().contains("id"), "{err}");
    }

    #[test]
    fn test_ping_and_capabilities_ok() {
        let mock = mock_socket(|request| {
            respond(
                request,
                json!({
                    "type": "pong",
                    "version": "0.8.0",
                    "protocol": REQUIRED_PROTOCOL,
                    "capabilities": {"live_handoff": true}
                }),
            )
        });

        let pong = mock.socket.ensure_capabilities().unwrap();
        assert_eq!(pong.version, "0.8.0");
        assert_eq!(pong.protocol, REQUIRED_PROTOCOL);
    }

    #[test]
    fn test_capabilities_reject_old_protocol() {
        let mock = mock_socket(|request| {
            respond(
                request,
                json!({ "type": "pong", "version": "0.1.0", "protocol": 5 }),
            )
        });

        let err = mock.socket.ensure_capabilities().unwrap_err();
        assert!(err.to_string().contains("protocol"), "{err}");
        assert!(err.to_string().contains("5"), "{err}");
    }

    #[test]
    fn test_ping_reject_non_pong() {
        let mock =
            mock_socket(|request| respond(request, json!({ "type": "tab_list", "tabs": [] })));

        let err = mock.socket.ping().unwrap_err();
        assert!(err.to_string().contains("pong"), "{err}");
    }

    #[test]
    fn test_tab_list_sorted_by_number() {
        let mock = mock_socket(|request| {
            respond(
                request,
                json!({
                    "type": "tab_list",
                    "tabs": [
                        {"tab_id": "w1:t2", "workspace_id": "w1", "number": 2, "label": "b"},
                        {"tab_id": "w1:t1", "workspace_id": "w1", "number": 1, "label": "a"}
                    ]
                }),
            )
        });

        let tabs = mock.socket.tab_list("w1").unwrap();
        let ids: Vec<&str> = tabs.iter().map(|t| t.tab_id.as_str()).collect();
        assert_eq!(ids, vec!["w1:t1", "w1:t2"]);
    }

    #[test]
    fn test_layout_apply_replace_params() {
        let mock = mock_socket(|request| {
            assert_eq!(method(request), "layout.apply");
            respond(
                request,
                json!({
                    "type": "layout_apply",
                    "layout": {
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "zoomed": false,
                        "focused_pane_id": "w1:p9",
                        "root": {"type": "pane", "pane_id": "w1:p9", "cwd": "/tmp"}
                    }
                }),
            )
        });

        let root = WireNode::Pane {
            pane_id: None,
            cwd: Some("/cwd".to_string()),
            command: None,
            env: None,
            label: None,
        };
        let layout = mock
            .socket
            .layout_apply_replace("w1:t1", "Agent", &root)
            .unwrap();
        assert_eq!(layout.tab_id, "w1:t1");

        let requests = mock.requests.lock().unwrap();
        let params = requests[0].get("params").unwrap();
        assert_eq!(params.get("tab_id").unwrap(), "w1:t1");
        assert_eq!(
            params.get("workspace_id"),
            None,
            "置換時は workspace_id を送らない"
        );
        assert_eq!(params.get("tab_label").unwrap(), "Agent");
        assert_eq!(params.get("focus"), Some(&json!(false)));
        let root = params.get("root").unwrap();
        assert_eq!(root.get("type").unwrap(), "pane");
        assert_eq!(root.get("cwd").unwrap(), "/cwd");
        assert_eq!(root.get("command"), None, "command は送信しない");
    }

    #[test]
    fn test_layout_apply_create_params() {
        let mock = mock_socket(|request| {
            respond(
                request,
                json!({
                    "type": "layout_apply",
                    "layout": {
                        "workspace_id": "w1",
                        "tab_id": "w1:t9",
                        "zoomed": false,
                        "focused_pane_id": "w1:p9",
                        "root": {"type": "pane", "pane_id": "w1:p9"}
                    }
                }),
            )
        });

        let root = WireNode::Pane {
            pane_id: None,
            cwd: None,
            command: None,
            env: None,
            label: Some("work".to_string()),
        };
        let layout = mock
            .socket
            .layout_apply_create("w1", "new tab", &root)
            .unwrap();
        assert_eq!(layout.tab_id, "w1:t9");

        let requests = mock.requests.lock().unwrap();
        let params = requests[0].get("params").unwrap();
        assert_eq!(params.get("tab_id"), None);
        assert_eq!(params.get("tab_label").unwrap(), "new tab");
    }

    #[test]
    fn test_wire_node_pane_path() {
        let root = json!({
            "type": "split",
            "direction": "right",
            "ratio": 0.5,
            "first": {
                "type": "split",
                "direction": "down",
                "ratio": 0.4,
                "first": {"type": "pane", "pane_id": "p1"},
                "second": {"type": "pane", "pane_id": "p2"}
            },
            "second": {"type": "pane", "pane_id": "p3"}
        });
        let root: WireNode = serde_json::from_value(root).unwrap();

        assert_eq!(root.pane_path("p2"), Some(vec![0, 1]));
        assert_eq!(root.pane_path("p3"), Some(vec![1]));
        assert_eq!(root.pane_path("p1"), Some(vec![0, 0]));
        assert_eq!(root.pane_path("nope"), None);

        assert_eq!(root.pane_id_at_path(&[0, 1]), Some("p2".to_string()));
        assert_eq!(root.pane_id_at_path(&[1]), Some("p3".to_string()));
        assert_eq!(root.pane_id_at_path(&[0, 2]), None);
        assert_eq!(
            root.pane_id_at_path(&[0, 0, 0]),
            None,
            "split で終端した path は None"
        );
    }
}
