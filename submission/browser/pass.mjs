// Scripted browser pass behind DEMO.md: plays the ANIMATION.md checklist in a
// real browser against a real server process (spawned here so it can be
// SIGKILLed mid-round), checking every result against the server's /events.
//
//   npm ci --prefix submission/browser --ignore-scripts
//   node submission/browser/pass.mjs                      # installed Google Chrome
//   npx --prefix submission/browser playwright-core install firefox
//   BROWSER=firefox node submission/browser/pass.mjs      # Playwright Firefox
//
// Screenshots go to $BROWSER_OUT (default: a temp dir). Exit code 1 on any failure.
import { chromium, firefox } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BROWSER = process.env.BROWSER || 'chrome';
const SHOTS = process.env.BROWSER_OUT || join(tmpdir(), `beacon-browser-${BROWSER}`);
mkdirSync(SHOTS, { recursive: true });
const PORT = 4410, GRPC_PORT = 4412;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'beacon-demo-'));

let server;
async function startServer() {
  server = spawn(process.execPath, ['submission/start.mjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), GRPC_PORT: String(GRPC_PORT), DATA_DIR },
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('server did not start');
}
const killServer = () => new Promise(r => { server.once('exit', r); server.kill('SIGKILL'); });

const results = [];
const record = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} #${id} ${name} — ${detail}`);
};

async function newPage(browser, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...opts });
  const page = await context.newPage();
  const posts = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/rounds')) posts.push(JSON.parse(r.postData())); });
  page.on('pageerror', e => console.log('  pageerror:', e.message));
  await page.addInitScript(() => {
    window.__phases = [];
    const watch = () => {
      const stage = document.querySelector('.stage');
      if (!stage) return requestAnimationFrame(watch);
      new MutationObserver(() => {
        const last = window.__phases.at(-1);
        if (!last || last.phase !== stage.dataset.phase) window.__phases.push({ phase: stage.dataset.phase, t: performance.now() });
      }).observe(stage, { attributes: true, attributeFilter: ['data-phase'] });
    };
    document.addEventListener('DOMContentLoaded', watch);
  });
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
  return { context, page, posts };
}
// Let the 0.2 s control fade finish so screenshots show the settled state.
const settle = page => page.waitForTimeout(400);
const phase = page => page.evaluate(() => document.querySelector('.stage').dataset.phase);
const waitPhase = (page, p, timeout = 10000) =>
  page.waitForFunction(x => document.querySelector('.stage').dataset.phase === x, p, { timeout });
const playerOf = page => page.evaluate(() => localStorage.getItem('beaconRelay.playerId'));
async function serverView(playerId) {
  const { events } = await (await fetch(BASE + '/events?after=0&limit=100')).json();
  const mine = events.filter(e => e.round.playerId === playerId);
  const completed = mine.filter(e => e.type === 'round.completed').map(e => e.round);
  return {
    accepted: mine.filter(e => e.type === 'round.accepted').length,
    completed, score: completed.reduce((n, r) => n + r.score, 0),
  };
}
const ui = page => page.evaluate(() => ({
  score: Number(document.querySelector('#score').textContent),
  result: document.querySelector('#result').textContent,
  lit: [...document.querySelectorAll('.beacon')].findIndex(b => b.classList.contains('lit')),
  outcome: document.querySelector('.stage').dataset.result,
  connection: document.querySelector('#connection').textContent,
}));
// Layout integrity: stage not scrolled, canvas sized to the stage, all beacons inside it.
const stageIntact = page => page.evaluate(() => {
  const stage = document.querySelector('.stage');
  const sr = stage.getBoundingClientRect();
  const cr = document.querySelector('.grid-bg').getBoundingClientRect();
  const inside = [...document.querySelectorAll('.beacon')].every(b => {
    const r = b.getBoundingClientRect();
    return r.left >= sr.left - 1 && r.right <= sr.right + 1 && r.top >= sr.top - 12 && r.bottom <= sr.bottom + 1;
  });
  return stage.scrollLeft === 0 && stage.scrollTop === 0 && inside
    && Math.abs(cr.width - sr.width) < 3 && Math.abs(cr.height - sr.height) < 3;
});
const animDuration = page => page.evaluate(() => {
  const p = window.__phases;
  const a = p.findLastIndex(x => x.phase === 'animating');
  const r = p.findLastIndex(x => x.phase === 'revealed');
  return a >= 0 && r > a ? Math.round(p[r].t - p[a].t) : null;
});
// Server truth vs. what the page shows for the latest round.
async function checkReveal(page) {
  const view = await serverView(await playerOf(page));
  const last = view.completed.at(-1);
  const u = await ui(page);
  const ok = last && u.lit === last.target && u.outcome === (last.score ? 'match' : 'miss')
    && u.score === view.score && u.result.includes('You chose');
  return { ok, view, u, last };
}

