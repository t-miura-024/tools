//! コメントの taxonomy 分類とゲート判定（純粋ドメイン規則）。
//!
//! fs・プロセス・difit サーバに依存しない。`mt difit check` のゲート意味論の
//! 唯一の判定実装であり、TS 側の formatReviewComment / collect_verdict が同じ
//! 契約を写している。
//!
//! - 未 resolve スレッドが 1 つでもブロッキングならゲートは通過しない
//! - 人間の投稿（author: `"User"`）は本文の内容にかかわらずブロックする
//! - want（AI）は人間 reply が付いた場合のみブロッキングに昇格する
//! - `[context]`（AI）は非ブロッキングだが、人間 reply が付いた場合は昇格する
//!   （人間の指示を無視しない）
//!
//! 「author が `"User"` のメッセージのみ人間由来」という外部契約は、difit UI が
//! 使う保存経路（`POST /api/comments`）の E2E で実 difit の配布物から author
//! ラベルを抽出して固定する（check.test.rs の UI 経路テスト）。

use serde::Deserialize;

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
    /// 投稿者。difit UI で人間が投稿したメッセージには `"User"` が付く。
    /// mt が HTTP import で注入した AI コメントは author を持たない。
    #[serde(default)]
    pub author: Option<String>,
    pub body: String,
}

/// コメント親本文の taxonomy 分類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Taxonomy {
    /// `[issue]` / `🐛 issue` — AI 発見の問題点（ブロッキング）
    Issue,
    /// `[question]` / `🙋 question` — AI が人間に判断を仰ぐ（ブロッキング）
    Question,
    /// `[context]` — 解説（ノンブロッキング。AI フローからは注入しない）
    Context,
    /// 人間の投稿（author: `"User"`）、または AI テンプレートにも旧プレフィックスにも
    /// 該当しない本文（ブロッキング）
    Human,
}

/// メッセージ本文の先頭行（ヘッダ行）を返す。
fn first_line(body: &str) -> &str {
    body.trim_start().lines().next().unwrap_or("")
}

/// ヘッダ行を `·` 区切りのトークン列にする。
///
/// 生成側（review-helpers の formatReviewComment）の契約は
/// `**🚨 must · 🐛 issue · 🎯 req-1**` の形式で、taxonomy / severity は
/// 1 行目ヘッダのトークンとしてのみ現れる。`**` 強調と旧形式の
/// taxonomy プレフィックス（`[issue]` 等）を外し、詳細本文（2 行目以降）は
/// 自由記述のため判定に使わない。
fn header_tokens(body: &str) -> Vec<&str> {
    let header = strip_legacy_prefix(first_line(body).trim());
    header
        .trim_start_matches("**")
        .trim_end_matches("**")
        .trim()
        .split('·')
        .map(str::trim)
        .collect()
}

/// 旧形式の taxonomy プレフィックス（`[issue]` 等）を先頭から外す。
fn strip_legacy_prefix(header: &str) -> &str {
    for prefix in ["[issue]", "[question]", "[context]"] {
        if let Some(rest) = header.strip_prefix(prefix) {
            return rest.trim_start();
        }
    }
    header
}

/// ヘッダ行にトークンが完全一致で現れるかどうか。
fn header_has_token(body: &str, token: &str) -> bool {
    header_tokens(body).contains(&token)
}

/// difit が人間の投稿に付ける author 値。
///
/// difit UI（クライアント）は人間のコメント / reply を `POST /api/comments` へ
/// `{threads, baseVersion}` で保存する際、メッセージにこのリテラルを埋め込む
/// （5.0.12 の dist/client 実装）。作者ラベルは mt が注入する AI コメント
/// （`/api/comment-imports` 経路、author なし）と人間投稿を区別する唯一の根拠
/// であり、difit 側がラベルを変えると「人間 reply 付き want の昇格」が無音で
/// 無効になる。そのため check.test.rs の UI 経路 E2E が difit の配布物から
/// author リテラルを抽出してこの値と一致することを固定し、変更時は失敗して
/// 追従を要求する。
const HUMAN_AUTHOR: &str = "User";

/// メッセージが人間（difit UI）の投稿かどうか。
///
/// 大文字小文字を無視して [`HUMAN_AUTHOR`] と完全一致する場合のみ true。
/// author なし・未知の author は人間とみなさない（[`has_human_reply`] 参照）。
fn is_human_author(author: Option<&str>) -> bool {
    author.is_some_and(|value| value.trim().eq_ignore_ascii_case(HUMAN_AUTHOR))
}

