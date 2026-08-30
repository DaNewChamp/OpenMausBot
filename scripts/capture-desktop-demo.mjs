#!/usr/bin/env node
// Capture the deterministic desktop demo at 1024x648. Output is never committed.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const out = process.env.VBOT_DEMO_SCREENSHOT || "/tmp/vbot-desktop-phase1.png";
const port = Number(process.env.VBOT_DEMO_PORT || 4179);
const WIDTH = 1024;
const HEIGHT = 648;

if (!existsSync(join(dist, "index.html"))) {
  console.error("dist/index.html is missing — run `pnpm build` first");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const electronBin = require("electron");

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      let relative = decodeURIComponent(url.pathname);
      if (relative === "/" || relative === "") relative = "/index.html";
      const file = join(dist, relative.replace(/^\//, "") || "index.html");
      if (!file.startsWith(dist) || !existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const type = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".svg")
            ? "image/svg+xml"
            : file.endsWith(".html")
              ? "text/html"
              : "application/octet-stream";
      res.writeHead(200, { "content-type": type });
      createReadStream(file).pipe(res);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const dir = mkdtempSync(join(tmpdir(), "vbot-demo-capture-"));
const mainFile = join(dir, "capture-main.cjs");
writeFileSync(
  mainFile,
  `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: ${WIDTH},
    height: ${HEIGHT},
    useContentSize: true,
    show: false,
    backgroundColor: "#070707",
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  await win.loadURL("http://127.0.0.1:${port}/index.html?vbotDemo=1");
  await new Promise((resolve) => setTimeout(resolve, 2400));
  const image = await win.capturePage();
  const png = image.resize({ width: ${WIDTH}, height: ${HEIGHT} }).toPNG();
  writeFileSync(${JSON.stringify(out)}, png);
  app.exit(0);
});
app.on("window-all-closed", () => app.exit(0));
`,
);

const server = await startStaticServer();
const child = spawn(electronBin, [mainFile], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
});
child.on("exit", (code) => {
  server.close();
  process.exit(code ?? 1);
});
