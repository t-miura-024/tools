use std::io;
use std::path::PathBuf;
use std::sync::mpsc;
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
use tui_textarea::{CursorMove, TextArea};

use super::state::{AuthStatus, Field, FormState};
use super::ui;
use super::ui::ClickTarget;

pub struct DraftInput {
    pub repo_path: PathBuf,
    pub title: String,
    pub description: String,
}

/// フォーム TUI を起動する。
///
/// `auth_rx` は `draft.rs` 側で起動されたバックグラウンド認証チェック
/// （`gh auth status`）の結果チャンネル。送信値は `true` = 認証成功、
/// `false` = 認証失敗。イベントループ内でポーリングされ `AuthStatus` に反映される。
pub fn run_tui(auth_rx: mpsc::Receiver<bool>) -> anyhow::Result<Option<DraftInput>> {
    let repos = load_repos()?;
    let mut state = FormState::new(repos);
    apply_cwd_default_selection(&mut state);
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

    let result = event_loop(&mut terminal, &mut state, &mut desc_area, &auth_rx);

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

/// カレントディレクトリが属するリポジトリを検出し、列挙内エントリと一致すれば
/// デフォルト選択する。検出・マッチングに失敗した場合は silently スキップし、
/// `(未選択)` を維持する（便利機能であり、エラーにしない）。
fn apply_cwd_default_selection(state: &mut FormState) {
    use crate::git::repo::repo_discover;

    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let Some(detected) = repo_discover::detect_current_repo_path(&cwd) else {
        return;
    };
    state.apply_default_selection(&detected);
}

fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    state: &mut FormState,
    desc_area: &mut TextArea,
    auth_rx: &mpsc::Receiver<bool>,
) -> anyhow::Result<Option<DraftInput>> {
    let mut hover: Option<ClickTarget> = None;
    let mut popup_hover: Option<usize> = None;
    loop {
        // バックグラウンド認証結果をポーリング（未確定の間のみ更新）
        update_auth_status(state, auth_rx);

        terminal.draw(|frame| ui::draw(frame, state, desc_area, hover, popup_hover))?;

        if !event::poll(Duration::from_millis(100))? {
            continue;
        }

        let ev = event::read()?;

        let action = match ev {
            Event::Key(key) => {
                hover = None;
                popup_hover = None;
                handle_key_event(key, state, desc_area)
            }
            Event::Mouse(mouse) => {
                let frame_area = terminal.get_frame().area();
                handle_mouse_event(mouse, state, desc_area, frame_area, &mut hover, &mut popup_hover)
            }
            _ => None,
        };

        match action {
            Some(LoopAction::SubmitRequested) => {
                return Ok(build_input(state, desc_area));
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
    Cancel,
}

/// 認証状態が未確定（`Checking`）の間のみバックグラウンド結果をポーリングし、
/// 確定後は状態を維持する。
///
/// 確定（`Authenticated` / `Failed`）後もポーリングを続けると、送信スレッド
/// 終了による `Disconnected` で確定済みの状態が `Failed` に上書きされてしまう
/// ため、ガードが必要。
fn update_auth_status(state: &mut FormState, rx: &mpsc::Receiver<bool>) {
    if state.auth_status == AuthStatus::Checking
        && let Some(status) = poll_auth_status(rx)
    {
        state.auth_status = status;
    }
}

/// バックグラウンド認証チャンネルを非ブロッキングで確認し、状態変化があれば返す。
///
/// - `Ok(true)` → `Authenticated`
/// - `Ok(false)` → `Failed`
/// - まだ結果なし（`Empty`）→ `None`（状態維持）
/// - 送信側切断（`Disconnected`、スレッド異常終了等）→ `Failed`（安全側倒し）
fn poll_auth_status(rx: &mpsc::Receiver<bool>) -> Option<AuthStatus> {
    match rx.try_recv() {
        Ok(true) => Some(AuthStatus::Authenticated),
        Ok(false) => Some(AuthStatus::Failed),
        Err(mpsc::TryRecvError::Empty) => None,
        Err(mpsc::TryRecvError::Disconnected) => Some(AuthStatus::Failed),
    }
}

fn handle_key_event(
    key: KeyEvent,
    state: &mut FormState,
    desc_area: &mut TextArea,
) -> Option<LoopAction> {
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

fn update_hover(
    x: u16,
    y: u16,
    state: &FormState,
    frame_area: ratatui::layout::Rect,
    hover: &mut Option<ClickTarget>,
    popup_hover: &mut Option<usize>,
) {
    let Some(popup) = state.popup.as_ref() else {
        *popup_hover = None;
        let areas = ui::compute_layout(frame_area);
        *hover = ui::hit_test_form(x, y, &areas);
        return;
    };
    *hover = None;
    let popup_area = ui::popup_rect(frame_area);
    let filtered = popup.filtered_indices(&state.repos);
    *popup_hover = ui::popup_hit_test(x, y, popup_area, filtered.len());
}

fn handle_mouse_event(
    mouse: MouseEvent,
    state: &mut FormState,
    desc_area: &mut TextArea,
    frame_area: ratatui::layout::Rect,
    hover: &mut Option<ClickTarget>,
    popup_hover: &mut Option<usize>,
) -> Option<LoopAction> {
    let (x, y) = (mouse.column, mouse.row);

    match mouse.kind {
        MouseEventKind::Moved => {
            update_hover(x, y, state, frame_area, hover, popup_hover);
            return None;
        }
        MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
            update_hover(x, y, state, frame_area, hover, popup_hover);
        }
        _ => return None,
    }

    let Some(popup) = state.popup.as_mut() else {
        if let Some(target) = *hover {
            let areas = ui::compute_layout(frame_area);
            match target {
                ClickTarget::Repo => {
                    state.focus = Field::Repo;
                    state.open_popup();
                    *hover = None;
                }
                ClickTarget::Title => {
                    state.focus = Field::Title;
                    state.title_cursor = ui::title_click_to_cursor(x, &areas.title, &state.title);
                }
                ClickTarget::Description => {
                    state.focus = Field::Description;
                    let desc_full = ratatui::layout::Rect {
                        x: areas.desc_label.x,
                        y: areas.desc_label.y,
                        width: areas.desc_label.width,
                        height: areas.desc_label.height + areas.desc_text.height,
                    };
                    let lines: Vec<String> =
                        desc_area.lines().iter().map(|s| s.to_string()).collect();
                    let (target_row, target_col) = ui::desc_click_to_row_col(
                        x,
                        y,
                        &desc_full,
                        state.desc_scroll_top,
                        &lines,
                    );
                    let (cur_row, _cur_col) = desc_area.cursor();
                    if target_row > cur_row {
                        for _ in 0..(target_row - cur_row) {
                            desc_area.move_cursor(CursorMove::Down);
                        }
                    } else if target_row < cur_row {
                        for _ in 0..(cur_row - target_row) {
                            desc_area.move_cursor(CursorMove::Up);
                        }
                    }
                    desc_area.move_cursor(CursorMove::Head);
                    for _ in 0..target_col {
                        desc_area.move_cursor(CursorMove::Forward);
                    }
                }
            }
        }
        return None;
    };
    let popup_area = ui::popup_rect(frame_area);
    let filtered = popup.filtered_indices(&state.repos);
    if let Some(vis_idx) = ui::popup_hit_test(x, y, popup_area, filtered.len()) {
        let real_idx = filtered[vis_idx];
        popup.selected_index = real_idx;
        state.confirm_repo_selection();
        *popup_hover = None;
    }
    None
}

fn build_input(state: &FormState, desc_area: &TextArea) -> Option<DraftInput> {
    Some(DraftInput {
        repo_path: state.repo_path.clone()?,
        title: state.title.trim().to_string(),
        description: desc_area.lines().join("\n"),
    })
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
        KeyCode::Enter => match state.focus {
            Field::Repo => {
                state.open_popup();
            }
            Field::Description => {
                desc_area.input(key);
            }
            Field::Title => {}
        },
        _ => match state.focus {
            Field::Title => handle_title_key(key, state),
            Field::Description => {
                desc_area.input(key);
            }
            Field::Repo => {}
        },
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
    let Some(popup) = state.popup.as_mut() else {
        return PopupAction::None;
    };

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_auth_status_empty_returns_none() {
        let (_tx, rx) = mpsc::channel();
        assert_eq!(poll_auth_status(&rx), None);
    }

    #[test]
    fn poll_auth_status_authenticated() {
        let (tx, rx) = mpsc::channel();
        tx.send(true).unwrap();
        assert_eq!(poll_auth_status(&rx), Some(AuthStatus::Authenticated));
    }

    #[test]
    fn poll_auth_status_failed() {
        let (tx, rx) = mpsc::channel();
        tx.send(false).unwrap();
        assert_eq!(poll_auth_status(&rx), Some(AuthStatus::Failed));
    }

    #[test]
    fn poll_auth_status_disconnected_returns_failed() {
        let (tx, rx) = mpsc::channel::<bool>();
        drop(tx);
        assert_eq!(poll_auth_status(&rx), Some(AuthStatus::Failed));
    }

    /// 回帰テスト: 認証成功（`Ok(true)`）受信後に送信スレッドが終了して
    /// チャンネルが `Disconnected` になっても、確定済みの `Authenticated` が
    /// 維持されること（`Failed` に上書きされないこと）。
    #[test]
    fn authenticated_state_survives_sender_disconnect() {
        let (tx, rx) = mpsc::channel();
        let mut state = FormState::new(vec![]);
        assert_eq!(state.auth_status, AuthStatus::Checking);

        // 認証成功を受信 → Authenticated に確定
        tx.send(true).unwrap();
        update_auth_status(&mut state, &rx);
        assert_eq!(state.auth_status, AuthStatus::Authenticated);

        // 送信スレッド終了 → 次回ポーリングは Disconnected になるが、
        // ガードにより確定済み状態は維持される
        drop(tx);
        update_auth_status(&mut state, &rx);
        assert_eq!(state.auth_status, AuthStatus::Authenticated);
    }
}

