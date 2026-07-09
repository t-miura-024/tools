use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;

use super::shared::{chezmoi_binary_present, home_dir, run_chezmoi};
use crate::cli::style;

/// `mt chezmoi install-hook`: platform-native hook を冪等に配置する。
///
/// 1. `chezmoi apply` を実行し、4 つの platform 設定ファイル
///    (`~/.cursor/hooks.json` / `~/.claude/settings.json` /
///    `~/.config/opencode/plugins/cursor-hook-bridge.ts` / 共通 hook
///    スクリプト) を既存 deployed に同期する。
/// 2. 旧 `~/.claude/hooks/agent-hooks/block-cursor-config-direct-edit.ts`
///    があれば削除（Phase 1 以前の rsync 配布で残存しているケース向け）。
/// 3. platform 設定の整合性を検証する。
pub fn run() -> anyhow::Result<()> {
    style::intro("mt chezmoi install-hook: platform-native hook 設置");

    if !chezmoi_binary_present() {
        anyhow::bail!(
            "chezmoi バイナリが見つかりません。`mt tool install` または `brew install chezmoi` で導入してください"
        );
    }

    // 1. chezmoi apply 実行
    style::info("chezmoi apply 実行中...");
    run_chezmoi(&["apply"]).context("chezmoi apply の実行に失敗")?;

    let home = home_dir()?;

    // 2. 旧 hook スクリプトの cleanup
    cleanup_legacy_hook(&home)?;

    // 3. platform 設定の整合性確認
    let all_ok = verify_platform_settings(&home).context("platform 設定の整合性確認に失敗")?;

    if all_ok {
        style::success("install-hook: 完了");
    } else {
        style::warn(
            "install-hook: 一部 platform 設定に問題あり。`mt chezmoi doctor` で詳細を確認してください",
        );
        std::process::exit(2);
    }
    style::outro("done");
    Ok(())
}

fn cleanup_legacy_hook(home: &Path) -> anyhow::Result<()> {
    let legacy = home.join(".claude/hooks/agent-hooks/block-cursor-config-direct-edit.ts");
    if legacy.exists() {
        fs::remove_file(&legacy).with_context(|| format!("{} の削除に失敗", legacy.display()))?;
        style::info(&format!("✓ 旧 hook スクリプト削除: {}", legacy.display()));
    } else {
        style::info("✓ 旧 hook スクリプト: なし（cleanup 不要）");
    }
    Ok(())
}

fn verify_platform_settings(home: &Path) -> anyhow::Result<bool> {
    let mut all_ok = true;
    let checks: &[(&str, PathBuf)] = &[
        ("Cursor hooks.json", home.join(".cursor/hooks.json")),
        ("Claude settings.json", home.join(".claude/settings.json")),
        (
            "opencode bridge",
            home.join(".config/opencode/plugins/cursor-hook-bridge.ts"),
        ),
        (
            "共通 hook スクリプト",
            home.join(".config/opencode/plugins/agent-hooks/block-cursor-config-direct-edit.ts"),
        ),
    ];

    for (label, path) in checks {
        if path.exists() {
            style::success(&format!("{}: 配置済み ({})", label, path.display()));
        } else {
            style::warn(&format!("{}: 設置先なし ({})", label, path.display()));
            all_ok = false;
        }
    }
    Ok(all_ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cleanup_legacy_hook_removes_file() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp
            .path()
            .join(".claude/hooks/agent-hooks/block-cursor-config-direct-edit.ts");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, "#!/bin/sh\n").unwrap();
        assert!(legacy.exists());
        cleanup_legacy_hook(temp.path()).unwrap();
        assert!(!legacy.exists());
    }

    #[test]
    fn test_cleanup_legacy_hook_missing_ok() {
        let temp = tempfile::tempdir().unwrap();
        // ファイルが存在しない場合はエラーなし
        cleanup_legacy_hook(temp.path()).unwrap();
    }
}
