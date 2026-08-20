# mt-plan Skillの廃止と共通リソースの抽出

`mt-plan` 統合Skillを廃止し、作成責務を `mt-plan-create`、実行責務を `mt-plan-run` に分離する。双方で参照される `init-config` / `transition-plan` / `plan-format` は `skill/_shared/mt-plan-xxx` に抽出し、片側専用の `list-plans` / `collect-review-context` は `mt-plan-run` に移す。legacyと `sync-sessions` は削除する。後方互換は維持しない。
