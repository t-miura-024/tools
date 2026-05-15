import consola from "consola";
import { execa } from "execa";

export async function getDefaultBranch(): Promise<string> {
  const { stdout } = await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  return stdout.replace("refs/remotes/origin/", "");
}

if (process.argv[1] === import.meta.filename) {
  const branch = await getDefaultBranch();
  consola.success(`Default branch: ${branch}`);
}