/// スレッドの親メッセージが人間（difit UI）の投稿かどうか。
///
/// `mt difit resolve` の防御（人間コメントは人間が resolve する）が使う。
/// author を持たない親メッセージは人間とみなさない（[`is_human_author`] と同一契約）。
pub(super) fn thread_parent_is_human(thread: &Thread) -> bool {
    thread
        .messages
        .first()
        .is_some_and(|message| is_human_author(message.author.as_deref()))
}

/// メッセージ body の taxonomy を分類する。
///
/// 旧形式のプレフィックス（`[issue]` / `[question]` / `[context]`）と、
/// GFM Markdown テンプレートの taxonomy 絵文字（`🐛 issue` / `🙋 question`）の
/// 両方を認識する。絵文字は 1 行目ヘッダの `·` 区切りトークンとしてのみ認識し、
/// 詳細本文中の文字列（人間が `🙋 question` 等を引用した場合を含む）では
/// 分類しない。
pub fn classify_body(body: &str) -> Taxonomy {
    let header = first_line(body);
    if header.starts_with("[issue]") || header_has_token(body, "🐛 issue") {
        Taxonomy::Issue
    } else if header.starts_with("[question]") || header_has_token(body, "🙋 question") {
        Taxonomy::Question
    } else if header.starts_with("[context]") {
        Taxonomy::Context
    } else {
        Taxonomy::Human
    }
}

/// メッセージの taxonomy を author を第一根拠にして分類する。
///
/// - 人間の投稿（author: `"User"`）→ `Human`（本文に taxonomy 風の文字列が
///   含まれても AI 指摘と誤認しない）
/// - それ以外（AI/不明）→ ヘッダ行の taxonomy を適用する
pub fn classify_message(message: &Message) -> Taxonomy {
    if is_human_author(message.author.as_deref()) {
        Taxonomy::Human
    } else {
        classify_body(&message.body)
    }
}

/// taxonomy がゲートをブロックするかどうか。
pub fn is_blocking(taxonomy: Taxonomy) -> bool {
    taxonomy != Taxonomy::Context
}

/// コメントが want 指摘かどうか（severity）。
///
/// want はノンブロッキングで、人間 reply が付いた場合のみブロッキングに昇格する。
/// - 現行テンプレート: 1 行目ヘッダの severity トークン `💡 want`
/// - 旧形式: `[question] ... (want)`（同じく 1 行目のみ）
pub fn is_want(body: &str) -> bool {
    if header_has_token(body, "💡 want") {
        return true;
    }
    let header = first_line(body);
    header.starts_with("[question]") && header.contains("(want)")
}

/// スレッドに人間（difit UI）の reply が付いているかどうか。
///
/// author が `"User"` の reply のみを人間由来とする。author を持たない reply は
/// 人間由来とみなさない（author の明示を唯一の根拠にし、AI の reply を人間の
/// 指示と誤認してブロック対象を広げない）。
///
/// この「author == `"User"` のみ人間」という契約は維持する。author 不明の reply を
/// 人間側（ブロック）へ倒す fail-closed は、author を持たない AI 経路の reply まで
/// 「人間の指示」としてブロック対象を広げてしまうため採用しない。difit UI の
/// author ラベル変更は check.test.rs の UI 経路 E2E が検知し、追従を要求する。
fn has_human_reply(thread: &Thread) -> bool {
    thread.messages[1..]
        .iter()
        .any(|message| is_human_author(message.author.as_deref()))
}

/// スレッド親の body がゲートをブロックするかどうか。
///
/// - メッセージなしスレッド → ブロックしない
/// - 人間の投稿（author: `"User"`）→ 本文の内容にかかわらずブロックする
/// - want（AI）→ 人間 reply がなければブロックしない。人間 reply があればブロッキングに昇格
/// - `[context]`（AI）→ 人間 reply がなければブロックしない。人間 reply があれば昇格
/// - `[issue]` / `[question]`（AI）、author 不明 → ブロック
///
/// 人間 reply による昇格は want だけに限らない。非ブロッキングの解説（`[context]`）
/// に人間が reply で指示した場合も「人間の指示」としてブロックする。
pub fn thread_blocks(thread: &Thread) -> bool {
    let Some(parent) = thread.messages.first() else {
        return false;
    };
    if is_human_author(parent.author.as_deref()) {
        return true;
    }
    if is_want(&parent.body) || !is_blocking(classify_body(&parent.body)) {
        return has_human_reply(thread);
    }
    true
}

/// 全スレッドのゲート判定を行う。未 resolve スレッドがすべてノンブロッキングなら true。
pub fn gate_passes(threads: &[Thread]) -> bool {
    !threads.iter().any(thread_blocks)
}

#[cfg(test)]
#[path = "gate.test.rs"]
mod tests;
