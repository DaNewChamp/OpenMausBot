// Lightweight Local VM: headless Chromium + git/CLI. Not the Cua XFCE desktop.
// The BYO-VPS path keeps the Cua image; fleet Local VM uses this one.

export const BROWSER_VM_REPOSITORY = "localhost/openmausbot/browser-vm";
export const BROWSER_VM_LAYER_VERSION = "1";
export const BROWSER_VM_LAYER_LABEL = "com.openmausbot.image-layer";
export const BROWSER_VM_KIND_LABEL = "com.openmausbot.computer-kind";
export const BROWSER_VM_KIND = "browser";
export const BROWSER_VM_IMAGE = `${BROWSER_VM_REPOSITORY}:v${BROWSER_VM_LAYER_VERSION}`;
export const BROWSER_CDP_HELPER = "/opt/ogb/openmausbot-cdp.mjs";
export const BROWSER_CDP_PORT = 9222;
export const BROWSER_VM_MEMORY_BYTES = 1 * 1024 * 1024 * 1024;
export const BROWSER_VM_NANO_CPUS = 1_000_000_000;
export const BROWSER_VM_PIDS_LIMIT = 256;
export const BROWSER_VM_SHM_BYTES = 256 * 1024 * 1024;
export const BROWSER_VM_MEMORY = "1g";
export const BROWSER_VM_CPUS = "1";
export const BROWSER_VM_SHM = "256m";

const NODE_VERSION = "22.14.0";
const NODE_TARBALLS = {
  x64: {
    file: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
    sha256: "69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec",
  },
  arm64: {
    file: `node-v${NODE_VERSION}-linux-arm64.tar.xz`,
    sha256: "08bfbf538bad0e8cbb0269f0173cca28d705874a67a22f60b57d99dc99e30050",
  },
} as const;

/** In-container CDP helper. Node 22 (global fetch + WebSocket). */
export const BROWSER_CDP_HELPER_SOURCE = String.raw`import { writeFile } from "node:fs/promises";

const [action, encoded = ""] = process.argv.slice(2);
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8") || "{}");
const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!page) throw new Error("no debuggable browser page");
if (input.url && page.url !== input.url) throw new Error("page changed; take a new browser snapshot");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result ?? {});
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const refId = (value) => {
  const match = /^b(\d+)$/.exec(String(value ?? ""));
  if (!match) throw new Error("invalid or stale browser ref; take a new snapshot");
  return Number(match[1]);
};
const clickAt = async (x, y, button = "left", clickCount = 1) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
};
if (action === "snapshot") {
  await send("Accessibility.enable");
  const { nodes = [] } = await send("Accessibility.getFullAXTree", { depth: 14 });
  const useful = new Set(["button", "checkbox", "combobox", "heading", "link", "menuitem", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
  const elements = [];
  for (const node of nodes) {
    const role = String(node.role?.value ?? "").toLowerCase();
    const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    const backend = Number(node.backendDOMNodeId ?? 0);
    if (!backend || !useful.has(role) || (!name && role !== "textbox" && role !== "searchbox")) continue;
    const disabled = node.properties?.some((property) => property.name === "disabled" && property.value?.value === true) ?? false;
    elements.push({ ref: "b" + backend, role, name: name || "unnamed", disabled });
    if (elements.length >= 250) break;
  }
  process.stdout.write(JSON.stringify({ title: String(page.title ?? "").slice(0, 200), url: page.url, elements }));
} else if (action === "click") {
  const backendNodeId = refId(input.ref);
  const { model } = await send("DOM.getBoxModel", { backendNodeId });
  const quad = model?.border ?? model?.content;
  if (!Array.isArray(quad) || quad.length < 8) throw new Error("element is not visible; take a new snapshot");
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await clickAt(x, y);
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else if (action === "fill") {
  const backendNodeId = refId(input.ref);
  await send("DOM.focus", { backendNodeId });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  await send("Input.insertText", { text: String(input.text ?? "") });
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else if (action === "screenshot") {
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
  const file = "/tmp/openmausbot-preview.jpg";
  await writeFile(file, Buffer.from(data, "base64"));
  process.stdout.write(JSON.stringify({ ok: true, path: file }));
} else if (action === "navigate") {
  const url = String(input.url ?? "");
  if (!/^https?:\/\//i.test(url)) throw new Error("navigate needs an http(s) URL");
  await send("Page.enable");
  await send("Page.navigate", { url });
  process.stdout.write(JSON.stringify({ ok: true, url }));
} else if (action === "mouse") {
  const x = Number(input.x);
  const y = Number(input.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("mouse needs numeric x,y");
  const button = input.button === "right" ? "right" : input.button === "middle" ? "middle" : "left";
  const clickCount = input.double === true ? 2 : 1;
  await clickAt(Math.round(x), Math.round(y), button, clickCount);
  process.stdout.write(JSON.stringify({ ok: true }));
} else if (action === "scroll") {
  const x = Number(input.x) || 640;
  const y = Number(input.y) || 360;
  const clicks = Math.min(Math.max(Number(input.clicks) || 3, 1), 20);
  const deltaY = (input.direction === "up" ? -120 : 120) * clicks;
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  process.stdout.write(JSON.stringify({ ok: true }));
} else if (action === "type") {
  await send("Input.insertText", { text: String(input.text ?? "") });
  process.stdout.write(JSON.stringify({ ok: true }));
} else if (action === "key") {
  const raw = String(input.keys ?? "").trim();
  if (!raw) throw new Error("key needs keys");
  const chord = raw.replace(/^Return$/i, "Enter").replace(/^Esc$/i, "Escape");
  const parts = chord.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts[parts.length - 1] || "Enter";
  let modifiers = 0;
  if (parts.some((part) => /^(ctrl|control)$/i.test(part))) modifiers |= 2;
  if (parts.some((part) => /^alt$/i.test(part))) modifiers |= 1;
  if (parts.some((part) => /^(meta|cmd|command)$/i.test(part))) modifiers |= 4;
  if (parts.some((part) => /^shift$/i.test(part))) modifiers |= 8;
  const code = key.length === 1 ? "Key" + key.toUpperCase() : key;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
  process.stdout.write(JSON.stringify({ ok: true }));
} else {
  throw new Error("unknown browser action");
}
socket.close();
`;

