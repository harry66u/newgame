#!/usr/bin/env node
/* Fall Line — end-to-end check of the real page in Chromium.      node tests/e2e.mjs

   Loads index.html from file://, plays it with real key presses and real touches, and prints
   one PASS/FAIL line per check; exits 1 if anything failed. Needs Playwright (not part of
   "node --test tests/", which has no dependencies).

   It leans only on what is stable: window.FL.game (st, mode, paused, input, press(), ff(sec),
   manual, tick(dt), R.layers, audio.muted), window.FL.Hud.fmt and the text a player can see —
   never on element ids or classes, which belong to whoever is styling the page.
   Frames are driven by hand (FL.game.manual + tick) wherever timing matters, so a slow
   software renderer cannot change the outcome.

   Options:  --headed   show the browser        --seed <n>   track seed (default 5)
   Env:      E2E_RETRY_WAIT=<seconds>  how long to wait before retrying a page that will not start (default 60) */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const argv = process.argv.slice(2);
const seed = argv.includes('--seed') ? argv[argv.indexOf('--seed') + 1] : '5';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'file://' + path.join(root, 'index.html') + '?seed=' + seed;
const RETRY_WAIT = +(process.env.E2E_RETRY_WAIT || 60) * 1000;
const STEP = 1 / 120, S_START = 24;

let passed = 0, failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const info = await fn();
    passed++;
    console.log('PASS  ' + name + (info ? '  — ' + info : ''));
  } catch (e) {
    failed++;
    const msg = String(e && e.message || e).split('\n')[0];
    failures.push(name + ': ' + msg);
    console.log('FAIL  ' + name + '  — ' + msg);
  }
}
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const errs = [];
function watch(page, label) {
  page.on('console', (m) => { if (m.type() === 'error') errs.push(label + ' console: ' + m.text()); });
  page.on('pageerror', (e) => errs.push(label + ' pageerror: ' + e.message));
}

// ---------------------------------------------------------------- page helpers
const started = (page) => page.evaluate(() => !!(window.FL && FL.game && FL.game.R && FL.Hud));
async function open(page) {
  await page.goto(URL_);
  await page.waitForFunction(() => window.FL && FL.game, null, { timeout: 15000 }).catch(() => {});
  return started(page);
}
/* Other parts of the game are being rewritten: a page that will not start may be someone
   mid-edit. Give it a minute, twice, before calling it a failure. */
