# SDD 共通ガイドライン — オーケストレーターの行動原則

SDD ファミリーの Skill（mt-sdd, mt-sdd-spec, mt-sdd-implement, mt-sdd-validate）で共通適用される注意事項。

1. **SubAgent 委譲**: SDD の各役割は `Subagent` ツールで委譲する。実行プロトコルは [subagent-protocol.md](subagent-protocol.md) に従う
2. **UCR 処理**: 下流フェーズで上流成果物の変更が必要な場合、[upstream-change-protocol.md](upstream-change-protocol.md) に従って処理する。UCR 処理は Critical 自動修正ループの前に実行する
3. **Critical 自動修正ループ**: レビューで Critical 指摘が出た場合、該当成果物を作成した SubAgent type に、対象成果物・指摘・制約を渡して修正を指示 → 再レビューを繰り返す。同一 Critical が 2 回続く場合は自動修正を止め、ユーザーに判断を仰ぐ
4. **Warning/Info は Human Gate へ**: Critical 以外の指摘は人間に判断を委ねる
5. **プロセス遵守**: フェーズ/ステップをスキップしない。すべての中間生成物を生成する
6. **本文での選択肢提示**: ユーザーとの対話（ヒアリング、確認、承認）では、番号付き選択肢や確認事項を本文で提示し、ユーザーのテキスト回答を解釈する
