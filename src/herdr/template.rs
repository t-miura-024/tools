//! ワークスペーステンプレートのモデル・検証・永続化。
//!
//! 保存形式はユーザー共通の `~/.config/mt/herdr/templates/<name>.json`（1 テンプレート 1 JSON）。
//! portable layout tree から pane の cwd / command / env / pane_id を取り除き、
//! tab label・tab 順・pane label・split tree・split ratio・active tab index・
//! active pane tree path だけを保存する。

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

use crate::config;
use crate::herdr::socket::{SplitDirection, WireNode};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Template {
    pub tabs: Vec<TemplateTab>,
    /// 保存元ワークスペースの active tab の index（template.tabs の並び順）。
    pub active_tab_index: usize,
    /// active tab 内の active pane の tree path（split の子 index 列）。None なら pane focus は復元しない。
    pub active_pane_path: Option<Vec<usize>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemplateTab {
    pub label: String,
    pub root: TemplateNode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TemplateNode {
    #[serde(rename = "pane")]
    Pane {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename = "split")]
    Split {
        direction: SplitDirection,
        ratio: f64,
        first: Box<TemplateNode>,
        second: Box<TemplateNode>,
    },
}

impl Template {
    /// 保存前・読み込み後に呼ぶスキーマ検証。不正なら理由つきでエラーにする。
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.tabs.is_empty() {
            bail!("テンプレートにタブがありません");
        }
        for (i, tab) in self.tabs.iter().enumerate() {
            if tab.label.trim().is_empty() {
                bail!("タブ {} のラベルが空です", i + 1);
            }
            tab.root.validate()?;
        }
        if self.active_tab_index >= self.tabs.len() {
            bail!(
                "active_tab_index {} がタブ数 {} の範囲外です",
                self.active_tab_index,
                self.tabs.len()
            );
        }
        if let Some(path) = &self.active_pane_path {
            let root = &self.tabs[self.active_tab_index].root;
            if !matches!(
                template_pane_at_path(root, path),
                Some(TemplateNode::Pane { .. })
            ) {
                bail!("active_pane_path {:?} が pane ノードに解決しません", path);
            }
        }
        Ok(())
    }
}

impl TemplateNode {
    /// portable layout tree（WireNode）から不要フィールドを除いてテンプレート形式へ変換する。
    pub fn from_wire(node: &WireNode) -> Self {
        match node {
            WireNode::Pane { label, .. } => TemplateNode::Pane {
                label: label.clone(),
            },
            WireNode::Split {
                direction,
                ratio,
                first,
                second,
            } => TemplateNode::Split {
                direction: *direction,
                ratio: *ratio,
                first: Box::new(Self::from_wire(first)),
                second: Box::new(Self::from_wire(second)),
            },
        }
    }

    fn validate(&self) -> anyhow::Result<()> {
        match self {
            TemplateNode::Pane { .. } => Ok(()),
            TemplateNode::Split {
                direction,
                ratio,
                first,
                second,
            } => {
                if !(*ratio > 0.0 && *ratio < 1.0) {
                    bail!("split の ratio が 0〜1 の範囲外です: {ratio}");
                }
                match direction {
                    SplitDirection::Right | SplitDirection::Down => {}
                }
                first.validate()?;
                second.validate()?;
                Ok(())
            }
        }
    }
}

/// テンプレート名の検証。前後空白を除去し、空・`.`・`..`・`/`・`\`・制御文字を拒否する。
/// それ以外の文字は不必要に制限しない。
pub fn validate_name(raw: &str) -> anyhow::Result<String> {
    let name = raw.trim();
    if name.is_empty() {
        bail!("テンプレート名が空です");
    }
    if name == "." || name == ".." {
        bail!("テンプレート名に {name} は使えません");
    }
    if name
        .chars()
        .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        bail!("テンプレート名に / \\ や制御文字は使えません");
    }
    Ok(name.to_string())
}

pub fn templates_dir() -> PathBuf {
    config::home_dir().join(".config/mt/herdr/templates")
}

pub fn template_path(name: &str) -> PathBuf {
    templates_dir().join(format!("{name}.json"))
}

/// 一覧に表示するエントリ。
#[derive(Debug, Clone)]
pub struct TemplateEntry {
    pub name: String,
    pub path: PathBuf,
    pub template: Template,
}

