use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use tui_textarea::TextArea;

use super::state::{Field, FormState};

pub fn draw(frame: &mut Frame, state: &FormState, desc_area: &TextArea) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(3),
        ])
        .split(frame.area());

    draw_repo_field(frame, state, chunks[0]);
    draw_title_field(frame, state, chunks[1]);
    draw_description_field(frame, state, desc_area, chunks[2], chunks[3]);
    draw_help_bar(frame, state, chunks[4]);

    if let Some(ref popup) = state.popup {
        draw_repo_popup(frame, state, popup);
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

fn border_style(focused: bool) -> Style {
    if focused {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::DarkGray)
    }
}

fn draw_repo_field(frame: &mut Frame, state: &FormState, area: Rect) {
    let focused = state.focus == Field::Repo && state.popup.is_none();
    let title = Span::styled(" 📂 リポジトリ ", field_style(focused));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style(focused))
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

fn draw_title_field(frame: &mut Frame, state: &FormState, area: Rect) {
    let focused = state.focus == Field::Title;
    let title = Span::styled(" ✏️ タイトル ", field_style(focused));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style(focused))
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
    state: &FormState,
    desc_area: &TextArea,
    label_area: Rect,
    text_area: Rect,
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
        .border_style(border_style(focused))
        .title(Span::styled(" 📄 説明 ", field_style(focused)));

    let inner = block.inner(full_area);
    frame.render_widget(block, full_area);

    let mut ta = desc_area.clone();
    if focused {
        ta.set_cursor_style(Style::default().fg(Color::Cyan));
    }
    ta.set_block(Block::default());
    frame.render_widget(&ta, inner);
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

fn draw_repo_popup(frame: &mut Frame, state: &FormState, popup: &super::state::RepoPopup) {
    let area = centered_rect(70, 70, frame.area());
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
        .map(|&idx| {
            let entry = &state.repos[idx];
            let label = format!(
                " {}/{} {}",
                entry.category,
                entry.name,
                entry.label()
            );
            let style = if idx == popup.selected_index {
                Style::default()
                    .bg(Color::DarkGray)
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD)
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
    let area = centered_rect(50, 20, frame.area());
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
