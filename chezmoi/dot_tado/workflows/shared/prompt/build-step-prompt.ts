// NOTE(arch-2): tado/prompt の buildStepPrompt 集約ポイント。
// workflows 配下からの直接 import（`from "tado/prompt"`）は行わず、
// 本モジュール経由で import すること。ADR-0019 の StepDef 限定と競合しない
// 純粋フォーマッターの再エクスポートであり、型もここから再掲する。
export { buildStepPrompt } from "tado/prompt";
