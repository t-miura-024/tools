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

use crate::plan::draft::{self, CreatedIssue, ExistingIssue, PlanConfig};

use super::state::{AuthStatus, FetchPhase, Field, FormState, SubmitPhase};
use super::ui;
use super::ui::ClickTarget;

/// submit スレッドからの結果。stale 判定のため起票時の repo_path を添える。
/// 成功時は作成 Issue、失敗時はエラーメッセージ。
type SubmitResult = (PathBuf, Result<CreatedIssue, String>);
/// fetch スレッドからの結果。stale 判定のため repo_path を添える。
type FetchResult = (PathBuf, Result<Vec<ExistingIssue>, String>);

/// フォーム TUI を起動する。
///
/// `auth_rx` は `draft.rs` 側で起動されたバックグラウンド認証チェック
/// （`gh auth status`）の結果チャンネル。送信値は `true` = 認証成功、
/// `false` = 認証失敗。イベントループ内でポーリングされ `AuthStatus` に反映される。
///
/// submit（Issue 作成）と既存 Issue fetch は TUI 内のバックグラウンドスレッドで
/// 実行され、イベントループはチャネル経由で結果を受け取って描画する。
/// 終了時（esc / ctrl+C、submit 中以外）に今回セッションで作成した Issue 一覧を返す。
pub fn run_tui(
    config: PlanConfig,
    auth_rx: mpsc::Receiver<bool>,
) -> anyhow::Result<Vec<CreatedIssue>> {
    let repos = load_repos()?;
    let mut state = FormState::new(repos);
    apply_cwd_default_selection(&mut state);
    let mut desc_area = new_desc_area();

    let mut stdout = io::stdout();
    stdout
        .execute(EnterAlternateScreen)
        .context("ターミナルの初期化に失敗しました")?;
    enable_raw_mode().context("raw mode の有効化に失敗しました")?;
    execute!(stdout, crossterm::event::EnableMouseCapture)
        .context("マウスキャプチャの有効化に失敗しました")?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("ターミナルの作成に失敗しました")?;

    let result = event_loop(&mut terminal, &mut state, &mut desc_area, &auth_rx, &config);

    disable_raw_mode()?;
    execute!(
        io::stdout(),
        crossterm::event::DisableMouseCapture,
        LeaveAlternateScreen
    )?;

    result
}

fn new_desc_area() -> TextArea<'static> {
    let mut desc_area = TextArea::default();
    desc_area.set_placeholder_text("説明を入力...（複数行可）");
    desc_area
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
    config: &PlanConfig,
) -> anyhow::Result<Vec<CreatedIssue>> {
    let mut hover: Option<ClickTarget> = None;
    let mut popup_hover: Option<usize> = None;
    let mut tick: u64 = 0;

    // バックグラウンドジョブの結果チャンネル（必要時に生成）
    let mut submit_rx: Option<mpsc::Receiver<SubmitResult>> = None;
    let mut fetch_rx: Option<mpsc::Receiver<FetchResult>> = None;

    // セッション全体で作成した Issue（終了時のサマリー用）
    let mut session_created: Vec<CreatedIssue> = Vec::new();

    // repo 切替検出用。初期値 None とし、起動時のデフォルト選択も fetch を発火させる。
    let mut last_repo: Option<PathBuf> = None;

    loop {
        // バックグラウンド認証結果をポーリング（未確定の間のみ更新）
        update_auth_status(state, auth_rx);

        // repo 切替を検出し、「今回作成」「既存」を当前 repo スコープに更新する。
        if state.repo_path != last_repo {
            on_repo_changed(state, config, &mut fetch_rx);
            last_repo = state.repo_path.clone();
        }

        // 既存 Issue fetch 結果をポーリング
        poll_fetch_result(state, &mut fetch_rx);

        // submit 結果をポーリング（完了後もループ継続、戻り値はテスト用にのみ使用）
        let _ = poll_submit_result(state, desc_area, &mut submit_rx, &mut session_created);

        terminal.draw(|frame| ui::draw(frame, state, desc_area, hover, popup_hover, tick))?;
        tick = tick.wrapping_add(1);

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
            Some(LoopAction::StartSubmit) => {
                start_submit(state, desc_area, config, &mut submit_rx);
            }
            Some(LoopAction::Cancel) => {
                return Ok(session_created);
            }
            None => {}
        }
    }
}