await startServer();
const browser = BROWSER === 'firefox'
  ? await firefox.launch({ headless: true })
  : await chromium.launch({ channel: 'chrome', headless: true });
console.log(`Browser: ${BROWSER} ${browser.version()}`);
const FIREFOX = BROWSER === 'firefox';

// 1. Happy path desktop
{
  const { context, page } = await newPage(browser, { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await page.click('.beacon[data-choice="1"]');
  await page.screenshot({ path: join(SHOTS, '01-idle-desktop.png') });
  const t0 = Date.now();
  await page.click('#play');
  const immediate = await phase(page);
  const feedbackMs = Date.now() - t0;
  await waitPhase(page, 'animating');
  await delay(500);
  const p1 = await page.$eval('.pulse', e => e.style.transform);
  await page.screenshot({ path: join(SHOTS, '03-travel.png') });
  await delay(300);
  const p2 = await page.$eval('.pulse', e => e.style.transform);
  await waitPhase(page, 'revealed');
  await settle(page);
  await page.screenshot({ path: join(SHOTS, '05-reveal.png') });
  const dur = await animDuration(page);
  const c = await checkReveal(page);
  const intact = await stageIntact(page);
  record(1, 'Happy path 1280×720 (DPR 2)', intact && immediate === 'pending' && p1 !== p2 && c.ok && dur > 1800 && dur < 3200,
    `stage intact at DPR 2 ${intact}; pending ${feedbackMs} ms after click; pulse moving (${p1 !== p2}); presentation ${dur} ms; target ${c.last?.target}, ${c.u.outcome}, score ${c.u.score} = server ${c.view.score}`);
  await context.close();
}

// 2. Mobile
{
  const { context, page } = await newPage(browser, FIREFOX
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true }
    : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const layout = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const boxes = [...document.querySelectorAll('.beacon, .stage, .controls button')].map(e => e.getBoundingClientRect());
    return { noHScroll: document.documentElement.scrollWidth <= vw, inside: boxes.every(b => b.left >= 0 && b.right <= vw + 0.5) };
  });
  await page.tap('.beacon[data-choice="2"]');
  await page.tap('#play');
  await waitPhase(page, 'animating');
  await delay(600);
  await page.screenshot({ path: join(SHOTS, '09-mobile-travel.png') });
  await waitPhase(page, 'revealed');
  await settle(page);
  await page.screenshot({ path: join(SHOTS, '09-mobile-reveal.png') });
  const c = await checkReveal(page);
  const intact = await stageIntact(page);
  record(2, 'Mobile 390×844 (DPR 3, touch)', intact && layout.noHScroll && layout.inside && c.ok,
    `stage intact after tap ${intact}; no horizontal scroll ${layout.noHScroll}; stage/beacons/controls within viewport ${layout.inside}; reveal matches server ${c.ok}`);
  await context.close();
}

// 3. Keyboard only
{
  const { context, page } = await newPage(browser);
  let focusedChoice = null;
  for (let i = 0; i < 15 && focusedChoice !== '2'; i++) {
    await page.keyboard.press('Tab');
    focusedChoice = await page.evaluate(() => document.activeElement?.dataset?.choice ?? null);
  }
  const ring = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none';
  });
  const intactOnFocus = await stageIntact(page);
  await page.keyboard.press('Enter');
  const selected = await page.$eval('.beacon[data-choice="2"]', e => e.getAttribute('aria-pressed'));
  let onPlay = false;
  for (let i = 0; i < 10 && !onPlay; i++) {
    await page.keyboard.press('Tab');
    onPlay = await page.evaluate(() => document.activeElement?.id === 'play');
  }
  await page.keyboard.press('Enter');
  await waitPhase(page, 'revealed');
  const c = await checkReveal(page);
  record(3, 'Keyboard-only play', intactOnFocus && focusedChoice === '2' && ring && selected === 'true' && onPlay && c.ok && c.last.choice === 2,
    `stage intact with beacon focused ${intactOnFocus}; Tab reached beacon 03 (${focusedChoice === '2'}), visible focus indicator ${ring}, Enter selected it (${selected}), Tab→Play→Enter played a round with choice ${c.last?.choice}; reveal matches server ${c.ok}`);
  await context.close();
}