/// `~/.config/mt/herdr/templates/` の有効なテンプレートを名前順に返す。
/// 不正 JSON / スキーマ不正は standard error に warning を出して除外し、
/// 有効が 0 件なら明確なエラーを返す。
pub fn list_templates() -> anyhow::Result<Vec<TemplateEntry>> {
    let dir = templates_dir();
    let mut entries = Vec::new();

    if dir.is_dir() {
        for entry in fs::read_dir(&dir).with_context(|| {
            format!(
                "テンプレートディレクトリ {} を読み込めません",
                dir.display()
            )
        })? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let content = match fs::read_to_string(&path) {
                Ok(content) => content,
                Err(e) => {
                    eprintln!(
                        "警告: テンプレート {} を読み込めないため除外します: {e}",
                        path.display()
                    );
                    continue;
                }
            };
            let template: Template = match serde_json::from_str(&content) {
                Ok(template) => template,
                Err(e) => {
                    eprintln!(
                        "警告: テンプレート {} は不正な JSON のため除外します: {e}",
                        path.display()
                    );
                    continue;
                }
            };
            if let Err(e) = template.validate() {
                eprintln!(
                    "警告: テンプレート {} はスキーマ不正のため除外します: {e}",
                    path.display()
                );
                continue;
            }
            entries.push(TemplateEntry {
                name,
                path,
                template,
            });
        }
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));

    if entries.is_empty() {
        bail!(
            "利用可能なテンプレートがありません（{} に有効なテンプレート JSON がありません）",
            dir.display()
        );
    }
    Ok(entries)
}

/// テンプレート名からファイルへ保存する。同名ファイルが既にあれば変更せずエラーにする。
/// 書き込みは一時ファイル + rename の atomic 方式で、途中失敗時は一時ファイルを削除する。
pub fn save_template(template: &Template, name: &str) -> anyhow::Result<PathBuf> {
    let path = template_path(name);
    if path.exists() {
        bail!("テンプレート {name} は既に存在します（上書きしません）");
    }
    let json = serde_json::to_string_pretty(template)
        .context("テンプレートのシリアライズに失敗しました")?;
    write_atomic(&path, &json)?;
    Ok(path)
}

pub fn delete_template(path: &Path) -> anyhow::Result<()> {
    fs::remove_file(path)
        .with_context(|| format!("テンプレート {} を削除できません", path.display()))
}

/// 一時ファイル + rename の atomic 書き込み。失敗時は一時ファイルを後始末する。
pub fn write_atomic(path: &Path, content: &str) -> anyhow::Result<()> {
    let dir = path
        .parent()
        .context("テンプレート保存先ディレクトリを特定できません")?;
    fs::create_dir_all(dir)
        .with_context(|| format!("テンプレート保存先 {} を作成できません", dir.display()))?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "template.json".to_string());
    let tmp = dir.join(format!(".{file_name}.tmp-{}", uuid::Uuid::new_v4()));

    if let Err(e) = fs::write(&tmp, content) {
        let _ = fs::remove_file(&tmp);
        return Err(e).with_context(|| {
            format!("テンプレート {} への書き込みに失敗しました", path.display())
        });
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e)
            .with_context(|| format!("テンプレート {} の保存に失敗しました", path.display()));
    }
    Ok(())
}

