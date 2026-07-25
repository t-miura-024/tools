use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use tui_textarea::TextArea;

use super::state::{AuthStatus, FetchPhase, Field, FormState, SubmitPhase};

#[derive(Debug, Clone)]
pub struct LayoutAreas {
    pub repo: Rect,
    pub title: Rect,
    pub desc_label: Rect,
    pub desc_text: Rect,
    /// 「今回作成」セクション（当前 repo スコープ）
    pub created: Rect,
    /// 「既存」セクション（当前 repo スコープの open な kind/plan）
    pub existing: Rect,
    pub help_bar: Rect,
}

/// フォーム（左カラム）と「今回作成」「既存」パネル（右カラム）、
/// 全幅ヘルプバー（最下部）のレイアウトを計算する。
///
/// タイトル欄の高さは折り返し行数に応じて動的に決まり、
/// 伸びた分だけ説明欄の表示領域が縮む（フォーム全体の縦幅は固定）。
pub fn compute_layout(area: Rect, title: &str) -> LayoutAreas {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(5), Constraint::Length(3)])
        .split(area);
    let main = rows[0];
    let help_bar = rows[1];

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(58), Constraint::Percentage(42)])
        .split(main);
    let form = cols[0];
    let panel = cols[1];

    let title_height = compute_title_height(title, form.width);

    let form_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(title_height),
            Constraint::Length(3),
            Constraint::Min(3),
        ])
        .split(form);

    let panel_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(35), Constraint::Percentage(65)])
        .split(panel);

    LayoutAreas {
        repo: form_chunks[0],
        title: form_chunks[1],
        desc_label: form_chunks[2],
        desc_text: form_chunks[3],
        created: panel_chunks[0],
        existing: panel_chunks[1],
        help_bar,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickTarget {
    Repo,
    Title,
    Description,
}

pub fn hit_test_form(x: u16, y: u16, areas: &LayoutAreas) -> Option<ClickTarget> {
    if areas.repo.contains((x, y).into()) {
        return Some(ClickTarget::Repo);
    }
    if areas.title.contains((x, y).into()) {
        return Some(ClickTarget::Title);
    }
    let desc_full = Rect {
        x: areas.desc_label.x,
        y: areas.desc_label.y,
        width: areas.desc_label.width,
        height: areas.desc_label.height + areas.desc_text.height,
    };
    if desc_full.contains((x, y).into()) {
        return Some(ClickTarget::Description);
    }
    None
}

pub fn popup_hit_test(
    x: u16,
    y: u16,
    popup_area: Rect,
    filtered_count: usize,
) -> Option<usize> {
    if !popup_area.contains((x, y).into()) {
        return None;
    }
    if y <= popup_area.y || y >= popup_area.y + popup_area.height - 1 {
        return None;
    }
    let inner_y = y - popup_area.y - 1;
    let idx = inner_y as usize;
    if idx < filtered_count {
        Some(idx)
    } else {
        None
    }
}

pub fn popup_rect(frame_area: Rect) -> Rect {
    centered_rect(70, 70, frame_area)
}

pub fn draw(
    frame: &mut Frame,
    state: &mut FormState,
    desc_area: &TextArea,
    hover: Option<ClickTarget>,
    popup_hover: Option<usize>,
    tick: u64,
) {
    let areas = compute_layout(frame.area(), &state.title);

    draw_repo_field(frame, state, areas.repo, hover == Some(ClickTarget::Repo));
    draw_title_field(frame, state, areas.title, hover == Some(ClickTarget::Title));
    draw_description_field(
        frame,
        state,
        desc_area,
        areas.desc_label,
        areas.desc_text,
        hover == Some(ClickTarget::Description),
    );
    draw_created_section(frame, state, areas.created);
    draw_existing_section(frame, state, areas.existing, tick);
    draw_help_bar(frame, state, areas.help_bar);

    if let Some(ref popup) = state.popup {
        draw_repo_popup(frame, state, popup, popup_hover);
    }

    // submit オーバーレイ（送信中ローディング / 失敗エラー）は最前面に描画する
    draw_submit_overlay(frame, state, tick);
}

fn field_style(focused: bool) -> Style {
    if focused {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Gray)
    }
}

fn border_style(focused: bool, hovered: bool) -> Style {
    if focused {
        Style::default().fg(Color::Cyan)
    } else if hovered {
        Style::default().fg(Color::Gray)
    } else {
        Style::default().fg(Color::DarkGray)
    }
}

fn draw_repo_field(frame: &mut Frame, state: &FormState, area: Rect, hovered: bool) {
    let focused = state.focus == Field::Repo && state.popup.is_none();
    let title = Span::styled(" 📂 リポジトリ ", field_style(focused));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style(focused, hovered))
        .title(title);

    let display = if state.repo_path.is_some() {
        state.repo_display.as_str()
    } else {
        "(Enter で選択)"
    };

    let paragraph = Paragraph::new(Line::from(vec![Span::styled(
        format!(" {display}"),
        if state.repo_path.is_some() {
            Style::default().fg(Color::White)
        } else {
            Style::default().fg(Color::DarkGray)
        },
    )]))
    .block(block);

    frame.render_widget(paragraph, area);
}

