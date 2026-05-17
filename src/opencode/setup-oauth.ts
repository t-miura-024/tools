import { intro, outro, text, confirm, log, isCancel } from "@clack/prompts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "pathe";
import { homedir } from "node:os";

const HOME = homedir();
const OAUTH_CONFIG_PATH = resolve(HOME, ".config", "opencode", "ngrok-oauth.json");

type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  allowedEmails: string[];
};

function readConfig(): OAuthConfig | undefined {
  if (!existsSync(OAUTH_CONFIG_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(OAUTH_CONFIG_PATH, "utf-8"));
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  intro("ngrok Google OAuth 設定");

  const existing = readConfig();

  if (existing) {
    const overwrite = await confirm({
      message: "既に OAuth 設定が存在します。上書きしますか？",
    });
    if (isCancel(overwrite) || !overwrite) {
      outro("設定を変更せずに終了します");
      process.exit(0);
    }
  }

  const clientId = await text({
    message: "Google OAuth クライアント ID:",
    placeholder: existing?.clientId ?? "xxxxx.apps.googleusercontent.com",
    validate(value) {
      if (!value) return "クライアント ID を入力してください";
      if (!value.endsWith(".apps.googleusercontent.com")) {
        return "クライアント ID は .apps.googleusercontent.com で終わる必要があります";
      }
    },
  });
  if (isCancel(clientId)) process.exit(0);

  const clientSecret = await text({
    message: "Google OAuth クライアントシークレット:",
    placeholder: existing?.clientSecret ?? "GOCSPX-xxxxxxxxxxxx",
    validate(value) {
      if (!value) return "クライアントシークレットを入力してください";
      if (!value.startsWith("GOCSPX-")) {
        return "クライアントシークレットは GOCSPX- で始まる必要があります";
      }
    },
  });
  if (isCancel(clientSecret)) process.exit(0);

  const emailsRaw = await text({
    message: "許可するメールアドレス（カンマ区切りで複数可）:",
    placeholder: existing?.allowedEmails.join(",") ?? "you@gmail.com",
    validate(value) {
      if (!value) return "少なくとも 1 つのメールアドレスを入力してください";
      const emails = value
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      if (emails.length === 0) {
        return "少なくとも 1 つのメールアドレスを入力してください";
      }
      for (const email of emails) {
        if (!email.includes("@")) {
          return `"${email}" は有効なメールアドレスではありません`;
        }
      }
    },
  });
  if (isCancel(emailsRaw)) process.exit(0);

  const allowedEmails = (emailsRaw as string)
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  const config: OAuthConfig = {
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    allowedEmails,
  };

  const dir = resolve(HOME, ".config", "opencode");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(OAUTH_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  log.success(`設定を保存しました: ${OAUTH_CONFIG_PATH}`);
  outro("✅ OAuth 設定が完了しました");
}

if (process.argv[1] === import.meta.filename) {
  await main();
}
