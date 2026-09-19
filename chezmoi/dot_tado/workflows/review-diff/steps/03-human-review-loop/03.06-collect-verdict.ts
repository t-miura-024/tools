import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { createCollectVerdictStep } from "../../helper/create-collect-verdict-step.ts";

/// 単独レビューの verdict 収集（2 亜種のうち人間レビューなし版。自律版は頂点で生成する）。
export const collectVerdictStep: TaskStepDef = createCollectVerdictStep(false);
