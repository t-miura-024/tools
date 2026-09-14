//! `gate`（taxonomy 分類・ゲート判定）のテスト。
//!
//! fs / プロセス / difit サーバに依存しない純粋規則の契約を固定する。

use super::*;

// ---------------------------------------------------------------------------
// classify_body
// ---------------------------------------------------------------------------

#[test]
fn test_classify_body_issue() {
    assert_eq!(classify_body("[issue] something wrong"), Taxonomy::Issue);
}

#[test]
fn test_classify_body_question() {
    assert_eq!(
        classify_body("[question] should we do X?"),
        Taxonomy::Question
    );
}

#[test]
fn test_classify_body_context() {
    assert_eq!(
        classify_body("[context] this is background info"),
        Taxonomy::Context
    );
}

#[test]
fn test_classify_body_human_no_prefix() {
    assert_eq!(classify_body("I think this is fine"), Taxonomy::Human);
}

#[test]
fn test_classify_body_leading_whitespace() {
    assert_eq!(classify_body("  [issue] indented"), Taxonomy::Issue);
}

#[test]
fn test_classify_body_empty() {
    assert_eq!(classify_body(""), Taxonomy::Human);
}

#[test]
fn test_classify_body_gfm_issue_emoji() {
    assert_eq!(
        classify_body("🚨 must · 🐛 issue · 🎯 req-1 | src/a.rs:1 — detail"),
        Taxonomy::Issue
    );
}

#[test]
fn test_classify_body_gfm_question_emoji() {
    assert_eq!(
        classify_body("⚠️ should · 🙋 question · 🧩 arch-1 | src/a.rs:1 — detail"),
        Taxonomy::Question
    );
}

#[test]
fn test_classify_body_gfm_want_is_question_taxonomy() {
    assert_eq!(
        classify_body("💡 want · 🙋 question · ⚡ logic-4 | src/a.rs:1 — detail"),
        Taxonomy::Question
    );
}

#[test]
fn test_classify_body_human_body_mentioning_taxonomy_words() {
    // 絵文字を伴わない単語だけでは taxonomy と判定しない
    assert_eq!(
        classify_body("issue という言葉を含む人間コメント"),
        Taxonomy::Human
    );
}

#[test]
fn test_classify_body_uses_first_line_only() {
    // ヘッダ（1 行目）が taxonomy を決める。詳細本文中の絵文字は参照しない。
    let body = "**🚨 must · 🐛 issue · 🎯 req-1**\n\n**詳細**:\n\n🙋 question に分類されるべきか。";
    assert_eq!(classify_body(body), Taxonomy::Issue);
}

#[test]
fn test_classify_body_ignores_taxonomy_tokens_after_first_line() {
    let body = "人間のコメント\n\n🐛 issue という文字列を含むだけ";
    assert_eq!(classify_body(body), Taxonomy::Human);
}

// ---------------------------------------------------------------------------
// classify_message（author を第一根拠にする）
// ---------------------------------------------------------------------------

#[test]
fn test_classify_message_human_author_overrides_body_taxonomy() {
    let message = make_message(
        "m1",
        Some("User"),
        "**🚨 must · 🐛 issue · 🎯 req-1** を引用した人間コメント",
    );
    assert_eq!(classify_message(&message), Taxonomy::Human);
}

#[test]
fn test_classify_message_ai_author_uses_header() {
    let message = make_message(
        "m1",
        Some("AI"),
        "**🚨 must · 🐛 issue · 🎯 req-1**\n\n**詳細**:\n\ndetail",
    );
    assert_eq!(classify_message(&message), Taxonomy::Issue);
}

#[test]
fn test_classify_message_without_author_uses_header() {
    let message = make_message("m1", None, "💡 want · 🙋 question · ⚡ logic-4 | a:1 — x");
    assert_eq!(classify_message(&message), Taxonomy::Question);
}

// ---------------------------------------------------------------------------
// thread_parent_is_human（resolve 防御の根拠）
// ---------------------------------------------------------------------------

/// ヘルパー: メッセージ列からスレッドを組み立てる。
fn make_thread_with_messages(messages: Vec<Message>) -> Thread {
    Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages,
    }
}

#[test]
fn test_thread_parent_is_human_detects_user_author() {
    let thread = make_thread_with_messages(vec![make_message("m1", Some("User"), "ここを直して")]);
    assert!(thread_parent_is_human(&thread));
}

