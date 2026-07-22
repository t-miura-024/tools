use std::io;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyModifiers, MouseEvent, MouseEventKind,
};
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use crossterm::ExecutableCommand;
use crossterm::execute;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use tui_textarea::TextArea;

use super::state::{Field, FormState};
use super::ui;
use super::ui::{ClickTarget, ConfirmClick};

pub struct DraftInput {
    pub repo_path: PathBuf,
    pub title: String,
    pub description: String,
}

pub fn run_tui() -> anyhow::Result<Option<DraftInput>> {
    let repos = load_repos()?;
    let mut state = FormState::new(repos);
    let mut desc_area = TextArea::default();
    desc_area.set_placeholder_text("説明を入力...（複数行可）");

    let mut stdout = io::stdout();
    stdout
        .execute(EnterAlternateScreen)
        .context("ターミナルの初期化に失敗しました")?;
    enable_raw_mode().context("raw mode の有効化に失敗しました")?;
    execute!(stdout, crossterm::event::EnableMouseCapture)
        .context("マウスキャプチャの有効化に失敗しました")?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("ターミナルの作成に失敗しました")?;

    let result = event_loop(&mut terminal, &mut state, &mut desc_area);

    disable_raw_mode()?;
    execute!(
        io::stdout(),
        crossterm::event::DisableMouseCapture,
        LeaveAlternateScreen
    )?;

    result
}

fn load_repos() -> anyhow::Result<Vec<crate::git::repo::repo_discover::RepoEntry>> {
    use crate::config;
    use crate::git::repo::repo_discover;

    let home = config::home_dir();
    let roots: Vec<PathBuf> = config::REPO_ROOTS.iter().map(|r| home.join(r)).collect();
    let entries = repo_discover::discover_repos(&roots)?;
    Ok(repo_discover::sort_entries(entries))
}

fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    state: &mut FormState,
    desc_area: &mut TextArea,
) -> anyhow::Result<Option<DraftInput>> {
    loop {
        terminal.draw(|frame| ui::draw(frame, state, desc_area))?;

        if !event::poll(Duration::from_millis(100))? {
            continue;
        }

        let ev = event::read()?;

        let action = match ev {
            Event::Key(key) => handle_key_event(key, state, desc_area),
            Event::Mouse(mouse) => {
                let frame_area = terminal.get_frame().area();
                handle_mouse_event(mouse, state, frame_area)
            }
            _ => None,
        };

        match action {
            Some(LoopAction::SubmitRequested) => {
                let desc = desc_area.lines().join("\n");
                if state.needs_desc_confirm(&desc) {
                    state.show_empty_desc_confirm = true;
                } else {
                    return Ok(Some(build_input(state, desc_area)));
                }
            }
            Some(LoopAction::SubmitConfirmed) => {
                return Ok(Some(build_input(state, desc_area)));
            }
            Some(LoopAction::Cancel) => {
                return Ok(None);
            }
            None => {}
        }
    }
}

enum LoopAction {
    SubmitRequested,
    SubmitConfirmed,
    Cancel,
}

fn handle_key_event(
    key: KeyEvent,
    state: &mut FormState,
    desc_area: &mut TextArea,
) -> Option<LoopAction> {
    if state.show_empty_desc_confirm {
        match handle_confirm_key(key, state, desc_area) {
            ConfirmAction::Submit => return Some(LoopAction::SubmitConfirmed),
            ConfirmAction::Back => {}
            ConfirmAction::None => {}
        }
        return None;
    }

    if state.popup.is_some() {
        match handle_popup_key(key, state) {
            PopupAction::Selected => {}
            PopupAction::Cancelled => {}
            PopupAction::None => {}
        }
        return None;
    }

    match handle_form_key(key, state, desc_area) {
        FormAction::Submit => {
            return Some(LoopAction::SubmitRequested);
        }
        FormAction::Cancel => {
            return Some(LoopAction::Cancel);
        }
        FormAction::None => {}
    }
    None
}

