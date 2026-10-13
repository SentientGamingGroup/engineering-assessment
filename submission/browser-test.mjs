// Optional real-browser integration checks and small, reproducible demo evidence.
// npm ci --prefix submission --ignore-scripts
// npm exec --prefix submission -- playwright install chromium
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox } from 'playwright';
import { createSystem, waitFor } from '../scripts/support.mjs';

const engine = process.env.BROWSER === 'firefox' ? firefox : chromium;
process.env.no_grpc_proxy = [
  process.env.no_grpc_proxy,
  '127.0.0.1',
  'localhost',
]
  .filter(Boolean)
  .join(',');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath =
  process.env.BROWSER_EXECUTABLE ||
  (engine === chromium && existsSync(chrome) ? chrome : undefined);
const system = await createSystem({ roundDelayMs: 900 });
const evidence = fileURLToPath(new URL('./evidence/', import.meta.url));
await mkdir(evidence, { recursive: true });
const browser = await engine.launch({
  executablePath,
  headless: process.env.HEADED !== '1',
  ...(engine === chromium
    ? { args: ['--no-proxy-server'] }
    : { firefoxUserPrefs: { 'network.proxy.type': 0 } }),
});
const checks = [],
  errors = [];
let activePage;
function pass(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}
const snapshot = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('beacon-relay.v1')));
const phase = (page, expected) =>
  page.waitForFunction(
    (value) => document.querySelector('.stage').dataset.phase === value,
    expected,
  );
const shoot = (page, name) =>
  page.screenshot({
    path: `${evidence}${engine === firefox ? 'firefox-' : ''}${name}.png`,
    fullPage: true,
  });
