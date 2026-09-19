import type { Perspective } from "./types.ts";

export const PERSPECTIVE_POOL: readonly Perspective[] = [
  {
    id: "req-1",
    label: "要件-1",
    name: "目的整合",
    category: "要件",
    tier: 1,
    summary: "Issue/背景の目的を達成し、本質的で効率的な解決か。目的外混入はないか",
  },
  {
    id: "req-2",
    label: "要件-2",
    name: "仕様カバレッジ",
    category: "要件",
    tier: 1,
    summary:
      "要求の充足、要求外の振る舞い・スコープクリープ・過剰実装(YAGNI違反/投機的一般化)がないか",
  },
  {
    id: "logic-1",
    label: "ロジック-1",
    name: "エラーハンドリング",
    category: "ロジック",
    tier: 1,
    summary: "例外・異常系の妥当性と回復戦略",
  },
  {
    id: "ai-1",
    label: "AI-1",
    name: "ハルシネーションチェック",
    category: "AIアンチパターン",
    tier: 1,
    summary: "幻覚 API・存在しない機能・未検証の前提に基づくコード",
  },
  {
    id: "logic-2",
    label: "ロジック-2",
    name: "セキュリティ",
    category: "ロジック",
    tier: 2,
    summary: "入力検証・秘匿情報・権限・データ整合性・ロールバック",
  },
  {
    id: "logic-3",
    label: "ロジック-3",
    name: "影響範囲",
    category: "ロジック",
    tier: 2,
    summary:
      "差分内の変更による波及・破壊的変更・テスト戦略。同種問題も差分内の原因行に紐付けて指摘し、差分外ファイルへの直接指摘は行わない",
  },
  {
    id: "ai-2",
    label: "AI-2",
    name: "ワイヤリング",
    category: "AIアンチパターン",
    tier: 2,
    summary: "作ったが呼ばれていない・既存機構と接続されていない・統合不整合",
  },
  {
    id: "arch-1",
    label: "アーキ-1",
    name: "関心事の分離",
    category: "アーキテクチャ",
    tier: 2,
    summary:
      "差分内の関心事の分離・ディレクトリ構成・モジュール責務境界。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
  {
    id: "logic-4",
    label: "ロジック-4",
    name: "パフォーマンス",
    category: "ロジック",
    tier: 3,
    summary: "実行効率・リソース(エッジケースはテスト委譲)",
  },
  {
    id: "ai-3",
    label: "AI-3",
    name: "冗長性",
    category: "AIアンチパターン",
    tier: 3,
    summary:
      "冗長な条件分岐・フォールバック/デフォルト引数濫用・早すぎるキャッシュ・不要な後方互換",
  },
  {
    id: "ai-4",
    label: "AI-4",
    name: "場当たり対応",
    category: "AIアンチパターン",
    tier: 3,
    summary:
      "レビュー指摘への表面的対応・決定トレーサビリティ欠如(死蔵/未使用コードは linter 委譲)",
  },
  {
    id: "arch-2",
    label: "アーキ-2",
    name: "凝集度",
    category: "アーキテクチャ",
    tier: 3,
    summary:
      "差分内が深い module か（浅い module 検出、凝集欠如）。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
  {
    id: "arch-3",
    label: "アーキ-3",
    name: "一貫性",
    category: "アーキテクチャ",
    tier: 4,
    summary:
      "差分内の既存コード思想・スタイル・パターンとの一致。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
  {
    id: "arch-4",
    label: "アーキ-4",
    name: "ネーミング",
    category: "アーキテクチャ",
    tier: 4,
    summary:
      "差分内の名前が意図を表すか、ドメイン概念の表現。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
  {
    id: "arch-5",
    label: "アーキ-5",
    name: "結合度",
    category: "アーキテクチャ",
    tier: 5,
    summary:
      "差分内の依存方向・過度な結合・変更の散らばり（Shotgun Surgery）。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
] as const;