fn template_pane_at_path<'a>(node: &'a TemplateNode, path: &[usize]) -> Option<&'a TemplateNode> {
    let mut node = node;
    for &idx in path {
        match node {
            TemplateNode::Split { first, second, .. } if idx == 0 => node = first,
            TemplateNode::Split {
                first: _, second, ..
            } if idx == 1 => node = second,
            _ => return None,
        }
    }
    Some(node)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_home() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path().to_str().unwrap());
        }
        tmp
    }

    fn restore_home(prev: Option<String>) {
        match prev {
            Some(v) => unsafe {
                std::env::set_var("HOME", v);
            },
            None => unsafe {
                std::env::remove_var("HOME");
            },
        }
    }

    fn valid_template() -> Template {
        Template {
            tabs: vec![
                TemplateTab {
                    label: "work".to_string(),
                    root: TemplateNode::Split {
                        direction: SplitDirection::Right,
                        ratio: 0.5,
                        first: Box::new(TemplateNode::Pane { label: None }),
                        second: Box::new(TemplateNode::Pane {
                            label: Some("editor".to_string()),
                        }),
                    },
                },
                TemplateTab {
                    label: "shell".to_string(),
                    root: TemplateNode::Pane { label: None },
                },
            ],
            active_tab_index: 0,
            active_pane_path: Some(vec![1]),
        }
    }

    // ---- 名前検証 ----

    #[test]
    fn test_validate_name_trims_and_accepts() {
        assert_eq!(validate_name("  my template  ").unwrap(), "my template");
        assert_eq!(
            validate_name("日本語-テンプレート").unwrap(),
            "日本語-テンプレート"
        );
        assert_eq!(validate_name("a.b.c").unwrap(), "a.b.c");
    }

    #[test]
    fn test_validate_name_rejects() {
        for name in ["", "   ", ".", "..", "a/b", "a\\b", "a\nb", "a\x00b"] {
            assert!(validate_name(name).is_err(), "{name:?} は拒否されるべき");
        }
    }

    // ---- from_wire の不要フィールド除去 ----

    #[test]
    fn test_from_wire_drops_unneeded_fields() {
        let wire: WireNode = serde_json::from_value(serde_json::json!({
            "type": "split",
            "direction": "right",
            "ratio": 0.5,
            "first": {
                "type": "pane",
                "pane_id": "w1:p1",
                "cwd": "/Users/mt/src/foo",
                "command": ["vim"],
                "env": {"A": "1"},
                "label": "main"
            },
            "second": {
                "type": "pane",
                "pane_id": "w1:p2",
                "cwd": "/tmp",
                "label": null
            }
        }))
        .unwrap();

        let node = TemplateNode::from_wire(&wire);
        match node {
            TemplateNode::Split { first, second, .. } => {
                assert_eq!(
                    first.as_ref(),
                    &TemplateNode::Pane {
                        label: Some("main".to_string())
                    }
                );
                assert_eq!(second.as_ref(), &TemplateNode::Pane { label: None });
            }
            _ => panic!("split のはず"),
        }
    }

    #[test]
    fn test_template_json_round_trip() {
        let template = valid_template();
        let json = serde_json::to_string(&template).unwrap();
        let back: Template = serde_json::from_str(&json).unwrap();
        assert_eq!(back, template);
    }

    // ---- 検証 ----

    #[test]
    fn test_validate_accepts_valid_template() {
        valid_template().validate().unwrap();
    }

    #[test]
    fn test_validate_rejects_empty_tabs() {
        let mut template = valid_template();
        template.tabs.clear();
        assert!(
            template
                .validate()
                .unwrap_err()
                .to_string()
                .contains("タブがありません")
        );
    }

    #[test]
    fn test_validate_rejects_empty_tab_label() {
        let mut template = valid_template();
        template.tabs[1].label = "  ".to_string();
        let err = template.validate().unwrap_err().to_string();
        assert!(err.contains("ラベルが空"), "{err}");
    }

    #[test]
    fn test_validate_rejects_bad_ratio() {
        let mut template = valid_template();
        template.tabs[0].root = TemplateNode::Split {
            direction: SplitDirection::Down,
            ratio: 1.5,
            first: Box::new(TemplateNode::Pane { label: None }),
            second: Box::new(TemplateNode::Pane { label: None }),
        };
        assert!(
            template
                .validate()
                .unwrap_err()
                .to_string()
                .contains("ratio")
        );
    }

    #[test]
    fn test_validate_rejects_active_tab_index_out_of_range() {
        let mut template = valid_template();
        template.active_tab_index = 2;
        assert!(
            template
                .validate()
                .unwrap_err()
                .to_string()
                .contains("範囲外")
        );
    }

    #[test]
    fn test_validate_rejects_pane_path_not_resolving() {
        let mut template = valid_template();
        template.active_pane_path = Some(vec![0, 0, 1]);
        assert!(
            template
                .validate()
                .unwrap_err()
                .to_string()
                .contains("解決しません")
        );
        let mut template = valid_template();
        template.active_pane_path = Some(vec![0, 9]);
        assert!(template.validate().is_err());
    }

    // ---- 永続化 ----

    #[test]
    fn test_save_template_writes_atomically_and_detects_duplicate() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("HOME").ok();
        let _tmp = with_temp_home();

        let path = save_template(&valid_template(), "alpha").unwrap();
        assert_eq!(path, template_path("alpha"));
        assert!(path.is_file());

        let loaded: Template = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded, valid_template());
        assert!(loaded.validate().is_ok());

        // 同名は上書きしない
        let err = save_template(&valid_template(), "alpha").unwrap_err();
        assert!(err.to_string().contains("既に存在します"), "{err}");

        // 一時ファイルの残骸がない
        let leftovers: Vec<_> = fs::read_dir(templates_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "一時ファイルが残っています: {leftovers:?}"
        );

        restore_home(prev);
    }

    #[test]
    fn test_list_templates_sorted_and_skips_invalid() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("HOME").ok();
        let _tmp = with_temp_home();

        let dir = templates_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            template_path("zzz"),
            serde_json::to_string(&valid_template()).unwrap(),
        )
        .unwrap();
        // 不正 JSON
        fs::write(template_path("aaa"), "{ not json").unwrap();
        // スキーマ不正（タブ 0 件）
        fs::write(
            template_path("mmm"),
            serde_json::to_string(&Template {
                tabs: vec![],
                active_tab_index: 0,
                active_pane_path: None,
            })
            .unwrap(),
        )
        .unwrap();
        // JSON ではないファイルは対象外
        fs::write(template_path("not-json-ext"), "{}").unwrap();
        fs::write(dir.join("README.txt"), "not a template").unwrap();

        let entries = list_templates().unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["zzz"],
            "不正ファイルは除外され名前順になる: {names:?}"
        );

        restore_home(prev);
    }

    #[test]
    fn test_list_templates_empty_is_error() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("HOME").ok();
        let _tmp = with_temp_home();

        fs::create_dir_all(templates_dir()).unwrap();
        let err = list_templates().unwrap_err();
        assert!(
            err.to_string()
                .contains("利用可能なテンプレートがありません"),
            "{err}"
        );

        restore_home(prev);
    }

    #[test]
    fn test_delete_template() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("HOME").ok();
        let _tmp = with_temp_home();

        let path = save_template(&valid_template(), "del-me").unwrap();
        assert!(path.exists());
        delete_template(&path).unwrap();
        assert!(!path.exists());

        restore_home(prev);
    }
}