/// タイトル欄を折り返し（Wrap）で描画する。
/// 折り返し行数に応じて枠の縦幅が自動調整され、常に全行表示される（縦スクロールなし）。
fn draw_title_field(frame: &mut Frame, state: &mut FormState, area: Rect, hovered: bool) {
    let focused = state.focus == Field::Title;
    let title = Span::styled(" ✏️ タイトル ", field_style(focused));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style(focused, hovered))
        .title(title);

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if state.title.is_empty() && !focused {
        let placeholder = Paragraph::new(Span::styled(
            " タイトルを入力...",
            Style::default().fg(Color::DarkGray),
        ));
        frame.render_widget(placeholder, inner);
        return;
    }

    // 先頭スペース 1 列分を差し引いたテキスト表示幅
    let text_view_width = inner.width.saturating_sub(1) as usize;
    state.title_view_width = text_view_width;

    // 折り返し視覚行を計算
    let visual_lines = wrap_line(&state.title, text_view_width);

    // 各視覚行を Line に変換（先頭スペース付き）
    let lines: Vec<Line> = visual_lines
        .iter()
        .map(|&(start, end)| {
            Line::from(vec![
                Span::styled(" ", Style::default()),
                Span::styled(
                    state.title[start..end].to_string(),
                    Style::default().fg(Color::White),
                ),
            ])
        })
        .collect();

    let paragraph = Paragraph::new(lines).wrap(Wrap { trim: true });
    frame.render_widget(paragraph, inner);

    if focused {
        let (cursor_visual_line, cursor_vcol) =
            cursor_to_visual_pos(&state.title, state.title_cursor, text_view_width);
        let cursor_x = inner.x + 1 + cursor_vcol as u16; // +1 for leading space
        let cursor_y = inner.y + cursor_visual_line as u16;
        frame.set_cursor_position((cursor_x, cursor_y));
    }
}

/// 説明欄を折り返し（Wrap）で描画する。
/// 縦スクロール（マウスホイール + カーソル追従）は視覚行単位で管理する。
fn draw_description_field(
    frame: &mut Frame,
    state: &mut FormState,
    desc_area: &TextArea,
    label_area: Rect,
    text_area: Rect,
    hovered: bool,
) {
    let focused = state.focus == Field::Description;

    let full_area = Rect {
        x: label_area.x,
        y: label_area.y,
        width: label_area.width,
        height: label_area.height + text_area.height,
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style(focused, hovered))
        .title(Span::styled(" 📄 説明 ", field_style(focused)));

    let inner = block.inner(full_area);
    frame.render_widget(block, full_area);

    let lines = desc_area.lines();
    let (cursor_row, cursor_col) = desc_area.cursor();

    let text_view_width = inner.width as usize;
    let visible_height = inner.height as usize;
    state.desc_view_width = text_view_width;

    // 全論理行の視覚行をフラットに展開: (logical_row, start_byte, end_byte)
    let mut flat_visual: Vec<(usize, usize, usize)> = Vec::new();
    for (row, line) in lines.iter().enumerate() {
        for (start, end) in wrap_line(line, text_view_width) {
            flat_visual.push((row, start, end));
        }
    }
    let total_visual = flat_visual.len();

    // --- 縦スクロール（カーソル追従、視覚行単位）---
    let lines_vec: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
    let (cursor_visual, cursor_vcol) =
        desc_cursor_to_visual(&lines_vec, cursor_row, cursor_col, text_view_width);

    if cursor_visual < state.desc_scroll_top {
        state.desc_scroll_top = cursor_visual;
    } else if visible_height > 0 && cursor_visual >= state.desc_scroll_top + visible_height {
        state.desc_scroll_top = cursor_visual + 1 - visible_height;
    }
    // クランプ
    if total_visual > 0 {
        state.desc_scroll_top = state
            .desc_scroll_top
            .min(total_visual.saturating_sub(1));
    } else {
        state.desc_scroll_top = 0;
    }

    let is_empty = lines.iter().all(|l| l.is_empty());

    if is_empty && !focused {
        let placeholder = Paragraph::new(Span::styled(
            "説明を入力...（複数行可）",
            Style::default().fg(Color::DarkGray),
        ));
        frame.render_widget(placeholder, inner);
    } else {
        // 可視範囲の視覚行を描画
        let visible_lines: Vec<Line> = flat_visual
            .iter()
            .skip(state.desc_scroll_top)
            .take(visible_height)
            .map(|&(row, start, end)| {
                Line::from(Span::styled(
                    lines[row][start..end].to_string(),
                    Style::default().fg(Color::White),
                ))
            })
            .collect();

        let paragraph = Paragraph::new(visible_lines).wrap(Wrap { trim: true });
        frame.render_widget(paragraph, inner);
    }

    if focused {
        let cursor_screen_y =
            inner.y + (cursor_visual.saturating_sub(state.desc_scroll_top)) as u16;
        let cursor_screen_x = inner.x + cursor_vcol as u16;
        frame.set_cursor_position((cursor_screen_x, cursor_screen_y));
    }
}

fn auth_status_span(status: AuthStatus) -> Span<'static> {
    match status {
        AuthStatus::Checking => Span::styled(
            " ⏳ 認証を確認中...（送信は認証完了後に可能になります）",
            Style::default().fg(Color::Yellow),
        ),
        AuthStatus::Authenticated => Span::styled(
            " ✔ 認証済み",
            Style::default().fg(Color::Green),
        ),
        AuthStatus::Failed => Span::styled(
            " ✖ gh CLI の認証に失敗しました。ターミナルで `gh auth login` を実行してください（送信できません）",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        ),
    }
}