/// repo 切替時: 「今回作成」「既存」をクリアし、選択 repo があれば既存 Issue の
/// 非同期 fetch を発火する（fetch 中はローディング表示）。
fn on_repo_changed(
    state: &mut FormState,
    config: &PlanConfig,
    fetch_rx: &mut Option<mpsc::Receiver<FetchResult>>,
) {
    state.created_issues.clear();
    state.existing_issues.clear();

    let Some(repo_path) = state.repo_path.clone() else {
        state.fetch_phase = FetchPhase::Idle;
        *fetch_rx = None;
        return;
    };

    state.fetch_phase = FetchPhase::Loading;
    let (tx, rx) = mpsc::channel();
    *fetch_rx = Some(rx);
    let config_owner = config.owner.clone();
    std::thread::spawn(move || {
        let result = draft::fetch_existing_for_repo(&repo_path, &config_owner)
            .map_err(|e| e.to_string());
        let _ = tx.send((repo_path, result));
    });
}

/// 既存 Issue fetch 結果を非ブロッキングでポーリングし、当前 repo の結果のみ反映する。
fn poll_fetch_result(state: &mut FormState, fetch_rx: &mut Option<mpsc::Receiver<FetchResult>>) {
    let Some(rx) = fetch_rx.as_ref() else {
        return;
    };
    match rx.try_recv() {
        Ok((path, result)) => {
            // stale ガード: 既に別の repo に切替済みの結果は破棄する
            if Some(path) == state.repo_path {
                match result {
                    Ok(issues) => {
                        state.existing_issues = issues;
                        state.fetch_phase = FetchPhase::Loaded;
                    }
                    Err(msg) => {
                        state.existing_issues.clear();
                        state.fetch_phase = FetchPhase::Failed(msg);
                    }
                }
            }
            *fetch_rx = None;
        }
        Err(mpsc::TryRecvError::Empty) => {}
        Err(mpsc::TryRecvError::Disconnected) => {
            if state.fetch_phase == FetchPhase::Loading {
                state.fetch_phase = FetchPhase::Failed("fetch スレッドが異常終了しました".to_string());
            }
            *fetch_rx = None;
        }
    }
}

/// submit 結果を非ブロッキングでポーリングする。
///
/// - 成功: セッション一覧に追加する。起票時の repo が当前 repo と一致する場合のみ
///   「今回作成」に追加し title/description をクリアする（repo 切替後の stale 結果で
///   別 repo の入力やセクションを汚さないため）。
/// - 失敗: エラーメッセージをオーバーレイ表示（title/description は保持）
///
/// 結果を受信した（完了した）場合に `true` を返す。
fn poll_submit_result(
    state: &mut FormState,
    desc_area: &mut TextArea,
    submit_rx: &mut Option<mpsc::Receiver<SubmitResult>>,
    session_created: &mut Vec<CreatedIssue>,
) -> bool {
    let Some(rx) = submit_rx.as_ref() else {
        return false;
    };
    match rx.try_recv() {
        Ok((path, Ok(issue))) => {
            session_created.push(issue.clone());
            // 当前 repo スコープの起票のみフォーム反映（stale ガード）
            if Some(path) == state.repo_path {
                state.record_created(issue);
                *desc_area = new_desc_area();
            }
            state.submit_phase = SubmitPhase::Idle;
            *submit_rx = None;
            true
        }
        Ok((_path, Err(msg))) => {
            state.submit_phase = SubmitPhase::Error(msg);
            *submit_rx = None;
            true
        }
        Err(mpsc::TryRecvError::Empty) => false,
        Err(mpsc::TryRecvError::Disconnected) => {
            state.submit_phase =
                SubmitPhase::Error("送信スレッドが異常終了しました".to_string());
            *submit_rx = None;
            true
        }
    }
}

/// ctrl+S 押下時に submit をバックグラウンドスレッドで開始する。
fn start_submit(
    state: &mut FormState,
    desc_area: &TextArea,
    config: &PlanConfig,
    submit_rx: &mut Option<mpsc::Receiver<SubmitResult>>,
) {
    let Some(repo_path) = state.repo_path.clone() else {
        return;
    };
    let title = state.title.trim().to_string();
    let description = desc_area.lines().join("\n");
    state.submit_phase = SubmitPhase::Submitting;

    let (tx, rx) = mpsc::channel();
    *submit_rx = Some(rx);
    let config = config.clone();
    std::thread::spawn(move || {
        let result = draft::submit_draft(&config, &repo_path, &title, &description)
            .map(|url| CreatedIssue {
                title: title.clone(),
                url,
            })
            .map_err(|e| e.to_string());
        let _ = tx.send((repo_path, result));
    });
}

