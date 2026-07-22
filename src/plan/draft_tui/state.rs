use std::path::PathBuf;

use crate::git::repo::repo_discover::RepoEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Repo,
    Title,
    Description,
    Submit,
}

impl Field {
    pub fn next(&self) -> Self {
        match self {
            Field::Repo => Field::Title,
            Field::Title => Field::Description,
            Field::Description => Field::Submit,
            Field::Submit => Field::Repo,
        }
    }

    pub fn prev(&self) -> Self {
        match self {
            Field::Repo => Field::Submit,
            Field::Title => Field::Repo,
            Field::Description => Field::Title,
            Field::Submit => Field::Description,
        }
    }
}

pub struct RepoPopup {
    pub filter: String,
    pub selected_index: usize,
}

impl RepoPopup {
    pub fn new() -> Self {
        Self {
            filter: String::new(),
            selected_index: 0,
        }
    }

    pub fn filtered_indices(&self, entries: &[RepoEntry]) -> Vec<usize> {
        filter_repos(entries, &self.filter)
    }

    pub fn move_up(&mut self, entries: &[RepoEntry]) {
        let filtered = self.filtered_indices(entries);
        if filtered.is_empty() {
            return;
        }
        let pos = filtered
            .iter()
            .position(|&i| i == self.selected_index)
            .unwrap_or(0);
        let new_pos = if pos == 0 { filtered.len() - 1 } else { pos - 1 };
        self.selected_index = filtered[new_pos];
    }

    pub fn move_down(&mut self, entries: &[RepoEntry]) {
        let filtered = self.filtered_indices(entries);
        if filtered.is_empty() {
            return;
        }
        let pos = filtered
            .iter()
            .position(|&i| i == self.selected_index)
            .unwrap_or(0);
        let new_pos = if pos + 1 >= filtered.len() { 0 } else { pos + 1 };
        self.selected_index = filtered[new_pos];
    }

    pub fn clamp_selection(&mut self, entries: &[RepoEntry]) {
        let filtered = self.filtered_indices(entries);
        if filtered.is_empty() {
            self.selected_index = 0;
            return;
        }
        if !filtered.contains(&self.selected_index) {
            self.selected_index = filtered[0];
        }
    }
}

pub fn filter_repos(entries: &[RepoEntry], query: &str) -> Vec<usize> {
    if query.is_empty() {
        return (0..entries.len()).collect();
    }
    let lower = query.to_lowercase();
    entries
        .iter()
        .enumerate()
        .filter(|(_, e)| {
            e.name.to_lowercase().contains(&lower)
                || e.category.to_lowercase().contains(&lower)
        })
        .map(|(i, _)| i)
        .collect()
}

pub struct FormState {
    pub focus: Field,
    pub repo_path: Option<PathBuf>,
    pub repo_display: String,
    pub title: String,
    pub title_cursor: usize,
    pub repos: Vec<RepoEntry>,
    pub popup: Option<RepoPopup>,
    pub show_empty_desc_confirm: bool,
}

impl FormState {
    pub fn new(repos: Vec<RepoEntry>) -> Self {
        Self {
            focus: Field::Repo,
            repo_path: None,
            repo_display: String::from("(未選択)"),
            title: String::new(),
            title_cursor: 0,
            repos,
            popup: None,
            show_empty_desc_confirm: false,
        }
    }

    pub fn focus_next(&mut self) {
        self.focus = self.focus.next();
    }

    pub fn focus_prev(&mut self) {
        self.focus = self.focus.prev();
    }

    pub fn open_popup(&mut self) {
        let mut popup = RepoPopup::new();
        if let Some(ref path) = self.repo_path {
            if let Some(idx) = self.repos.iter().position(|e| &e.path == path) {
                popup.selected_index = idx;
            }
        }
        self.popup = Some(popup);
    }

    pub fn close_popup(&mut self) {
        self.popup = None;
    }

    pub fn confirm_repo_selection(&mut self) {
        if let Some(popup) = self.popup.take() {
            if let Some(entry) = self.repos.get(popup.selected_index) {
                self.repo_path = Some(entry.path.clone());
                self.repo_display =
                    format!("{}/{} {}", entry.category, entry.name, entry.label());
            }
        }
    }

    pub fn title_insert(&mut self, c: char) {
        self.title.insert(self.title_cursor, c);
        self.title_cursor += c.len_utf8();
    }

