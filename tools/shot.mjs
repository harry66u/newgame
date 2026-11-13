#!/usr/bin/env node
/* Screenshots of the real game, driven deterministically. Needs Playwright with Chromium.

   node tools/shot.mjs --out shot.png [options]

   --out <file>        where to write the PNG (required). With --every, files are <name>-NN.png
   --size <WxH>        viewport, default 1280x720          --dpr <n>   device pixel ratio, default 1
   --touch             emulate a phone (touch, coarse pointer)
   --seed <n>          track seed (default 5)              --q <0..5>  quality notch (default 0 = best)
   --only <a,b,c>      draw only these layers (e.g. piste,flora)
   --state <title|run|dead>   default run
   --bot <perfect|human|none> who steers during --ff and --frames (default perfect)
   --ff <seconds>      simulate this far ahead before drawing (no rendering, fast)
   --until <chunk>     then keep simulating until the skier is inside a section of this type
                       (start, open, slalom, gates, field, sweep, tilt, bridge, split, jump, islands, drop, rest)
   --steer <pattern>   scripted input for the rendered frames instead of the bot, e.g. "L30,N10,R45" (frames at 60 Hz)
   --frames <n>        then render n frames at 1/60 s each (default 20) — effects need frames to build up
   --every <k>         also save a screenshot every k rendered frames (a motion strip)
   --eval <js>         run this in the page just before the final screenshot; its result is printed
   --stats             print frame cost (CPU ms per frame) and what was drawn

   Prints console errors from the page; exits 1 if there were any. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2), nx = args[i + 1];
  if (nx === undefined || nx.startsWith('--')) opt[k] = true; else { opt[k] = nx; i++; }
}
if (!opt.out) { console.error('--out is required'); process.exit(2); }
const [W, H] = (opt.size || '1280x720').split('x').map(Number);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const q = new URLSearchParams({ q: opt.q ?? '0', shot: '1', seed: opt.seed ?? '5' });
if (opt.only) q.set('only', opt.only);
const BOTS = { perfect: { delay: 0, horizon: 1.6, period: 6 }, human: { delay: 0.22, horizon: 1.2, period: 10, noise: 0.5, twoStage: false } };

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: +(opt.dpr || 1), hasTouch: !!opt.touch, isMobile: !!opt.touch });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto('file://' + path.join(root, 'index.html') + '?' + q);
await page.addScriptTag({ path: path.join(root, 'tests', 'bot.js') });
await page.waitForFunction(() => window.FL && FL.game, null, { timeout: 15000 }).catch(() => {});
if (!(await page.evaluate(() => !!(window.FL && FL.game)))) {
  await page.screenshot({ path: opt.out });
  console.log('the game did not start\n' + errs.join('\n'));
  await browser.close(); process.exit(1);
}
const state = opt.state || 'run', botName = opt.bot || 'perfect';
await page.evaluate(({ botOpts, state }) => {
  const g = FL.game;
  g.manual = true;
  if (botOpts) { const bot = new FL.Bot(botOpts); g.bot = (st, tr) => bot.input(st, tr); }
  if (state !== 'title') g.press();
}, { botOpts: BOTS[botName] || null, state });
if (state !== 'title') {
  if (opt.ff) await page.evaluate((sec) => FL.game.ff(sec), +opt.ff);
  if (opt.until) {
    const ok = await page.evaluate((type) => {
      const g = FL.game;
      for (let i = 0; i < 1200 && g.mode === 'run'; i++) { if (g.track.chunkAt(g.st.s).type === type && g.st.s - g.track.chunkAt(g.st.s).s0 > 30) return true; g.ff(0.1); }
      return false;
    }, opt.until);
    if (!ok) console.log('note: never reached a "' + opt.until + '" section');
  }
  if (state === 'dead') await page.evaluate(() => { const g = FL.game; g.bot = () => 0; for (let i = 0; i < 400 && g.mode === 'run'; i++) g.ff(0.1); });
}
const steer = [];
if (opt.steer) for (const part of String(opt.steer).split(',')) { const d = { L: -1, R: 1, N: 0 }[part[0]] ?? 0; for (let i = 0, n = +part.slice(1) || 1; i < n; i++) steer.push(d); }
const frames = +(opt.frames ?? 20), every = +(opt.every || 0);
const base = opt.out.replace(/\.png$/i, '');
let cost = 0, shots = 0;
for (let f = 0; f < frames; f++) {
  cost += await page.evaluate((d) => {
    const g = FL.game;
    if (d !== null) g.bot = () => d;
    const t0 = performance.now(); g.tick(1 / 60); return performance.now() - t0;
  }, opt.steer ? (steer[f] ?? 0) : null);
  if (every && (f + 1) % every === 0 && f + 1 < frames) await page.screenshot({ path: `${base}-${String(++shots).padStart(2, '0')}.png` });
}
if (opt.eval) console.log('eval:', JSON.stringify(await page.evaluate(opt.eval)));
await page.waitForTimeout(120);
await page.screenshot({ path: opt.out });
const info = await page.evaluate(() => {
  const g = FL.game, s = g.st, ch = g.track.chunkAt(s.s);
  return { mode: g.mode, s: Math.round(s.s), u: +s.u.toFixed(1), o: +s.o.toFixed(1), mult: s.mult, score: Math.round(s.score), onGround: s.onGround,
    chunk: ch.type, I: +ch.I.toFixed(2), wave: g.wave, notch: g.R.notch, size: g.R.targets.w + 'x' + g.R.targets.h,
    layers: g.R.layers.map((L) => L.name + (L.dead ? '(DEAD)' : '')).join(' ') };
});
console.log(opt.out, JSON.stringify(info));
if (opt.stats && frames) console.log('cpu ms per frame (JS + GL calls, software GL so not GPU-representative):', (cost / frames).toFixed(2));
if (errs.length) console.log('PAGE ERRORS:\n' + [...new Set(errs)].join('\n'));
await browser.close();
process.exit(errs.length ? 1 : 0);
