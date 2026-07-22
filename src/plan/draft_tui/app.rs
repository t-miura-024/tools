use std::io;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyModifiers,
};
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use crossterm::ExecutableCommand;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use tui_textarea::TextArea;

use super::state::{Field, FormState};
use super::ui;

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

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("ターミナルの作成に失敗しました")?;

    let result = event_loop(&mut terminal, &mut state, &mut desc_area);

    disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;

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

        let Event::Key(key) = event::read()? else {
            continue;
        };

        if state.show_empty_desc_confirm {
            match handle_confirm_key(key, state, desc_area) {
                ConfirmAction::Submit => {
                    return Ok(Some(build_input(state, desc_area)));
                }
                ConfirmAction::Back => {}
                ConfirmAction::None => {}
            }
            continue;
        }

        if state.popup.is_some() {
            match handle_popup_key(key, state) {
                PopupAction::Selected => {}
                PopupAction::Cancelled => {}
                PopupAction::None => {}
            }
            continue;
        }

        match handle_form_key(key, state, desc_area) {
            FormAction::Submit => {
                let desc = desc_area.lines().join("\n");
                if state.needs_desc_confirm(&desc) {
                    state.show_empty_desc_confirm = true;
                } else {
                    return Ok(Some(build_input(state, desc_area)));
                }
            }
            FormAction::Cancel => {
                return Ok(None);
            }
            FormAction::None => {}
        }
    }
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
