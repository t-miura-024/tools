use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState};
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
pub fn compute_layout(area: Rect) -> LayoutAreas {
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

    let form_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
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
    let areas = compute_layout(frame.area());

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

    let view_width = inner.width as usize;
    // 先頭スペース 1 列分を差し引いたテキスト表示幅
    let text_view_width = view_width.saturating_sub(1);
    let total_width = unicode_width(&state.title) as usize;
    let cursor_col = unicode_width(&state.title[..state.title_cursor]) as usize;

    // --- 自動横スクロール（カーソル追従） ---
    // Pass 1: 大まかなスクロール調整
    if cursor_col < state.title_scroll_left {
        state.title_scroll_left = cursor_col;
    }
    if text_view_width > 0 && cursor_col >= state.title_scroll_left + text_view_width {
        state.title_scroll_left = cursor_col + 1 - text_view_width;
    }
    // 文字境界にスナップ
    state.title_scroll_left = snap_to_char_boundary(&state.title, state.title_scroll_left);

    // 省略記号を考慮した実効幅で Pass 2
    let left_ellipsis = state.title_scroll_left > 0;
    let right_ellipsis = state.title_scroll_left + text_view_width < total_width;
    let content_width = text_view_width
        .saturating_sub(if left_ellipsis { 1 } else { 0 })
        .saturating_sub(if right_ellipsis { 1 } else { 0 });
    if cursor_col < state.title_scroll_left {
        state.title_scroll_left = cursor_col;
    }
    if content_width > 0 && cursor_col >= state.title_scroll_left + content_width {
        state.title_scroll_left = cursor_col + 1 - content_width;
    }
    state.title_scroll_left = snap_to_char_boundary(&state.title, state.title_scroll_left);

    // クランプ
    let max_scroll = total_width.saturating_sub(text_view_width);
    if state.title_scroll_left > max_scroll {
        state.title_scroll_left = max_scroll;
    }

    // --- 描画 ---
    let scroll_left = state.title_scroll_left;
    let left_ellipsis = scroll_left > 0;
    let right_ellipsis = scroll_left + text_view_width < total_width;
    let content_width = text_view_width
        .saturating_sub(if left_ellipsis { 1 } else { 0 })
        .saturating_sub(if right_ellipsis { 1 } else { 0 });

    let (visible_text, actual_start_col) =
        slice_text_by_width(&state.title, scroll_left, content_width);

    let mut spans: Vec<Span> = vec![Span::styled(" ", Style::default().fg(Color::White))];
    if left_ellipsis {
        spans.push(Span::styled("…", Style::default().fg(Color::DarkGray)));
    }
    spans.push(Span::styled(visible_text, Style::default().fg(Color::White)));
    if right_ellipsis {
        spans.push(Span::styled("…", Style::default().fg(Color::DarkGray)));
    }

    let paragraph = Paragraph::new(Line::from(spans));
    frame.render_widget(paragraph, inner);

    if focused {
        let cursor_offset = cursor_col.saturating_sub(actual_start_col);
        let cursor_x = inner.x + 1 + (if left_ellipsis { 1 } else { 0 }) + cursor_offset as u16;
        let cursor_y = inner.y;
        frame.set_cursor_position((cursor_x, cursor_y));
    }
}

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

    // スクロールバー用の領域を確保（右端: 縦、下端: 横）
    let text_render_width = inner.width.saturating_sub(1);
    let text_render_height = inner.height.saturating_sub(1);
    let visible_height = text_render_height as usize;
    let text_view_width = text_render_width as usize;

    // --- 縦スクロール（カーソル追従）---
    if cursor_row < state.desc_scroll_top {
        state.desc_scroll_top = cursor_row;
    } else if visible_height > 0 && cursor_row >= state.desc_scroll_top + visible_height {
        state.desc_scroll_top = cursor_row + 1 - visible_height;
    }

    // --- 横スクロール（カーソル追従）---
    let current_line = lines.get(cursor_row).map(|s| s.as_str()).unwrap_or("");
    let byte_offset = current_line
        .char_indices()
        .nth(cursor_col)
        .map(|(i, _)| i)
        .unwrap_or(current_line.len());
    let cursor_display_col = unicode_width(&current_line[..byte_offset]) as usize;
    let cursor_line_width = unicode_width(current_line) as usize;

    // Pass 1: 大まかなスクロール調整
    if cursor_display_col < state.desc_scroll_left {
        state.desc_scroll_left = cursor_display_col;
    }
    if text_view_width > 0 && cursor_display_col >= state.desc_scroll_left + text_view_width {
        state.desc_scroll_left = cursor_display_col + 1 - text_view_width;
    }
    state.desc_scroll_left = snap_to_char_boundary(current_line, state.desc_scroll_left);

    // 省略記号を考慮した実効幅で Pass 2
    let left_ellipsis_cursor = state.desc_scroll_left > 0 && cursor_line_width > state.desc_scroll_left;
    let right_ellipsis_cursor = state.desc_scroll_left + text_view_width < cursor_line_width;
    let content_width_cursor = text_view_width
        .saturating_sub(if left_ellipsis_cursor { 1 } else { 0 })
        .saturating_sub(if right_ellipsis_cursor { 1 } else { 0 });
    if cursor_display_col < state.desc_scroll_left {
        state.desc_scroll_left = cursor_display_col;
    }
    if content_width_cursor > 0 && cursor_display_col >= state.desc_scroll_left + content_width_cursor {
        state.desc_scroll_left = cursor_display_col + 1 - content_width_cursor;
    }
    state.desc_scroll_left = snap_to_char_boundary(current_line, state.desc_scroll_left);

    // クランプ（最大行幅基準）
    let max_line_width = lines.iter().map(|l| unicode_width(l) as usize).max().unwrap_or(0);
    let max_scroll = max_line_width.saturating_sub(text_view_width);
    if state.desc_scroll_left > max_scroll {
        state.desc_scroll_left = max_scroll;
    }

    let is_empty = lines.iter().all(|l| l.is_empty());

    if is_empty && !focused {
        let placeholder = Paragraph::new(Span::styled(
            "説明を入力...（複数行可）",
            Style::default().fg(Color::DarkGray),
        ));
        frame.render_widget(placeholder, inner);
    } else {
        let scroll_left = state.desc_scroll_left;

        let text_render_area = Rect {
            x: inner.x,
            y: inner.y,
            width: text_render_width,
            height: text_render_height,
        };

        let visible_lines: Vec<Line> = lines
            .iter()
            .skip(state.desc_scroll_top)
            .take(visible_height)
            .map(|line| render_scrolled_line(line, scroll_left, text_view_width))
            .collect();

        let paragraph = Paragraph::new(visible_lines);
        frame.render_widget(paragraph, text_render_area);

        // 縦スクロールバー（右端）
        let mut v_scrollbar_state = ScrollbarState::new(lines.len())
            .position(state.desc_scroll_top)
            .viewport_content_length(visible_height);
        frame.render_stateful_widget(
            Scrollbar::new(ScrollbarOrientation::VerticalRight)
                .begin_symbol(None)
                .end_symbol(None)
                .track_symbol(Some("│"))
                .thumb_symbol("█"),
            inner,
            &mut v_scrollbar_state,
        );

        // 横スクロールバー（下端）
        let h_content = max_line_width.max(1);
        let mut h_scrollbar_state = ScrollbarState::new(h_content)
            .position(scroll_left)
            .viewport_content_length(text_view_width);
        frame.render_stateful_widget(
            Scrollbar::new(ScrollbarOrientation::HorizontalBottom)
                .begin_symbol(None)
                .end_symbol(None)
                .track_symbol(Some("─"))
                .thumb_symbol("█"),
            inner,
            &mut h_scrollbar_state,
        );
    }

    if focused {
        let scroll_left = state.desc_scroll_left;
        let left_ellipsis = scroll_left > 0 && cursor_line_width > scroll_left;
        let (_, actual_start_col) = slice_text_by_width(current_line, scroll_left, text_view_width);
        let cursor_offset = cursor_display_col.saturating_sub(actual_start_col);
        let cursor_x = inner.x + (if left_ellipsis { 1 } else { 0 }) + cursor_offset as u16;
        let cursor_y = inner.y + (cursor_row.saturating_sub(state.desc_scroll_top)) as u16;
        frame.set_cursor_position((cursor_x, cursor_y));
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

/// 表示列 `col` 以下で最大の文字境界位置を返す。
/// 横スクロールオフセットが全角文字の中間に落ちないようスナップする。
fn snap_to_char_boundary(text: &str, col: usize) -> usize {
    let mut acc = 0;
    for c in text.chars() {
        let w = char_display_width(c);
        if acc + w > col {
            return acc;
        }
        acc += w;
    }
    acc
}

/// テキストを表示列で切り出す。`skip_cols` 分だけ左からスキップし、
/// `take_cols` 分だけ取る。`(表示テキスト, 実際の開始表示列)` を返す。
/// 全角文字が境界にまたがる場合はその文字をスキップする。
fn slice_text_by_width(text: &str, skip_cols: usize, take_cols: usize) -> (String, usize) {
    let mut col = 0;
    let mut result = String::new();
    let mut taken = 0;
    let mut actual_start = 0;
    let mut started = false;

    for c in text.chars() {
        let w = char_display_width(c);
        if !started {
            if col >= skip_cols {
                started = true;
                actual_start = col;
            } else {
                col += w;
                continue;
            }
        }
        if taken + w > take_cols {
            break;
        }
        result.push(c);
        taken += w;
        col += w;
    }

    if !started {
        actual_start = col;
    }

    (result, actual_start)
}

/// 1 行分を横スクロールオフセットと省略記号付きで描画用 `Line` に変換する。
/// `scroll_left` は表示列単位のオフセット、`view_width` は表示領域の幅。
fn render_scrolled_line(line: &str, scroll_left: usize, view_width: usize) -> Line<'static> {
    let total_width = unicode_width(line) as usize;

    if total_width == 0 || view_width == 0 {
        return Line::from("");
    }

    let left_ellipsis = scroll_left > 0 && total_width > scroll_left;
    let right_ellipsis = scroll_left + view_width < total_width;

    let content_width = view_width
        .saturating_sub(if left_ellipsis { 1 } else { 0 })
        .saturating_sub(if right_ellipsis { 1 } else { 0 });

    let (visible_text, _) = slice_text_by_width(line, scroll_left, content_width);

    let mut spans: Vec<Span> = Vec::new();
    if left_ellipsis {
        spans.push(Span::styled("…", Style::default().fg(Color::DarkGray)));
    }
    spans.push(Span::styled(visible_text, Style::default().fg(Color::White)));
    if right_ellipsis {
        spans.push(Span::styled("…", Style::default().fg(Color::DarkGray)));
    }

    Line::from(spans)
}

