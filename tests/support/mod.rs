#![allow(dead_code)]

use std::ops::{Deref, DerefMut};

pub struct Command(assert_cmd::Command);

const GIT_CONTEXT_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
];

impl Command {
    pub fn cargo_bin<S: AsRef<str>>(name: S) -> Result<Self, assert_cmd::cargo::CargoError> {
        let mut command = assert_cmd::Command::cargo_bin(name)?;
        clear_assert_git_context(&mut command);
        Ok(Self(command))
    }
}

impl Deref for Command {
    type Target = assert_cmd::Command;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for Command {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

pub fn git_command() -> std::process::Command {
    let mut command = std::process::Command::new("git");
    clear_git_context(&mut command);
    command
}

fn clear_git_context(command: &mut std::process::Command) {
    for variable in GIT_CONTEXT_ENV {
        command.env_remove(variable);
    }
}

fn clear_assert_git_context(command: &mut assert_cmd::Command) {
    for variable in GIT_CONTEXT_ENV {
        command.env_remove(variable);
    }
}
