import { intro, outro, log } from "@clack/prompts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "pathe";

const HOME = homedir();
const ZSHRC_PATH = resolve(HOME, ".zshrc");
const MT_FUNC = `
# mt command (managed by ~/src/tools)
mt() { (cd ~/src/tools && pnpm tsx src/cli/mt-launcher.ts "$@"); }
`;

function main(): void {
  intro("mt コマンドセットアップ");

  try {
    if (!existsSync(ZSHRC_PATH)) {
      writeFileSync(ZSHRC_PATH, MT_FUNC.trimStart());
      outro("✅ ~/.zshrc を作成し、mt 関数を追加しました");
      log.info("ターミナルを再起動するか、source ~/.zshrc を実行してください");
      return;
    }

    const content = readFileSync(ZSHRC_PATH, "utf-8");

    if (content.includes("mt() {")) {
      log.info("mt 関数は既に ~/.zshrc に登録されています");
      outro("スキップしました");
      return;
    }

    writeFileSync(ZSHRC_PATH, content.trimEnd() + "\n" + MT_FUNC);
    outro("✅ mt 関数を ~/.zshrc に追加しました");
    log.info("ターミナルを再起動するか、source ~/.zshrc を実行してください");
  } catch (e) {
    log.error(String(e));
    process.exit(1);
  }
}

main();