pub fn title_click_to_cursor(click_x: u16, area: &Rect, title: &str, scroll_left: usize) -> usize {
    let text_start = area.x + 2;
    let mut click_col = click_x.saturating_sub(text_start) as usize;
    // 左省略記号表示中はテキストが 1 列右にずれるため補正
    if scroll_left > 0 {
        click_col = click_col.saturating_sub(1);
    }
    click_col += scroll_left;
    let mut acc_width: usize = 0;
    for (byte_pos, c) in title.char_indices() {
        let char_w = char_display_width(c);
        if acc_width + char_w > click_col {
            return byte_pos;
        }
        acc_width += char_w;
    }
    title.len()
}

pub fn desc_click_to_row_col(
    click_x: u16,
    click_y: u16,
    area: &Rect,
    scroll_top: usize,
    scroll_left: usize,
    lines: &[String],
) -> (usize, usize) {
    if lines.is_empty() {
        return (0, 0);
    }
    let inner_x = area.x + 1;
    let inner_y = area.y + 1;
    let row = (click_y.saturating_sub(inner_y) as usize + scroll_top).min(lines.len() - 1);
    let line = &lines[row];
    // 左省略記号表示中はテキストが 1 列右にずれるため補正
    let line_width = unicode_width(line) as usize;
    let left_ellipsis = scroll_left > 0 && line_width > scroll_left;
    let mut click_col = click_x.saturating_sub(inner_x) as usize;
    if left_ellipsis {
        click_col = click_col.saturating_sub(1);
    }
    click_col += scroll_left;
    let mut acc_width: usize = 0;
    let mut col = 0usize;
    for c in line.chars() {
        let char_w = char_display_width(c);
        if acc_width + char_w > click_col {
            break;
        }
        acc_width += char_w;
        col += 1;
    }
    (row, col)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_area() -> Rect {
        Rect::new(0, 0, 100, 40)
    }

    #[test]
    fn compute_layout_splits_form_panel_and_help_bar() {
        let areas = compute_layout(test_area());
        // フォーム（左カラム）は上部から縦積み
        assert_eq!(areas.repo.height, 3);
        assert_eq!(areas.title.height, 3);
        assert_eq!(areas.desc_label.height, 3);
        assert!(areas.desc_text.height >= 3);
        assert_eq!(areas.repo.y, 0);
        assert_eq!(areas.title.y, 3);
        assert_eq!(areas.desc_label.y, 6);
        assert_eq!(areas.desc_text.y, 9);
        // フォームは左カラム（x=0 起点）
        assert_eq!(areas.repo.x, 0);
        // 「今回作成」「既存」は右カラム（フォームより右）
        assert!(areas.created.x > areas.repo.x);
        assert!(areas.existing.x > areas.repo.x);
        assert!(areas.existing.y >= areas.created.y + areas.created.height);
        // ヘルプバーは最下部の全幅
        assert_eq!(areas.help_bar.height, 3);
        assert_eq!(areas.help_bar.y, 37);
    }

    #[test]
    fn spinner_frame_cycles() {
        assert_eq!(spinner_frame(0), "⠋");
        assert_eq!(spinner_frame(1), "⠙");
        // 周期は 10
        assert_eq!(spinner_frame(10), "⠋");
        assert_eq!(spinner_frame(11), "⠙");
    }

    #[test]
    fn hit_test_repo_field() {
        let areas = compute_layout(test_area());
        assert_eq!(
            hit_test_form(5, 1, &areas),
            Some(ClickTarget::Repo)
        );
    }

    #[test]
    fn hit_test_title_field() {
        let areas = compute_layout(test_area());
        assert_eq!(
            hit_test_form(5, 4, &areas),
            Some(ClickTarget::Title)
        );
    }

    #[test]
    fn hit_test_description_field() {
        let areas = compute_layout(test_area());
        assert_eq!(
            hit_test_form(5, 7, &areas),
            Some(ClickTarget::Description)
        );
        assert_eq!(
            hit_test_form(5, 15, &areas),
            Some(ClickTarget::Description)
        );
    }

    #[test]
    fn hit_test_outside_returns_none() {
        let areas = compute_layout(test_area());
        assert_eq!(hit_test_form(0, 39, &areas), None);
    }

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

    #[test]
    fn title_click_ascii() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(2, &area, "hello", 0), 0);
        assert_eq!(title_click_to_cursor(3, &area, "hello", 0), 1);
        assert_eq!(title_click_to_cursor(5, &area, "hello", 0), 3);
        assert_eq!(title_click_to_cursor(7, &area, "hello", 0), 5);
        assert_eq!(title_click_to_cursor(50, &area, "hello", 0), 5);
    }

    #[test]
    fn title_click_unicode() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(2, &area, "日本語", 0), 0);
        assert_eq!(title_click_to_cursor(3, &area, "日本語", 0), 0);
        assert_eq!(title_click_to_cursor(4, &area, "日本語", 0), 3);
        assert_eq!(title_click_to_cursor(5, &area, "日本語", 0), 3);
        assert_eq!(title_click_to_cursor(6, &area, "日本語", 0), 6);
        assert_eq!(title_click_to_cursor(7, &area, "日本語", 0), 6);
        assert_eq!(title_click_to_cursor(8, &area, "日本語", 0), 9);
    }

    #[test]
    fn title_click_mixed() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(2, &area, "a日b", 0), 0);
        assert_eq!(title_click_to_cursor(3, &area, "a日b", 0), 1);
        assert_eq!(title_click_to_cursor(4, &area, "a日b", 0), 1);
        assert_eq!(title_click_to_cursor(5, &area, "a日b", 0), 4);
        assert_eq!(title_click_to_cursor(6, &area, "a日b", 0), 5);
    }

    #[test]
    fn title_click_empty() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(5, &area, "", 0), 0);
    }

    #[test]
    fn title_click_before_text_start() {
        let area = Rect::new(0, 3, 100, 3);
        assert_eq!(title_click_to_cursor(0, &area, "hello", 0), 0);
        assert_eq!(title_click_to_cursor(1, &area, "hello", 0), 0);
    }

    #[test]
    fn desc_click_basic() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec![
            "hello".to_string(),
            "world".to_string(),
            "foo".to_string(),
        ];
        assert_eq!(desc_click_to_row_col(1, 7, &area, 0, 0, &lines), (0, 0));
        assert_eq!(desc_click_to_row_col(3, 7, &area, 0, 0, &lines), (0, 2));
        assert_eq!(desc_click_to_row_col(1, 8, &area, 0, 0, &lines), (1, 0));
        assert_eq!(desc_click_to_row_col(4, 9, &area, 0, 0, &lines), (2, 3));
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
        assert_eq!(desc_click_to_row_col(1, 7, &area, 2, 0, &lines), (2, 0));
        assert_eq!(desc_click_to_row_col(1, 8, &area, 2, 0, &lines), (3, 0));
    }

    #[test]
    fn desc_click_clamps_row() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["only".to_string()];
        assert_eq!(desc_click_to_row_col(50, 20, &area, 0, 0, &lines), (0, 4));
    }

    #[test]
    fn desc_click_unicode() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["日本語".to_string()];
        assert_eq!(desc_click_to_row_col(1, 7, &area, 0, 0, &lines), (0, 0));
        assert_eq!(desc_click_to_row_col(2, 7, &area, 0, 0, &lines), (0, 0));
        assert_eq!(desc_click_to_row_col(3, 7, &area, 0, 0, &lines), (0, 1));
        assert_eq!(desc_click_to_row_col(4, 7, &area, 0, 0, &lines), (0, 1));
        assert_eq!(desc_click_to_row_col(5, 7, &area, 0, 0, &lines), (0, 2));
        assert_eq!(desc_click_to_row_col(6, 7, &area, 0, 0, &lines), (0, 2));
        assert_eq!(desc_click_to_row_col(7, 7, &area, 0, 0, &lines), (0, 3));
    }

    #[test]
    fn desc_click_empty_lines() {
        let area = Rect::new(0, 6, 100, 10);
        let lines: Vec<String> = vec![];
        assert_eq!(desc_click_to_row_col(5, 7, &area, 0, 0, &lines), (0, 0));
    }

    #[test]
    fn desc_click_past_line_end() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["ab".to_string()];
        assert_eq!(desc_click_to_row_col(50, 7, &area, 0, 0, &lines), (0, 2));
    }

    // --- 横スクロールヘルパーのテスト ---

    #[test]
    fn snap_to_char_boundary_ascii() {
        assert_eq!(snap_to_char_boundary("hello", 0), 0);
        assert_eq!(snap_to_char_boundary("hello", 3), 3);
        assert_eq!(snap_to_char_boundary("hello", 5), 5);
        assert_eq!(snap_to_char_boundary("hello", 10), 5);
    }

    #[test]
    fn snap_to_char_boundary_cjk() {
        // "日本語" → 各文字 2 列、境界は 0, 2, 4, 6
        assert_eq!(snap_to_char_boundary("日本語", 0), 0);
        assert_eq!(snap_to_char_boundary("日本語", 1), 0);
        assert_eq!(snap_to_char_boundary("日本語", 2), 2);
        assert_eq!(snap_to_char_boundary("日本語", 3), 2);
        assert_eq!(snap_to_char_boundary("日本語", 4), 4);
        assert_eq!(snap_to_char_boundary("日本語", 5), 4);
        assert_eq!(snap_to_char_boundary("日本語", 6), 6);
    }

    #[test]
    fn snap_to_char_boundary_mixed() {
        // "a日b" → 境界は 0, 1, 3, 4
        assert_eq!(snap_to_char_boundary("a日b", 0), 0);
        assert_eq!(snap_to_char_boundary("a日b", 1), 1);
        assert_eq!(snap_to_char_boundary("a日b", 2), 1);
        assert_eq!(snap_to_char_boundary("a日b", 3), 3);
        assert_eq!(snap_to_char_boundary("a日b", 4), 4);
    }

    #[test]
    fn slice_text_no_scroll() {
        let (text, start) = slice_text_by_width("hello", 0, 10);
        assert_eq!(text, "hello");
        assert_eq!(start, 0);
    }

    #[test]
    fn slice_text_with_skip() {
        let (text, start) = slice_text_by_width("hello world", 6, 5);
        assert_eq!(text, "world");
        assert_eq!(start, 6);
    }

    #[test]
    fn slice_text_truncated() {
        let (text, start) = slice_text_by_width("hello world", 0, 5);
        assert_eq!(text, "hello");
        assert_eq!(start, 0);
    }

    #[test]
    fn slice_text_cjk_no_scroll() {
        let (text, start) = slice_text_by_width("日本語", 0, 6);
        assert_eq!(text, "日本語");
        assert_eq!(start, 0);
    }

    #[test]
    fn slice_text_cjk_with_skip() {
        // "日本語" skip 2 → "本語"
        let (text, start) = slice_text_by_width("日本語", 2, 4);
        assert_eq!(text, "本語");
        assert_eq!(start, 2);
    }

    #[test]
    fn slice_text_cjk_truncated() {
        // "日本語" take 4 → "日本"
        let (text, start) = slice_text_by_width("日本語", 0, 4);
        assert_eq!(text, "日本");
        assert_eq!(start, 0);
    }

    #[test]
    fn slice_text_cjk_skip_mid_char() {
        // skip 1 は全角文字の中間 → 文字境界 2 にスナップされ "本語" になる
        let (text, start) = slice_text_by_width("日本語", 1, 4);
        assert_eq!(text, "本語");
        assert_eq!(start, 2);
    }

    #[test]
    fn slice_text_mixed() {
        // "a日b" skip 1, take 3 → "日b" (日=2 + b=1 = 3)
        let (text, start) = slice_text_by_width("a日b", 1, 3);
        assert_eq!(text, "日b");
        assert_eq!(start, 1);
    }

    #[test]
    fn slice_text_empty() {
        let (text, start) = slice_text_by_width("", 0, 10);
        assert_eq!(text, "");
        assert_eq!(start, 0);
    }

    #[test]
    fn slice_text_skip_beyond_end() {
        let (text, start) = slice_text_by_width("ab", 5, 10);
        assert_eq!(text, "");
        assert_eq!(start, 2);
    }

    #[test]
    fn title_click_with_scroll() {
        let area = Rect::new(0, 3, 100, 3);
        // scroll_left = 3: 左省略記号 "…" が 1 列を占め、テキストは area.x+3 から
        // click_x=2 → "…" 上 → 補正後 表示列 0 → 実際の列 3 → 'l' (byte 3)
        assert_eq!(title_click_to_cursor(2, &area, "hello", 3), 3);
        // click_x=3 → テキスト先頭 → 補正後 表示列 0 → 実際の列 3 → 'l' (byte 3)
        assert_eq!(title_click_to_cursor(3, &area, "hello", 3), 3);
        // click_x=4 → テキスト 2 列目 → 補正後 表示列 1 → 実際の列 4 → 'o' (byte 4)
        assert_eq!(title_click_to_cursor(4, &area, "hello", 3), 4);
    }

    #[test]
    fn title_click_with_scroll_cjk() {
        let area = Rect::new(0, 3, 100, 3);
        // "日本語" scroll_left=2: 左省略記号 "…" が 1 列を占め、テキストは area.x+3 から
        // click_x=2 → "…" 上 → 補正後 表示列 0 → 実際の列 2 → '本' (byte 3)
        assert_eq!(title_click_to_cursor(2, &area, "日本語", 2), 3);
        // click_x=3 → テキスト先頭 → 補正後 表示列 0 → 実際の列 2 → '本' (byte 3)
        assert_eq!(title_click_to_cursor(3, &area, "日本語", 2), 3);
        // click_x=4 → 補正後 表示列 1 → 実際の列 3 → '本' の 2 列目 (byte 3)
        assert_eq!(title_click_to_cursor(4, &area, "日本語", 2), 3);
        // click_x=5 → 補正後 表示列 2 → 実際の列 4 → '語' (byte 6)
        assert_eq!(title_click_to_cursor(5, &area, "日本語", 2), 6);
    }

    // --- 説明欄横スクロール: desc_click_to_row_col with scroll_left ---

    #[test]
    fn desc_click_with_horizontal_scroll() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["hello world".to_string()];
        // scroll_left=6: 左省略記号 "…" が 1 列を占め、テキストは inner.x+1 から
        // click_x=1 → "…" 上 → 補正後 表示列 0 → 実際の列 6 → 'w' (col 6)
        assert_eq!(desc_click_to_row_col(1, 7, &area, 0, 6, &lines), (0, 6));
        // click_x=2 → テキスト先頭 → 補正後 表示列 0 → 実際の列 6 → 'w' (col 6)
        assert_eq!(desc_click_to_row_col(2, 7, &area, 0, 6, &lines), (0, 6));
        // click_x=3 → 補正後 表示列 1 → 実際の列 7 → 'o' (col 7)
        assert_eq!(desc_click_to_row_col(3, 7, &area, 0, 6, &lines), (0, 7));
        // click_x=4 → 補正後 表示列 2 → 実際の列 8 → 'r' (col 8)
        assert_eq!(desc_click_to_row_col(4, 7, &area, 0, 6, &lines), (0, 8));
    }

    #[test]
    fn desc_click_with_horizontal_scroll_cjk() {
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["日本語テスト".to_string()];
        // scroll_left=4: 左省略記号 "…" が 1 列を占め、テキストは inner.x+1 から
        // click_x=1 → "…" 上 → 補正後 表示列 0 → 実際の列 4 → '語' (col 2)
        assert_eq!(desc_click_to_row_col(1, 7, &area, 0, 4, &lines), (0, 2));
        // click_x=2 → テキスト先頭 → 補正後 表示列 0 → 実際の列 4 → '語' (col 2)
        assert_eq!(desc_click_to_row_col(2, 7, &area, 0, 4, &lines), (0, 2));
        // click_x=3 → 補正後 表示列 1 → 実際の列 5 → '語' の 2 列目 (col 2)
        assert_eq!(desc_click_to_row_col(3, 7, &area, 0, 4, &lines), (0, 2));
        // click_x=4 → 補正後 表示列 2 → 実際の列 6 → 'テ' (col 3)
        assert_eq!(desc_click_to_row_col(4, 7, &area, 0, 4, &lines), (0, 3));
    }

    // --- render_scrolled_line テスト ---

    /// 行のテキスト内容を抽出するヘルパー
    fn line_to_string(line: &Line) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn render_scrolled_line_no_scroll() {
        let line = render_scrolled_line("hello", 0, 10);
        assert_eq!(line_to_string(&line), "hello");
    }

    #[test]
    fn render_scrolled_line_right_ellipsis() {
        // "hello world" (11 cols), view_width=5, scroll_left=0
        // right_ellipsis = true (0+5 < 11)
        // content_width = 5-1 = 4
        let line = render_scrolled_line("hello world", 0, 5);
        assert_eq!(line_to_string(&line), "hell…");
    }

    #[test]
    fn render_scrolled_line_left_ellipsis() {
        // "hello world" (11 cols), view_width=5, scroll_left=6
        // left_ellipsis = true (6 > 0 && 11 > 6)
        // right_ellipsis = false (6+5 = 11, not < 11)
        // content_width = 5-1 = 4
        let line = render_scrolled_line("hello world", 6, 5);
        assert_eq!(line_to_string(&line), "…worl");
    }

    #[test]
    fn render_scrolled_line_both_ellipsis() {
        // "hello world" (11 cols), view_width=5, scroll_left=3
        // left_ellipsis = true, right_ellipsis = true (3+5=8 < 11)
        // content_width = 5-1-1 = 3
        let line = render_scrolled_line("hello world", 3, 5);
        assert_eq!(line_to_string(&line), "…lo …");
    }

    #[test]
    fn render_scrolled_line_empty() {
        let line = render_scrolled_line("", 0, 10);
        assert_eq!(line_to_string(&line), "");
    }

    #[test]
    fn render_scrolled_line_cjk_no_scroll() {
        // "日本語" (6 cols), view_width=6
        let line = render_scrolled_line("日本語", 0, 6);
        assert_eq!(line_to_string(&line), "日本語");
    }

    #[test]
    fn render_scrolled_line_cjk_right_ellipsis() {
        // "日本語" (6 cols), view_width=4, scroll_left=0
        // right_ellipsis = true (0+4 < 6)
        // content_width = 4-1 = 3 → "日" (2 cols) fits, "本" (2 cols) doesn't
        let line = render_scrolled_line("日本語", 0, 4);
        assert_eq!(line_to_string(&line), "日…");
    }

    #[test]
    fn render_scrolled_line_cjk_with_scroll() {
        // "日本語" (6 cols), view_width=4, scroll_left=2
        // left_ellipsis = true (2 > 0 && 6 > 2)
        // right_ellipsis = false (2+4 = 6, not < 6)
        // content_width = 4-1 = 3 → "本" (2 cols) fits, "語" (2 cols) doesn't
        let line = render_scrolled_line("日本語", 2, 4);
        assert_eq!(line_to_string(&line), "…本");
    }

    #[test]
    fn render_scrolled_line_short_line_no_ellipsis() {
        // 短い行: 省略記号なし
        let line = render_scrolled_line("ab", 0, 10);
        assert_eq!(line_to_string(&line), "ab");
    }

    #[test]
    fn render_scrolled_line_scroll_beyond_line() {
        // scroll_left が行幅を超える場合: 空表示
        let line = render_scrolled_line("ab", 5, 10);
        assert_eq!(line_to_string(&line), "");
    }

    // --- 左省略記号表示中のクリック精度テスト ---

    #[test]
    fn title_click_left_ellipsis_narrow_area() {
        // 狭い area (幅 10) で scroll_left > 0 の状態をシミュレート
        // draw_title_field: inner.width = 10-2 = 8, text_view_width = 7
        // "hello world" (11 cols), scroll_left=4 → left_ellipsis=true
        // spans: [" "(1), "…"(1), visible_text] → テキストは area.x+3 から
        let area = Rect::new(5, 3, 10, 3);
        // click_x=7 (area.x+2 = "…" 上) → 補正後 0 + 4 = 4 → 'o' (byte 4)
        assert_eq!(title_click_to_cursor(7, &area, "hello world", 4), 4);
        // click_x=8 (area.x+3 = テキスト先頭) → 補正後 0 + 4 = 4 → 'o' (byte 4)
        assert_eq!(title_click_to_cursor(8, &area, "hello world", 4), 4);
        // click_x=9 → 補正後 1 + 4 = 5 → ' ' (byte 5)
        assert_eq!(title_click_to_cursor(9, &area, "hello world", 4), 5);
        // click_x=10 → 補正後 2 + 4 = 6 → 'w' (byte 6)
        assert_eq!(title_click_to_cursor(10, &area, "hello world", 4), 6);
    }

    #[test]
    fn title_click_left_ellipsis_cjk_narrow_area() {
        // 狭い area で CJK テキストの左省略記号クリック
        // "日本語テスト" (12 cols), scroll_left=6 → left_ellipsis=true
        // テキストは area.x+3 から
        let area = Rect::new(2, 3, 10, 3);
        // click_x=4 (area.x+2 = "…" 上) → 補正後 0 + 6 = 6 → 'テ' (byte 9)
        assert_eq!(title_click_to_cursor(4, &area, "日本語テスト", 6), 9);
        // click_x=5 (area.x+3 = テキスト先頭) → 補正後 0 + 6 = 6 → 'テ' (byte 9)
        assert_eq!(title_click_to_cursor(5, &area, "日本語テスト", 6), 9);
        // click_x=6 → 補正後 1 + 6 = 7 → 'テ' の 2 列目 (byte 9)
        assert_eq!(title_click_to_cursor(6, &area, "日本語テスト", 6), 9);
        // click_x=7 → 補正後 2 + 6 = 8 → 'ス' (byte 12)
        assert_eq!(title_click_to_cursor(7, &area, "日本語テスト", 6), 12);
    }

    #[test]
    fn title_click_no_ellipsis_scroll_zero() {
        // scroll_left=0 のときは補正なし（既存動作の回帰確認）
        let area = Rect::new(0, 3, 10, 3);
        assert_eq!(title_click_to_cursor(2, &area, "hello", 0), 0);
        assert_eq!(title_click_to_cursor(3, &area, "hello", 1), 1);
    }

    #[test]
    fn desc_click_left_ellipsis_narrow_area() {
        // 狭い area で scroll_left > 0 の説明欄クリック
        // "hello world" (11 cols), scroll_left=4 → left_ellipsis=true
        // render_scrolled_line: "…" + visible → テキストは inner.x+1 から
        let area = Rect::new(3, 6, 10, 8);
        // inner_x = 4, click_x=4 → "…" 上 → 補正後 0 + 4 = 4 → 'o' (col 4)
        assert_eq!(desc_click_to_row_col(4, 7, &area, 0, 4, &["hello world".to_string()]), (0, 4));
        // click_x=5 → テキスト先頭 → 補正後 0 + 4 = 4 → 'o' (col 4)
        assert_eq!(desc_click_to_row_col(5, 7, &area, 0, 4, &["hello world".to_string()]), (0, 4));
        // click_x=6 → 補正後 1 + 4 = 5 → ' ' (col 5)
        assert_eq!(desc_click_to_row_col(6, 7, &area, 0, 4, &["hello world".to_string()]), (0, 5));
        // click_x=7 → 補正後 2 + 4 = 6 → 'w' (col 6)
        assert_eq!(desc_click_to_row_col(7, 7, &area, 0, 4, &["hello world".to_string()]), (0, 6));
    }

    #[test]
    fn desc_click_left_ellipsis_cjk_narrow_area() {
        // 狭い area で CJK テキストの左省略記号クリック
        // "日本語テスト" (12 cols), scroll_left=6 → left_ellipsis=true
        let area = Rect::new(1, 6, 10, 8);
        // inner_x = 2, click_x=2 → "…" 上 → 補正後 0 + 6 = 6 → 'テ' (col 3)
        assert_eq!(desc_click_to_row_col(2, 7, &area, 0, 6, &["日本語テスト".to_string()]), (0, 3));
        // click_x=3 → テキスト先頭 → 補正後 0 + 6 = 6 → 'テ' (col 3)
        assert_eq!(desc_click_to_row_col(3, 7, &area, 0, 6, &["日本語テスト".to_string()]), (0, 3));
        // click_x=4 → 補正後 1 + 6 = 7 → 'テ' の 2 列目 (col 3)
        assert_eq!(desc_click_to_row_col(4, 7, &area, 0, 6, &["日本語テスト".to_string()]), (0, 3));
        // click_x=5 → 補正後 2 + 6 = 8 → 'ス' (col 4)
        assert_eq!(desc_click_to_row_col(5, 7, &area, 0, 6, &["日本語テスト".to_string()]), (0, 4));
    }

    #[test]
    fn desc_click_no_ellipsis_short_line_with_scroll() {
        // scroll_left > 0 だが行が短い（line_width <= scroll_left）場合:
        // left_ellipsis = false → 補正なし
        let area = Rect::new(0, 6, 100, 10);
        let lines = vec!["ab".to_string()];
        // scroll_left=5 > line_width=2 → left_ellipsis=false
        // click_x=1 → 補正なし 0 + 5 = 5 → 行末 (col 2)
        assert_eq!(desc_click_to_row_col(1, 7, &area, 0, 5, &lines), (0, 2));
    }

}
