import type { InitCtx } from "tado";
import { loadConfig } from "../../shared/plan-init-config/load-config";

export async function beforeInit(_ctx: InitCtx): Promise<void> {
  try {
    loadConfig();
  } catch (error) {
    throw new Error(
      `mt-plan config not found: ${error instanceof Error ? error.message : String(error)}. Run 'mt-plan init' first.`,
    );
  }
}
