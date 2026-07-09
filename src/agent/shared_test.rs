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
}