fn handle_mouse_event(
    mouse: MouseEvent,
    state: &mut FormState,
    frame_area: ratatui::layout::Rect,
) -> Option<LoopAction> {
    if !matches!(
        mouse.kind,
        MouseEventKind::Down(crossterm::event::MouseButton::Left)
    ) {
        return None;
    }

    let (x, y) = (mouse.column, mouse.row);

    if state.show_empty_desc_confirm {
        let dialog = ui::confirm_rect(frame_area);
        if let Some(click) = ui::confirm_hit_test(x, y, dialog) {
            state.show_empty_desc_confirm = false;
            return match click {
                ConfirmClick::Yes => Some(LoopAction::SubmitConfirmed),
                ConfirmClick::No => None,
            };
        }
        return None;
    }

    if state.popup.is_some() {
        let popup_area = ui::popup_rect(frame_area);
        let popup = state.popup.as_ref().unwrap();
        let filtered = popup.filtered_indices(&state.repos);
        if let Some(vis_idx) = ui::popup_hit_test(x, y, popup_area, filtered.len()) {
            let real_idx = filtered[vis_idx];
            state.popup.as_mut().unwrap().selected_index = real_idx;
            state.confirm_repo_selection();
        }
        return None;
    }

    let areas = ui::compute_layout(frame_area);
    if let Some(target) = ui::hit_test_form(x, y, &areas) {
        match target {
            ClickTarget::Repo => {
                state.focus = Field::Repo;
            }
            ClickTarget::Title => {
                state.focus = Field::Title;
            }
            ClickTarget::Description => {
                state.focus = Field::Description;
            }
            ClickTarget::SubmitButton => {
                if state.can_submit() {
                    return Some(LoopAction::SubmitRequested);
                }
            }
        }
    }
    None
}

fn build_input(state: &FormState, desc_area: &TextArea) -> DraftInput {
    DraftInput {
        repo_path: state.repo_path.clone().unwrap(),
        title: state.title.trim().to_string(),
        description: desc_area.lines().join("\n"),
    }
}

enum FormAction {
    Submit,
    Cancel,
    None,
}

fn handle_form_key(key: KeyEvent, state: &mut FormState, desc_area: &mut TextArea) -> FormAction {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        match key.code {
            KeyCode::Char('s') => {
                if state.can_submit() {
                    return FormAction::Submit;
                }
                return FormAction::None;
            }
            KeyCode::Char('c') => return FormAction::Cancel,
            _ => return FormAction::None,
        }
    }

    match key.code {
        KeyCode::Esc => return FormAction::Cancel,
        KeyCode::Tab => {
            state.focus_next();
        }
        KeyCode::BackTab => {
            state.focus_prev();
        }
        KeyCode::Enter => {
            if state.focus == Field::Repo {
                state.open_popup();
            }
        }
        _ => {
            match state.focus {
                Field::Title => handle_title_key(key, state),
                Field::Description => {
                    desc_area.input(key);
                }
                Field::Repo => {}
            }
        }
    }

    FormAction::None
}

fn handle_title_key(key: KeyEvent, state: &mut FormState) {
    match key.code {
        KeyCode::Char(c) => state.title_insert(c),
        KeyCode::Backspace => state.title_backspace(),
        KeyCode::Delete => state.title_delete(),
        KeyCode::Left => state.title_move_left(),
        KeyCode::Right => state.title_move_right(),
        KeyCode::Home => state.title_cursor = 0,
        KeyCode::End => state.title_cursor = state.title.len(),
        _ => {}
    }
}

enum PopupAction {
    Selected,
    Cancelled,
    None,
}

fn handle_popup_key(key: KeyEvent, state: &mut FormState) -> PopupAction {
    let popup = state.popup.as_mut().unwrap();

    match key.code {
        KeyCode::Esc => {
            state.close_popup();
            PopupAction::Cancelled
        }
        KeyCode::Enter => {
            state.confirm_repo_selection();
            PopupAction::Selected
        }
        KeyCode::Up => {
            let repos = &state.repos;
            popup.move_up(repos);
            PopupAction::None
        }
        KeyCode::Down => {
            let repos = &state.repos;
            popup.move_down(repos);
            PopupAction::None
        }
        KeyCode::Char(c) => {
            popup.filter.push(c);
            let repos = &state.repos;
            popup.clamp_selection(repos);
            PopupAction::None
        }
        KeyCode::Backspace => {
            popup.filter.pop();
            let repos = &state.repos;
            popup.clamp_selection(repos);
            PopupAction::None
        }
        _ => PopupAction::None,
    }
}

enum ConfirmAction {
    Submit,
    Back,
    None,
}

fn handle_confirm_key(
    key: KeyEvent,
    state: &mut FormState,
    _desc_area: &TextArea,
) -> ConfirmAction {
    match key.code {
        KeyCode::Char('y') | KeyCode::Char('Y') => {
            state.show_empty_desc_confirm = false;
            ConfirmAction::Submit
        }
        KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
            state.show_empty_desc_confirm = false;
            ConfirmAction::Back
        }
        _ => ConfirmAction::None,
    }
}
