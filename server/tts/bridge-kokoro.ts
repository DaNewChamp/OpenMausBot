// Optional operator-pinned access to an existing Kokoro container over the
// authenticated fleet job channel. No listener, tunnel, new bridge grant or
// arbitrary endpoint is exposed. The paired API can only request voices/audio.
import type { BridgeJobResult, BridgeRegistry } from "../bridge-registry.ts";
import { waitForBridgeJobResult } from "../bridge-job-wait.ts";

const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const VOICE = /^[a-z]{2}_[a-z0-9]+(?:_[a-z0-9]+)*$/i;
const ROOT = "http://127.0.0.1:8880/v1";
const MAX_BYTES = 700_000; // Base64 envelope remains below the bridge's 1 MiB cap.
export type KokoroBridgeSettings = { bridgeId: string; container: string; dockerCli: "docker" | "docker.exe" };
type Operation = { operation: "voices" } | { operation: "speech"; text: string; voice: string };
type Execute = (command: string, signal?: AbortSignal) => Promise<Pick<BridgeJobResult, "exitCode" | "stdout" | "stderr" | "truncated">>;

export function kokoroBridgeSettings(env: Record<string, string | undefined> = process.env): KokoroBridgeSettings | null {
  const bridgeId = env.OMB_KOKORO_BRIDGE_ID?.trim();
  const container = env.OMB_KOKORO_CONTAINER?.trim() || "kokoro-tts";
  const dockerCli = env.OMB_KOKORO_DOCKER_CLI?.trim() || "docker";
  if (dockerCli !== "docker" && dockerCli !== "docker.exe") return null;
  if (!bridgeId || !/^[\w-]{1,100}$/.test(bridgeId) || !CONTAINER.test(container)) return null;
  return { bridgeId, container, dockerCli };
}

export function buildKokoroBridgeCommand(container: string, op: Operation, dockerCli: "docker" | "docker.exe" = "docker"): string {
  if (dockerCli !== "docker" && dockerCli !== "docker.exe") throw new Error("Invalid operator Docker executable.");
  if (!CONTAINER.test(container)) throw new Error("Invalid operator speech container.");
  if (op.operation !== "voices" && (op.operation !== "speech" || !op.text.trim() || op.text.length > 500 || op.voice.length > 80 || !VOICE.test(op.voice))) {
    throw new Error("Invalid speech request.");
  }
  // User text is encoded data, never interpolated into shell/Python syntax.
  const payload = Buffer.from(JSON.stringify(op)).toString("base64");
  const program = `import base64,json,urllib.request,urllib.error\nclass NoRedirect(urllib.request.HTTPRedirectHandler):\n def redirect_request(self,*args,**kwargs): return None\np=json.loads(base64.b64decode('${payload}'))\npath='/v1/audio/voices' if p['operation']=='voices' else '/v1/audio/speech'\ndata=None if p['operation']=='voices' else json.dumps({'model':'kokoro','input':p['text'],'voice':p['voice'],'response_format':'mp3','stream':False}).encode()\nreq=urllib.request.Request('http://127.0.0.1:8880'+path,data=data,headers={'Content-Type':'application/json'})\ntry:\n with urllib.request.build_opener(NoRedirect).open(req,timeout=25) as r:\n  body=r.read(${MAX_BYTES + 1})\n  if len(body)>${MAX_BYTES}: raise ValueError('response too large')\n  print(json.dumps({'status':r.status,'mime':r.headers.get('Content-Type',''),'body':base64.b64encode(body).decode()}))\nexcept Exception:\n print(json.dumps({'status':502,'mime':'application/json','body':base64.b64encode(b'{"error":"Kokoro container request failed"}').decode()}))\n`;
  const encoded = Buffer.from(program).toString("base64");
  return `${dockerCli} exec ${container} python -c "exec(__import__('base64').b64decode('${encoded}'))"`;
}

