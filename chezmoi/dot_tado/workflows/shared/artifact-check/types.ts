export type ArtifactForm = "json" | "markdown" | "text";

/** ステップが成果物ごとに宣言する期待。省略項目は検証しない。 */
export interface ArtifactExpectation {
  /** report 時の artifacts に要求する key（= 正典ファイル名を想定） */
  key: string;
  form: ArtifactForm;
  /** json（オブジェクト）: トップレベルに必須のキー */
  keys?: string[];
  /** json: 配列であることの要求と最小要素数 */
  minItems?: number;
  /** json: 配列の全要素に必須のキー（配列要素がオブジェクトの場合） */
  itemKeys?: string[];
  /** markdown: 存在必須の見出し（`#` 接頭辞は任意。例: "## 完了条件"） */
  sections?: string[];
  /** text の許容パターン（例: /^[0-9]+$/） */
  pattern?: RegExp;
  /** markdown/text の内容に必須のパターン（例: effort コメント） */
  patterns?: RegExp[];
  /** 正典パス。既定は join(sessionDir, key) */
  path?: string;
}