async function openPatiently(page) {
  for (let i = 0; i < 3; i++) {
    if (await open(page)) return true;
    if (i < 2) { console.log(`      (the page did not start; waiting ${RETRY_WAIT / 1000}s and trying again)`); await sleep(RETRY_WAIT); }
  }
  return false;
}
const state = (page) => page.evaluate(() => {
  const g = FL.game, st = g.st;
  return { mode: g.mode, paused: g.paused, s: st.s, o: st.o, vo: st.vo, t: st.t, u: st.u, score: st.score, mult: st.mult,
    alive: st.alive, started: st.started, cause: st.cause, into: st.into, dir: g.input.dir, muted: !!g.audio.muted, time: g.view.time };
});
const ticks = (page, n, dt) => page.evaluate(([n, dt]) => { for (let i = 0; i < n; i++) FL.game.tick(dt); }, [n, dt || 1 / 60]);
const manual = (page, on) => page.evaluate((on) => { FL.game.manual = on; }, on);
// What a player can read, lower-cased; `tight` drops all spacing (digits may sit in separate cells).
const text = async (page, tight) => {
  const t = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  return tight ? t.replace(/\s+/g, '') : t.replace(/\s+/g, ' ');
};
const fmt = (page, n) => page.evaluate((n) => FL.Hud.fmt(n), n);
const stored = (page, k) => page.evaluate((k) => { try { return localStorage.getItem(k); } catch (e) { return 'ERR ' + e.message; } }, k);
const layers = (page) => page.evaluate(() => FL.game.R.layers.map((L) => ({ name: L.name, dead: L.dead === true })));
async function layersAlive(page) {
  const ls = await layers(page);
  need(ls.length > 0, 'the renderer has no layers');
  const dead = ls.filter((l) => l.dead).map((l) => l.name);
  need(dead.length === 0, 'dead layers: ' + dead.join(', ') + ' (alive: ' + ls.filter((l) => !l.dead).map((l) => l.name).join(', ') + ')');
  return ls.length + ' layers alive: ' + ls.map((l) => l.name).join(', ');
}
// Draw one frame and look at what actually reached the canvas, in the same task (before the browser clears it).
const drawn = (page) => page.evaluate(() => {
  const c = document.querySelector('canvas');
  FL.game.tick(1 / 60);
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const out = { cw: c.width, ch: c.height, clientW: c.clientWidth, clientH: c.clientHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, lost: !gl || gl.isContextLost(), colours: 0 };
  if (out.lost) return out;
  const RB = gl.READ_FRAMEBUFFER_BINDING || gl.FRAMEBUFFER_BINDING, RF = gl.READ_FRAMEBUFFER || gl.FRAMEBUFFER;
  const was = gl.getParameter(RB);
  if (was) gl.bindFramebuffer(RF, null);
  const px = new Uint8Array(4), seen = new Set();
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    gl.readPixels(Math.floor((x + 0.5) * c.width / 12), Math.floor((y + 0.5) * c.height / 12), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    seen.add((px[0] >> 3) + ',' + (px[1] >> 3) + ',' + (px[2] >> 3));
  }
  if (was) gl.bindFramebuffer(RF, was);
  out.colours = seen.size;
  return out;
});
function sized(d, what) {
  need(!d.lost, what + ': the WebGL context is lost');
  need(d.clientW === d.iw && d.clientH === d.ih, `${what}: canvas is ${d.clientW}x${d.clientH} in a ${d.iw}x${d.ih} window`);
  need(d.cw > 0 && d.ch > 0, what + ': canvas has no pixels');
  const a = d.cw / d.ch, want = d.iw / d.ih;
  need(Math.abs(a / want - 1) < 0.04, `${what}: drawing buffer ${d.cw}x${d.ch} does not match the window's shape ${d.iw}x${d.ih}`);
  need(d.colours >= 6, `${what}: the frame is blank or flat (${d.colours} distinct colours in a 12x12 sample)`);
  return `${d.iw}x${d.ih} -> buffer ${d.cw}x${d.ch}, ${d.colours} colours`;
}
// Run to the end with no input, then draw the result.
async function runOut(page) {
  await page.evaluate(() => { FL.game.ff(90); FL.game.tick(1 / 60); });
  return state(page);
}
// From a finished run: wait out the lock-out and press a key for a fresh one.
async function again(page) {
  await runOut(page);
  await ticks(page, 5, 0.1);
  await page.keyboard.press('Space');
  const s = await state(page);
  need(s.mode === 'run' && s.s === S_START, 'could not get a fresh run (mode ' + s.mode + ', s=' + s.s + ')');
}