fn draw_help_bar(frame: &mut Frame, state: &FormState, area: Rect) {
    let hints = match state.submit_phase {
        SubmitPhase::Submitting => "送信中...（完了まで esc / ctrl+C は無効です）",
        SubmitPhase::Error(_) => "何かキーを押すとフォームに戻ります",
        SubmitPhase::Idle if state.popup.is_some() => {
            "↑↓: 移動  Enter: 選択  Esc: 閉じる  入力: 絞り込み"
        }
        SubmitPhase::Idle => {
            "Tab/Shift-Tab: 移動  Enter: リポ選択  Ctrl+S: 送信  Esc/Ctrl+C: 終了"
        }
    };

    let paragraph = Paragraph::new(vec![
        Line::from(Span::styled(
            format!(" {hints}"),
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(auth_status_span(state.auth_status)),
    ])
    .alignment(Alignment::Left);

    frame.render_widget(paragraph, area);
}

fn draw_repo_popup(
    frame: &mut Frame,
    state: &FormState,
    popup: &super::state::RepoPopup,
    popup_hover: Option<usize>,
) {
    let area = popup_rect(frame.area());
    frame.render_widget(Clear, area);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(Span::styled(
            format!(" リポジトリ選択 (絞り込み: {}) ", popup.filter),
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        ));

    let filtered = popup.filtered_indices(&state.repos);
    let items: Vec<ListItem> = filtered
        .iter()
        .enumerate()
        .map(|(vis_idx, &idx)| {
            let entry = &state.repos[idx];
            let label = format!(" {}", entry.display_name());
            let style = if idx == popup.selected_index {
                Style::default()
                    .bg(Color::DarkGray)
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD)
            } else if Some(vis_idx) == popup_hover {
                Style::default().bg(Color::DarkGray).fg(Color::White)
            } else {
                Style::default().fg(Color::White)
            };
            ListItem::new(Line::from(Span::styled(label, style)))
        })
        .collect();

    let list = List::new(items).block(block);
    frame.render_widget(list, area);
}

/// 「今回作成」セクション。当前 repo スコープ、最新が先頭。
/// Issue 番号付きで表示し、`ListState` によるスクロールに対応する。
fn draw_created_section(frame: &mut Frame, state: &mut FormState, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray))
        .title(Span::styled(
            format!(" 🎉 今回作成 ({}) ", state.created_issues.len()),
            Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
        ));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if state.created_issues.is_empty() {
        let placeholder = Paragraph::new(Span::styled(
            " (まだありません)",
            Style::default().fg(Color::DarkGray),
        ));
        frame.render_widget(placeholder, inner);
        return;
    }

    let items: Vec<ListItem> = state
        .created_issues
        .iter()
        .map(|issue| {
            ListItem::new(Line::from(vec![
                Span::styled(" ✔ ", Style::default().fg(Color::Green)),
                Span::styled(
                    format!("#{} ", issue.number),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(issue.title.as_str(), Style::default().fg(Color::White)),
            ]))
        })
        .collect();
    let list = List::new(items);
    frame.render_stateful_widget(list, inner, &mut state.created_list_state);
}

/// 「既存」セクション。当前 repo スコープの open な kind/plan Issue。
/// fetch 中はローディング表示、失敗時はエラーを表示する。
/// `ListState` によるスクロールに対応する。
fn draw_existing_section(frame: &mut Frame, state: &mut FormState, area: Rect, tick: u64) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray))
        .title(Span::styled(
            " 📋 既存の計画 ".to_string(),
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        ));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    match state.fetch_phase {
        FetchPhase::Idle => {
            let placeholder = Paragraph::new(Span::styled(
                " (リポジトリを選択してください)",
                Style::default().fg(Color::DarkGray),
            ));
            frame.render_widget(placeholder, inner);
        }
        FetchPhase::Loading => {
            let spinner = spinner_frame(tick);
            let loading = Paragraph::new(Line::from(vec![
                Span::styled(format!(" {spinner} "), Style::default().fg(Color::Yellow)),
                Span::styled("読み込み中...", Style::default().fg(Color::Yellow)),
            ]));
            frame.render_widget(loading, inner);
        }
        FetchPhase::Loaded => {
            if state.existing_issues.is_empty() {
                let placeholder = Paragraph::new(Span::styled(
                    " (open な計画 Issue はありません)",
                    Style::default().fg(Color::DarkGray),
                ));
                frame.render_widget(placeholder, inner);
            } else {
                let items: Vec<ListItem> = state
                    .existing_issues
                    .iter()
                    .map(|issue| {
                        ListItem::new(Line::from(vec![
                            Span::styled(
                                format!(" #{} ", issue.number),
                                Style::default().fg(Color::DarkGray),
                            ),
                            Span::styled(issue.title.as_str(), Style::default().fg(Color::White)),
                        ]))
                    })
                    .collect();
                let list = List::new(items);
                frame.render_stateful_widget(list, inner, &mut state.existing_list_state);
            }
        }
        FetchPhase::Failed(ref msg) => {
            let error = Paragraph::new(Span::styled(
                format!(" ✖ {msg}"),
                Style::default().fg(Color::Red),
            ));
            frame.render_widget(error, inner);
        }
    }
}

