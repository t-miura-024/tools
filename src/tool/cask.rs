use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;
use regex::Regex;
use walkdir::WalkDir;

use crate::tool::shared::command_output;

/// 実体を失った cask（Caskroom に dangling symlink だけが残っているもの）。
pub(super) struct BrokenCask {
    pub(super) spec: String,
    pub(super) dangling: Vec<PathBuf>,
}

impl BrokenCask {
    pub(super) fn dangling_display(&self) -> String {
        self.dangling
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Brewfile に記載された cask の spec を出現順に返す。
pub(super) fn brewfile_casks(brewfile: &Path) -> anyhow::Result<Vec<String>> {
    let content = fs::read_to_string(brewfile)
        .with_context(|| format!("Brewfile を読み込めません: {}", brewfile.display()))?;
    let re = Regex::new(r#"^cask\s+"([^"]+)""#).unwrap();

    Ok(content
        .lines()
        .filter_map(|line| {
            re.captures(line)
                .and_then(|caps| caps.get(1))
                .map(|m| m.as_str().to_string())
        })
        .collect())
}

/// Brewfile の cask のうち、実体が欠けているものを返す。
///
/// `brew bundle check` は Caskroom のメタデータしか見ないため、アプリ本体が
/// Homebrew を経由せずに削除されると「インストール済み」と誤判定する。
/// ここでは Caskroom 配下の symlink のリンク先が存在するかで実体を確認する。
pub(super) fn broken_brewfile_casks(brewfile: &Path) -> anyhow::Result<Vec<BrokenCask>> {
    let caskroom = PathBuf::from(command_output("brew", &["--caskroom"])?);
    Ok(broken_casks(&caskroom, &brewfile_casks(brewfile)?))
}

pub(super) fn broken_casks(caskroom: &Path, casks: &[String]) -> Vec<BrokenCask> {
    casks
        .iter()
        .filter_map(|spec| {
            let token = spec.rsplit('/').next().unwrap_or(spec);
            let cask_dir = caskroom.join(token);
            if !cask_dir.is_dir() {
                // 未インストールの cask は brew bundle install の担当。
                return None;
            }

            let dangling = dangling_artifacts(&cask_dir);
            (!dangling.is_empty()).then(|| BrokenCask {
                spec: spec.clone(),
                dangling,
            })
        })
        .collect()
}

/// `.metadata` を除く Caskroom 配下の symlink のうち、リンク先が存在しないものを返す。
fn dangling_artifacts(cask_dir: &Path) -> Vec<PathBuf> {
    WalkDir::new(cask_dir)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".metadata")
        .filter_map(Result::ok)
        .filter(|entry| entry.path_is_symlink())
        .map(|entry| entry.path().to_path_buf())
        .filter(|path| fs::metadata(path).is_err())
        .collect()
}

#[cfg(test)]
#[path = "cask.test.rs"]
mod tests;
