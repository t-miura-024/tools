use std::fs;

use anyhow::Context;
use dialoguer::Confirm;

use crate::cli::style;

const PATH_ENTRY: &str = r#"export PATH="$HOME/.cargo/bin:$PATH""#;
const WT_BRIDGE_MARKER: &str = "# mt wt bridge";
const WT_BRIDGE_ENTRY: &str = r#"# mt wt bridge
wt() {
  local target
  target="$(mt git worktree select)" || return
  [[ -n "$target" ]] || return
  cd -- "$target"
}
"#;
const RP_BRIDGE_MARKER: &str = "# mt rp bridge";
const RP_BRIDGE_ENTRY: &str = r#"# mt rp bridge
rp() {
  local target
  target="$(mt git repo select)" || return
  [[ -n "$target" ]] || return
  cd -- "$target"
}
"#;

pub fn run() -> anyhow::Result<()> {
    style::intro("mt コマンドセットアップ");

    let home = std::env::var("HOME").context("HOME 環境変数が設定されていません")?;
    let cargo_bin = format!("{}/.cargo/bin", home);
    let zshrc_path = format!("{}/.zshrc", home);
    let mut content = fs::read_to_string(&zshrc_path).unwrap_or_default();
    let mut changed = false;

    let path = std::env::var("PATH").unwrap_or_default();
    if path_contains(&path, &cargo_bin) {
        style::info("~/.cargo/bin は既に PATH に含まれています");
    } else {
        style::info("~/.cargo/bin が PATH に含まれていません");
        style::info(
            "Rust でインストールしたバイナリ（mt を含む）を実行するには、~/.cargo/bin を PATH に追加する必要があります",
        );

        let add = Confirm::new()
            .with_prompt("~/.zshrc に PATH 設定を追加しますか？")
            .default(true)
            .interact()?;

        if add {
            append_block(&mut content, PATH_ENTRY);
            changed = true;
            style::success("~/.zshrc に PATH 設定を追加します");
        }
    }

    if has_wt_bridge(&content) {
        style::info("wt ブリッジは既に ~/.zshrc に含まれています");
    } else {
        let add = Confirm::new()
            .with_prompt("~/.zshrc に wt ブリッジを追加しますか？")
            .default(true)
            .interact()?;

        if add {
            append_block(&mut content, WT_BRIDGE_ENTRY.trim_end());
            changed = true;
            style::success("~/.zshrc に wt ブリッジ設定を追加します");
        }
    }

    if has_rp_bridge(&content) {
        style::info("rp ブリッジは既に ~/.zshrc に含まれています");
    } else {
        let add = Confirm::new()
            .with_prompt("~/.zshrc に rp ブリッジを追加しますか？")
            .default(true)
            .interact()?;

        if add {
            append_block(&mut content, RP_BRIDGE_ENTRY.trim_end());
            changed = true;
            style::success("~/.zshrc に rp ブリッジ設定を追加します");
        }
    }

    if changed {
        fs::write(&zshrc_path, content).context("~/.zshrc の書き込みに失敗しました")?;
        style::info("ターミナルを再起動するか、source ~/.zshrc を実行してください");
        style::outro("セットアップが完了しました");
    } else {
        style::outro("変更はありません");
    }

    Ok(())
}

fn append_block(content: &mut String, block: &str) {
    if !content.trim().is_empty() {
        *content = content.trim_end().to_string();
        content.push_str("\n\n");
    }
    content.push_str(block);
    content.push('\n');
}

fn path_contains(path: &str, target: &str) -> bool {
    path.split(':').any(|p| p == target)
}

fn has_wt_bridge(content: &str) -> bool {
    content.contains(WT_BRIDGE_MARKER)
}

fn has_rp_bridge(content: &str) -> bool {
    content.contains(RP_BRIDGE_MARKER)
}

#[cfg(test)]
#[path = "init.test.rs"]
mod tests;