/// submit 中のローディングオーバーレイ、または失敗時のエラーオーバーレイを描画する。
/// Idle の場合は何もしない。
fn draw_submit_overlay(frame: &mut Frame, state: &FormState, tick: u64) {
    match state.submit_phase {
        SubmitPhase::Idle => {}
        SubmitPhase::Submitting => {
            let area = centered_rect(50, 20, frame.area());
            frame.render_widget(Clear, area);
            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Yellow))
                .title(Span::styled(
                    " 送信中 ",
                    Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
                ));
            let inner = block.inner(area);
            frame.render_widget(block, area);

            let spinner = spinner_frame(tick);
            let body = Paragraph::new(vec![
                Line::from(""),
                Line::from(vec![
                    Span::styled(format!("  {spinner} "), Style::default().fg(Color::Yellow)),
                    Span::styled("Issue を作成しています...", Style::default().fg(Color::White)),
                ]),
                Line::from(Span::styled(
                    "  （完了まで esc / ctrl+C は無効です）",
                    Style::default().fg(Color::DarkGray),
                )),
            ])
            .alignment(Alignment::Left);
            frame.render_widget(body, inner);
        }
        SubmitPhase::Error(ref msg) => {
            let area = centered_rect(70, 40, frame.area());
            frame.render_widget(Clear, area);
            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Red))
                .title(Span::styled(
                    " エラー ",
                    Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                ));
            let inner = block.inner(area);
            frame.render_widget(block, area);

            let mut lines: Vec<Line> = vec![Line::from("")];
            for line in msg.lines() {
                lines.push(Line::from(Span::styled(
                    format!("  {line}"),
                    Style::default().fg(Color::Red),
                )));
            }
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                "  何かキーを押すとフォームに戻ります（入力は保持されます）",
                Style::default().fg(Color::DarkGray),
            )));
            let body = Paragraph::new(lines).alignment(Alignment::Left);
            frame.render_widget(body, inner);
        }
    }
}

/// ローディングアニメーション用のスピナーフレームを tick から選ぶ。
fn spinner_frame(tick: u64) -> &'static str {
    const FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    FRAMES[(tick as usize) % FRAMES.len()]
}

fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

// ---------------------------------------------------------------------------
// 文字幅・折り返しヘルパー
// ---------------------------------------------------------------------------

/// 1 文字の表示幅を返す（ASCII = 1、それ以外 = 2）。
/// 幅計算ルールの唯一の定義箇所。`unicode_width` もこの関数に委譲する。
fn char_display_width(c: char) -> usize {
    if c.is_ascii() { 1 } else { 2 }
}

/// 文字列の表示幅を返す。各文字の幅は `char_display_width` に委譲する。
fn unicode_width(s: &str) -> u16 {
    s.chars()
        .map(|c| char_display_width(c) as u16)
        .sum()
}

/// 1 論理行を表示幅で折り返し、視覚行のバイトオフセット範囲 `(start, end)` を返す。
/// ratatui の `Wrap { trim: true }` と同等の挙動（行頭の空白を除去）。
pub fn wrap_line(line: &str, width: usize) -> Vec<(usize, usize)> {
    if width == 0 {
        return vec![(0, line.len())];
    }
    if line.is_empty() {
        return vec![(0, 0)];
    }

    let mut result = Vec::new();
    let mut line_start = 0;
    let mut col = 0;
    let mut byte_pos = 0;

    while byte_pos < line.len() {
        let c = line[byte_pos..].chars().next().unwrap();
        let w = char_display_width(c);

        if col + w > width && col > 0 {
            // 折り返し
            result.push((line_start, byte_pos));
            // trim: 行頭の空白をスキップ
            let mut trimmed = byte_pos;
            while trimmed < line.len() && line.as_bytes()[trimmed] == b' ' {
                trimmed += 1;
            }
            line_start = trimmed;
            byte_pos = trimmed;
            col = 0;
            continue;
        }

        col += w;
        byte_pos += c.len_utf8();
    }

    result.push((line_start, line.len()));
    result
}

/// タイトル欄の枠の高さ（視覚行数 + ボーダー 2 行）を計算する。
pub fn compute_title_height(title: &str, form_width: u16) -> u16 {
    // 2 borders + 1 leading space
    let text_width = form_width.saturating_sub(3) as usize;
    if title.is_empty() || text_width == 0 {
        return 3; // minimum: 1 line + 2 borders
    }
    let visual_lines = wrap_line(title, text_width);
    (visual_lines.len() as u16 + 2).max(3)
}

/// バイトオフセットから視覚行インデックスと視覚列（表示幅）を計算する。
pub fn cursor_to_visual_pos(line: &str, byte_offset: usize, width: usize) -> (usize, usize) {
    let visual_lines = wrap_line(line, width);
    for (i, &(start, end)) in visual_lines.iter().enumerate() {
        // 次の視覚行の start が byte_offset と同じ場合（trim なしで連続している場合）、
        // byte_offset == end でも次の視覚行に归属させる。
        let next_start = visual_lines.get(i + 1).map(|&(s, _)| s);
        if byte_offset < end || (byte_offset == end && next_start != Some(byte_offset)) {
            let col = unicode_width(&line[start..byte_offset.min(end)]) as usize;
            return (i, col);
        }
    }
    // Fallback: 最終視覚行
    let last_idx = visual_lines.len().saturating_sub(1);
    let (start, _) = visual_lines[last_idx];
    let col = unicode_width(&line[start..byte_offset.min(line.len())]) as usize;
    (last_idx, col)
}

