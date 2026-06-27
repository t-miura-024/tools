# セッション管理

## セッションディレクトリ

ワークフロー開始時にセッションディレクトリを作成する:

- パス: `tmp/mt-sdd/YYYYMMDD_<session-name>/`
- `<session-name>` はユーザーの要求内容から英語ケバブケースで生成
- SubAgent の永続セッション ID 管理ファイルは作成しない。継続が必要な場合は成果物ファイルと前回出力を prompt に含めて再委譲する

### ディレクトリ構成（全フェーズ完了後）

```text
tmp/mt-sdd/YYYYMMDD_<session-name>/
├── spec.md                        # mt-sdd-spec が生成（Phase 1）
├── implementation-plan.md         # mt-sdd-implement が生成（Phase 4）
├── appendix-hearing-log.md        # mt-sdd-spec が生成（Phase 1）
├── appendix-spec-review.md        # mt-sdd-spec が生成（Phase 2）
├── appendix-plan-review.md        # mt-sdd-implement が生成（Phase 5）
├── appendix-code-review.md        # mt-sdd-implement が生成（Phase 7）
├── appendix-validation-report.md  # mt-sdd-validate が生成（Phase 8）
└── appendix-change-log.md         # UCR 発生時に生成（フォーマットは upstream-change-protocol.md を参照）
```

### SubAgent 実行管理

SubAgent の起動、並列実行、修正ループの詳細は [subagent-protocol.md](subagent-protocol.md) を参照する。
親エージェントは各 SubAgent の出力を確認し、必要な内容だけを成果物ファイルや付録に集約する。

## 進捗管理

`TodoWrite` でフェーズ単位の TODO リストを作成し、進捗を管理する。
