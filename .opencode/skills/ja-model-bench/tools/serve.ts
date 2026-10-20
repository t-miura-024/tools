#!/usr/bin/env bun
import { join, resolve, normalize } from "path";

const SKILL_DIR = resolve(join(import.meta.dir, ".."));
const RESULTS_DIR = join(SKILL_DIR, "results");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

let clients = new Set<any>();
let closeTimer: Timer | null = null;

function scheduleExitIfIdle() {
  if (clients.size !== 0) {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    return;
  }
  if (closeTimer) return;
  console.log("[serve] no clients, will exit in 800ms if no reconnect");
  closeTimer = setTimeout(() => {
    if (clients.size === 0) {
      console.log("[serve] all clients closed, exiting");
      process.exit(0);
    }
    closeTimer = null;
  }, 800);
}

async function tryServe(port: number) {
  try {
    const server = Bun.serve({
      port,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/__ws") {
          const ok = server.upgrade(req);
          if (ok) return undefined as any;
          return new Response("upgrade failed", { status: 500 });
        }
        if (url.pathname === "/__close" && req.method === "POST") {
          console.log("[serve] /__close received, exiting");
          setTimeout(() => process.exit(0), 200);
          return new Response("ok");
        }
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === "/") pathname = "/results/history.html";
        // prevent traversal
        const filePath = normalize(join(SKILL_DIR, pathname.replace(/^\//, "")));
        if (!filePath.startsWith(SKILL_DIR)) {
          return new Response("forbidden", { status: 403 });
        }
        const f = Bun.file(filePath);
        // Bun.file exists check is async via exists(), but we can just return Response and let Bun handle 404?
        // To give 404 quickly, check existence
        return f.exists().then((ok) => {
          if (!ok) return new Response("not found: " + pathname, { status: 404 });
          return new Response(f, { headers: { "content-type": mimeFor(filePath), "cache-control": "no-store" } });
        }) as any;
      },
      websocket: {
        open(ws) {
          clients.add(ws);
          if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
          console.log(`[serve] ws open clients=${clients.size}`);
        },
        close(ws) {
          clients.delete(ws);
          console.log(`[serve] ws close clients=${clients.size}`);
          scheduleExitIfIdle();
        },
        message(ws, msg) {
          // heartbeat
          if (msg === "ping") ws.send("pong");
        },
      },
    });
    console.log(`[serve] serving ${SKILL_DIR} at http://localhost:${port}/results/history.html`);
    return { server, port };
  } catch (e: any) {
    const msg = String(e?.message || e).toLowerCase();
    if (msg.includes("eaddrinuse") || msg.includes("in use") || msg.includes("already") || msg.includes("address already")) {
      return null;
    }
    throw e;
  }
}

let chosen: { server: any; port: number } | null = null;
for (let p = 8000; p <= 8010; p++) {
  chosen = await tryServe(p);
  if (chosen) break;
  console.log(`[serve] port ${p} in use, trying ${p + 1}`);
}
if (!chosen) {
  console.error("[serve] no available port 8000-8010");
  process.exit(1);
}

const url = `http://localhost:${chosen.port}/results/history.html`;
console.log(`[serve] opening ${url}`);

// open browser (macOS)
try {
  // use Bun.spawn to not block
  const proc = Bun.spawn(["open", url], { stdout: "inherit", stderr: "inherit" });
  // don't await
} catch (e) {
  console.log(`[serve] please open manually: ${url}`);
  console.error(e);
}

console.log(`[serve] running (Ctrl+C to stop, or close browser tab to auto-exit)`);

// keep process alive
process.on("SIGINT", () => {
  console.log("\n[serve] interrupted, exiting");
  process.exit(0);
});