/// 視覚行インデックスと目標表示列からバイトオフセットを計算する。
pub fn visual_pos_to_byte(line: &str, visual_line: usize, target_col: usize, width: usize) -> usize {
    let visual_lines = wrap_line(line, width);
    let Some(&(start, end)) = visual_lines.get(visual_line) else {
        return line.len();
    };
    let mut col = 0;
    for (byte_pos, c) in line[start..end].char_indices() {
        let w = char_display_width(c);
        if col + w > target_col {
            return start + byte_pos;
        }
        col += w;
    }
    end
}

/// 説明欄のカーソル位置 `(row, col_char)` からグローバル視覚行インデックスと視覚列を計算する。
pub fn desc_cursor_to_visual(
    lines: &[String],
    row: usize,
    col_char: usize,
    width: usize,
) -> (usize, usize) {
    let mut global_visual = 0;
    for (i, line) in lines.iter().enumerate() {
        let vl = wrap_line(line, width);
        if i == row {
            let byte_offset = line
                .char_indices()
                .nth(col_char)
                .map(|(b, _)| b)
                .unwrap_or(line.len());
            let (local_visual, col) = cursor_to_visual_pos(line, byte_offset, width);
            return (global_visual + local_visual, col);
        }
        global_visual += vl.len();
    }
    (global_visual, 0)
}

/// グローバル視覚行インデックスと目標視覚列から `(row, col_char)` を計算する。
pub fn desc_visual_to_cursor(
    lines: &[String],
    target_visual: usize,
    target_col: usize,
    width: usize,
) -> (usize, usize) {
    let mut global_visual = 0;
    for (i, line) in lines.iter().enumerate() {
        let vl = wrap_line(line, width);
        let count = vl.len();
        if target_visual < global_visual + count {
            let local_visual = target_visual - global_visual;
            let byte_offset = visual_pos_to_byte(line, local_visual, target_col, width);
            let col_char = line[..byte_offset].chars().count();
            return (i, col_char);
        }
        global_visual += count;
    }
    // 最終行の末尾
    let last_row = lines.len().saturating_sub(1);
    let last_line = lines.get(last_row).map(|s| s.as_str()).unwrap_or("");
    (last_row, last_line.chars().count())
}

/// 全論理行の視覚行の合計数を返す。
pub fn total_visual_lines(lines: &[String], width: usize) -> usize {
    lines.iter().map(|l| wrap_line(l, width).len()).sum()
}

// ---------------------------------------------------------------------------
// クリック → カーソル位置変換
// ---------------------------------------------------------------------------

/// タイトル欄のクリック位置からバイトオフセットを計算する（折り返し対応）。
pub fn title_click_to_cursor(
    click_x: u16,
    click_y: u16,
    area: &Rect,
    title: &str,
    view_width: usize,
) -> usize {
    if title.is_empty() || view_width == 0 {
        return 0;
    }
    let inner_y = area.y + 1;
    let visual_line = click_y.saturating_sub(inner_y) as usize;
    // 1 border + 1 leading space
    let text_start_x = area.x + 2;
    let click_col = click_x.saturating_sub(text_start_x) as usize;
    visual_pos_to_byte(title, visual_line, click_col, view_width)
}