// 4. Reduced motion
{
  const { context, page } = await newPage(browser, { reducedMotion: 'reduce' });
  await page.click('#play');
  await waitPhase(page, 'revealed');
  const dur = await animDuration(page);
  const c = await checkReveal(page);
  record(4, 'Reduced motion', dur !== null && dur < 600 && c.ok,
    `presentation ${dur} ms (vs ~2200 ms full); same server outcome and score ${c.ok}`);
  await context.close();
}

// 5. Rapid clicks
{
  const { context, page, posts } = await newPage(browser);
  await page.evaluate(() => { const b = document.querySelector('#play'); for (let i = 0; i < 20; i++) b.click(); });
  for (let i = 0; i < 3; i++) await page.click('.beacon[data-choice="2"]', { force: true }).catch(() => {});
  const choiceLocked = await page.$eval('.beacon[data-choice="0"]', e => e.getAttribute('aria-pressed') === 'true');
  await waitPhase(page, 'revealed');
  const view = await serverView(await playerOf(page));
  const ids = new Set(posts.map(p => p.requestId));
  record(5, 'Rapid clicks', posts.length === 1 && ids.size === 1 && view.accepted === 1 && choiceLocked,
    `20 synchronous Play clicks → ${posts.length} POST /rounds, ${ids.size} requestId, ${view.accepted} accepted event; clicks on beacon 03 mid-round ignored (choice still 01: ${choiceLocked})`);
  await context.close();
}

// 6. Pause / Resume
{
  const { context, page } = await newPage(browser);
  await page.click('#play');
  await waitPhase(page, 'animating');
  await delay(400);
  await page.click('#pause');
  const label = await page.textContent('#pause');
  const a = await page.$eval('.pulse', e => e.style.transform);
  await page.screenshot({ path: join(SHOTS, '04-paused.png') });
  await delay(3500);
  const b = await page.$eval('.pulse', e => e.style.transform);
  const still = await phase(page);
  await page.click('#pause');
  await waitPhase(page, 'revealed');
  const c = await checkReveal(page);
  record(6, 'Pause / Resume', a === b && still === 'animating' && label === 'Resume' && c.ok,
    `paused 3.5 s (> full 2.2 s run): pulse frozen ${a === b}, still animating ${still === 'animating'}; Resume completed; outcome matches server ${c.ok}`);
  await context.close();
}

// 7. Skip (during travel, and while pending)
{
  const { context, page } = await newPage(browser);
  await page.click('#play');
  await waitPhase(page, 'animating');
  await delay(200);
  const t = Date.now();
  await page.click('#skip');
  await waitPhase(page, 'revealed', 1000);
  const travelSkipMs = Date.now() - t;
  const c1 = await checkReveal(page);
  await page.click('#new');
  await page.click('#play');
  await page.click('#skip');
  const stillPending = await phase(page);
  const resultText = await page.textContent('#result');
  await waitPhase(page, 'revealed');
  const dur = await animDuration(page);
  const c2 = await checkReveal(page);
  record(7, 'Skip', travelSkipMs < 500 && c1.ok && stillPending === 'pending' && dur < 600 && c2.ok,
    `skip mid-travel revealed in ${travelSkipMs} ms; skip while pending stayed pending ("${resultText}") and revealed ${dur} ms after server completion; both match server`);
  await context.close();
}

// 8. Replay
{
  const { context, page, posts } = await newPage(browser);
  await page.click('#play');
  await waitPhase(page, 'revealed');
  const before = await ui(page);
  const postsBefore = posts.length;
  const eventsBefore = (await (await fetch(BASE + '/events?after=0&limit=100')).json()).events.length;
  await page.click('#replay');
  const replaying = await phase(page);
  await waitPhase(page, 'revealed');
  const after = await ui(page);
  const eventsAfter = (await (await fetch(BASE + '/events?after=0&limit=100')).json()).events.length;
  record(8, 'Replay', replaying === 'animating' && posts.length === postsBefore && eventsAfter === eventsBefore
    && after.score === before.score && after.lit === before.lit && after.outcome === before.outcome,
    `replayed animation; POST /rounds ${postsBefore}→${posts.length}; server events ${eventsBefore}→${eventsAfter}; score ${before.score}→${after.score}; same target ${after.lit === before.lit}`);
  await context.close();
}

