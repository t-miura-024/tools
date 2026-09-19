import { spawn } from "node:child_process";
import { GitCommandError } from "./git-command-error";

export type RunCommandResult = {
  stdout: string;
  stderr: string;
};

export async function runCommand(command: string, args: string[]): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(
        new GitCommandError({
          command,
          args,
          exitCode: null,
          stderr: stderr || error.message,
          cause: error,
        }),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new GitCommandError({
            command,
            args,
            exitCode: code,
            stderr,
          }),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
