import { intro, select, isCancel, outro, log } from "@clack/prompts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "pathe";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPTS_PATH = resolve(REPO_ROOT, "scripts.json");

interface ScriptEntry {
  description: string;
  category: string;
}

function loadScripts(): Record<string, ScriptEntry> {
  return JSON.parse(readFileSync(SCRIPTS_PATH, "utf-8"));
}

async function showSelector(): Promise<void> {
  intro("mt: スクリプト選択");

  const scripts = loadScripts();

  const entries = Object.entries(scripts)
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.name.localeCompare(b.name);
    });

  const options = entries.map(({ name, description }) => ({
    value: name,
    label: name,
    hint: description,
  }));

  const selected = await select({
    message: "実行するスクリプトを選択してください",
    options,
  });

  if (isCancel(selected)) {
    outro("キャンセルしました");
    process.exit(0);
  }

  await runScript(scripts, selected as string);
}

async function runScript(scripts: Record<string, ScriptEntry>, name: string, passThroughArgs: string[] = []): Promise<void> {
  if (!(name in scripts)) {
    log.error(`スクリプト '${name}' は登録されていません`);
    process.exit(1);
  }

  await execa("pnpm", ["run", name, ...passThroughArgs], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await showSelector();
  } else {
    const scripts = loadScripts();
    await runScript(scripts, args[0], args.slice(1));
  }
}

try {
  await main();
} catch (e) {
  log.error(String(e));
  process.exit(1);
}