// ================================================================= desktop
const browser = await chromium.launch({ headless: !argv.includes('--headed'), args: ['--enable-unsafe-swiftshader'] });
const t0 = Date.now();
let ok = false;
{
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page, 'desktop');
  await check('the page starts (FL.game and a renderer exist)', async () => {
    ok = await openPatiently(page);
    need(ok, 'window.FL.game never appeared: ' + (errs[0] || 'no error reported'));
    need(!(await text(page)).includes("can't start"), 'the page shows its "can\'t start" message');
  });

  if (ok) {
    await check('title: shows the game\'s name and is drawing', async () => {
      const s = await state(page);
      need(s.mode === 'title', 'mode is ' + s.mode);
      need((await text(page)).includes('fall line'), 'the visible text does not contain "Fall Line"');
      await page.waitForFunction((t) => FL.game.view.time > t + 0.05, s.time, { timeout: 8000 });
      need((await state(page)).s === S_START, 'the skier moved on the title');
      return '"fall line" visible, frames advancing';
    });

    await check('M toggles mute, does not start a run, and the choice survives a reload', async () => {
      const a = await state(page);
      await page.keyboard.press('KeyM');
      const b = await state(page);
      need(b.muted === !a.muted, 'M did not toggle mute');
      need(b.mode === 'title', 'M started a run');
      need((await stored(page, 'fallline.muted')) === (b.muted ? '1' : '0'), 'mute not written to localStorage: ' + (await stored(page, 'fallline.muted')));
      need(await open(page), 'reload failed');
      const c = await state(page);
      need(c.muted === b.muted, 'mute did not survive the reload');
      await page.keyboard.press('KeyM');
      const d = await state(page);
      need(d.muted === a.muted && (await stored(page, 'fallline.muted')) === (d.muted ? '1' : '0'), 'M did not toggle back');
      return `muted ${a.muted} -> ${b.muted} -> reload ${c.muted} -> ${d.muted}`;
    });

    await manual(page, true);
    await check('a key press starts a run', async () => {
      await page.keyboard.press('Space');
      const s = await state(page);
      need(s.mode === 'run' && s.started && s.alive, 'mode is ' + s.mode);
      need(s.s === S_START && s.o === 0, 'the run did not begin at the start position');
      return 'mode run at s=' + s.s;
    });

    const steer = async (right, left, label) => {
      const a = await state(page);
      await page.keyboard.down(right);
      const dn = await state(page);
      await ticks(page, 18);
      const b = await state(page);
      await page.keyboard.up(right);
      need(dn.dir === 1, label + ': holding ' + right + ' gives input ' + dn.dir);
      need(b.o > a.o + 0.8 && b.vo > 3, `${label}: ${right} moved the skier from o=${a.o.toFixed(2)} to ${b.o.toFixed(2)}`);
      await page.keyboard.down(left);
      const dl = await state(page);
      await ticks(page, 36);
      const c = await state(page);
      await page.keyboard.up(left);
      const up = await state(page);
      need(dl.dir === -1, label + ': holding ' + left + ' gives input ' + dl.dir);
      need(c.o < b.o - 0.8 && c.vo < -3, `${label}: ${left} moved the skier from o=${b.o.toFixed(2)} to ${c.o.toFixed(2)}`);
      need(up.dir === 0, label + ': input is ' + up.dir + ' after release');
      need(c.mode === 'run', label + ': the run ended while steering (' + c.cause + ' ' + c.into + ')');
      await page.keyboard.down(right); await ticks(page, 14); await page.keyboard.up(right);     // back toward the middle
      return `o ${a.o.toFixed(2)} -> ${b.o.toFixed(2)} -> ${c.o.toFixed(2)}`;
    };
    await check('holding ArrowRight moves the skier right, ArrowLeft left', () => steer('ArrowRight', 'ArrowLeft', 'arrows'));
    await check('holding D moves the skier right, A left', () => steer('KeyD', 'KeyA', 'A/D'));

    let score1 = 0;
    await check('with no input the run ends and the result shows the score', async () => {
      const s = await runOut(page);
      need(s.mode === 'dead' && !s.alive, 'still ' + s.mode + ' after 90 s without input');
      score1 = Math.floor(s.score);
      need(score1 > 0, 'score is ' + score1);
      const shown = await fmt(page, score1);
      need((await text(page, true)).includes(shown), 'the visible text does not contain the score ' + shown);
      return `ended by ${s.cause}${s.into ? ' into ' + s.into : ''} at s=${s.s.toFixed(0)}, score ${shown} shown`;
    });

    await check('the best score is saved to localStorage', async () => {
      const v = await stored(page, 'fallline.best');
      need(v === String(score1), 'fallline.best is ' + v + ', expected ' + score1);
      return 'fallline.best = ' + v;
    });

    await check('the next key press restarts into a fresh run at the start, but not within the 0.4 s lock-out', async () => {
      await page.keyboard.press('Space');
      need((await state(page)).mode === 'dead', 'a key restarted at once');
      await ticks(page, 3, 0.1);
      await page.keyboard.press('Space');
      need((await state(page)).mode === 'dead', 'a key restarted after 0.3 s');
      await ticks(page, 2, 0.1);
      await page.keyboard.press('Space');
      const s = await state(page);
      need(s.mode === 'run', 'a key did not restart after 0.5 s (mode ' + s.mode + ')');
      need(s.alive && s.started && s.s === S_START && s.o === 0 && s.vo === 0 && s.score === 0 && s.mult === 1 && s.cause === '', 'the new run is not fresh: ' + JSON.stringify(s));
      await ticks(page, 2);
      const sc = await fmt(page, score1);
      need(!(await text(page, true)).includes(sc) || score1 < 10, 'the old result is still on screen');
      return 'locked at 0 s and 0.3 s, fresh run at 0.5 s';
    });

    await check('P pauses, and any key resumes', async () => {
      await manual(page, false);                              // let the page drive itself for this one
      await page.keyboard.press('KeyP');
      const a = await state(page);
      need(a.paused, 'P did not pause');
      const shows = (await text(page)).includes('paused');
      await sleep(350);
      const b = await state(page);
      need(b.t === a.t && b.s === a.s, `the run moved while paused (${a.s} -> ${b.s})`);
      await page.keyboard.press('KeyK');
      const c = await state(page);
      need(!c.paused && c.mode === 'run', 'a key did not resume');
      await page.waitForFunction((t) => FL.game.st.t > t + 0.05, a.t, { timeout: 8000 });
      await manual(page, true);
      need(shows, 'paused, but the visible text does not say "Paused"');
      return 'held still for 350 ms, then carried on';
    });

    await check('the page\'s own loop: 30, 144 and 120 Hz frames land within one step of each other', async () => {
      const out = [];
      for (const hz of [30, 144, 120]) {
        await again(page);
        await ticks(page, hz / 2, 1 / hz);                    // half a second of frames
        const s = await state(page);
        need(s.mode === 'run', 'the run ended');
        out.push(Object.assign({ hz }, s));
      }
      const ref = out[2];
      need(Math.abs(ref.t - 0.5) < 1e-9, 'at 120 Hz, 60 frames should be exactly 60 steps: t=' + ref.t);
      for (const s of out) {
        need(Math.abs(s.t - ref.t) <= STEP + 1e-9, `${s.hz} Hz is ${((s.t - ref.t) / STEP).toFixed(2)} steps from 120 Hz`);
        need(Math.abs(s.s - ref.s) <= ref.u * STEP * 1.05, `${s.hz} Hz is ${(s.s - ref.s).toFixed(3)} m from 120 Hz`);
      }
      return out.map((s) => `${s.hz} Hz: ${Math.round(s.t / STEP)} steps, s=${s.s.toFixed(3)}`).join('; ');
    });

    await check('a resize does not break rendering', async () => {
      const a = sized(await drawn(page), 'before');
      await page.setViewportSize({ width: 430, height: 820 });
      await sleep(150);
      await ticks(page, 3);
      const b = sized(await drawn(page), 'portrait');
      await page.setViewportSize({ width: 1280, height: 600 });
      await sleep(150);
      await ticks(page, 3);
      const c = sized(await drawn(page), 'wide');
      need((await state(page)).mode === 'run', 'the run ended during the resize');
      await layersAlive(page);
      return [a, b, c].join(' | ');
    });

    await check('the best score survives a reload and is shown', async () => {
      need(await open(page), 'reload failed');
      const best = +(await stored(page, 'fallline.best'));
      need(best >= score1 && score1 > 0, 'fallline.best is ' + best + ' after the reload, expected at least ' + score1);
      const shown = await fmt(page, best);
      await manual(page, true);
      await page.keyboard.press('Space');
      await ticks(page, 2);
      const t = await text(page, true);
      need(t.includes(shown), 'the best score ' + shown + ' is not on screen during a run');
      return 'best ' + shown + ' kept and shown';
    });

    await check('every renderer layer is alive (desktop)', () => layersAlive(page));
  }
  await ctx.close();
}