enum LoopAction {
    StartSubmit,
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
    // submit 状態に応じたキー制御
    match state.submit_phase {
        // 送信中は esc / ctrl+C を含めすべてのキーを無視する
        SubmitPhase::Submitting => return None,
        // エラー表示中は任意のキー押下でフォームに戻る（入力は保持）
        SubmitPhase::Error(_) => {
            state.submit_phase = SubmitPhase::Idle;
            return None;
        }
        SubmitPhase::Idle => {}
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
            return Some(LoopAction::StartSubmit);
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
    // submit 中・エラー表示中はマウス操作を無視する
    if state.submit_phase != SubmitPhase::Idle {
        return None;
    }

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

    /// submit 成功（当前 repo 一致）: 「今回作成」に追加され、title/description が
    /// クリアされ、Idle に戻る。
    #[test]
    fn poll_submit_result_success_records_and_clears() {
        let mut state = FormState::new(vec![]);
        state.repo_path = Some(PathBuf::from("/home/user/src/tools"));
        state.submit_phase = SubmitPhase::Submitting;
        state.title = "my title".to_string();
        state.title_cursor = 8;
        let mut desc_area = new_desc_area();
        desc_area.insert_str("some description");
        let mut session_created = Vec::new();

        let (tx, rx) = mpsc::channel();
        let mut submit_rx = Some(rx);
        tx.send((
            PathBuf::from("/home/user/src/tools"),
            Ok(CreatedIssue {
                title: "my title".to_string(),
                url: "https://github.com/o/r/issues/1".to_string(),
            }),
        ))
        .unwrap();

        let completed = poll_submit_result(&mut state, &mut desc_area, &mut submit_rx, &mut session_created);
        assert!(completed);
        assert_eq!(state.submit_phase, SubmitPhase::Idle);
        assert_eq!(state.created_issues.len(), 1);
        assert_eq!(state.created_issues[0].url, "https://github.com/o/r/issues/1");
        assert!(state.title.is_empty());
        assert_eq!(state.title_cursor, 0);
        assert!(desc_area.lines().iter().all(|l| l.is_empty()));
        assert_eq!(session_created.len(), 1);
        assert!(submit_rx.is_none());
    }

    /// submit 成功だが repo 切替済み（stale）: セッション一覧には追加されるが、
    /// 当前 repo の「今回作成」や入力には反映されない。
    #[test]
    fn poll_submit_result_success_stale_repo_does_not_touch_form() {
        let mut state = FormState::new(vec![]);
        state.repo_path = Some(PathBuf::from("/home/user/src/webapp"));
        state.submit_phase = SubmitPhase::Submitting;
        state.title = "new repo title".to_string();
        state.title_cursor = 13;
        let mut desc_area = new_desc_area();
        desc_area.insert_str("new repo desc");
        let mut session_created = Vec::new();

        let (tx, rx) = mpsc::channel();
        let mut submit_rx = Some(rx);
        tx.send((
            PathBuf::from("/home/user/src/tools"),
            Ok(CreatedIssue {
                title: "old repo title".to_string(),
                url: "https://github.com/o/r/issues/9".to_string(),
            }),
        ))
        .unwrap();

        let completed = poll_submit_result(&mut state, &mut desc_area, &mut submit_rx, &mut session_created);
        assert!(completed);
        assert_eq!(state.submit_phase, SubmitPhase::Idle);
        // セッション一覧には追加される
        assert_eq!(session_created.len(), 1);
        // 当前 repo のセクション・入力はそのまま
        assert!(state.created_issues.is_empty());
        assert_eq!(state.title, "new repo title");
        assert_eq!(state.title_cursor, 13);
        assert_eq!(desc_area.lines().join("\n"), "new repo desc");
    }

    /// submit 失敗: エラーメッセージがセットされ、title/description は保持される。
    #[test]
    fn poll_submit_result_error_preserves_input() {
        let mut state = FormState::new(vec![]);
        state.repo_path = Some(PathBuf::from("/home/user/src/tools"));
        state.submit_phase = SubmitPhase::Submitting;
        state.title = "keep me".to_string();
        state.title_cursor = 7;
        let mut desc_area = new_desc_area();
        desc_area.insert_str("keep this desc");
        let mut session_created = Vec::new();

        let (tx, rx) = mpsc::channel();
        let mut submit_rx = Some(rx);
        tx.send((
            PathBuf::from("/home/user/src/tools"),
            Err("boom".to_string()),
        ))
        .unwrap();

        let completed = poll_submit_result(&mut state, &mut desc_area, &mut submit_rx, &mut session_created);
        assert!(completed);
        assert_eq!(state.submit_phase, SubmitPhase::Error("boom".to_string()));
        assert_eq!(state.title, "keep me");
        assert_eq!(state.title_cursor, 7);
        assert_eq!(desc_area.lines().join("\n"), "keep this desc");
        assert!(state.created_issues.is_empty());
        assert!(session_created.is_empty());
    }

    /// submit 結果未到着: 状態変化なし、`false` を返す。
    #[test]
    fn poll_submit_result_empty_no_change() {
        let mut state = FormState::new(vec![]);
        state.submit_phase = SubmitPhase::Submitting;
        let mut desc_area = new_desc_area();
        let mut session_created = Vec::new();

        let (_tx, rx) = mpsc::channel();
        let mut submit_rx = Some(rx);
        let completed = poll_submit_result(&mut state, &mut desc_area, &mut submit_rx, &mut session_created);
        assert!(!completed);
        assert_eq!(state.submit_phase, SubmitPhase::Submitting);
        assert!(submit_rx.is_some());
    }

    /// fetch 結果: 当前 repo の結果のみ反映される。
    #[test]
    fn poll_fetch_result_applies_matching_repo() {
        let mut state = FormState::new(vec![]);
        state.repo_path = Some(PathBuf::from("/home/user/src/tools"));
        state.fetch_phase = FetchPhase::Loading;

        let (tx, rx) = mpsc::channel();
        let mut fetch_rx = Some(rx);
        tx.send((
            PathBuf::from("/home/user/src/tools"),
            Ok(vec![ExistingIssue {
                number: 5,
                title: "existing".to_string(),
                url: "https://github.com/o/r/issues/5".to_string(),
            }]),
        ))
        .unwrap();

        poll_fetch_result(&mut state, &mut fetch_rx);
        assert_eq!(state.fetch_phase, FetchPhase::Loaded);
        assert_eq!(state.existing_issues.len(), 1);
        assert_eq!(state.existing_issues[0].number, 5);
        assert!(fetch_rx.is_none());
    }

    /// fetch 結果: stale（別 repo に切替済み）の結果は破棄される。
    #[test]
    fn poll_fetch_result_ignores_stale_repo() {
        let mut state = FormState::new(vec![]);
        state.repo_path = Some(PathBuf::from("/home/user/src/webapp"));
        state.fetch_phase = FetchPhase::Loading;

        let (tx, rx) = mpsc::channel();
        let mut fetch_rx = Some(rx);
        tx.send((
            PathBuf::from("/home/user/src/tools"),
            Ok(vec![ExistingIssue {
                number: 5,
                title: "stale".to_string(),
                url: "https://github.com/o/r/issues/5".to_string(),
            }]),
        ))
        .unwrap();

        poll_fetch_result(&mut state, &mut fetch_rx);
        assert_eq!(state.fetch_phase, FetchPhase::Loading);
        assert!(state.existing_issues.is_empty());
        assert!(fetch_rx.is_none());
    }

    /// fetch 失敗: Failed 状態に遷移する。
    #[test]
    fn poll_fetch_result_failure_sets_failed() {
        let mut state = FormState::new(vec![]);
        state.repo_path = Some(PathBuf::from("/home/user/src/tools"));
        state.fetch_phase = FetchPhase::Loading;

        let (tx, rx) = mpsc::channel();
        let mut fetch_rx = Some(rx);
        tx.send((
            PathBuf::from("/home/user/src/tools"),
            Err("network error".to_string()),
        ))
        .unwrap();

        poll_fetch_result(&mut state, &mut fetch_rx);
        assert_eq!(state.fetch_phase, FetchPhase::Failed("network error".to_string()));
        assert!(state.existing_issues.is_empty());
    }
}