    pub fn title_backspace(&mut self) {
        if self.title_cursor > 0 {
            let prev = self.title[..self.title_cursor]
                .char_indices()
                .last()
                .map(|(i, _)| i)
                .unwrap_or(0);
            self.title.replace_range(prev..self.title_cursor, "");
            self.title_cursor = prev;
        }
    }

    pub fn title_delete(&mut self) {
        if self.title_cursor < self.title.len() {
            let next = self.title[self.title_cursor..]
                .char_indices()
                .nth(1)
                .map(|(i, _)| self.title_cursor + i)
                .unwrap_or(self.title.len());
            self.title.replace_range(self.title_cursor..next, "");
        }
    }

    pub fn title_move_left(&mut self) {
        if self.title_cursor > 0 {
            self.title_cursor = self.title[..self.title_cursor]
                .char_indices()
                .last()
                .map(|(i, _)| i)
                .unwrap_or(0);
        }
    }

    pub fn title_move_right(&mut self) {
        if self.title_cursor < self.title.len() {
            self.title_cursor = self.title[self.title_cursor..]
                .char_indices()
                .nth(1)
                .map(|(i, _)| self.title_cursor + i)
                .unwrap_or(self.title.len());
        }
    }

    pub fn can_submit(&self) -> bool {
        !self.title.trim().is_empty() && self.repo_path.is_some()
    }

