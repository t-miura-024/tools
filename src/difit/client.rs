//! 実行中 difit サーバへの HTTP クライアント（コメント選択キーの固定つき）。
//!
//! difit はコメントを diff の選択（base / target / baseMode）ごとのセッションに
//! 分離して保持する。選択クエリのない `difit comment get/add` や HTTP リクエストは
//! サーバ可変の `currentCommentSelection` を読み書きするため、人間がブラウザ UI の
//! リビジョンセレクタで別の選択に切り替えると、別セッション（多くは未 resolve 0 件）
//! を読んでゲートを無音で通過してしまう。
//!
//! そこで mt はサーバ起動直後に [`probe_selection`] で `/api/diff` の応答から
//! 解決済み選択を取得し、以降のコメント読み書きを [`CommentSelection`] のクエリで
//! 固定する。difit CLI の `comment get/add` は選択を引数で指定できないため、
//! 選択固定には HTTP API を使う。
//!
//! difit の内部契約への依存:
//! - `/api/diff` は選択クエリなしの場合、サーバの `currentSelection` を解決した
//!   `baseCommitish` / `targetCommitish` / `requestedBaseMode` を返す
//! - `/api/comments-json` と `/api/comment-imports` は `base` / `target` /
//!   `baseMode` クエリで対象セッションを決定する（`baseMode` 未指定は direct）
//!
//! これらは E2E テスト（check.test.rs / start.test.rs）で固定する。

use std::time::Duration;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

use super::gate::Thread;

/// difit サーバ HTTP API のタイムアウト。
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// `comment get --format json` 相当のレスポンス。
#[derive(Debug, Deserialize)]
pub struct CommentGetResponse {
    #[allow(dead_code)]
    pub version: u64,
    pub threads: Vec<Thread>,
}

/// difit がコメントセッションを識別する、解決済みの diff 選択。
///
/// `/api/diff` の応答（`baseCommitish` / `targetCommitish` / `requestedBaseMode`）
/// から作り、`ReviewState` に保存する。ブラウザ UI が同じ選択で使う
/// `base` / `target` / `baseMode` クエリと同じキーになる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentSelection {
    /// 解決済み base（short hash、または `staged` / `stdin`）。
    pub base: String,
    /// 解決済み target（short hash、または `.` / `working` / `staged` / `stdin`）。
    pub target: String,
    /// `merge-base` のときのみ `Some`。direct のときは None。
    ///
    /// 永続化（`.difit/difit-review.json`）と `mt difit threads --json` の出力は
    /// difit API と同じ `baseMode` キーを使う。
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "baseMode")]
    pub base_mode: Option<String>,
}

impl CommentSelection {
    /// `/api/comments-json` 等に付ける選択クエリ（先頭の `?` は含まない）。
    ///
    /// base / target を常に渡すことで、サーバ側 `currentCommentSelection` に
    /// 依存せず同じセッションを指す。direct（baseMode なし）はクエリからも
    /// 省き、difit のキー正規化（direct）と一致させる。
    ///
    /// 値は difit が返した解決済み commitish（short hash / 特殊ターゲット）だが、
    /// ブランチ由来の文字列がそのまま残る場合に備え、`&` `#` `%` `+` `=` 空白等を
    /// パーセントエンコードする。エンコードしないと `&` 以降が別パラメータとして
    /// 解釈され、読み書きが別セッションへ向かう（無音 pass / 追記漏れ）。
    pub fn query(&self) -> String {
        let mut query = format!(
            "base={}&target={}",
            encode_component(&self.base),
            encode_component(&self.target)
        );
        if let Some(base_mode) = &self.base_mode {
            query.push_str("&baseMode=");
            query.push_str(&encode_component(base_mode));
        }
        query
    }
}

