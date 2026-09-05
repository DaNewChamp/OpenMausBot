// Isolated real-harness HTTP gate. Stub speech bytes, no provider account,
// production HOME, fleet, live Docker daemon, or API credential is accessed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeLocalVmDockerRuntime } from '../server/testing/fake-local-vm-docker.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'vbot-voice-http-'));
const bin = join(home, 'fakebin');
const { dockerLog } = installFakeLocalVmDockerRuntime(bin, home);
mkdirSync(join(home, '.openmausbot'), { recursive: true });
const config = join(home, '.openmausbot/config.json');
writeFileSync(config, JSON.stringify({ tts: { key: 'FIXTURE_SECRET_MUST_STAY_LOCAL', voice: 'old-voice' } }));
mkdirSync(join(home, 'static'), { recursive: true });
writeFileSync(join(home, 'static/index.html'), '<!doctype html><title>Voice fixture</title>');
let requests = 0;
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);
const speech = createServer((req, res) => {
  requests++;
  if (req.url === '/v1/audio/voices') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ voices: [{ id: 'af_heart', name: 'Heart' }] }));
  } else if (req.url === '/v1/audio/speech' && req.method === 'POST') {
    res.setHeader('content-type', 'audio/mpeg'); res.end(mp3);
  } else { res.writeHead(404); res.end(); }
});
await new Promise(r => speech.listen(0, '127.0.0.1', r));
const reserve = createServer();
await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port;
await new Promise(r => reserve.close(r));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [join(root, 'server/index.ts')], {
  cwd: root,
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_PORT: String(port),
    OMB_STATIC_DIR: join(home, 'static'), OMB_EXTRA_PATH: bin, FAKE_DOCKER_DIR: bin,
    FAKE_DOCKER_LOG: dockerLog, OMB_KOKORO_BASE_URL: `http://127.0.0.1:${speech.address().port}/v1` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let errors = '';
child.stdout.on('data', () => {});
child.stderr.on('data', b => { errors = (errors + b).slice(-6000); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(12000) });
const patch = (body, path = '/api/config/voice', type = 'application/json') => api(path, {
  method: 'PATCH', headers: { 'content-type': type }, body: JSON.stringify(body),
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null) throw new Error(`Fixture harness exited: ${errors}`);
    try { ready = (await api('/api/health')).ok; } catch {}
    if (ready) break;
    await sleep(100);
  }
  assert.ok(ready, 'Fixture harness readiness timeout');
  const before = readFileSync(config, 'utf8');
  for (const body of [{ key: 'NO_PAIRED_KEY_WRITER' }, { provider: 'kokoro', baseUrl: 'http://untrusted.invalid' }, { provider: 'invalid' }]) {
    assert.equal((await patch(body)).status, 400);
    assert.equal(readFileSync(config, 'utf8'), before, 'A refused patch must not write partial config');
  }
  assert.equal((await patch({ provider: 'kokoro' }, '/api/config/voice?url=untrusted')).status, 400);
  assert.equal((await patch({ provider: 'kokoro' }, '/api/config/voice', 'text/plain')).status, 415);
  assert.equal((await patch({ provider: 'kokoro' }, '/api/config/voice', 'application/jsonp')).status, 415);
  const changed = await patch({ provider: 'kokoro', voice: 'af_heart' });
  assert.equal(changed.status, 200);
  const status = await changed.text();
  assert.ok(!status.includes('FIXTURE_SECRET'));
  assert.equal(JSON.parse(status).tts.ready, true);
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).tts.key, 'FIXTURE_SECRET_MUST_STAY_LOCAL');
  const catalog = await (await api('/api/tts/voices')).json();
  assert.deepEqual(catalog.voices, [{ id: 'af_heart', label: 'Heart' }]);
  const audio = await api('/api/tts/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Neutral voice test.' }) });
  assert.equal(audio.status, 200);
  assert.match(audio.headers.get('content-type'), /audio\/mpeg/);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), mp3);
  const prior = requests;
  const bad = await api('/api/tts/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Neutral test.', voiceId: 'incompatible-old-provider-id' }) });
  assert.equal(bad.status, 409);
  assert.equal(requests, prior, 'An incompatible voice must not reach any provider');
  const oversized = await api('/api/tts/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(501) }) });
  assert.equal(oversized.status, 413);
  console.log(JSON.stringify({ ok: true, realHarness: true, fixtureSpeech: true, secretPreserved: true,
    pairedKeyRejected: true, endpointInjectionRejected: true, contentTypeAndQueryRejected: true,
    voicesAndAudioPassed: true, invalidVoiceStatus: 409, oversizedStatus: 413 }));
} finally {
  if (child.exitCode === null) {
    const exited = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM'); await Promise.race([exited, sleep(4000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  }
  speech.closeAllConnections();
  await new Promise(r => speech.close(r));
  rmSync(home, { recursive: true, force: true });
}
