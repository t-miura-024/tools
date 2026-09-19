import { initConfig } from "./init-config";
import { parseInitConfigCli } from "./parse-init-config-cli";
import { usage } from "./usage";
import { formatInitConfigResult } from "./format-init-config-result";

if (require.main === module) {
  void (async () => {
    try {
      const options = parseInitConfigCli(process.argv.slice(2));
      if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
      }
      if (!options.owner || options.projectNumber === undefined) {
        process.stderr.write("Both --owner and --project are required.\n\n" + usage() + "\n");
        process.exitCode = 1;
        return;
      }
      const result = await initConfig({
        owner: options.owner,
        projectNumber: options.projectNumber,
        configPath: options.configPath,
      });
      process.stdout.write(`${formatInitConfigResult(result.config, result.configPath)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  })();
}
