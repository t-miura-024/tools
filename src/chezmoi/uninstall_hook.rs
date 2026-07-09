use crate::cli::style;

/// `mt chezmoi uninstall-hook`: platform-native hook を無効化する手順を案内する。
///
/// Phase 1 以前は `mt agent-config hook --check` で冪等な hook 設置ができたが、
/// Phase 2 では `chezmoi apply` 経由で platform 設定ファイルがデプロイされる。
/// 完全な uninstall は chezmoi source の編集が必要。
pub fn run() -> anyhow::Result<()> {
    style::intro("mt chezmoi uninstall-hook: platform-native hook 無効化");
    style::warn("chezmoi source 内の platform-native hook 設定を無効化するには以下を実行:");
    style::info(
        "  1. tools/chezmoi/dot_cursor/hooks.json から 'preToolUse' を除去（または空配列に）",
    );
    style::info("  2. tools/chezmoi/dot_claude/settings.json から 'PreToolUse' matcher を除去");
    style::info(
        "  3. tools/chezmoi/dot_config/opencode/plugins/cursor-hook-bridge.ts を `chezmoi forget` で管理外にする",
    );
    style::info(
        "  4. tools/chezmoi/dot_config/opencode/config.json から './plugins/cursor-hook-bridge.ts' エントリを除去",
    );
    style::info("  5. `mt chezmoi apply` 実行");
    style::outro("完了");
    Ok(())
}
