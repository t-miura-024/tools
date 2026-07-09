#[cfg(test)]
mod tests {
    #[test]
    fn test_parse_color() {
        let content = "---\nname: test-agent\ndescription: desc\nreadonly: false\ncolor: green\n---\nbody\n";
        let result = crate::agent::shared::parse_cursor_agent(content).unwrap();
        assert_eq!(result.meta.color, "green");
        assert_eq!(result.meta.name, "test-agent");
        assert!(!result.meta.readonly);
    }

    #[test]
    fn test_parse_with_japanese() {
        let content = concat!(
            "---\n",
            "name: mt-cursor-config-creator\n",
            "description: Cursor設定ファイル（Rule・Skill・SubAgent）の作成・修正スペシャリスト\n",
            "readonly: false\n",
            "color: green\n",
            "---\n",
            "body\n",
        );
        let result = crate::agent::shared::parse_cursor_agent(content).unwrap();
        assert_eq!(result.meta.color, "green");
        assert_eq!(result.meta.name, "mt-cursor-config-creator");
        assert!(!result.meta.readonly);
    }

    #[test]
    fn test_parse_actual_file() {
        let content = std::fs::read_to_string("chezmoi/dot_cursor/agents/mt-cursor-config-creator.md").unwrap();
        let result = crate::agent::shared::parse_cursor_agent(&content).unwrap();
        assert_eq!(result.meta.color, "green");
    }

    #[test]
    fn test_generate_opencode_agent_readonly() {
        let agent = crate::agent::shared::AgentFile {
            meta: crate::agent::shared::AgentMeta {
                name: "reviewer".to_string(),
                description: "レビュアー".to_string(),
                readonly: true,
                color: "yellow".to_string(),
            },
            body: "# body".to_string(),
        };
        let out = crate::agent::shared::generate_opencode_agent(&agent);
        assert!(out.contains("mode: \"subagent\""), "mode は subagent のべき: {}", out);
        assert!(out.contains("permission:\n  edit: \"deny\"\n  bash: \"deny\""), "permission のインデントが壊れています:\n{}", out);
        assert!(!out.contains("\nedit: \"deny\""), "edit がトップレベルキーになっています:\n{}", out);
    }

    #[test]
    fn test_generate_opencode_agent_writable() {
        let agent = crate::agent::shared::AgentFile {
            meta: crate::agent::shared::AgentMeta {
                name: "writer".to_string(),
                description: "ライター".to_string(),
                readonly: false,
                color: "green".to_string(),
            },
            body: "# body".to_string(),
        };
        let out = crate::agent::shared::generate_opencode_agent(&agent);
        assert!(out.contains("mode: \"subagent\""), "mode は subagent のべき: {}", out);
        assert!(!out.contains("permission"), "writable agent に permission は不要: {}", out);
    }
}
