// Drives headless Chrome over CDP against a live Beacon Relay server.
// Manual-evidence helper (not part of CI): drives local Google Chrome over CDP.
// Usage (macOS): node submission/tools/browser-e2e.mjs . /tmp/beacon-shots
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const [repo, out] = process.argv.slice(2).map(path => resolve(path ?? '.'));
mkdirSync(out, { recursive: true });
const WebSocket = createRequire(join(repo, 'package.json'))('ws');
const PORT = 4471, GRPC = 4472;
const dataDir = mkdtempSync(join(tmpdir(), 'beacon-e2e-'));
const base = `http://127.0.0.1:${PORT}`;
let server;
async function startServer() {
  server = spawn(process.execPath, ['submission/start.mjs'], {
    cwd: repo, env: { ...process.env, PORT: String(PORT), GRPC_PORT: String(GRPC), DATA_DIR: dataDir }, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch {} await delay(50); }
  throw new Error('server did not start');
}
const killServer = async () => { server.kill('SIGKILL'); await new Promise(r => server.once('exit', r)); };
const events = async () => (await (await fetch(base + '/events?after=0')).json()).events;

await startServer();
const profile = mkdtempSync(join(tmpdir(), 'beacon-chrome-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
], { stdio: 'ignore' });
let version;
for (let i = 0; i < 400 && !version; i++) { try { version = await (await fetch('http://127.0.0.1:9333/json/version')).json(); } catch { await delay(100); } }
const target = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const cdp = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise(r => cdp.once('open', r));
let id = 0; const pending = new Map(); const errors = []; let posts = 0;
cdp.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST') posts++;
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id; pending.set(n, m => m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result));
  cdp.send(JSON.stringify({ id: n, method, params }));
});
const js = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const shot = async name => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, name + '.png'), Buffer.from(data, 'base64'));
};
const viewport = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
const load = async () => { await send('Page.navigate', { url: base + '/' }); await delay(700); };
const text = sel => js(`document.querySelector(${JSON.stringify(sel)}).textContent`);
const key = async (key, code = key, text) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text, windowsVirtualKeyCode: { Tab: 9, Enter: 13, ArrowRight: 39 }[key] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: { Tab: 9, Enter: 13, ArrowRight: 39 }[key] });
};
const waitText = async (sel, re, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const t = await text(sel); if (re.test(t)) return t; await delay(50); }
  throw new Error(`timeout waiting for ${sel} ~ ${re}; got "${await text(sel)}"`);
};
const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
try {
  // 1. Desktop play with screenshots of each phase.
  await viewport(1280, 720);
  await load();
  check('connection status shows Live', /Live/.test(await text('#connection')));
  const centres = await js(`['.orbit', '.orbit-ticks', '.core'].map(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })`);
  check('orbit, inner ring and core share one centre', centres.every(([x, y]) => Math.abs(x - centres[0][0]) <= 1 && Math.abs(y - centres[0][1]) <= 1), JSON.stringify(centres));
  await js(`document.activeElement?.blur()`);
  await key('3');
  await key('Enter', 'Enter', '\r');
  const keyPlay = await waitText('#result', /Match|Miss/);
  check('page-wide keys with nothing focused: "3" then Enter plays Violet', /You chose Violet/.test(keyPlay), keyPlay);
  await key('n');
  await shot('01-desktop-idle');
  await js(`document.querySelector('[data-choice="1"]').click()`);
  await js(`document.querySelector('#play').click()`);
  await delay(250); await shot('02-desktop-charge');
  await delay(700); await shot('03-desktop-travel');
  const t0 = Date.now();
  const result = await waitText('#result', /Match|Miss/);
  check('desktop round reveals server result', true, `${result} (${Date.now() - t0 + 950}ms after Play)`);
  await shot('04-desktop-result');
  const [acc, comp] = (await events()).slice(-2);
  const expect = ['Azure', 'Amber', 'Violet'][comp.round.target];
  check('revealed target matches server', result.includes(`landed on ${expect}`), `server target=${comp.round.target}`);
  check('score equals server score', Number(await text('#score')) === comp.round.score);

  // 2. Replay: no POST, no score change, same result.
  const postsBefore = posts, scoreBefore = await text('#score'), evBefore = (await events()).length;
  await js(`document.querySelector('#replay').click()`);
  await delay(300); await shot('05-replay-mid');
  const replayText = await waitText('#result', /Replay — .*(Match|Miss)/);
  check('replay sends no request and keeps score', posts === postsBefore && await text('#score') === scoreBefore && (await events()).length === evBefore, replayText);

  // 3. Rapid clicks: one round only.
  await js(`document.querySelector('#new').click()`);
  const evRapid = (await events()).length;
  await js(`for (let i = 0; i < 8; i++) document.querySelector('#play').click()`);
  await waitText('#result', /Match|Miss/);
  check('8 rapid Play clicks create one round', (await events()).length - evRapid === 2, `${(await events()).length - evRapid} new events`);

  // 4. Refresh during a round.
  await js(`document.querySelector('#new').click()`);
  const evRefresh = (await events()).length;
  await js(`document.querySelector('#play').click()`);
  await delay(400);
  const roundBefore = await js(`JSON.parse(localStorage.getItem('beacon-relay/v1')).round?.roundId`);
  await load();
  await waitText('#result', /Match|Miss/);
  const roundAfter = await js(`JSON.parse(localStorage.getItem('beacon-relay/v1')).round?.roundId`);
  check('refresh mid-round resumes the same round', roundBefore && roundBefore === roundAfter && (await events()).length - evRefresh === 2);
  const scoreAfterRefresh = Number(await text('#score'));
  await load(); // reload a revealed round: static result, same score
  check('reload after reveal keeps result and score', /Match|Miss/.test(await text('#result')) && Number(await text('#score')) === scoreAfterRefresh);

  // 5. Connection loss during animation (server killed and restarted).
  await js(`document.querySelector('#new').click()`);
  await js(`document.querySelector('#play').click()`);
  await delay(200);
  await killServer();
  await delay(1500);
  const offlineNote = await text('#stage-note'), conn = await text('#connection');
  await shot('06-connection-lost');
  check('connection loss shown honestly, no invented result', !/Match|Miss/.test(await text('#result')), `note="${offlineNote}" conn="${conn}"`);
  await startServer();
  const recovered = await waitText('#result', /Match|Miss/, 20000);
  check('round reconciles and reveals after server restart', true, recovered);
  const all = await events();
  const scoreServer = all.filter(e => e.type === 'round.completed').reduce((n, e) => n + e.round.score, 0);
  check('UI score equals server total after all of the above', Number(await text('#score')) === scoreServer, `ui=${await text('#score')} server=${scoreServer}`);

  // 5b. Reload never shows an unpositioned/default frame: the loader covers it.
  await send('Page.navigate', { url: base + '/' });
  const samples = [];
  for (let i = 0; i < 60; i++) {
    try {
      samples.push(await js(`(() => { const b = document.body; if (!b || !document.querySelector('.beacon')) return null;
        const s = document.querySelector('#stage').getBoundingClientRect(), r = document.querySelector('.beacon[data-choice="1"]').getBoundingClientRect();
        return { loading: b.classList.contains('loading'), dx: Math.round(r.left - s.left), score: document.querySelector('#score').textContent }; })()`));
    } catch { samples.push(null); }
    await delay(25);
  }
  const shown = samples.filter(x => x && !x.loading);
  check('reload: loader shown first, then hidden', samples.some(x => x?.loading) && shown.length > 0, `${samples.filter(x => x?.loading).length} loading samples`);
  check('reload: no visible frame with unpositioned beacons', shown.every(x => x.dx > 40), JSON.stringify(shown.slice(0, 3)));

  // 6. Keyboard-only play.
  await js(`document.querySelector('#new').click(); document.activeElement?.blur()`);
  const evKey = (await events()).length;
  await js(`document.querySelector('.beacon[tabindex="0"]').focus()`);
  await key('ArrowRight');
  const selected = await js(`document.activeElement.dataset.choice`);
  await key('Tab'); // → Play
  const onPlay = await js(`document.activeElement.id`);
  await key('Enter', 'Enter', '\r');
  await waitText('#result', /Match|Miss/);
  const last = (await events()).at(-1);
  check('keyboard-only selection and play', onPlay === 'play' && (await events()).length - evKey === 2 && String(last.round.choice) === selected, `choice=${last.round.choice} focus=${onPlay}`);
  await shot('07-keyboard-focus');

  // 7. Reduced motion.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await load();
  await js(`document.querySelector('#new').click()`);
  await js(`document.querySelector('#play').click()`);
  const tr = Date.now();
  await waitText('#result', /Match|Miss/);
  check('reduced motion completes with server result', true, `${Date.now() - tr}ms incl. ${1200}ms backend delay`);
  await send('Emulation.setEmulatedMedia', { features: [] });

  // 8. Pause/Skip.
  await js(`document.querySelector('#new').click()`);
  await js(`document.querySelector('#play').click()`);
  await delay(300);
  await js(`document.querySelector('#pause').click()`);
  const pausedLabel = await text('#pause');
  await delay(2000);
  check('pause holds presentation while server completes', pausedLabel === 'Resume' && !/Match|Miss/.test(await text('#result')) && (await events()).at(-1).type === 'round.completed');
  await shot('08-paused');
  await js(`document.querySelector('#skip').click()`);
  await delay(150);
  check('skip reveals immediately', /Match|Miss/.test(await text('#result')));

  // 9. Mobile.
  await viewport(390, 844, true);
  await load();
  await js(`document.querySelector('#new').click()`);
  const fits = await js(`(() => { const s = document.querySelector('#stage').getBoundingClientRect(); return [...document.querySelectorAll('.beacon')].every(b => { const r = b.getBoundingClientRect(); return r.left >= s.left && r.right <= s.right; }) && document.documentElement.scrollWidth <= innerWidth; })()`);
  check('mobile 390×844: beacons inside stage, no horizontal scroll', fits);
  await shot('09-mobile-idle');
  await js(`document.querySelector('[data-choice="2"]').click(); document.querySelector('#play').click()`);
  await delay(900); await shot('10-mobile-travel');
  await waitText('#result', /Match|Miss/); await shot('11-mobile-result');

  check('no console errors / exceptions', errors.length === 0, errors.join(' | '));
} catch (error) {
  results.push('ERROR ' + error.stack);
} finally {
  console.log(`Chrome ${version?.Browser}`);
  console.log(results.join('\n'));
  cdp.close(); chrome.kill(); server.kill('SIGKILL');
}