// 9. Refresh mid-pending, mid-animation, and after reveal
{
  const { context, page, posts } = await newPage(browser);
  const player = await playerOf(page);
  await page.click('#play');
  await page.reload();
  await page.waitForFunction(() => ['pending', 'animating', 'revealed'].includes(document.querySelector('.stage').dataset.phase));
  await waitPhase(page, 'revealed');
  const c1 = await checkReveal(page);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, '06-reveal-after-refresh.png') });
  await page.click('#new');
  await page.click('#play');
  await waitPhase(page, 'animating');
  await delay(300);
  await page.reload();
  await waitPhase(page, 'revealed');
  const c2 = await checkReveal(page);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
  const c3 = await checkReveal(page);
  const view = await serverView(player);
  const ids = new Set(posts.map(p => p.requestId));
  record(9, 'Refresh during a round', c1.ok && c2.ok && c3.ok && view.accepted === 2 && ids.size === 2 && (await playerOf(page)) === player,
    `refresh while pending → reconciled and revealed (${c1.ok}); refresh mid-animation → revealed (${c2.ok}); refresh after reveal → lit target + result shown (${c3.ok}); same player; 2 rounds / 2 requestIds on server; score ${c3.u.score} = server ${view.score}`);
  await context.close();
}

// 10. Connection loss (server SIGKILL) during pending and during animation
{
  const { context, page } = await newPage(browser);
  const player = await playerOf(page);
  await page.click('#play');
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('Waiting'));
  await killServer();
  await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Reconnecting', null, { timeout: 5000 });
  const statusDown = (await ui(page)).connection;
  await page.screenshot({ path: join(SHOTS, '07-reconnecting.png') });
  await delay(2500); // server down past ROUND_DELAY_MS: round is overdue
  const phaseWhileDown = await phase(page);
  await startServer();
  await waitPhase(page, 'revealed', 20000);
  const c1 = await checkReveal(page);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, '08-reveal-after-recovery.png') });
  // Second case: kill while the reveal animation is already playing.
  await page.click('#new');
  await page.click('#play');
  await waitPhase(page, 'animating');
  await killServer();
  await waitPhase(page, 'revealed');
  const offlineReveal = await checkReveal(page).catch(() => null);
  await startServer();
  await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected', null, { timeout: 20000 });
  await delay(500);
  const c2 = await checkReveal(page);
  const view = await serverView(player);
  record(10, 'Connection loss (server killed)', statusDown === 'Reconnecting' && phaseWhileDown === 'pending' && c1.ok && c2.ok
    && view.accepted === 2 && view.completed.length === 2,
    `kill while pending: status "${statusDown}", stayed pending (no invented result), after restart round completed server-side and revealed (${c1.ok}); kill mid-animation: reveal finished offline, reconnected, score ${c2.u.score} = server ${view.score}; 2 accepted / 2 completed events`);
  await context.close();
}

// 11. New Round
{
  const { context, page } = await newPage(browser);
  await page.click('.beacon[data-choice="2"]');
  await page.click('#play');
  await waitPhase(page, 'revealed');
  const before = await ui(page);
  await page.click('#new');
  const state = await page.evaluate(() => ({
    phase: document.querySelector('.stage').dataset.phase,
    beaconsEnabled: [...document.querySelectorAll('.beacon')].every(b => !b.disabled),
    play: !document.querySelector('#play').disabled,
    lit: document.querySelectorAll('.beacon.lit').length,
  }));
  const after = await ui(page);
  const view = await serverView(await playerOf(page));
  record(11, 'New Round / visual reset', state.phase === 'idle' && state.beaconsEnabled && state.play && state.lit === 0
    && after.score === before.score && view.completed.length === 1,
    `back to idle with beacons + Play enabled and stage cleared; score kept (${before.score}→${after.score}); server history intact (${view.completed.length} completed round)`);
  await context.close();
}

// 12. Two players concurrently
{
  const A = await newPage(browser);
  const B = await newPage(browser);
  const [pa, pb] = [await playerOf(A.page), await playerOf(B.page)];
  await B.page.click('.beacon[data-choice="1"]');
  await Promise.all([A.page.click('#play'), B.page.click('#play')]);
  await Promise.all([waitPhase(A.page, 'revealed'), waitPhase(B.page, 'revealed')]);
  const [ca, cb] = [await checkReveal(A.page), await checkReveal(B.page)];
  record(12, 'Two players', pa !== pb && ca.ok && cb.ok && ca.view.completed.length === 1 && cb.view.completed.length === 1,
    `separate playerIds; both rounds accepted concurrently (no ROUND_IN_PROGRESS) and revealed; scores independent (A ${ca.u.score} = server ${ca.view.score}, B ${cb.u.score} = server ${cb.view.score})`);
  await A.context.close(); await B.context.close();
}

await browser.close();
await killServer();
const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} passed (${BROWSER} ${browser.version()}); screenshots in ${SHOTS}`);
process.exitCode = passed === results.length ? 0 : 1;
