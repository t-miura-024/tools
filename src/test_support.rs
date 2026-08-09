use std::process::Command;

pub(crate) fn git_command() -> Command {
    crate::git::common::command_with_clean_git_context("git")
}