export function browserVmImageLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return (
    labels?.["com.openmausbot.local-vm"] === "1" &&
    labels?.[BROWSER_VM_KIND_LABEL] === BROWSER_VM_KIND &&
    labels?.[BROWSER_VM_LAYER_LABEL] === BROWSER_VM_LAYER_VERSION
  );
}

export function browserVmDockerfile(): string {
  const helperB64 = Buffer.from(BROWSER_CDP_HELPER_SOURCE, "utf8").toString("base64");
  return `FROM debian:bookworm-slim
USER root
RUN set -eux; \\
    apt-get update; \\
    apt-get install -y --no-install-recommends ca-certificates curl git chromium fonts-liberation fonts-unifont xz-utils; \\
    arch="$(uname -m)"; \\
    case "$arch" in \\
      x86_64) node_file='${NODE_TARBALLS.x64.file}'; node_sha='${NODE_TARBALLS.x64.sha256}' ;; \\
      aarch64|arm64) node_file='${NODE_TARBALLS.arm64.file}'; node_sha='${NODE_TARBALLS.arm64.sha256}' ;; \\
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \\
    esac; \\
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/$node_file" -o /tmp/node.tar.xz; \\
    echo "$node_sha  /tmp/node.tar.xz" | sha256sum -c -; \\
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \\
    rm -f /tmp/node.tar.xz; \\
    command -v node; \\
    command -v chromium; \\
    command -v git; \\
    node -e 'if (typeof WebSocket !== "function") process.exit(1)'; \\
    apt-get clean; \\
    rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 --shell /bin/bash cua \\
    && install -d -o cua -g cua -m 0700 /home/cua/workspace /opt/ogb
RUN printf '%s' '${helperB64}' | base64 -d > ${BROWSER_CDP_HELPER} \\
    && chmod 0755 ${BROWSER_CDP_HELPER}
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      'set -eu' \\
      'workspace=/home/cua/workspace' \\
      'profile="$workspace/.chrome"' \\
      'mkdir -p "$profile" "$workspace"' \\
      'chmod 0700 "$workspace" "$profile" 2>/dev/null || true' \\
      'exec chromium \\' \\
      '  --headless=new \\' \\
      '  --no-sandbox \\' \\
      '  --disable-gpu \\' \\
      '  --disable-dev-shm-usage \\' \\
      '  --disable-session-crashed-bubble \\' \\
      '  --no-first-run \\' \\
      '  --password-store=basic \\' \\
      '  --remote-debugging-address=127.0.0.1 \\' \\
      '  --remote-debugging-port=9222 \\' \\
      '  --user-data-dir="$profile" \\' \\
      '  --window-size=1280,800 \\' \\
      '  about:blank' \\
      > /usr/local/bin/start-openmausbot-browser.sh \\
    && chmod 0755 /usr/local/bin/start-openmausbot-browser.sh
USER cua
ENV HOME=/home/cua
WORKDIR /home/cua/workspace
EXPOSE 9222
LABEL com.openmausbot.local-vm="1" \\
      ${BROWSER_VM_KIND_LABEL}="${BROWSER_VM_KIND}" \\
      ${BROWSER_VM_LAYER_LABEL}="${BROWSER_VM_LAYER_VERSION}"
ENTRYPOINT ["/usr/local/bin/start-openmausbot-browser.sh"]
`;
}

export function encodeBrowserCdpInput(input: unknown): string {
  return Buffer.from(JSON.stringify(input ?? {})).toString("base64url");
}

export function browserCdpExecArgs(
  action: string,
  input: unknown,
  options: { container: string },
): string[] {
  return [
    "exec",
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    options.container,
    "node",
    BROWSER_CDP_HELPER,
    action,
    encodeBrowserCdpInput(input),
  ];
}