/// URL のクエリ値・パスセグメントのパーセントエンコード
/// （RFC 3986 の unreserved のみ素通し）。
///
/// `+` はクエリ文字列によって空白として解釈されるため、unreserved には含めない。
/// すべての非 unreserved バイトを `%XX`（大文字 hex）へ変換する。reserved を
/// 過剰にエンコードしても、クエリパーサと `decodeURIComponent` は元の値へ戻す。
fn encode_component(value: &str) -> String {
    const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if UNRESERVED.contains(byte) {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build()
}

fn base_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

/// 起動直後の difit サーバから、解決済みの diff 選択を取得する。
///
/// `/api/diff` は選択クエリなしの場合サーバの `currentSelection`（起動引数から
/// 決まる初期選択）を解決し、その `baseCommitish` / `targetCommitish` /
/// `requestedBaseMode` を返す。これを起動直後に呼ぶことで、以降に注入する
/// コメントのセッションキーを確定できる。
///
/// `currentCommentSelection` の再解決を伴うが、初期選択と同一のため冪等。
pub fn probe_selection(port: u16) -> anyhow::Result<CommentSelection> {
    let url = format!("{}/api/diff", base_url(port));
    let response: serde_json::Value = agent()
        .get(&url)
        .call()
        .with_context(|| format!("{url} の取得に失敗しました"))?
        .into_json()
        .with_context(|| format!("{url} の応答を JSON としてパースできませんでした"))?;

    let Some(base) = response
        .get("baseCommitish")
        .and_then(|value| value.as_str())
    else {
        bail!("{url} の応答に baseCommitish がありません（difit の契約変更の可能性）");
    };
    let Some(target) = response
        .get("targetCommitish")
        .and_then(|value| value.as_str())
    else {
        bail!("{url} の応答に targetCommitish がありません（difit の契約変更の可能性）");
    };
    let base_mode = response
        .get("requestedBaseMode")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    Ok(CommentSelection {
        base: base.to_string(),
        target: target.to_string(),
        base_mode,
    })
}

/// 指定ポートの difit サーバから未 resolve スレッドを取得する。
///
/// `selection` が Some なら選択クエリでセッションを固定する（人間のリビジョン
/// 切替に影響されない）。None はサーバ同一性確認など、どのセッションでもよい
/// 用途に限る。
///
/// difit の契約により resolve 済みスレッドは応答に現れない。
pub fn fetch_comments(
    port: u16,
    selection: Option<&CommentSelection>,
) -> anyhow::Result<CommentGetResponse> {
    let mut url = format!("{}/api/comments-json", base_url(port));
    if let Some(selection) = selection {
        url.push('?');
        url.push_str(&selection.query());
    }

    let body = agent()
        .get(&url)
        .call()
        .with_context(|| format!("difit comment get（{url}）に失敗しました"))?
        .into_string()
        .with_context(|| format!("{url} の応答を読み取れませんでした"))?;

    serde_json::from_str(body.trim()).context("difit comment get の出力をパースできませんでした")
}

/// `difit comment resolve` 相当: 選択固定セッションのスレッドを削除（resolve）する。
///
/// difit CLI の `comment resolve` は選択クエリを指定できず、サーバ可変の
/// `currentCommentSelection`（ブラウザのリビジョン切替で変わる）へ DELETE を送る。
/// この関数は `selection` のクエリで対象セッションを固定し、`threadId` を
/// パスセグメントとしてエンコードして `DELETE /api/comments/<threadId>` を送る。
///
/// 404（既に resolve 済み・存在しない ID）は成功と区別できるよう明示エラーにする。
pub fn resolve_comment(
    port: u16,
    selection: Option<&CommentSelection>,
    thread_id: &str,
) -> anyhow::Result<()> {
    let mut url = format!(
        "{}/api/comments/{}",
        base_url(port),
        encode_component(thread_id)
    );
    if let Some(selection) = selection {
        url.push('?');
        url.push_str(&selection.query());
    }

    match agent().delete(&url).call() {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(404, _)) => bail!(
            "スレッド {thread_id} は既に resolve 済みか、固定した選択セッションに存在しません"
        ),
        Err(error) => {
            Err(error).with_context(|| format!("difit comment resolve（{url}）に失敗しました"))
        }
    }
}