#[test]
fn test_thread_parent_is_human_ignores_ai_parent_with_human_reply() {
    // 人間 reply 付きの want は修正後にエージェントが resolve してよい（親 author のみ見る）
    let thread = make_thread_with_messages(vec![
        make_message("m1", None, "💡 want · 🙋 question · ⚡ logic-4 | a:1 — x"),
        make_message("m2", Some("User"), "これも直して"),
    ]);
    assert!(!thread_parent_is_human(&thread));
}

#[test]
fn test_thread_parent_is_human_false_for_empty_thread() {
    assert!(!thread_parent_is_human(&make_thread_with_messages(
        Vec::new()
    )));
}

// ---------------------------------------------------------------------------
// is_blocking
// ---------------------------------------------------------------------------

#[test]
fn test_is_blocking_issue() {
    assert!(is_blocking(Taxonomy::Issue));
}

#[test]
fn test_is_blocking_question() {
    assert!(is_blocking(Taxonomy::Question));
}

#[test]
fn test_is_blocking_human() {
    assert!(is_blocking(Taxonomy::Human));
}

#[test]
fn test_is_blocking_context_not_blocking() {
    assert!(!is_blocking(Taxonomy::Context));
}

// ---------------------------------------------------------------------------
// is_want
// ---------------------------------------------------------------------------

#[test]
fn test_is_want_gfm_template() {
    assert!(is_want(
        "💡 want · 🙋 question · ⚡ logic-4 | src/a.rs:1 — detail"
    ));
}

#[test]
fn test_is_want_legacy_prefix() {
    assert!(is_want("[question] (want) consider this"));
}

#[test]
fn test_is_want_legacy_prefix_with_gfm() {
    assert!(is_want(
        "[question] 💡 want · 🙋 question | src/a.rs:1 — detail"
    ));
}

#[test]
fn test_is_want_must_body_containing_word_want() {
    // severity マーカーではなく本文中に want の語が現れるだけでは want ではない
    assert!(!is_want(
        "🚨 must · 🐛 issue · 🎯 req-1 | src/a.rs:1 — user wants more"
    ));
}

#[test]
fn test_is_want_question_without_want_severity() {
    assert!(!is_want("[question] which approach?"));
}

#[test]
fn test_is_want_ignores_want_token_in_detail() {
    // テンプレート 1 行目ヘッダのみを判定し、詳細本文中の 💡 want は誤検知しない
    let body = "**🚨 must · 🐛 issue · 🎯 req-1**\n\n**詳細**:\n\n💡 want も検討する。";
    assert!(!is_want(body));
}

#[test]
fn test_is_want_ignores_want_token_after_first_line() {
    let body = "human comment\n\n💡 want this too";
    assert!(!is_want(body));
}

#[test]
fn test_is_want_empty() {
    assert!(!is_want(""));
}

// ---------------------------------------------------------------------------
// thread_blocks / gate_passes
// ---------------------------------------------------------------------------

pub(super) fn make_message(id: &str, author: Option<&str>, body: &str) -> Message {
    Message {
        id: id.to_string(),
        author: author.map(str::to_string),
        body: body.to_string(),
    }
}

pub(super) fn make_thread(body: &str) -> Thread {
    Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![make_message("m1", None, body)],
    }
}

pub(super) fn make_thread_with_author(author: &str, body: &str) -> Thread {
    Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![make_message("m1", Some(author), body)],
    }
}

pub(super) fn make_thread_with_reply(parent_body: &str, reply_body: &str) -> Thread {
    make_thread_with_authors(None, parent_body, None, reply_body)
}

pub(super) fn make_thread_with_authors(
    parent_author: Option<&str>,
    parent_body: &str,
    reply_author: Option<&str>,
    reply_body: &str,
) -> Thread {
    Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![
            make_message("m1", parent_author, parent_body),
            make_message("m2", reply_author, reply_body),
        ],
    }
}

#[test]
fn test_gate_passes_empty_threads() {
    assert!(gate_passes(&[]));
}

