// Auxiliary evidence tool (NOT part of the graded build or the npm deps).
// Exercises the running client in headless Chrome to produce DEMO.md evidence.
// Usage: start the server, `pnpm add puppeteer-core` in a scratch dir, then run this.
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:4400';
const OUT = '/Users/sahibzada/dev/sentient-assessment/submission/evidence';
await mkdir(OUT, { recursive: true });

const results = [];
const record = (name, pass, note = '') => { results.push({ name, pass, note }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? ', ' + note : ''}`); };
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--force-prefers-reduced-motion=false'] });
const version = await browser.version();
console.log('Browser:', version);

const fresh = async (opts = {}) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: opts.width ?? 1280, height: opts.height ?? 720, deviceScaleFactor: 1 });
  // Headless Chrome defaults to reduce; set it explicitly per scenario.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: opts.reduced ? 'reduce' : 'no-preference' }]);
  return { ctx, page };
};
const revealText = async page => page.$eval('#result', el => el.textContent);
const waitReveal = page => page.waitForFunction(() => /Match|Miss/.test(document.querySelector('#result').textContent), { timeout: 10000 });

try {
  // 1. Desktop happy path with screenshots
  {
    const { ctx, page } = await fresh();
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#connection').dataset.ok === '1', { timeout: 5000 });
    await page.click('.beacon[data-choice="2"]');
    const pressed = await page.$eval('.beacon[data-choice="2"]', b => b.getAttribute('aria-pressed'));
    await page.screenshot({ path: `${OUT}/01-selection.png` });
    record('desktop: select beacon sets aria-pressed', pressed === 'true');
    await page.click('#play');
    await new Promise(r => setTimeout(r, 450));
    const pendingTxt = await revealText(page);
    await page.screenshot({ path: `${OUT}/02-pending.png` });
    record('desktop: pending state shown, no premature outcome', /Awaiting|Pulse/.test(pendingTxt) && !/Match|Miss/.test(pendingTxt), JSON.stringify(pendingTxt));
    await waitReveal(page);
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: `${OUT}/03-reveal.png` });
    const revealTxt = await revealText(page);
    const score = await page.$eval('#score', el => el.textContent);
    record('desktop: reveal shows outcome + score', /Match|Miss/.test(revealTxt), `${revealTxt} | score=${score}`);
    // Replay must not change score and not start a new round
    await page.click('#replay');
    await new Promise(r => setTimeout(r, 300));
    const score2 = await page.$eval('#score', el => el.textContent);
    record('desktop: replay keeps score unchanged', score === score2, `score ${score}->${score2}`);
    await ctx.close();
  }

  // 2. Mobile layout, no horizontal overflow
  {
    const { ctx, page } = await fresh({ width: 390, height: 844 });
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: `${OUT}/04-mobile.png` });
    const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
    record('mobile 390x844: no horizontal overflow', overflow <= 1, `overflow=${overflow}px`);
    await ctx.close();
  }

  // 3. prefers-reduced-motion, round must complete and reveal, no crash
  {
    const errors = [];
    const { ctx, page } = await fresh({ reduced: true });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.click('.beacon[data-choice="1"]');
    await page.click('#play');
    await waitReveal(page);
    await page.screenshot({ path: `${OUT}/05-reduced-motion.png` });
    record('reduced-motion: round reveals correctly, no page error', errors.length === 0, errors.join('; ') || 'ok');
    await ctx.close();
  }

  // 4. Keyboard-only play
  {
    const { ctx, page } = await fresh();
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.keyboard.press('3');
    const kp = await page.$eval('.beacon[data-choice="2"]', b => b.getAttribute('aria-pressed'));
    await page.keyboard.press('Enter');
    await waitReveal(page);
    record('keyboard: 3 selects + Enter plays to reveal', kp === 'true');
    await ctx.close();
  }

  // 5. Rapid clicks, one round only (score rises by exactly 0 or 1)
  {
    const { ctx, page } = await fresh();
    await page.goto(URL, { waitUntil: 'networkidle0' });
    const before = Number(await page.$eval('#score', el => el.textContent));
    await page.click('.beacon[data-choice="0"]');
    for (let i = 0; i < 8; i++) page.click('#play').catch(() => {});
    await waitReveal(page);
    await new Promise(r => setTimeout(r, 300));
    const after = Number(await page.$eval('#score', el => el.textContent));
    record('rapid clicks: a single round scores (Δ≤1)', after - before <= 1, `score ${before}->${after}`);
    await ctx.close();
  }

  // 6. Refresh during a pending round, must recover, not get stuck
  {
    const errors = [];
    const { ctx, page } = await fresh();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.click('.beacon[data-choice="1"]');
    await page.click('#play');
    await new Promise(r => setTimeout(r, 300)); // mid-pending
    await page.reload({ waitUntil: 'networkidle0' });
    await waitReveal(page); // round resolves after reload
    record('refresh mid-round: recovers and reveals', errors.length === 0, errors.join('; ') || 'recovered');
    await ctx.close();
  }

  // 7. Pause/Resume, presentation only; server still completes the round
  {
    const { ctx, page } = await fresh();
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.click('.beacon[data-choice="0"]');
    await page.click('#play');
    await new Promise(r => setTimeout(r, 250));
    await page.click('#pause');
    const label = await page.$eval('#pause', b => b.textContent);
    await waitReveal(page); // completes despite paused presentation
    record('pause: toggles to Resume, server still completes', label === 'Resume');
    await ctx.close();
  }

  // 8. Skip, immediately reveals a completed result
  {
    const { ctx, page } = await fresh();
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.click('.beacon[data-choice="1"]');
    await page.click('#play');
    await new Promise(r => setTimeout(r, 1500)); // round completed; reveal animation mid-flight
    await page.click('#skip');
    await new Promise(r => setTimeout(r, 150));
    const txt = await revealText(page);
    record('skip: reveals the completed outcome at once', /Match|Miss/.test(txt));
    await ctx.close();
  }

  // 9. New Round, returns to selection, score preserved
  {
    const { ctx, page } = await fresh();
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.click('.beacon[data-choice="2"]');
    await page.click('#play');
    await waitReveal(page);
    const score = await page.$eval('#score', el => el.textContent);
    await page.click('#new');
    const playEnabled = await page.$eval('#play', b => !b.disabled);
    const prompt = await revealText(page);
    const score2 = await page.$eval('#score', el => el.textContent);
    record('new round: back to selection, score preserved', playEnabled && /Choose a beacon/.test(prompt) && score === score2);
    await ctx.close();
  }

  // 10. Connection loss mid-round, reconnects and reconciles, no gap
  {
    const { ctx, page } = await fresh();
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.click('.beacon[data-choice="0"]');
    await page.click('#play');
    await new Promise(r => setTimeout(r, 200));
    await page.setOfflineMode(true);               // drop the network mid-round
    await new Promise(r => setTimeout(r, 1600));    // round completes server-side while offline
    await page.setOfflineMode(false);              // reconnect + reconcile the missed completion
    await waitReveal(page);
    const status = await page.$eval('#connection', el => el.textContent);
    record('connection loss: reconnects and reconciles the missed result', /Connect/i.test(status), `final status="${status}"`);
    await ctx.close();
  }
} finally {
  console.log('---SUMMARY---');
  console.log(JSON.stringify({ browser: version, results }, null, 2));
  await browser.close();
}