    pub fn needs_desc_confirm(&self, description: &str) -> bool {
        description.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::repo::repo_discover::HeadInfo;

    fn make_entry(category: &str, name: &str) -> RepoEntry {
        RepoEntry {
            category: category.to_string(),
            name: name.to_string(),
            path: PathBuf::from(format!("/home/user/{category}/{name}")),
            head_info: HeadInfo::Branch("main".to_string()),
        }
    }

    fn sample_repos() -> Vec<RepoEntry> {
        vec![
            make_entry("doc", "notes"),
            make_entry("doc", "blog"),
            make_entry("src", "tools"),
            make_entry("src", "webapp"),
        ]
    }

    #[test]
    fn field_next_cycles() {
        assert_eq!(Field::Repo.next(), Field::Title);
        assert_eq!(Field::Title.next(), Field::Description);
        assert_eq!(Field::Description.next(), Field::Submit);
        assert_eq!(Field::Submit.next(), Field::Repo);
    }

    #[test]
    fn field_prev_cycles() {
        assert_eq!(Field::Repo.prev(), Field::Submit);
        assert_eq!(Field::Title.prev(), Field::Repo);
        assert_eq!(Field::Description.prev(), Field::Title);
        assert_eq!(Field::Submit.prev(), Field::Description);
    }

    #[test]
    fn focus_next_wraps() {
        let mut state = FormState::new(vec![]);
        assert_eq!(state.focus, Field::Repo);
        state.focus_next();
        assert_eq!(state.focus, Field::Title);
        state.focus_next();
        assert_eq!(state.focus, Field::Description);
        state.focus_next();
        assert_eq!(state.focus, Field::Submit);
        state.focus_next();
        assert_eq!(state.focus, Field::Repo);
    }

    #[test]
    fn focus_prev_wraps() {
        let mut state = FormState::new(vec![]);
        assert_eq!(state.focus, Field::Repo);
        state.focus_prev();
        assert_eq!(state.focus, Field::Submit);
        state.focus_prev();
        assert_eq!(state.focus, Field::Description);
        state.focus_prev();
        assert_eq!(state.focus, Field::Title);
        state.focus_prev();
        assert_eq!(state.focus, Field::Repo);
    }

    #[test]
    fn filter_empty_query_returns_all() {
        let repos = sample_repos();
        let result = filter_repos(&repos, "");
        assert_eq!(result, vec![0, 1, 2, 3]);
    }

    #[test]
    fn filter_case_insensitive() {
        let repos = sample_repos();
        let result = filter_repos(&repos, "TOOL");
        assert_eq!(result, vec![2]);
    }

    #[test]
    fn filter_matches_category() {
        let repos = sample_repos();
        let result = filter_repos(&repos, "doc");
        assert_eq!(result, vec![0, 1]);
    }

    #[test]
    fn filter_matches_name_partial() {
        let repos = sample_repos();
        let result = filter_repos(&repos, "bl");
        assert_eq!(result, vec![1]);
    }

    #[test]
    fn filter_no_match() {
        let repos = sample_repos();
        let result = filter_repos(&repos, "zzz");
        assert!(result.is_empty());
    }

    #[test]
    fn popup_move_down_wraps() {
        let repos = sample_repos();
        let mut popup = RepoPopup::new();
        popup.move_down(&repos);
        assert_eq!(popup.selected_index, 1);
        popup.move_down(&repos);
        assert_eq!(popup.selected_index, 2);
        popup.move_down(&repos);
        assert_eq!(popup.selected_index, 3);
        popup.move_down(&repos);
        assert_eq!(popup.selected_index, 0);
    }

    #[test]
    fn popup_move_up_wraps() {
        let repos = sample_repos();
        let mut popup = RepoPopup::new();
        popup.move_up(&repos);
        assert_eq!(popup.selected_index, 3);
    }

    #[test]
    fn popup_move_respects_filter() {
        let repos = sample_repos();
        let mut popup = RepoPopup::new();
        popup.filter = "doc".to_string();
        popup.selected_index = 0;
        popup.move_down(&repos);
        assert_eq!(popup.selected_index, 1);
        popup.move_down(&repos);
        assert_eq!(popup.selected_index, 0);
    }

    #[test]
    fn popup_clamp_selection_after_filter_change() {
        let repos = sample_repos();
        let mut popup = RepoPopup::new();
        popup.selected_index = 3;
        popup.filter = "doc".to_string();
        popup.clamp_selection(&repos);
        assert_eq!(popup.selected_index, 0);
    }

    #[test]
    fn confirm_repo_selection_sets_path() {
        let repos = sample_repos();
        let mut state = FormState::new(repos);
        state.open_popup();
        state.popup.as_mut().unwrap().selected_index = 2;
        state.confirm_repo_selection();
        assert_eq!(
            state.repo_path,
            Some(PathBuf::from("/home/user/src/tools"))
        );
        assert!(state.repo_display.contains("src/tools"));
        assert!(state.popup.is_none());
    }

    #[test]
    fn title_insert_and_cursor() {
        let mut state = FormState::new(vec![]);
        state.title_insert('h');
        state.title_insert('i');
        assert_eq!(state.title, "hi");
        assert_eq!(state.title_cursor, 2);
    }

    #[test]
    fn title_backspace() {
        let mut state = FormState::new(vec![]);
        state.title_insert('a');
        state.title_insert('b');
        state.title_backspace();
        assert_eq!(state.title, "a");
        assert_eq!(state.title_cursor, 1);
    }

    #[test]
    fn title_backspace_at_start_noop() {
        let mut state = FormState::new(vec![]);
        state.title_backspace();
        assert_eq!(state.title, "");
        assert_eq!(state.title_cursor, 0);
    }

    #[test]
    fn title_delete_forward() {
        let mut state = FormState::new(vec![]);
        state.title_insert('a');
        state.title_insert('b');
        state.title_move_left();
        state.title_delete();
        assert_eq!(state.title, "a");
    }

    #[test]
    fn title_move_left_right() {
        let mut state = FormState::new(vec![]);
        state.title_insert('a');
        state.title_insert('b');
        state.title_move_left();
        assert_eq!(state.title_cursor, 1);
        state.title_move_right();
        assert_eq!(state.title_cursor, 2);
    }

    #[test]
    fn title_unicode_handling() {
        let mut state = FormState::new(vec![]);
        state.title_insert('日');
        state.title_insert('本');
        assert_eq!(state.title, "日本");
        assert_eq!(state.title_cursor, 6);
        state.title_move_left();
        assert_eq!(state.title_cursor, 3);
        state.title_backspace();
        assert_eq!(state.title, "本");
        assert_eq!(state.title_cursor, 0);
    }

    #[test]
    fn can_submit_requires_title_and_repo() {
        let repos = sample_repos();
        let mut state = FormState::new(repos);
        assert!(!state.can_submit());

        state.title_insert('t');
        assert!(!state.can_submit());

        state.open_popup();
        state.confirm_repo_selection();
        assert!(state.can_submit());
    }

    #[test]
    fn can_submit_empty_title_fails() {
        let repos = sample_repos();
        let mut state = FormState::new(repos);
        state.open_popup();
        state.confirm_repo_selection();
        state.title_insert(' ');
        assert!(!state.can_submit());
    }

    #[test]
    fn needs_desc_confirm_when_empty() {
        let state = FormState::new(vec![]);
        assert!(state.needs_desc_confirm(""));
        assert!(state.needs_desc_confirm("  \n  "));
        assert!(!state.needs_desc_confirm("hello"));
    }
}
