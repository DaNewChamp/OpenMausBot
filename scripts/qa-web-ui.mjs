import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Build first, then run with Node 24+. The frozen demo is not production proof.
// This disposable browser is never paired to a real hub. Mutations are rejected.
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const output = mkdtempSync(join(tmpdir(), 'vbot-ui-qa-artifacts-'));
const chromePath = process.env.VBOT_QA_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
assert.ok(chromePath, 'Set VBOT_QA_CHROME to a Chromium executable.');
const profile = mkdtempSync(join(tmpdir(), 'vbot-ui-qa-'));
const status = { platform: 'linux', runtime: 'docker', available: ['docker'], daemonUp: true, image: true, imageMatches: true, managed: true, container: 'running', network: 'loopback', security: 'hardened', persistence: 'durable', desktopReady: true, ready: true, problem: null, image_ref: 'fixture/browser:v1', workspace_path: '/fixture/workspace', workspace_guest_path: '/home/cua/workspace', mode: 'per-bot', max_instances: 3, commands: {} };
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') { res.writeHead(405); res.end('{"error":"Visual fixture never mutates"}'); return; }
    const data = pathname === '/api/bridges' ? { bridges: [{ id: 'fixture-host', name: 'Windows fixture', online: true, capabilities: ['local-vm', 'shell'] }] } : pathname.includes('local-computer') ? status : { devices: [], available: false };
    res.end(JSON.stringify(data)); return;
  }
  let file = resolve(dist, '.' + pathname);
  if (!file.startsWith(dist + '/') || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[extname(file)] ?? 'application/octet-stream';
  res.setHeader('Content-Type', mime); res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('Chrome debug endpoint timeout')), 15000);
    chrome.stderr.on('data', b => { log += b; const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.on('error', reject);
  });
  const debug = new URL(endpoint);
  const pages = await (await fetch(`http://${debug.host}/json/list`)).json();
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r,j) => { socket.addEventListener('open',r,{once:true}); socket.addEventListener('error',j,{once:true}); });
  let seq = 0; const pending = new Map(); const errors = [];
  socket.addEventListener('message', ({data}) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) { const {r,j,t} = pending.get(msg.id); clearTimeout(t); pending.delete(msg.id); msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
  });
  const call = (method, params = {}) => new Promise((r,j) => { const id = ++seq; const t = setTimeout(() => {pending.delete(id);j(new Error(method+' timeout'));},15000); pending.set(id,{r,j,t}); socket.send(JSON.stringify({id,method,params})); });
  const js = async expression => { const out = await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); if(out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails)); return out.result.value; };
  const wait = async expression => { for(let i=0;i<80;i++){ if(await js(expression)) return; await new Promise(r=>setTimeout(r,100)); } throw new Error('Timed out: '+expression); };
  const shot = async name => { const {data} = await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); const file=join(output,name+".png"); writeFileSync(file,Buffer.from(data,'base64')); return file; };
  await call('Page.enable'); await call('Runtime.enable');
  const reports = [];
  for (const [width,height] of [[1440,900],[1024,768],[768,1024],[390,844],[320,740]]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:origin+'/?client=web&vbotDemo=1'});
    await wait("Boolean(document.querySelector('textarea'))");
    await js('document.fonts.ready.then(()=>true)');
    await new Promise(r=>setTimeout(r,300));
    const bounds = await js('({width:innerWidth,body:document.body.scrollWidth,root:document.documentElement.scrollWidth,chat:document.querySelector("textarea")?.getBoundingClientRect().width})');
    assert.ok(bounds.root <= width+1 && bounds.body <= width+1, 'Horizontal overflow '+JSON.stringify(bounds));
    const bubble = await js(`(()=>{const e=[...document.querySelectorAll('.shell-bubble')].find(e=>e.textContent.includes('On it.'));const trail=[];for(let n=e;n&&trail.length<7;n=n.parentElement){const c=getComputedStyle(n);trail.push({class:n.className,width:n.getBoundingClientRect().width,flex:c.flex,minWidth:c.minWidth,maxWidth:c.maxWidth,display:c.display})}return {width:e?.getBoundingClientRect().width,trail}})()`);
    if(width===390) console.log('PHONE_BUBBLE',JSON.stringify(bubble));
    assert.ok(bubble.width >= Math.min(240,width-60), 'Long message collapsed: '+JSON.stringify(bubble));
    const screenshot = await shot('vbot-ui-qa-'+width+'-0904');
    let target = null;
    if (width === 1440) {
      const clicked = await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Manage in Settings');if(b)b.click();return !!b})()`);
      assert.ok(clicked,'Settings entrypoint missing');
      await wait('Boolean(document.querySelector(\'select[aria-label="Bot workspace"]\'))');
      target = await js('document.querySelector(\'select[aria-label="Bot workspace"]\').value');
      assert.equal(target, 'bot-chief');
      const selected = await js(`(()=>{const s=document.querySelector('select[aria-label="Bot workspace"]');s.value='bot-risk';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
      assert.ok(selected);
      await wait('document.querySelector(\'select[aria-label="Bot workspace"]\')?.value === "bot-risk"');
      await shot('vbot-ui-settings-0904');
    }
    reports.push({width,height,bounds,screenshot,settingsTarget:target});
  }
  assert.equal(errors.length,0,'Uncaught browser errors: '+errors.join('; '));
  console.log(JSON.stringify({ok:true,fixture:true,productionRequests:false,output,reports,uncaughtErrors:errors},null,2));
} finally {
  socket?.close(); chrome.kill('SIGTERM'); server.close();
}
