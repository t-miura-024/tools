#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::agent::shared;
    use crate::agent::sync::{sync_agents, SyncMode};

    /// Create the canonical cursor agent directory structure and write a cursor agent file.
    fn setup_source_dir(tmp: &TempDir) -> std::path::PathBuf {
        let source_dir = tmp.path().to_path_buf();
        let cursor_agents = shared::cursor_agents_dir(&source_dir);
        fs::create_dir_all(&cursor_agents).unwrap();
        // Also create target dirs so orphan cleanup can scan them
        fs::create_dir_all(shared::claude_agents_dir(&source_dir)).unwrap();
        fs::create_dir_all(shared::opencode_agents_dir(&source_dir)).unwrap();
        source_dir
    }

    /// Write a cursor agent `.md` file with the given parameters.
    fn write_cursor_agent(
        source_dir: &std::path::Path,
        file_name: &str,
        name: &str,
        description: &str,
        readonly: bool,
        color: &str,
        body: &str,
    ) {
        let dir = shared::cursor_agents_dir(source_dir);
        fs::create_dir_all(&dir).unwrap();
        let content = format!(
            "---\nname: {name}\ndescription: {description}\nreadonly: {readonly}\ncolor: {color}\n---\n{body}\n"
        );
        fs::write(dir.join(format!("{file_name}.md")), content).unwrap();
    }

    // ─── drift detection: content mismatch ───────────────────────────────

    #[test]
    fn test_drift_detected_content_mismatch() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_source_dir(&tmp);

        write_cursor_agent(
            &source_dir, "my-agent", "my-agent", "test desc", false, "green", "body",
        );

        // Write stale content to claude target so it differs from generated
        let claude_path = shared::claude_agents_dir(&source_dir).join("my-agent.md");
        fs::write(&claude_path, "stale content").unwrap();

        // Write correct content to opencode target (no drift there)
        let agent_files = shared::read_cursor_agents(&source_dir).unwrap();
        let opencode_content = shared::generate_opencode_agent(&agent_files[0].1);
        let opencode_path = shared::opencode_agents_dir(&source_dir).join("my-agent.md");
        fs::write(&opencode_path, &opencode_content).unwrap();

        let drift = sync_agents(&source_dir, SyncMode::Check).unwrap();

        // Only claude should be detected as drift
        assert_eq!(drift.len(), 1);
        assert_eq!(drift[0].0, "my-agent");
        assert_eq!(drift[0].1, "claude");
        assert_eq!(drift[0].2, "update");
    }

    // ─── drift detection: file missing ───────────────────────────────────

    #[test]
    fn test_drift_detected_file_missing() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_source_dir(&tmp);

        write_cursor_agent(
            &source_dir, "new-agent", "new-agent", "desc", false, "blue", "hello",
        );

        // No target files exist → both claude and opencode should be drift
        let drift = sync_agents(&source_dir, SyncMode::Check).unwrap();

        assert_eq!(drift.len(), 2);
        let platforms: Vec<&str> = drift.iter().map(|d| d.1.as_str()).collect();
        assert!(platforms.contains(&"claude"));
        assert!(platforms.contains(&"opencode"));
        for entry in &drift {
            assert_eq!(entry.0, "new-agent");
            assert_eq!(entry.2, "update");
        }
    }

    // ─── Sync mode writes files ──────────────────────────────────────────

    #[test]
    fn test_sync_mode_writes_files() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_source_dir(&tmp);

        write_cursor_agent(
            &source_dir, "writer-agent", "writer-agent", "writes stuff", false, "green",
            "# Body",
        );

        let drift = sync_agents(&source_dir, SyncMode::Sync).unwrap();
        assert_eq!(drift.len(), 2, "both platforms should have drift initially");

        // Verify files were actually written
        let claude_path = shared::claude_agents_dir(&source_dir).join("writer-agent.md");
        let opencode_path = shared::opencode_agents_dir(&source_dir).join("writer-agent.md");
        assert!(claude_path.exists(), "claude agent file should be written");
        assert!(opencode_path.exists(), "opencode agent file should be written");

        // Verify content matches expected generation
        let agent_files = shared::read_cursor_agents(&source_dir).unwrap();
        let expected_claude = shared::generate_claude_agent(&agent_files[0].1);
        let expected_opencode = shared::generate_opencode_agent(&agent_files[0].1);
        assert_eq!(fs::read_to_string(&claude_path).unwrap(), expected_claude);
        assert_eq!(fs::read_to_string(&opencode_path).unwrap(), expected_opencode);

        // Second sync should produce no drift
        let drift2 = sync_agents(&source_dir, SyncMode::Sync).unwrap();
        assert!(drift2.is_empty(), "no drift after sync");
    }

    // ─── Check mode does NOT write files ─────────────────────────────────

    #[test]
    fn test_check_mode_does_not_write() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_source_dir(&tmp);

        write_cursor_agent(
            &source_dir, "check-agent", "check-agent", "desc", false, "red", "body",
        );

        let drift = sync_agents(&source_dir, SyncMode::Check).unwrap();
        assert_eq!(drift.len(), 2, "drift should be detected");

        let claude_path = shared::claude_agents_dir(&source_dir).join("check-agent.md");
        let opencode_path = shared::opencode_agents_dir(&source_dir).join("check-agent.md");
        assert!(
            !claude_path.exists(),
            "Check mode must not write claude file"
        );
        assert!(
            !opencode_path.exists(),
            "Check mode must not write opencode file"
        );
    }

    // ─── DryRun mode does NOT write files ────────────────────────────────

    #[test]
    fn test_dryrun_mode_does_not_write() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_source_dir(&tmp);

        write_cursor_agent(
            &source_dir, "dry-agent", "dry-agent", "desc", true, "yellow", "body",
        );

        let drift = sync_agents(&source_dir, SyncMode::DryRun).unwrap();
        assert_eq!(drift.len(), 2, "drift should be detected");

        let claude_path = shared::claude_agents_dir(&source_dir).join("dry-agent.md");
        let opencode_path = shared::opencode_agents_dir(&source_dir).join("dry-agent.md");
        assert!(
            !claude_path.exists(),
            "DryRun mode must not write claude file"
        );
        assert!(
            !opencode_path.exists(),
            "DryRun mode must not write opencode file"
        );
    }

    // ─── orphan agent cleanup ────────────────────────────────────────────

    #[test]
    fn test_orphan_agent_detected_and_deleted_in_sync_mode() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_source_dir(&tmp);

        // One canonical agent
        write_cursor_agent(
            &source_dir, "alive", "alive", "desc", false, "green", "body",
        );

        // Orphan files in both platform dirs (no matching cursor agent)
        let orphan_claude = shared::claude_agents_dir(&source_dir).join("ghost.md");
        let orphan_opencode = shared::opencode_agents_dir(&source_dir).join("ghost.md");
        fs::write(&orphan_claude, "orphan content").unwrap();
        fs::write(&orphan_opencode, "orphan content").unwrap();

        let drift = sync_agents(&source_dir, SyncMode::Sync).unwrap();

        // Should have: 2 updates (alive claude+opencode) + 2 deletes (ghost claude+opencode)
        let deletes: Vec<_> = drift.iter().filter(|d| d.2 == "delete").collect();
        assert_eq!(deletes.len(), 2, "orphan should be detected on both platforms");
        for d in &deletes {
            assert_eq!(d.0, "ghost");
        }

        // Orphan files should be removed
        assert!(!orphan_claude.exists(), "orphan claude file should be deleted");
        assert!(!orphan_opencode.exists(), "orphan opencode file should be deleted");
    }

    #[test]
    fn test_orphan_agent_not_deleted_in_check_mode() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_source_dir(&tmp);

        write_cursor_agent(
            &source_dir, "alive", "alive", "desc", false, "green", "body",
        );

        let orphan_claude = shared::claude_agents_dir(&source_dir).join("ghost.md");
        fs::write(&orphan_claude, "orphan content").unwrap();

        let drift = sync_agents(&source_dir, SyncMode::Check).unwrap();

        let deletes: Vec<_> = drift.iter().filter(|d| d.2 == "delete").collect();
        assert_eq!(deletes.len(), 1, "orphan should be detected");

        // File should still exist (Check mode doesn't delete)
        assert!(
            orphan_claude.exists(),
            "Check mode must not delete orphan file"
        );
    }

    // ─── color not set → bail ────────────────────────────────────────────

    #[test]
    fn test_color_not_set_bails() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_source_dir(&tmp);

        // Write agent with empty color
        write_cursor_agent(
            &source_dir, "no-color", "no-color", "desc", false, "", "body",
        );

        let result = sync_agents(&source_dir, SyncMode::Sync);
        assert!(result.is_err(), "should bail when color is empty");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("color"),
            "error message should mention color: {err_msg}"
        );
    }

    // ─── no drift when already synced ────────────────────────────────────

    #[test]
    fn test_no_drift_when_synced() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_source_dir(&tmp);

        write_cursor_agent(
            &source_dir, "synced", "synced", "desc", false, "blue", "body",
        );

        // First sync to write files
        sync_agents(&source_dir, SyncMode::Sync).unwrap();

        // Second check should find no drift
        let drift = sync_agents(&source_dir, SyncMode::Check).unwrap();
        assert!(drift.is_empty(), "no drift expected after sync");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// U3: skill 同期テスト（symlink 生成・migrate・orphan cleanup）
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod skill_tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::agent::shared;
    use crate::agent::sync::{sync_skills, SyncMode};

    /// Create a minimal chezmoi source dir with the given skill names as dirs
    /// under `dot_cursor/skills/`, plus empty target dirs for both platforms.
    fn setup_skill_source(tmp: &TempDir, skills: &[&str]) -> std::path::PathBuf {
        let source_dir = tmp.path().to_path_buf();

        for skill in skills {
            fs::create_dir_all(shared::cursor_skills_dir(&source_dir).join(skill)).unwrap();
        }

        // Ensure target dirs exist so orphan cleanup can scan them
        fs::create_dir_all(shared::claude_skills_dir(&source_dir)).unwrap();
        fs::create_dir_all(shared::opencode_skills_dir(&source_dir)).unwrap();

        source_dir
    }

    // ─── 完了条件 4: Check / DryRun モードでは skill symlink が書き込まれない ──

    #[test]
    fn test_skill_check_mode_does_not_write_symlink() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_skill_source(&tmp, &["my-skill"]);

        let drift = sync_skills(&source_dir, SyncMode::Check).unwrap();

        // drift should detect symlink needed for both platforms
        assert!(
            !drift.is_empty(),
            "Check モードでも drift は検出されるべき"
        );
        assert!(
            drift
                .iter()
                .any(|(name, _, action)| name == "my-skill" && action == "symlink"),
            "symlink drift が検出されるべき: {:?}",
            drift
        );

        // But no symlink file should be written
        let claude_symlink = shared::claude_skills_dir(&source_dir).join("symlink_my-skill");
        let opencode_symlink = shared::opencode_skills_dir(&source_dir).join("symlink_my-skill");
        assert!(
            !claude_symlink.exists(),
            "Check モードでは claude symlink は書き込まれない"
        );
        assert!(
            !opencode_symlink.exists(),
            "Check モードでは opencode symlink は書き込まれない"
        );
    }

    #[test]
    fn test_skill_dryrun_mode_does_not_write_symlink() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_skill_source(&tmp, &["my-skill"]);

        let drift = sync_skills(&source_dir, SyncMode::DryRun).unwrap();

        assert!(
            !drift.is_empty(),
            "DryRun モードでも drift は検出されるべき"
        );
        assert!(
            drift
                .iter()
                .any(|(name, _, action)| name == "my-skill" && action == "symlink"),
            "symlink drift が検出されるべき: {:?}",
            drift
        );

        let claude_symlink = shared::claude_skills_dir(&source_dir).join("symlink_my-skill");
        let opencode_symlink = shared::opencode_skills_dir(&source_dir).join("symlink_my-skill");
        assert!(
            !claude_symlink.exists(),
            "DryRun モードでは claude symlink は書き込まれない"
        );
        assert!(
            !opencode_symlink.exists(),
            "DryRun モードでは opencode symlink は書き込まれない"
        );
    }

    // ─── 完了条件 6: orphan skill（symlink + old dir）の検出・削除 ──────────

    #[test]
    fn test_orphan_skill_symlink_detected_and_deleted() {
        let tmp = TempDir::new().unwrap();
        // No canonical skills → everything in target is orphan
        let source_dir = setup_skill_source(&tmp, &[]);

        // Create orphan symlink files in both target dirs
        let claude_orphan = shared::claude_skills_dir(&source_dir).join("symlink_orphan-skill");
        let opencode_orphan =
            shared::opencode_skills_dir(&source_dir).join("symlink_orphan-skill");
        fs::write(&claude_orphan, "../../.cursor/skills/orphan-skill").unwrap();
        fs::write(&opencode_orphan, "../../../.cursor/skills/orphan-skill").unwrap();

        let drift = sync_skills(&source_dir, SyncMode::Sync).unwrap();

        // Should detect orphan on both platforms
        let deletes: Vec<_> = drift
            .iter()
            .filter(|(name, _, action)| name == "orphan-skill" && action == "delete")
            .collect();
        assert_eq!(
            deletes.len(),
            2,
            "orphan symlink は両プラットフォームで検出されるべき: {:?}",
            drift
        );

        // Orphan files should be removed
        assert!(
            !claude_orphan.exists(),
            "orphan claude symlink は削除されるべき"
        );
        assert!(
            !opencode_orphan.exists(),
            "orphan opencode symlink は削除されるべき"
        );
    }

    #[test]
    fn test_orphan_skill_old_dir_detected_and_deleted() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_skill_source(&tmp, &[]);

        // Create orphan old-style dirs in both target dirs
        let claude_orphan_dir = shared::claude_skills_dir(&source_dir).join("orphan-dir");
        let opencode_orphan_dir = shared::opencode_skills_dir(&source_dir).join("orphan-dir");
        fs::create_dir_all(&claude_orphan_dir).unwrap();
        fs::create_dir_all(&opencode_orphan_dir).unwrap();
        // Put a file inside to make removal non-trivial
        fs::write(claude_orphan_dir.join("SKILL.md"), "old content").unwrap();
        fs::write(opencode_orphan_dir.join("SKILL.md"), "old content").unwrap();

        let drift = sync_skills(&source_dir, SyncMode::Sync).unwrap();

        let deletes: Vec<_> = drift
            .iter()
            .filter(|(name, _, action)| name == "orphan-dir" && action == "delete (old dir)")
            .collect();
        assert_eq!(
            deletes.len(),
            2,
            "orphan old dir は両プラットフォームで検出されるべき: {:?}",
            drift
        );

        assert!(
            !claude_orphan_dir.exists(),
            "orphan claude old dir は削除されるべき"
        );
        assert!(
            !opencode_orphan_dir.exists(),
            "orphan opencode old dir は削除されるべき"
        );
    }

    #[test]
    fn test_orphan_skill_not_deleted_in_check_mode() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_skill_source(&tmp, &[]);

        let claude_orphan = shared::claude_skills_dir(&source_dir).join("symlink_ghost");
        fs::write(&claude_orphan, "../../.cursor/skills/ghost").unwrap();

        let drift = sync_skills(&source_dir, SyncMode::Check).unwrap();

        let deletes: Vec<_> = drift
            .iter()
            .filter(|(name, _, action)| name == "ghost" && action == "delete")
            .collect();
        assert_eq!(deletes.len(), 1, "orphan は検出されるべき: {:?}", drift);

        // File should still exist (Check mode doesn't delete)
        assert!(
            claude_orphan.exists(),
            "Check モードでは orphan symlink は削除されない"
        );
    }

    // ─── 完了条件 7: skill symlink の生成・migrate（old dir 削除）──────────

    #[test]
    fn test_sync_mode_creates_skill_symlink() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_skill_source(&tmp, &["my-skill"]);

        let drift = sync_skills(&source_dir, SyncMode::Sync).unwrap();

        assert!(
            drift
                .iter()
                .any(|(name, _, action)| name == "my-skill" && action == "symlink"),
            "symlink drift が検出されるべき: {:?}",
            drift
        );

        let claude_symlink = shared::claude_skills_dir(&source_dir).join("symlink_my-skill");
        let opencode_symlink = shared::opencode_skills_dir(&source_dir).join("symlink_my-skill");

        assert!(
            claude_symlink.exists(),
            "Sync モードでは claude symlink が作成されるべき"
        );
        assert!(
            opencode_symlink.exists(),
            "Sync モードでは opencode symlink が作成されるべき"
        );

        // Verify content matches expected symlink target
        assert_eq!(
            fs::read_to_string(&claude_symlink).unwrap(),
            shared::claude_skill_symlink_target("my-skill"),
            "claude symlink の内容が期待値と異なる"
        );
        assert_eq!(
            fs::read_to_string(&opencode_symlink).unwrap(),
            shared::opencode_skill_symlink_target("my-skill"),
            "opencode symlink の内容が期待値と異なる"
        );

        // Second sync should produce no drift (idempotent)
        let drift2 = sync_skills(&source_dir, SyncMode::Sync).unwrap();
        assert!(drift2.is_empty(), "同期後に drift は無いべき: {:?}", drift2);
    }

    #[test]
    fn test_old_dir_migrated_to_symlink() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_skill_source(&tmp, &["my-skill"]);

        // Create old-style dirs in both targets (simulating pre-migration state)
        let claude_old = shared::claude_skills_dir(&source_dir).join("my-skill");
        let opencode_old = shared::opencode_skills_dir(&source_dir).join("my-skill");
        fs::create_dir_all(&claude_old).unwrap();
        fs::create_dir_all(&opencode_old).unwrap();
        fs::write(claude_old.join("SKILL.md"), "old skill content").unwrap();
        fs::write(opencode_old.join("SKILL.md"), "old skill content").unwrap();

        let drift = sync_skills(&source_dir, SyncMode::Sync).unwrap();

        // Should detect migration
        assert!(
            drift.iter().any(|(name, _, action)| name == "my-skill"
                && action == "migrate (remove old dir)"),
            "migrate drift が検出されるべき: {:?}",
            drift
        );

        // Old dirs should be removed
        assert!(!claude_old.exists(), "claude old dir は削除されるべき");
        assert!(!opencode_old.exists(), "opencode old dir は削除されるべき");

        // Symlinks should be created with correct content
        let claude_symlink = shared::claude_skills_dir(&source_dir).join("symlink_my-skill");
        let opencode_symlink = shared::opencode_skills_dir(&source_dir).join("symlink_my-skill");
        assert!(
            claude_symlink.exists(),
            "migrate 後に claude symlink が作成されるべき"
        );
        assert!(
            opencode_symlink.exists(),
            "migrate 後に opencode symlink が作成されるべき"
        );
        assert_eq!(
            fs::read_to_string(&claude_symlink).unwrap(),
            shared::claude_skill_symlink_target("my-skill")
        );
        assert_eq!(
            fs::read_to_string(&opencode_symlink).unwrap(),
            shared::opencode_skill_symlink_target("my-skill")
        );
    }

    #[test]
    fn test_skill_symlink_content_mismatch_triggers_update() {
        let tmp = TempDir::new().unwrap();
        let source_dir = setup_skill_source(&tmp, &["my-skill"]);

        // Write stale symlink content
        let claude_symlink = shared::claude_skills_dir(&source_dir).join("symlink_my-skill");
        fs::write(&claude_symlink, "stale/target/path").unwrap();

        // Write correct content for opencode (no drift there)
        let opencode_symlink = shared::opencode_skills_dir(&source_dir).join("symlink_my-skill");
        fs::write(
            &opencode_symlink,
            shared::opencode_skill_symlink_target("my-skill"),
        )
        .unwrap();

        let drift = sync_skills(&source_dir, SyncMode::Sync).unwrap();

        // Only claude should have symlink drift
        let symlink_drifts: Vec<_> = drift
            .iter()
            .filter(|(_, _, action)| action == "symlink")
            .collect();
        assert_eq!(
            symlink_drifts.len(),
            1,
            "claude のみ symlink drift が検出されるべき: {:?}",
            drift
        );
        assert_eq!(symlink_drifts[0].0, "my-skill");
        assert_eq!(symlink_drifts[0].1, "claude");

        // Content should be corrected
        assert_eq!(
            fs::read_to_string(&claude_symlink).unwrap(),
            shared::claude_skill_symlink_target("my-skill")
        );
    }
}