export function createKokoroBridgeFetch(execute: Execute, container = "kokoro-tts", dockerCli: "docker" | "docker.exe" = "docker"): typeof fetch {
  let catalog: { bytes: Buffer; mime: string; expiresAt: number } | undefined;
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method?.toUpperCase() ?? "GET";
    if (url.origin !== "http://127.0.0.1:8880" || url.username || url.password || url.search || url.hash) {
      throw new Error("Bridge speech accepts only the fixed container API.");
    }
    const headers = new Headers(init?.headers);
    for (const [name] of headers) {
      if (name !== "accept" && name !== "content-type") throw new Error("Unsupported speech header.");
    }
    let op: Operation;
    if (method === "GET" && url.pathname === "/v1/audio/voices" && init?.body == null) {
      op = { operation: "voices" };
    } else if (method === "POST" && url.pathname === "/v1/audio/speech" && typeof init?.body === "string" && init.body.length <= 8_000) {
      const body: unknown = JSON.parse(init.body);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid speech payload.");
      const p = body as Record<string, unknown>;
      if (Object.keys(p).some((key) => !["model", "input", "voice", "response_format", "stream"].includes(key))
        || p.model !== "kokoro" || p.response_format !== "mp3" || p.stream !== false
        || typeof p.input !== "string" || typeof p.voice !== "string") throw new Error("Invalid speech payload.");
      op = { operation: "speech", text: p.input, voice: p.voice };
    } else {
      throw new Error("Unsupported bridge speech operation.");
    }
    init?.signal?.throwIfAborted();
    if (op.operation === "voices" && catalog && catalog.expiresAt > Date.now()) {
      return new Response(catalog.bytes, { status: 200, headers: { "content-type": catalog.mime } });
    }
    const result = await execute(buildKokoroBridgeCommand(container, op, dockerCli), init?.signal ?? undefined);
    init?.signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.truncated || result.stdout.length > 960_000) throw new Error("The speech bridge could not complete this request.");
    let envelope: { status?: unknown; mime?: unknown; body?: unknown };
    try { envelope = JSON.parse(result.stdout); } catch { throw new Error("The speech bridge returned an invalid result."); }
    if (!envelope || typeof envelope !== "object" || typeof envelope.status !== "number"
      || !Number.isInteger(envelope.status) || envelope.status < 200 || envelope.status > 599
      || typeof envelope.mime !== "string" || envelope.mime.length > 120
      || /[\r\n]/.test(envelope.mime) || typeof envelope.body !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.body)) {
      throw new Error("The speech bridge returned an invalid result.");
    }
    const bytes = Buffer.from(envelope.body, "base64");
    if (bytes.length > MAX_BYTES) throw new Error("The speech bridge returned too much audio.");
    if (op.operation === "voices" && envelope.status === 200) {
      catalog = { bytes, mime: envelope.mime, expiresAt: Date.now() + 30_000 };
    }
    return new Response(bytes, { status: envelope.status, headers: { "content-type": envelope.mime } });
  };
}

const transports = new WeakMap<BridgeRegistry, {
  key: string; options: { baseUrl: string; fetch: typeof fetch };
}>();

export function kokoroBridgeOptions(registry: BridgeRegistry): { baseUrl: string; fetch: typeof fetch } | undefined {
  const settings = kokoroBridgeSettings();
  if (!settings) return undefined;
  const key = JSON.stringify(settings);
  const existing = transports.get(registry);
  if (existing?.key === key) return existing.options;
  const options = {
    baseUrl: ROOT,
    fetch: createKokoroBridgeFetch(async (command, signal) => {
      const bridge = registry.list().find((row) => row.id === settings.bridgeId);
      if (!bridge?.online || !bridge.capabilities.includes("shell")) {
        throw new Error("The selected speech bridge is offline or unavailable.");
      }
      signal?.throwIfAborted();
      // enqueueShell rechecks the bridge's locally granted shell capability.
      const job = registry.enqueueShell(bridge.id, command, undefined, 30_000, { maxAttempts: 1 });
      let finished = false;
      try {
        const result = await waitForBridgeJobResult(registry, job.id, 30_000, "speech bridge", signal);
        finished = true;
        return result;
      } finally {
        if (!finished || signal?.aborted) registry.cancelJob(job.id);
      }
    }, settings.container, settings.dockerCli),
  };
  transports.set(registry, { key, options });
  return options;
}