/// 説明欄のクリック位置から `(row, col_char)` を計算する（折り返し対応）。
pub fn desc_click_to_row_col(
    click_x: u16,
    click_y: u16,
    area: &Rect,
    scroll_top: usize,
    lines: &[String],
    view_width: usize,
) -> (usize, usize) {
    if lines.is_empty() {
        return (0, 0);
    }
    let inner_y = area.y + 1;
    let inner_x = area.x + 1;
    let visual_line = click_y.saturating_sub(inner_y) as usize + scroll_top;
    let click_col = click_x.saturating_sub(inner_x) as usize;
    desc_visual_to_cursor(lines, visual_line, click_col, view_width)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_area() -> Rect {
        Rect::new(0, 0, 100, 40)
    }

    // --- compute_layout ---

    #[test]
    fn compute_layout_splits_form_panel_and_help_bar() {
        let areas = compute_layout(test_area(), "");
        assert_eq!(areas.repo.height, 3);
        assert_eq!(areas.title.height, 3);
        assert_eq!(areas.desc_label.height, 3);
        assert!(areas.desc_text.height >= 3);
        assert_eq!(areas.repo.y, 0);
        assert_eq!(areas.title.y, 3);
        assert_eq!(areas.desc_label.y, 6);
        assert_eq!(areas.desc_text.y, 9);
        assert_eq!(areas.repo.x, 0);
        assert!(areas.created.x > areas.repo.x);
        assert!(areas.existing.x > areas.repo.x);
        assert!(areas.existing.y >= areas.created.y + areas.created.height);
        assert_eq!(areas.help_bar.height, 3);
        assert_eq!(areas.help_bar.y, 37);
    }

    #[test]
    fn compute_layout_title_grows_with_long_text() {
        // form_width = 58% of 100 = 58, text_width = 58 - 3 = 55
        // 110 chars of 'a' → 110 cols → ceil(110/55) = 2 visual lines → height = 4
        let long_title = "a".repeat(110);
        let areas = compute_layout(test_area(), &long_title);
        assert_eq!(areas.title.height, 4);
        // desc_label shifts down
        assert_eq!(areas.desc_label.y, 7);
    }

    // --- spinner ---

    #[test]
    fn spinner_frame_cycles() {
        assert_eq!(spinner_frame(0), "⠋");
        assert_eq!(spinner_frame(1), "⠙");
        assert_eq!(spinner_frame(10), "⠋");
        assert_eq!(spinner_frame(11), "⠙");
    }

    // --- hit_test ---

    #[test]
    fn hit_test_repo_field() {
        let areas = compute_layout(test_area(), "");
        assert_eq!(hit_test_form(5, 1, &areas), Some(ClickTarget::Repo));
    }

    #[test]
    fn hit_test_title_field() {
        let areas = compute_layout(test_area(), "");
        assert_eq!(hit_test_form(5, 4, &areas), Some(ClickTarget::Title));
    }

    #[test]
    fn hit_test_description_field() {
        let areas = compute_layout(test_area(), "");
        assert_eq!(hit_test_form(5, 7, &areas), Some(ClickTarget::Description));
        assert_eq!(hit_test_form(5, 15, &areas), Some(ClickTarget::Description));
    }

    #[test]
    fn hit_test_outside_returns_none() {
        let areas = compute_layout(test_area(), "");
        assert_eq!(hit_test_form(0, 39, &areas), None);
    }

    // --- popup_hit_test ---

    #[test]
    fn popup_hit_test_first_item() {
        let popup_area = Rect::new(15, 6, 70, 28);
        assert_eq!(popup_hit_test(20, 7, popup_area, 10), Some(0));
    }

    #[test]
    fn popup_hit_test_third_item() {
        let popup_area = Rect::new(15, 6, 70, 28);
        assert_eq!(popup_hit_test(20, 9, popup_area, 10), Some(2));
    }

    #[test]
    fn popup_hit_test_out_of_range() {
        let popup_area = Rect::new(15, 6, 70, 28);
        assert_eq!(popup_hit_test(20, 7, popup_area, 0), None);
    }

    #[test]
    fn popup_hit_test_outside_area() {
        let popup_area = Rect::new(15, 6, 70, 28);
        assert_eq!(popup_hit_test(5, 7, popup_area, 10), None);
    }

    #[test]
    fn popup_hit_test_border_not_item() {
        let popup_area = Rect::new(15, 6, 70, 28);
        assert_eq!(popup_hit_test(20, 6, popup_area, 10), None);
    }

    // --- wrap_line ---

    #[test]
    fn wrap_line_no_wrap() {
        assert_eq!(wrap_line("hello", 10), vec![(0, 5)]);
    }

    #[test]
    fn wrap_line_exact_fit() {
        assert_eq!(wrap_line("hello", 5), vec![(0, 5)]);
    }

    #[test]
    fn wrap_line_wraps_ascii() {
        // "hello world" width=5 → "hello" + "world" (space trimmed)
        assert_eq!(wrap_line("hello world", 5), vec![(0, 5), (6, 11)]);
    }

    #[test]
    fn wrap_line_cjk() {
        // "日本語" width=4 → "日本" + "語"
        assert_eq!(wrap_line("日本語", 4), vec![(0, 6), (6, 9)]);
    }

    #[test]
    fn wrap_line_cjk_exact() {
        // "日本語" width=6 → 1 line
        assert_eq!(wrap_line("日本語", 6), vec![(0, 9)]);
    }

    #[test]
    fn wrap_line_mixed() {
        // "a日b" width=3 → "a日" (1+2=3) + "b"
        assert_eq!(wrap_line("a日b", 3), vec![(0, 4), (4, 5)]);
    }

    #[test]
    fn wrap_line_empty() {
        assert_eq!(wrap_line("", 10), vec![(0, 0)]);
    }

    #[test]
    fn wrap_line_zero_width() {
        assert_eq!(wrap_line("hello", 0), vec![(0, 5)]);
    }

    #[test]
    fn wrap_line_trims_leading_spaces() {
        // "ab   cd" width=2 → "ab" + "cd" (3 spaces trimmed)
        assert_eq!(wrap_line("ab   cd", 2), vec![(0, 2), (5, 7)]);
    }

    #[test]
    fn wrap_line_single_wide_char_narrow() {
        // "日" width=1 → char wider than width, still 1 line
        assert_eq!(wrap_line("日", 1), vec![(0, 3)]);
    }

    // --- compute_title_height ---

    #[test]
    fn compute_title_height_empty() {
        assert_eq!(compute_title_height("", 58), 3);
    }

    #[test]
    fn compute_title_height_single_line() {
        assert_eq!(compute_title_height("hello", 58), 3);
    }

    #[test]
    fn compute_title_height_two_lines() {
        // form_width=58, text_width=55, 110 chars → 2 lines → height=4
        let title = "a".repeat(110);
        assert_eq!(compute_title_height(&title, 58), 4);
    }

    // --- cursor_to_visual_pos ---

    #[test]
    fn cursor_to_visual_pos_first_line() {
        // "hello world" width=5, cursor at byte 3 → visual line 0, col 3
        assert_eq!(cursor_to_visual_pos("hello world", 3, 5), (0, 3));
    }

    #[test]
    fn cursor_to_visual_pos_second_line() {
        // "hello world" width=5, cursor at byte 6 ('w') → visual line 1, col 0
        assert_eq!(cursor_to_visual_pos("hello world", 6, 5), (1, 0));
    }

    #[test]
    fn cursor_to_visual_pos_end_of_first_line() {
        // "hello world" width=5, cursor at byte 5 (end of "hello") → visual line 0, col 5
        assert_eq!(cursor_to_visual_pos("hello world", 5, 5), (0, 5));
    }

    #[test]
    fn cursor_to_visual_pos_cjk() {
        // "日本語" width=4, cursor at byte 6 ('語') → visual line 1, col 0
        assert_eq!(cursor_to_visual_pos("日本語", 6, 4), (1, 0));
    }

    #[test]
    fn cursor_to_visual_pos_cjk_mid() {
        // "日本語" width=4, cursor at byte 3 ('本') → visual line 0, col 2
        assert_eq!(cursor_to_visual_pos("日本語", 3, 4), (0, 2));
    }

    // --- visual_pos_to_byte ---

    #[test]
    fn visual_pos_to_byte_first_line() {
        // "hello world" width=5, visual line 0, col 3 → byte 3
        assert_eq!(visual_pos_to_byte("hello world", 0, 3, 5), 3);
    }

    #[test]
    fn visual_pos_to_byte_second_line() {
        // "hello world" width=5, visual line 1, col 2 → byte 8 ('r')
        assert_eq!(visual_pos_to_byte("hello world", 1, 2, 5), 8);
    }

    #[test]
    fn visual_pos_to_byte_beyond_line() {
        // "hello" width=10, visual line 0, col 100 → byte 5 (end)
        assert_eq!(visual_pos_to_byte("hello", 0, 100, 10), 5);
    }

    #[test]
    fn visual_pos_to_byte_out_of_range_visual() {
        // "hello" width=10, visual line 5 → byte 5 (end)
        assert_eq!(visual_pos_to_byte("hello", 5, 0, 10), 5);
    }

    #[test]
    fn visual_pos_to_byte_cjk() {
        // "日本語" width=4, visual line 1, col 0 → byte 6 ('語')
        assert_eq!(visual_pos_to_byte("日本語", 1, 0, 4), 6);
    }

    #[test]
    fn visual_pos_to_byte_cjk_mid_char() {
        // "日本語" width=4, visual line 0, col 1 → byte 0 (col 1 is mid-char '日')
        assert_eq!(visual_pos_to_byte("日本語", 0, 1, 4), 0);
    }

    // --- desc_cursor_to_visual / desc_visual_to_cursor ---

    #[test]
    fn desc_cursor_to_visual_basic() {
        let lines = vec!["hello".to_string(), "world".to_string()];
        // row=0, col=3 → visual 0, col 3
        assert_eq!(desc_cursor_to_visual(&lines, 0, 3, 10), (0, 3));
        // row=1, col=2 → visual 1, col 2
        assert_eq!(desc_cursor_to_visual(&lines, 1, 2, 10), (1, 2));
    }

    #[test]
    fn desc_cursor_to_visual_wrapped() {
        let lines = vec!["hello world".to_string(), "foo".to_string()];
        // width=5: "hello world" → 2 visual lines, "foo" → 1
        // row=0, col=6 ('w') → visual 1, col 0
        assert_eq!(desc_cursor_to_visual(&lines, 0, 6, 5), (1, 0));
        // row=1, col=0 → visual 2, col 0
        assert_eq!(desc_cursor_to_visual(&lines, 1, 0, 5), (2, 0));
    }

    #[test]
    fn desc_visual_to_cursor_basic() {
        let lines = vec!["hello".to_string(), "world".to_string()];
        assert_eq!(desc_visual_to_cursor(&lines, 0, 3, 10), (0, 3));
        assert_eq!(desc_visual_to_cursor(&lines, 1, 2, 10), (1, 2));
    }

    #[test]
    fn desc_visual_to_cursor_wrapped() {
        let lines = vec!["hello world".to_string(), "foo".to_string()];
        // width=5: visual 0="hello", 1="world", 2="foo"
        assert_eq!(desc_visual_to_cursor(&lines, 1, 2, 5), (0, 8)); // 'r' in "world"
        assert_eq!(desc_visual_to_cursor(&lines, 2, 0, 5), (1, 0)); // 'f' in "foo"
    }

    #[test]
    fn desc_visual_to_cursor_beyond_end() {
        let lines = vec!["ab".to_string()];
        assert_eq!(desc_visual_to_cursor(&lines, 5, 0, 10), (0, 2));
    }

    // --- total_visual_lines ---

    #[test]
    fn total_visual_lines_basic() {
        let lines = vec!["hello".to_string(), "world".to_string()];
        assert_eq!(total_visual_lines(&lines, 10), 2);
    }

    #[test]
    fn total_visual_lines_wrapped() {
        let lines = vec!["hello world".to_string(), "foo".to_string()];
        assert_eq!(total_visual_lines(&lines, 5), 3);
    }

    // --- title_click_to_cursor ---

    #[test]
    fn title_click_ascii() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(2, 4, &area, "hello", 97), 0);
        assert_eq!(title_click_to_cursor(3, 4, &area, "hello", 97), 1);
        assert_eq!(title_click_to_cursor(5, 4, &area, "hello", 97), 3);
        assert_eq!(title_click_to_cursor(7, 4, &area, "hello", 97), 5);
        assert_eq!(title_click_to_cursor(50, 4, &area, "hello", 97), 5);
    }

    #[test]
    fn title_click_unicode() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(2, 4, &area, "日本語", 97), 0);
        assert_eq!(title_click_to_cursor(3, 4, &area, "日本語", 97), 0);
        assert_eq!(title_click_to_cursor(4, 4, &area, "日本語", 97), 3);
        assert_eq!(title_click_to_cursor(5, 4, &area, "日本語", 97), 3);
        assert_eq!(title_click_to_cursor(6, 4, &area, "日本語", 97), 6);
        assert_eq!(title_click_to_cursor(7, 4, &area, "日本語", 97), 6);
        assert_eq!(title_click_to_cursor(8, 4, &area, "日本語", 97), 9);
    }

    #[test]
    fn title_click_mixed() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(2, 4, &area, "a日b", 97), 0);
        assert_eq!(title_click_to_cursor(3, 4, &area, "a日b", 97), 1);
        assert_eq!(title_click_to_cursor(4, 4, &area, "a日b", 97), 1);
        assert_eq!(title_click_to_cursor(5, 4, &area, "a日b", 97), 4);
        assert_eq!(title_click_to_cursor(6, 4, &area, "a日b", 97), 5);
    }

    #[test]
    fn title_click_empty() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(5, 4, &area, "", 97), 0);
    }

    #[test]
    fn title_click_before_text_start() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(0, 4, &area, "hello", 97), 0);
        assert_eq!(title_click_to_cursor(1, 4, &area, "hello", 97), 0);
    }

    #[test]
    fn title_click_wrapped_second_line() {
        // "hello world" width=5, area at y=3, height=4 (2 visual lines + 2 borders)
        let area = Rect::new(0, 3, 100, 4);
        // click on visual line 1 (y=5), col 0 → byte 6 ('w')
        assert_eq!(title_click_to_cursor(2, 5, &area, "hello world", 5), 6);
        // click on visual line 1, col 2 → byte 8 ('r')
        assert_eq!(title_click_to_cursor(4, 5, &area, "hello world", 5), 8);
    }

    // --- desc_click_to_row_col ---

    #[test]
    fn desc_click_basic() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec![
            "hello".to_string(),
            "world".to_string(),
            "foo".to_string(),
        ];
        assert_eq!(desc_click_to_row_col(1, 7, &area, 0, &lines, 98), (0, 0));
        assert_eq!(desc_click_to_row_col(3, 7, &area, 0, &lines, 98), (0, 2));
        assert_eq!(desc_click_to_row_col(1, 8, &area, 0, &lines, 98), (1, 0));
        assert_eq!(desc_click_to_row_col(4, 9, &area, 0, &lines, 98), (2, 3));
    }

    #[test]
    fn desc_click_with_scroll() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec![
            "line0".to_string(),
            "line1".to_string(),
            "line2".to_string(),
            "line3".to_string(),
        ];
        assert_eq!(desc_click_to_row_col(1, 7, &area, 2, &lines, 98), (2, 0));
        assert_eq!(desc_click_to_row_col(1, 8, &area, 2, &lines, 98), (3, 0));
    }

    #[test]
    fn desc_click_clamps_row() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["only".to_string()];
        assert_eq!(desc_click_to_row_col(50, 20, &area, 0, &lines, 98), (0, 4));
    }

    #[test]
    fn desc_click_unicode() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["日本語".to_string()];
        assert_eq!(desc_click_to_row_col(1, 7, &area, 0, &lines, 98), (0, 0));
        assert_eq!(desc_click_to_row_col(2, 7, &area, 0, &lines, 98), (0, 0));
        assert_eq!(desc_click_to_row_col(3, 7, &area, 0, &lines, 98), (0, 1));
        assert_eq!(desc_click_to_row_col(4, 7, &area, 0, &lines, 98), (0, 1));
        assert_eq!(desc_click_to_row_col(5, 7, &area, 0, &lines, 98), (0, 2));
        assert_eq!(desc_click_to_row_col(6, 7, &area, 0, &lines, 98), (0, 2));
        assert_eq!(desc_click_to_row_col(7, 7, &area, 0, &lines, 98), (0, 3));
    }

    #[test]
    fn desc_click_empty_lines() {
        let area = Rect::new(0, 6, 100, 10);
        let lines: Vec<String> = vec![];
        assert_eq!(desc_click_to_row_col(5, 7, &area, 0, &lines, 98), (0, 0));
    }

    #[test]
    fn desc_click_past_line_end() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["ab".to_string()];
        assert_eq!(desc_click_to_row_col(50, 7, &area, 0, &lines, 98), (0, 2));
    }

    #[test]
    fn desc_click_wrapped_line() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["hello world".to_string(), "foo".to_string()];
        // width=5: "hello world" → "hello" (visual 0) + "world" (visual 1), "foo" (visual 2)
        // click on visual line 1 (y=8), col 0 → row=0, col=6 ('w')
        assert_eq!(desc_click_to_row_col(1, 8, &area, 0, &lines, 5), (0, 6));
        // click on visual line 2 (y=9), col 0 → row=1, col=0 ('f')
        assert_eq!(desc_click_to_row_col(1, 9, &area, 0, &lines, 5), (1, 0));
    }

    #[test]
    fn desc_click_wrapped_with_scroll() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["hello world".to_string(), "foo".to_string()];
        // width=5, scroll_top=1: visual line 1 is at y=7
        // click at y=7 → visual line 1 → row=0, col=6 ('w')
        assert_eq!(desc_click_to_row_col(1, 7, &area, 1, &lines, 5), (0, 6));
    }
}
