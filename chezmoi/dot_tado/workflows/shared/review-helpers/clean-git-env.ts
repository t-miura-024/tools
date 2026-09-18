import { GIT_CONTEXT_ENV } from "./git-context-env.ts";

export function cleanGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of GIT_CONTEXT_ENV) {
    delete env[key];
  }
  return env;
}
