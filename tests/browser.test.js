#!/usr/bin/env node
// Browser smoke test: loads index.html in headless Chromium, checks render, URL state, mobile layout.
// Usage: node tests/browser.test.js [path/to/chart.umd.js]   (optional local Chart.js if the CDN is unreachable)
'use strict';
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const file = 'file://' + path.join(__dirname, '..', 'index.html');
const localChart = process.argv[2];
const outDir = process.env.SHOT_DIR || __dirname;
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  —  ' + d : ''}`); };

(async () => {
  const browser = await chromium.launch();
  async function open(qs, viewport) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_|net::/.test(m.text())) errors.push(m.text()); });
    if (localChart) await page.route(/cdnjs\.cloudflare\.com\/.*chart\.umd\.js/, r => r.fulfill({ body: fs.readFileSync(localChart), contentType: 'application/javascript' }));
    await page.goto(file + (qs || ''));
    await page.waitForFunction(() => /\d+ ms/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    return { page, errors, ctx };
  }

  // Desktop, defaults
  let { page, errors, ctx } = await open('', { width: 1280, height: 900 });
  check('Default page renders without JS errors', errors.length === 0, errors.join(' | '));
  const verdict = await page.textContent('#verdict');
  check('Verdict sentence present', /improves on-time quotes from \d+% to \d+%/.test(verdict), verdict);
  check('Bottleneck badge on intake', await page.isVisible('#stIntake .badge') && !(await page.isVisible('#stQuote .badge')));
  check('Chart drawn', await page.evaluate(() => !!window.Chart && !!Chart.getChart(document.getElementById('chart'))));
  check('What-if table has 7 rows', (await page.$$('#whatif tbody tr')).length === 7);
  await page.screenshot({ path: path.join(outDir, 'desktop.png'), fullPage: true });

  // Change an input -> URL updates
  await page.fill('#nQuoters', '5'); await page.press('#nQuoters', 'Tab');
  await page.waitForFunction(() => location.search.includes('nq=5') && /\d+ ms/.test(document.getElementById('status').textContent));
  check('Editing an input writes it to the URL', page.url().includes('nq=5'), page.url().split('?')[1]);
  check('Bottleneck moves to quoting at 5 quoters', await page.isVisible('#stQuote .badge'));
  await ctx.close();

  // Shared link restores scenario
  ({ page, errors, ctx } = await open('?w=80&nq=6&ni=1', { width: 1280, height: 900 }));
  const vals = await page.evaluate(() => [weekly.value, nQuoters.value, nIntake.value]);
  check('Shared URL restores inputs', vals.join() === '80,6,1', vals.join());
  const sub = await page.textContent('#verdictSub');
  check('Double-overload scenario explains why intake hire lowers on-time', /Why would an intake hire lower it/.test(sub), (await page.textContent('#verdict')));
  await ctx.close();

  // Garbage URL values are clamped, not crashing
  ({ page, errors, ctx } = await open('?w=abc&nq=-4&h=99', { width: 1280, height: 900 }));
  const v2 = await page.evaluate(() => [weekly.value, nQuoters.value, hoursPerDay.value]);
  check('Invalid URL values fall back/clamp safely', v2.join() === '60,1,8' && errors.length === 0, v2.join());
  await ctx.close();

  // Mobile
  ({ page, errors, ctx } = await open('', { width: 375, height: 800 }));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('Mobile (375px): no horizontal page scroll', overflow <= 0, `overflow ${overflow}px`);
  await page.screenshot({ path: path.join(outDir, 'mobile.png'), fullPage: true });
  await ctx.close();

  // Dark mode renders
  ({ page, errors, ctx } = await (async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }); const pg = await c.newPage(); const er = []; pg.on('pageerror', e => er.push(e.message)); if (localChart) await pg.route(/cdnjs.*chart\.umd\.js/, r => r.fulfill({ body: fs.readFileSync(localChart), contentType: 'application/javascript' })); await pg.goto(file); await pg.waitForFunction(() => /\d+ ms/.test(document.getElementById('status').textContent)); return { page: pg, errors: er, ctx: c }; })());
  check('Dark mode renders without errors', errors.length === 0);
  await page.screenshot({ path: path.join(outDir, 'dark.png') });
  await ctx.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