// ================================================================= phone
if (ok) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  watch(page, 'phone');
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  let up = false;
  await check('phone: the page starts', async () => {
    up = await openPatiently(page);
    need(up, 'window.FL.game never appeared');
    need((await state(page)).mode === 'title' && (await text(page)).includes('fall line'), 'no title');
    await manual(page, true);
  });
  if (up) {
    await check('phone: a tap starts a run', async () => {
      await page.touchscreen.tap(195, 420);
      const s = await state(page);
      need(s.mode === 'run' && s.s === S_START, 'mode is ' + s.mode + ' after a tap');
      need(s.dir === 0, 'the starting tap left the skier steering (' + s.dir + ')');
    });
    await check('phone: touching the left half steers left, the right half right', async () => {
      const a = await state(page);
      await touch('touchStart', 70, 600);
      const dl = await state(page);
      await ticks(page, 20);
      const b = await state(page);
      await touch('touchEnd');
      const rel = await state(page);
      need(dl.dir === -1, 'a finger on the left half gives input ' + dl.dir);
      need(b.o < a.o - 0.8 && b.vo < -3, `left touch moved the skier from o=${a.o.toFixed(2)} to ${b.o.toFixed(2)}`);
      need(rel.dir === 0, 'input is ' + rel.dir + ' after lifting the finger');
      await touch('touchStart', 320, 600);
      const dr = await state(page);
      await ticks(page, 36);
      const c = await state(page);
      await touch('touchEnd');
      need(dr.dir === 1, 'a finger on the right half gives input ' + dr.dir);
      need(c.o > b.o + 0.8 && c.vo > 3, `right touch moved the skier from o=${b.o.toFixed(2)} to ${c.o.toFixed(2)}`);
      need((await state(page)).dir === 0 && c.mode === 'run', 'input stuck or run ended');
      return `o ${a.o.toFixed(2)} -> ${b.o.toFixed(2)} -> ${c.o.toFixed(2)}`;
    });
    await check('phone: a tap restarts after the run ends (and not inside the lock-out)', async () => {
      const s = await runOut(page);
      need(s.mode === 'dead', 'the run did not end');
      const shown = await fmt(page, Math.floor(s.score));
      need((await text(page, true)).includes(shown), 'the result does not show the score ' + shown);
      await page.touchscreen.tap(195, 420);
      need((await state(page)).mode === 'dead', 'a tap restarted at once');
      await ticks(page, 5, 0.1);
      await page.touchscreen.tap(195, 420);
      const r = await state(page);
      need(r.mode === 'run' && r.s === S_START && r.o === 0 && r.score === 0 && r.alive, 'not a fresh run: ' + JSON.stringify(r));
      return 'score ' + shown + ' shown, fresh run after a tap';
    });
    await check('phone: renders in portrait at 2x, every layer alive', async () => {
      await ticks(page, 3);
      const d = sized(await drawn(page), 'phone');
      return d + '; ' + (await layersAlive(page));
    });
  }
  await ctx.close();
}

await check('no console errors or page errors throughout', async () => {
  need(errs.length === 0, errs.length + ' error(s), first: ' + errs[0]);
});
await browser.close();

console.log(`\n${passed} passed, ${failed} failed  (${((Date.now() - t0) / 1000).toFixed(1)}s, seed ${seed})`);
if (failed) { console.log('Failures:'); for (const f of failures) console.log('  - ' + f); }
if (errs.length) { console.log('Errors seen on the page:'); for (const e of errs.slice(0, 12)) console.log('  ' + e); }
process.exit(failed ? 1 : 0);