/// difit の `/api/comment-imports` が受理する JSON ボディの上限。
///
/// difit 5.0.12 は `express.json()` の既定上限（100kb）でボディを制限し、超過を
/// 413 で拒否する。1 リクエストにまとめる量はこの上限に対する安全マージンとして
/// [`COMMENT_IMPORT_CHUNK_BYTES`] を使う。
const COMMENT_IMPORT_REQUEST_LIMIT: usize = 100 * 1024;

/// 1 リクエストで送るコメント import の上限（difit 側の 100kb 制限に対する余裕）。
const COMMENT_IMPORT_CHUNK_BYTES: usize = 64 * 1024;

/// `difit comment add` 相当: 実行中サーバの対象セッションへコメントを追記する。
///
/// difit 側は同一 import を content hash で冪等に扱うため、同一コメントの
/// 再投入でスレッドは重複しない。`selection` が Some なら選択クエリで
/// セッションを固定する。
///
/// コメント全量は大きくなり得る（未 resolve スレッドの再注入）。difit は
/// 1 リクエストの JSON ボディを 100kb で制限するため、[`chunk_comments`] で
/// 上限未満に分割して順に POST する。reply は親スレッドの直後に並ぶため、
/// 分割しても親スレッドの注入後に reply が届く（同一セッションへ追記される）。
pub fn add_comments(
    port: u16,
    selection: Option<&CommentSelection>,
    comments: &[serde_json::Value],
) -> anyhow::Result<()> {
    if comments.is_empty() {
        return Ok(());
    }

    let mut url = format!("{}/api/comment-imports", base_url(port));
    if let Some(selection) = selection {
        url.push('?');
        url.push_str(&selection.query());
    }

    // keep-alive を効かせるため、HTTP クライアントはチャンク間で 1 つを使い回す。
    let client = agent();
    for chunk in chunk_comments(comments)? {
        let payload = serde_json::to_string(chunk).context("コメント JSON のシリアライズに失敗")?;
        client
            .post(&url)
            .set("Content-Type", "application/json")
            .send_string(&payload)
            .with_context(|| format!("difit comment add（{url}）に失敗しました"))?;
    }
    Ok(())
}

/// コメント import を difit の 1 リクエスト上限未満のチャンクへ分割する。
///
/// 直列化後のサイズで詰め、[`COMMENT_IMPORT_CHUNK_BYTES`] を超えない範囲で
/// まとめる。単体でチャンク上限を超えるコメントはそれだけで 1 リクエストに
/// する（difit の上限自体を超える場合は difit 側が 413 で拒否するため、
/// 事前に明示エラーにする）。
fn chunk_comments(comments: &[serde_json::Value]) -> anyhow::Result<Vec<&[serde_json::Value]>> {
    let mut chunks: Vec<&[serde_json::Value]> = Vec::new();
    let mut start = 0;
    let mut size = 2; // "[]"

    for (index, comment) in comments.iter().enumerate() {
        let entry_len = serde_json::to_string(comment)
            .context("コメント JSON のシリアライズに失敗")?
            .len();
        // 単体チャンクとして送る場合のボディサイズは "[" + entry + "]" = entry_len + 2。
        // difit の上限を超える 1 件はどのチャンクにも収まらない。
        if entry_len + 2 > COMMENT_IMPORT_REQUEST_LIMIT {
            bail!(
                "コメント 1 件が difit の HTTP 取込上限（{} KiB）を超えているため注入できません。\
                 本文を分割するか、コメント数を減らしてください",
                COMMENT_IMPORT_REQUEST_LIMIT / 1024
            );
        }
        let entry_size = entry_len + 1; // 区切りカンマ
        if index > start && size + entry_size > COMMENT_IMPORT_CHUNK_BYTES {
            chunks.push(&comments[start..index]);
            start = index;
            size = 2;
        }
        size += entry_size;
    }
    if start < comments.len() {
        chunks.push(&comments[start..]);
    }
    Ok(chunks)
}

#[cfg(test)]
#[path = "client.test.rs"]
mod tests;
