use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use tui_textarea::TextArea;

use super::state::{Field, FormState};

#[derive(Debug, Clone)]
pub struct LayoutAreas {
    pub repo: Rect,
    pub title: Rect,
    pub desc_label: Rect,
    pub desc_text: Rect,
    pub help_bar: Rect,
}

pub fn compute_layout(area: Rect) -> LayoutAreas {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(3),
        ])
        .split(area);
    LayoutAreas {
        repo: chunks[0],
        title: chunks[1],
        desc_label: chunks[2],
        desc_text: chunks[3],
        help_bar: chunks[4],
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmClick {
    Yes,
    No,
}

pub fn confirm_hit_test(x: u16, y: u16, dialog_area: Rect) -> Option<ConfirmClick> {
    if !dialog_area.contains((x, y).into()) {
        return None;
    }
    let button_y = dialog_area.y + 4;
    if y != button_y {
        return None;
    }
    let inner_x = x.saturating_sub(dialog_area.x);
    if inner_x >= 3 && inner_x <= 10 {
        return Some(ConfirmClick::Yes);
    }
    if inner_x >= 14 && inner_x <= 21 {
        return Some(ConfirmClick::No);
    }
    None
}

pub fn popup_rect(frame_area: Rect) -> Rect {
    centered_rect(70, 70, frame_area)
}

pub fn confirm_rect(frame_area: Rect) -> Rect {
    centered_rect(50, 20, frame_area)
}

pub fn draw(
    frame: &mut Frame,
    state: &mut FormState,
    desc_area: &TextArea,
    hover: Option<ClickTarget>,
    popup_hover: Option<usize>,
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
    draw_help_bar(frame, state, areas.help_bar);

    if let Some(ref popup) = state.popup {
        draw_repo_popup(frame, state, popup, popup_hover);
    }

    if state.show_empty_desc_confirm {
        draw_confirm_dialog(frame);
    }
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

fn draw_title_field(frame: &mut Frame, state: &FormState, area: Rect, hovered: bool) {
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
    } else {
        let text = Paragraph::new(Line::from(vec![Span::styled(
            format!(" {}", state.title),
            Style::default().fg(Color::White),
        )]));
        frame.render_widget(text, inner);
        if focused {
            let cursor_x = inner.x + 1 + unicode_width(&state.title[..state.title_cursor]);
            let cursor_y = inner.y;
            frame.set_cursor_position((cursor_x, cursor_y));
        }
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
    let visible_height = inner.height as usize;

    if cursor_row < state.desc_scroll_top {
        state.desc_scroll_top = cursor_row;
    } else if visible_height > 0 && cursor_row >= state.desc_scroll_top + visible_height {
        state.desc_scroll_top = cursor_row + 1 - visible_height;
    }

    let is_empty = lines.iter().all(|l| l.is_empty());

    if is_empty && !focused {
        let placeholder = Paragraph::new(Span::styled(
            "説明を入力...（複数行可）",
            Style::default().fg(Color::DarkGray),
        ));
        frame.render_widget(placeholder, inner);
    } else {
        let visible_lines: Vec<Line> = lines
            .iter()
            .skip(state.desc_scroll_top)
            .take(visible_height)
            .map(|line| {
                if line.is_empty() {
                    Line::from("")
                } else {
                    Line::from(Span::styled(
                        line.as_str(),
                        Style::default().fg(Color::White),
                    ))
                }
            })
            .collect();

        let paragraph = Paragraph::new(visible_lines);
        frame.render_widget(paragraph, inner);
    }

    if focused {
        let current_line = lines.get(cursor_row).map(|s| s.as_str()).unwrap_or("");
        let byte_offset = current_line
            .char_indices()
            .nth(cursor_col)
            .map(|(i, _)| i)
            .unwrap_or(current_line.len());
        let col_display_width = unicode_width(&current_line[..byte_offset]);
        let cursor_x = inner.x + col_display_width;
        let cursor_y = inner.y + (cursor_row.saturating_sub(state.desc_scroll_top)) as u16;
        frame.set_cursor_position((cursor_x, cursor_y));
    }
}

fn draw_help_bar(frame: &mut Frame, state: &FormState, area: Rect) {
    let hints = if state.show_empty_desc_confirm {
        "y: 送信  n: 戻る"
    } else if state.popup.is_some() {
        "↑↓: 移動  Enter: 選択  Esc: 閉じる  入力: 絞り込み"
    } else {
        "Tab/Shift-Tab: 移動  Enter: リポ選択  Ctrl+S: 送信  Esc: キャンセル"
    };

    let paragraph = Paragraph::new(Line::from(vec![Span::styled(
        format!(" {hints}"),
        Style::default().fg(Color::DarkGray),
    )]))
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

fn draw_confirm_dialog(frame: &mut Frame) {
    let area = confirm_rect(frame.area());
    frame.render_widget(Clear, area);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(Span::styled(
            " 確認 ",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ));

    let text = vec![
        Line::from(""),
        Line::from(Span::styled(
            " 説明が空ですが、このまま起票しますか？",
            Style::default().fg(Color::White),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "   y: 送信    n: 戻る",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    let paragraph = Paragraph::new(text)
        .block(block)
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
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

fn unicode_width(s: &str) -> u16 {
    s.chars()
        .map(|c| {
            if c.is_ascii() {
                1
            } else {
                2
            }
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_area() -> Rect {
        Rect::new(0, 0, 100, 40)
    }

    #[test]
    fn compute_layout_splits_five_regions() {
        let areas = compute_layout(test_area());
        assert_eq!(areas.repo.height, 3);
        assert_eq!(areas.title.height, 3);
        assert_eq!(areas.desc_label.height, 3);
        assert!(areas.desc_text.height >= 5);
        assert_eq!(areas.help_bar.height, 3);
        assert_eq!(areas.repo.y, 0);
        assert_eq!(areas.title.y, 3);
        assert_eq!(areas.desc_label.y, 6);
        assert_eq!(areas.desc_text.y, 9);
        assert_eq!(areas.help_bar.y, 37);
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
    fn confirm_hit_test_yes() {
        let dialog = Rect::new(25, 16, 50, 8);
        let y_line = dialog.y + 4;
        assert_eq!(
            confirm_hit_test(dialog.x + 4, y_line, dialog),
            Some(ConfirmClick::Yes)
        );
    }

    #[test]
    fn confirm_hit_test_no() {
        let dialog = Rect::new(25, 16, 50, 8);
        let y_line = dialog.y + 4;
        assert_eq!(
            confirm_hit_test(dialog.x + 15, y_line, dialog),
            Some(ConfirmClick::No)
        );
    }

    #[test]
    fn confirm_hit_test_wrong_line() {
        let dialog = Rect::new(25, 16, 50, 8);
        assert_eq!(confirm_hit_test(dialog.x + 4, dialog.y + 2, dialog), None);
    }

    #[test]
    fn confirm_hit_test_outside() {
        let dialog = Rect::new(25, 16, 50, 8);
        assert_eq!(confirm_hit_test(0, 0, dialog), None);
    }
}
