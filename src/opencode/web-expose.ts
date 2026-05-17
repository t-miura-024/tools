import { intro, outro, log } from "@clack/prompts";
import { execa } from "execa";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "pathe";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const HOME = homedir();
const OAUTH_CONFIG_PATH = resolve(HOME, ".config", "opencode", "ngrok-oauth.json");
const PID_FILE_PATH = resolve(HOME, ".config", "opencode", "web-expose.pid");

type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  allowedEmails: string[];
};

type PidData = {
  opencodePid: number;
  ngrokPid: number;
  port: number;
  url: string;
  repoDir: string;
  startedAt: string;
  policyFile: string;
};

function readOAuthConfig(): OAuthConfig {
  return JSON.parse(readFileSync(OAUTH_CONFIG_PATH, "utf-8"));
}

function readPidData(): PidData | null {
  if (!existsSync(PID_FILE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writePidData(data: PidData): void {
  writeFileSync(PID_FILE_PATH, JSON.stringify(data, null, 2) + "\n");
}

function deletePidData(): void {
  if (existsSync(PID_FILE_PATH)) {
    unlinkSync(PID_FILE_PATH);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killProcess(pid: number | undefined, name: string): Promise<void> {
  if (!pid) return;
  log.info(`${name} (PID: ${pid}) を停止中...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 30; i++) {
    if (!isProcessAlive(pid)) {
      log.info(`${name} が終了しました`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  log.warn(`${name} が SIGTERM に応答しません。SIGKILL を送信します`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}

function generatePolicyFile(config: OAuthConfig): string {
  const emailsStr = config.allowedEmails.map((e) => `'${e}'`).join(", ");
  const yaml =
    [
      "on_http_request:",
      "  - actions:",
      "      - type: oauth",
      "        config:",
      "          provider: google",
      `          client_id: '${config.clientId}'`,
      `          client_secret: '${config.clientSecret}'`,
      "          scopes:",
      "            - https://www.googleapis.com/auth/userinfo.profile",
      "            - https://www.googleapis.com/auth/userinfo.email",
      `  - expressions:`,
      `      - "!(actions.ngrok.oauth.identity.email in [${emailsStr}])"`,
      "    actions:",
      "      - type: deny",
    ].join("\n") + "\n";

  const id = randomBytes(4).toString("hex");
  const path = resolve("/tmp", `opencode-ngrok-policy-${id}.yml`);
  writeFileSync(path, yaml);
  return path;
}

async function checkPrerequisites(): Promise<boolean> {
  try {
    await execa("ngrok", ["version"], { stdio: "ignore" });
  } catch {
    log.error(
      "ngrok がインストールされていません。brew install ngrok などでインストールしてください",
    );
    return false;
  }

  try {
    await execa("ngrok", ["config", "check"], { stdio: "ignore" });
  } catch {
    log.error(
      "ngrok authtoken が設定されていません。\n  ngrok config add-authtoken <token> を実行してください",
    );
    return false;
  }

  try {
    await execa("opencode", ["version"], { stdio: "ignore" });
  } catch {
    log.error("opencode がインストールされていません");
    return false;
  }

  if (!existsSync(OAUTH_CONFIG_PATH)) {
    log.error("Google OAuth 設定がありません。\n  npm run opencode:oauth を先に実行してください");
    return false;
  }

  return true;
}

async function start(): Promise<void> {
  intro("OpenCode Web 公開");

  const existingPid = readPidData();
  if (existingPid) {
    const opencodeAlive = isProcessAlive(existingPid.opencodePid);
    const ngrokAlive = isProcessAlive(existingPid.ngrokPid);
    if (opencodeAlive || ngrokAlive) {
      log.error("既に OpenCode Web が起動中です:");
      log.info(`  URL:              ${existingPid.url}`);
      log.info(`  opencode (PID):   ${existingPid.opencodePid}`);
      log.info(`  ngrok (PID):      ${existingPid.ngrokPid}`);
      log.info(`  起動ディレクトリ: ${existingPid.repoDir}`);
      log.info("  停止するには npm run opencode:expose -- --stop を実行してください");
      outro("起動を中止しました");
      process.exit(1);
    }
    if (existsSync(existingPid.policyFile)) {
      try {
        unlinkSync(existingPid.policyFile);
      } catch {
        // ignore
      }
    }
    deletePidData();
  }

  if (!(await checkPrerequisites())) {
    process.exit(1);
  }

  const oauthConfig = readOAuthConfig();
  const repoDir = process.cwd();

  log.info("opencode web を起動中...");
  const env = { ...process.env };
  delete env.OPENCODE_SERVER_PASSWORD;
  const opencodeProcess = execa("opencode", ["web", "--port", "0"], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    extendEnv: false,
    env,
  });
  opencodeProcess.catch(() => {});

  const opencodePid = opencodeProcess.pid;

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("opencode のポートを検出できませんでした（タイムアウト）"));
    }, 15_000);

    opencodeProcess.stderr?.on("data", (chunk: Buffer) => {
      const m = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timeout);
        resolve(parseInt(m[1], 10));
      }
    });

    opencodeProcess.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`opencode が予期せず終了しました（exit code: ${code}）`));
    });
  });

  log.info(`opencode web がポート ${port} で起動しました`);

  log.info("トラフィックポリシーを生成中...");
  const policyFile = generatePolicyFile(oauthConfig);

  log.info("ngrok を起動中...");
  const ngrokProcess = execa("ngrok", ["http", String(port), "--traffic-policy-file", policyFile], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  ngrokProcess.catch(() => {});

  const ngrokPid = ngrokProcess.pid;

  log.info("ngrok の URL を取得中...");
  let url: string | null = null;
  for (let i = 0; i < 10 && url === null; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      const data = (await res.json()) as { tunnels?: { public_url?: string }[] };
      if (data.tunnels && data.tunnels.length > 0 && data.tunnels[0].public_url) {
        url = data.tunnels[0].public_url;
      }
    } catch {
      // retry
    }
  }

  if (url === null) {
    log.error("ngrok の URL を取得できませんでした");
    try {
      process.kill(opencodePid!, "SIGKILL");
    } catch {
      // ignore
    }
    try {
      process.kill(ngrokPid!, "SIGKILL");
    } catch {
      // ignore
    }
    try {
      unlinkSync(policyFile);
    } catch {
      // ignore
    }
    process.exit(1);
  }

  const pidData: PidData = {
    opencodePid: opencodePid!,
    ngrokPid: ngrokPid!,
    port,
    url,
    repoDir,
    startedAt: new Date().toISOString(),
    policyFile,
  };
  writePidData(pidData);

  outro(`✅ OpenCode Web が公開されました

  URL: ${url}
  Ctrl+C で停止できます`);

  await new Promise<void>((_resolve) => {
    let cleaningUp = false;
    const handler = async () => {
      if (cleaningUp) return;
      cleaningUp = true;

      log.info("\n終了中...");

      await killProcess(opencodePid, "opencode web");
      await killProcess(ngrokPid, "ngrok");

      deletePidData();
      try {
        unlinkSync(policyFile);
      } catch {
        // ignore
      }

      outro("✅ セッションを停止しました");
      process.exit(0);
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });
}

async function stop(): Promise<void> {
  intro("OpenCode Web 停止");

  const data = readPidData();

  if (!data) {
    log.info("起動中のセッションはありません");
    outro("完了");
    return;
  }

  const opencodeAlive = isProcessAlive(data.opencodePid);
  const ngrokAlive = isProcessAlive(data.ngrokPid);

  if (!opencodeAlive && !ngrokAlive) {
    log.info("セッションは既に終了していました。PID ファイルを削除します");
    deletePidData();
    if (existsSync(data.policyFile)) {
      try {
        unlinkSync(data.policyFile);
      } catch {
        // ignore
      }
    }
    outro("完了");
    return;
  }

  if (opencodeAlive) {
    await killProcess(data.opencodePid, "opencode web");
  }
  if (ngrokAlive) {
    await killProcess(data.ngrokPid, "ngrok");
  }

  deletePidData();
  if (existsSync(data.policyFile)) {
    try {
      unlinkSync(data.policyFile);
    } catch {
      // ignore
    }
  }

  outro("✅ セッションを停止しました");
}

async function main(): Promise<void> {
  if (process.argv.includes("--stop")) {
    await stop();
  } else {
    await start();
  }
}

if (process.argv[1] === import.meta.filename) {
  await main();
}