async function history() {
  const all = [];
  let after = 0;
  for (;;) {
    const page = await system.rpc('listEvents', { after, limit: 100 });
    all.push(...(page.events ?? []));
    after = page.nextCursor;
    if ((page.events ?? []).length < 100) return all;
  }
}
async function assertRoundOnce(requestId) {
  const events = (await history()).filter(
    (event) => event.round.requestId === requestId,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['round.accepted', 'round.completed'],
  );
}
async function assertScore(page) {
  const saved = await snapshot(page);
  const events = (await history()).filter(
    (event) =>
      event.type === 'round.completed' &&
      event.round.playerId === saved.playerId,
  );
  assert.equal(
    Number(await page.locator('#score').innerText()),
    events.reduce((sum, event) => sum + event.round.score, 0),
  );
  assert.equal(saved.ledger.length, events.length);
}
try {
  await system.start();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', (error) => errors.push(error.message));
  let posts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/rounds'
    )
      posts++;
  });
  await page.goto(system.apiUrl);
  await page.waitForFunction(
    () => document.querySelector('#connection').dataset.connected === 'true',
  );
  await shoot(page, '01-selection-desktop');
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  pass('1280×720 selection and layout');

  await page.keyboard.press('3');
  assert.equal(
    await page.locator('[data-choice="2"]').getAttribute('aria-pressed'),
    'true',
  );
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'play');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++)
      document.querySelector('#play').dispatchEvent(new MouseEvent('click'));
  });
  await phase(page, 'travel');
  await delay(650);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const backgroundPosition = await page
    .locator('.pulse')
    .evaluate((element) => element.style.transform);
  await delay(200);
  assert.equal(
    await page.locator('.pulse').evaluate((element) => element.style.transform),
    backgroundPosition,
  );
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  pass(
    'simulated visibility changes stop and resume presentation without a second loop',
  );
  await page.locator('#pause').click();
  const transform = await page
    .locator('.pulse')
    .evaluate((element) => element.style.transform);
  await delay(250);
  assert.equal(
    await page.locator('.pulse').evaluate((element) => element.style.transform),
    transform,
  );
  await shoot(page, '02-animation-desktop');
  await page.locator('#pause').click();
  await phase(page, 'revealed');
  let saved = await snapshot(page);
  assert.equal(saved.round.choice, 2);
  assert.equal(posts, 1);
  const actual = await system.rpc('getRound', { roundId: saved.round.roundId });
  assert.deepEqual(saved.round, actual);
  assert.match(
    await page.locator('#result').innerText(),
    new RegExp(['Azure', 'Amber', 'Violet'][actual.target]),
  );
  await assertRoundOnce(saved.intent.requestId);
  await assertScore(page);
  await shoot(page, '03-result-desktop');
  pass(
    'keyboard play, 20 rapid clicks, pause/resume, and authoritative reveal',
  );

  const originalPosts = posts,
    originalHistory = await history();
  await page.locator('#replay').click();
  await phase(page, 'travel');
  await page.locator('#skip').click();
  await phase(page, 'revealed');
  assert.equal(posts, originalPosts);
  assert.deepEqual(await history(), originalHistory);
  await assertScore(page);
  const beforeReset = Number(await page.locator('#score').innerText());
  await page.locator('#new').click();
  await phase(page, 'select');
  assert.equal(Number(await page.locator('#score').innerText()), beforeReset);
  pass('replay/skip have no server writes; New Round preserves score');

  await page.locator('#play').click();
  await phase(page, 'waiting');
  const pending = await snapshot(page);
  await page.reload();
  await phase(page, 'revealed');
  saved = await snapshot(page);
  assert.equal(saved.intent.requestId, pending.intent.requestId);
  assert.equal(saved.round.roundId, pending.round.roundId);
  await assertRoundOnce(saved.intent.requestId);
  await assertScore(page);
  pass('refresh during pending round preserves identity and score');

  await page.locator('#new').click();
  await page.locator('#play').click();
  await phase(page, 'waiting');
  await page.locator('#pause').click();
  const paused = await snapshot(page);
  await waitFor(
    async () =>
      (await system.rpc('getRound', { roundId: paused.round.roundId }))
        .status === 'completed',
    'paused server completion',
  );
  await phase(page, 'travel');
  await delay(250);
  assert.equal(await page.locator('#pause').innerText(), 'Resume');
  assert.equal(
    await page.locator('.stage').getAttribute('data-phase'),
    'travel',
  );
  await page.locator('#skip').click();
  await phase(page, 'revealed');
  await assertScore(page);
  pass(
    'paused presentation does not pause the server; Skip reveals completed result',
  );

  await page.locator('#new').click();
  await page.locator('#play').click();
  await phase(page, 'waiting');
  const skipPending = await snapshot(page);
  await page.locator('#skip').click();
  assert.match(
    await page.locator('#result').innerText(),
    /Waiting for the server/,
  );
  await phase(page, 'revealed');
  await assertRoundOnce(skipPending.intent.requestId);
  pass('Skip before completion waits for the actual result');

  await page.locator('#new').click();
  await context.setOffline(true);
  await page.locator('#play').click();
  const offlineIntent = (await snapshot(page)).intent;
  await page.waitForFunction(() =>
    document.querySelector('#notice').textContent.includes('Retrying'),
  );
  await context.setOffline(false);
  await phase(page, 'revealed');
  assert.equal(
    (await snapshot(page)).intent.requestId,
    offlineIntent.requestId,
  );
  await assertRoundOnce(offlineIntent.requestId);
  await assertScore(page);
  pass('offline submission retries the original request identity');

  await page.locator('#new').click();
  await page.locator('#play').click();
  await phase(page, 'travel');
  const disconnected = await snapshot(page);
  await context.setOffline(true);
  await phase(page, 'revealed');
  assert.equal(
    (await snapshot(page)).round.roundId,
    disconnected.round.roundId,
  );
  await context.setOffline(false);
  await page.waitForFunction(
    () => document.querySelector('#connection').dataset.connected === 'true',
  );
  await assertRoundOnce(disconnected.intent.requestId);
  await assertScore(page);
  pass('connection loss during animation preserves the recorded outcome');

  await page.locator('#new').click();
  await page.locator('#play').click();
  await phase(page, 'waiting');
  const restarting = await snapshot(page);
  await system.stop(true);
  await delay(950);
  await system.start();
  await phase(page, 'revealed');
  assert.equal((await snapshot(page)).round.roundId, restarting.round.roundId);
  await assertRoundOnce(restarting.intent.requestId);
  await assertScore(page);
  pass(
    'abrupt server restart recovers the browser round without another acceptance',
  );

  await page.locator('#new').click();
  let releaseReply, replyFinished;
  let held = false;
  const finished = new Promise((resolve) => {
    replyFinished = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseReply = resolve;
  });
  const holdReply = async (route) => {
    if (held) return route.continue();
    held = true;
    try {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
      replyFinished(null);
    } catch (error) {
      replyFinished(error);
    }
  };
  await page.route('**/rounds', holdReply);
  await page.locator('#play').click();
  await phase(page, 'travel');
  const older = await snapshot(page);
  await page.locator('#skip').click();
  await page.locator('#new').click();
  await page.locator('#play').click();
  const newer = await snapshot(page);
  assert.notEqual(newer.intent.requestId, older.intent.requestId);
  releaseReply();
  const replyError = await finished;
  if (replyError) throw replyError;
  await page.unroute('**/rounds', holdReply);
  await phase(page, 'revealed');
  assert.equal((await snapshot(page)).round.requestId, newer.intent.requestId);
  await assertRoundOnce(older.intent.requestId);
  await assertRoundOnce(newer.intent.requestId);
  await assertScore(page);
  pass('a delayed accepted HTTP reply cannot replace a newer round');

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  const phone = await mobile.newPage();
  phone.on('pageerror', (error) => errors.push(error.message));
  await phone.goto(system.apiUrl);
  await shoot(phone, '04-selection-mobile');
  assert.equal(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const stageBox = await phone.locator('.stage').boundingBox();
  for (const beacon of await phone.locator('.beacon').all()) {
    const box = await beacon.boundingBox();
    assert.ok(
      box.x >= stageBox.x && box.x + box.width <= stageBox.x + stageBox.width,
    );
    assert.ok(
      box.y >= stageBox.y && box.y + box.height <= stageBox.y + stageBox.height,
    );
  }
  await phone.locator('[data-choice="1"]').tap();
  await phone.locator('#play').tap();
  await phase(phone, 'waiting');
  await phone.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('beacon-relay.v1')).round?.status ===
      'completed',
  );
  const receivedAt = Date.now();
  await phase(phone, 'revealed');
  assert.ok(Date.now() - receivedAt < 900);
  await assertScore(phone);
  await shoot(phone, '05-result-mobile');
  pass('390×844 at DPR 2: no clipped beacons, touch controls, reduced motion');
  await mobile.close();
  assert.deepEqual(errors, []);
  pass('no uncaught browser errors');
  const report = {
    generatedAt: new Date().toISOString(),
    browser: `${engine === firefox ? 'Firefox' : 'Chromium'} ${browser.version()}`,
    platform: process.platform,
    headless: process.env.HEADED !== '1',
    viewports: ['1280×720 DPR 1', '390×844 DPR 2'],
    checks,
    errors,
  };
  await writeFile(
    `${evidence}${engine === firefox ? 'firefox-' : ''}browser-report.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  await context.close();
  console.log(`${checks.length} browser groups passed.`);
} catch (error) {
  console.error('Browser failure:', error.message);
  if (activePage && !activePage.isClosed()) {
    try {
      console.error(
        'Browser diagnostics:',
        JSON.stringify({
          errors,
          saved: await snapshot(activePage),
          result: await activePage.locator('#result').innerText(),
          notice: await activePage.locator('#notice').innerText(),
        }),
      );
    } catch {
      console.error('Page was unavailable for diagnostics.');
    }
  }
  throw error;
} finally {
  await browser.close();
  await system.close();
}