#[test]
fn test_gate_passes_context_only() {
    let threads = vec![make_thread("[context] FYI")];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_passes_multiple_context() {
    let threads = vec![
        make_thread("[context] info 1"),
        make_thread("[context] info 2"),
    ];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_blocks_issue() {
    let threads = vec![make_thread("[issue] bug found")];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_blocks_question() {
    let threads = vec![make_thread("[question] which approach?")];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_blocks_human_comment() {
    let threads = vec![make_thread("please fix this")];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_blocks_mixed_with_issue() {
    let threads = vec![
        make_thread("[context] info"),
        make_thread("[issue] problem"),
    ];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_passes_want_only() {
    // want はノンブロッキング
    let threads = vec![make_thread("💡 want · 🙋 question · ⚡ logic-4 | a:1 — x")];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_promotes_want_with_human_reply() {
    // 人間 reply（author: "User"）のある want はブロッキングに昇格する
    let threads = vec![make_thread_with_authors(
        None,
        "💡 want · 🙋 question · ⚡ logic-4 | a.txt:1 — x",
        Some("User"),
        "please fix this too",
    )];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_does_not_promote_want_with_authorless_reply() {
    // author を持たない reply は人間由来とみなさない（author: "User" が唯一の根拠）
    let threads = vec![make_thread_with_reply(
        "💡 want · 🙋 question · ⚡ logic-4 | a.txt:1 — x",
        "not a human reply",
    )];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_promotes_context_with_human_reply() {
    // 非ブロッキングの [context] でも、人間（author: "User"）の reply は
    // 人間の指示としてブロックする
    let threads = vec![make_thread_with_authors(
        None,
        "[context] FYI",
        Some("User"),
        "これも直して",
    )];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_does_not_promote_context_with_authorless_reply() {
    let threads = vec![make_thread_with_reply("[context] FYI", "generated reply")];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_does_not_promote_want_with_explicit_ai_reply() {
    // author: "AI" の reply は人間 reply ではないため昇格しない
    let threads = vec![make_thread_with_authors(
        Some("AI"),
        "💡 want · 🙋 question · ⚡ logic-4 | a.txt:1 — x",
        Some("AI"),
        "[issue] generated reply",
    )];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_does_not_promote_want_with_unknown_author_reply() {
    // 現行契約の維持: author が "User" と一致しない reply（未知の author）は
    // 人間とみなさない。author 不明を人間側へ倒す fail-closed にすると、author を
    // 持たない AI 経路の reply まで「人間の指示」としてブロック対象を広げてしまう。
    // difit UI が author ラベルを変えた場合は、実 difit の配布物からラベルを
    // 抽出する E2E（check.test.rs の UI 経路テスト）が検知して追従を要求する。
    let threads = vec![make_thread_with_authors(
        None,
        "💡 want · 🙋 question · ⚡ logic-4 | a.txt:1 — x",
        Some("Alice"),
        "maybe fix later",
    )];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_blocks_human_comment_quoting_want_token() {
    // 人間（author: "User"）のコメントは本文に 💡 want を含んでいてもブロックする
    let threads = vec![make_thread_with_author(
        "User",
        "**💡 want · 🙋 question · ⚡ logic-4** を引用した人間の指摘",
    )];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_blocks_human_comment_quoting_question_token() {
    let threads = vec![make_thread_with_author(
        "User",
        "**⚠️ should · 🙋 question · 🧩 arch-1** への回答",
    )];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_passes_ai_context_with_taxonomy_token_in_detail() {
    // AI の [context] スレッドは詳細本文に別 taxonomy を含んでも通過する
    let threads = vec![make_thread(
        "[context] info\n\n🐛 issue という文字列を含むが解説",
    )];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_passes_want_with_taxonomy_token_in_detail() {
    // ヘッダが want なら詳細本文の 💡 want ではなくヘッダで判定する
    let threads = vec![make_thread(
        "💡 want · 🙋 question · ⚡ logic-4 | a:1 — x\n\n**詳細**:\n\n🐛 issue にも見える",
    )];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_blocks_parent_issue_with_reply() {
    let threads = vec![make_thread_with_reply("[issue] problem", "I agree")];
    assert!(!gate_passes(&threads));
}

#[test]
fn test_gate_uses_parent_body_not_reply() {
    // 親が [context]、reply が [issue] でも、reply が人間（author: "User"）で
    // なければゲートは通過する（ブロック判定は親 body + 人間 reply で決まる）
    let threads = vec![make_thread_with_reply(
        "[context] info",
        "[issue] reply issue",
    )];
    assert!(gate_passes(&threads));
}

#[test]
fn test_gate_thread_with_no_messages() {
    let thread = Thread {
        id: "t1".to_string(),
        file_path: "a.txt".to_string(),
        position: serde_json::json!({"side": "new", "line": 1}),
        messages: vec![],
    };
    assert!(gate_passes(&[thread]));
}
