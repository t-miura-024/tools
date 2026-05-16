import { intro, outro, text, select, spinner, log, isCancel } from "@clack/prompts";
import { execa } from "execa";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "pathe";
import { homedir } from "node:os";

const HOME = homedir();

export type RepoConfig = {
  name: string;
  placement: "src" | "doc";
  visibility: "public" | "private";
  description: string;
};

export async function createRepo(config: RepoConfig): Promise<void> {
  const dir = resolve(HOME, config.placement, config.name);

  if (existsSync(dir)) {
    log.error(`ディレクトリが既に存在します: ${dir}`);
    return;
  }

  try {
    await execa("gh", ["auth", "status"]);
  } catch {
    log.error("gh CLI が認証されていません。\n  gh auth login を実行してください");
    return;
  }

  const s = spinner();
  s.start("ローカルリポジトリをセットアップ中...");
  try {
    await mkdir(dir, { recursive: true });
    await execa("git", ["init", "-b", "main"], { cwd: dir });
    writeFileSync(resolve(dir, "README.md"), `# ${config.name}\n`);
    writeFileSync(resolve(dir, ".gitignore"), "");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "Initial commit"], { cwd: dir });
    s.stop("ローカルセットアップ完了");
  } catch (e) {
    s.stop("ローカルセットアップ失敗");
    log.error(String(e));
    return;
  }

  try {
    await execa("ssh", ["-o", "StrictHostKeyChecking=accept-new", "-T", "git@github.com"], {
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    // expected: GitHub doesn't grant shell access (exit code 1)
    // but the host key was accepted on first connection
  }

  s.start("GitHub リポジトリを作成・push 中...");
  try {
    const args = [
      "repo", "create", config.name,
      `--${config.visibility}`,
      "--source=.", "--push",
    ];
    if (config.description) {
      args.push("--description", config.description);
    }
    await execa("gh", args, { cwd: dir });
    s.stop("GitHub リポジトリを作成しました");
  } catch (e) {
    s.stop("GitHub リポジトリ作成失敗");
    log.error(String(e));
    return;
  }

  outro(`✅ ${config.name} を作成しました: ${dir}`);
}

async function main(): Promise<void> {
  intro("GitHub リポジトリ作成");

  const name = await text({
    message: "リポジトリ名:",
    validate(value) {
      if (!value) return "リポジトリ名を入力してください";
      if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
        return "リポジトリ名に使える文字: a-z, 0-9, _, ., -";
      }
    },
  });
  if (isCancel(name)) process.exit(0);

  const placement = await select({
    message: "配置先:",
    options: [
      { value: "src", label: "~/src" },
      { value: "doc", label: "~/doc" },
    ],
  });
  if (isCancel(placement)) process.exit(0);

  const visibility = await select({
    message: "公開設定:",
    options: [
      { value: "private", label: "Private" },
      { value: "public", label: "Public" },
    ],
  });
  if (isCancel(visibility)) process.exit(0);

  const description = await text({
    message: "説明 (省略可):",
  });
  if (isCancel(description)) process.exit(0);

  await createRepo({
    name: name as string,
    placement: placement as "src" | "doc",
    visibility: visibility as "public" | "private",
    description: description as string,
  });
}

if (process.argv[1] === import.meta.filename) {
  await main();
}
