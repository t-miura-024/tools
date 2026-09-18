import { DIFIT_RECOVERY_TARGET_COMMAND } from "./difit-recovery-target-command.ts";
/// 選択復旧の案内に添える、target ありセッション向けの補足。
export const TARGET_RECOVERY_NOTE = `effort.json に target があるセッションでは、セッションの復旧も \`${DIFIT_RECOVERY_TARGET_COMMAND}\`（difit の第2引数が compare-with=base）で行うこと`;
