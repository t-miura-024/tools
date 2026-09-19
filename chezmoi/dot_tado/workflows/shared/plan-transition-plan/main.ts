import { loadConfig } from "../plan-init-config/load-config";
import { InitConfigError } from "../plan-init-config/init-config-error";
import { transitionPlan } from "./transition-plan";
import { parseTransitionPlanCli } from "./parse-transition-plan-cli";
import { usage } from "./usage";
import { formatTransitionResult } from "./format-transition-result";
import { TransitionPlanError } from "./transition-plan-error";

if (require.main === module) {
  void (async () => {
    try {
      const options = parseTransitionPlanCli(process.argv.slice(2));
      if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
      }
      if (options.number === undefined || options.targetStatus === undefined) {
        process.stderr.write(`${usage()}\n`);
        process.exitCode = 1;
        return;
      }
      const config = loadConfig(options.configPath);
      const result = await transitionPlan({
        config,
        number: options.number,
        targetStatus: options.targetStatus,
        repo: options.repo,
      });
      process.stdout.write(`${formatTransitionResult(result)}\n`);
    } catch (error) {
      if (error instanceof InitConfigError || error instanceof TransitionPlanError) {
        process.stderr.write(`${error.message}\n`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
      }
      process.exitCode = 1;
    }
  })();
}
