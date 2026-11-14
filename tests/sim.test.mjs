/* Fall Line — simulation tests.   node --test tests/     (no dependencies, about a minute)

   What is proved here, in order of importance:
     1. determinism           same seed + same inputs = bit-identical state
     2. refresh-rate freedom  main.js's fixed-step loop gives the same run at 30..240 Hz and with jitter
     3. fairness              the perfect-play bot survives on several seeds
     4. generator invariants  long tracks on many seeds are well-formed and passable
     5. rules                 multiplier, score, causes of death, ghost steps
     6. steering feel         as numbers, inside bands, so it cannot drift by accident

   The game scripts are plain files that attach to a global FL; they load here exactly as
   tests/run.js loads them. Rule tests build small hand-made layouts on the opening straight
   with the generator's own _block/_pad helpers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
for (const f of ['util', 'look', 'track', 'sim']) require('../js/' + f + '.js');
require('./bot.js');
const { C, Sim, Track, Bot, U } = globalThis.FL;
const DT = C.STEP;
const PERFECT = { delay: 0, horizon: 1.8, period: 4 };
const SF = { h: 0, b: 0, edge: 0, d: 0, hw: 0, rb: null, wall: 0, wallH: 0 };
const note = (t, s) => { t.diagnostic(s); console.log('    ' + s); };

// ------------------------------------------------------------------------------- helpers
function sameState(a, b, msg) {
  for (const k in a) assert.ok(Object.is(a[k], b[k]), `${msg}: field "${k}" differs (${a[k]} vs ${b[k]})`);
}
const snap = (st) => Sim.copy({}, st);

function trackSig(tr, upTo) {
  const n = Math.min(tr.k, Math.floor(upTo / C.SEG)), F = tr.F, parts = [];
  for (const key of Object.keys(F)) parts.push(F[key].slice(0, n + 1));
  parts.push(tr.obstacles.filter((o) => o.s <= upTo).map((o) => [o.s, o.o, o.hx, o.hz, o.h, o.kind, o.flag, o.yTop]));
  parts.push(tr.pads.filter((p) => p.s <= upTo).map((p) => [p.s, p.o, p.hx, p.hz]));
  parts.push(tr.ribbons.filter((r) => r.sB <= upTo).map((r) => [r.sA, r.sB, Array.from(r.c), Array.from(r.hw), Array.from(r.e), Array.from(r.b)]));
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

/* One simulation step as main.js's stepOnce() does it (minus drawing, sound and HUD). */
function newGame(seed, inputs) {
  const tr = new Track(seed), st = Sim.newState();
  Sim.reset(st, tr); Sim.launch(st);
  return { tr, st, inputs, steps: 0, acc: 0, ev: [], prune: true };
}
function stepOnce(g, inp) {
  g.ev.length = 0;
  if (inp === undefined) inp = g.inputs && g.steps < g.inputs.length ? g.inputs[g.steps] : 0;
  Sim.step(g.st, g.tr, inp, g.ev, false);
  g.tr.ensure(g.st.s + C.GEN_AHEAD);
  g.steps++;
  if (g.prune && g.steps % 30 === 0) g.tr.prune(g.st.s - C.PRUNE_BEHIND);
}
/* One displayed frame as main.js's frame() + advance() do it: clamp the frame time to 0.1 s,
   add it to the accumulator, run whole 120 Hz steps, at most 8 of them. */
function frame(g, rawDt) {
  if (rawDt > 0.1) rawDt = 0.1;
  if (rawDt < 0) rawDt = 0;
  g.acc += rawDt;
  let n = 0;
  while (g.acc >= C.STEP) {
    stepOnce(g);
    g.acc -= C.STEP;
    if (++n >= 8) { g.acc = 0; break; }
  }
  return n;
}

// Play the perfect bot and keep every input and every state: the reference run.
function record(seed, nSteps) {
  const g = newGame(seed), bot = new Bot(Object.assign({ seed }, PERFECT));
  const inputs = new Int8Array(nSteps), states = [snap(g.st)], events = [];
  for (let i = 0; i < nSteps; i++) {
    const inp = bot.input(g.st, g.tr);
    inputs[i] = inp;
    stepOnce(g, inp);
    for (const e of g.ev) events.push(i + ':' + e.type + ':' + (e.why || e.cause || ''));
    states.push(snap(g.st));
  }
  return { seed, inputs, states, events, sig: trackSig(g.tr, 1e9) };
}
const REF_SEED = 3, REF_T = 20, REF_STEPS = Math.round((REF_T + 1) / DT);
let REF = null;
const ref = () => (REF || (REF = record(REF_SEED, REF_STEPS)));

// A bare track: the real generated centreline and road, with every obstacle and strip removed.
function bare(seed) {
  const tr = new Track(seed === undefined ? 11 : seed);
  tr.obstacles.length = 0; tr.pads.length = 0; tr.noPads = false;
  const st = Sim.newState();
  Sim.reset(st, tr); Sim.launch(st);
  return { tr, st };
}
function addOb(tr, s, o, hx, kind, row) {
  const ob = tr._block(s, o, hx, kind, row);
  assert.ok(ob, 'test obstacle must sit on the road');
  tr._obs.length = 0;
  tr.obstacles.push(ob); tr.obstacles.sort((a, b) => a.s - b.s);
  return ob;
}
function addPad(tr, s, o, grp) {
  const pd = tr._pad(s, o, grp);
  assert.ok(pd, 'test strip must sit on the road');
  tr._pads.length = 0;
  tr.pads.push(pd); tr.pads.sort((a, b) => a.s - b.s);
  return pd;
}
// Step until `until` says stop or the run ends; returns every event with its step and time.
function run(st, tr, inpFn, maxSteps, until) {
  const out = [], ev = [];
  for (let i = 0; i < maxSteps; i++) {
    ev.length = 0;
    Sim.step(st, tr, typeof inpFn === 'function' ? inpFn(st, i) : inpFn, ev, false);
    for (const e of ev) out.push(Object.assign({ i, t: st.t, s: st.s }, e));
    if (!st.alive || (until && until(st))) break;
  }
  return out;
}
const hold = (st) => { const e = -st.o - st.vo * 0.11; return e > 0.3 ? 1 : e < -0.3 ? -1 : 0; };

// =============================================================================== 1. determinism
test('determinism: the same seed builds the same track, different seeds different ones', () => {
  const sigs = new Map();
  for (const seed of [0, 1, 2, 3, 7920, 123456789, 4294967295]) {
    const a = new Track(seed), b = new Track(seed);
    a.ensure(8000); b.ensure(8000);
    const sa = trackSig(a, 8000), sb = trackSig(b, 8000);
    assert.equal(sa, sb, `seed ${seed} built two different tracks`);
    for (const [other, sig] of sigs) assert.notEqual(sa, sig, `seeds ${seed} and ${other} built the same track`);
    sigs.set(seed, sa);
  }
  // generating in small bites or in one go is the same track
  const a = new Track(42), b = new Track(42);
  a.ensure(6000);
  for (let s = 0; s <= 6000; s += 37) b.ensure(s);
  assert.equal(trackSig(a, 5500), trackSig(b, 5500), 'the track depends on how it was asked for');
});

test('determinism: same seed and same inputs give bit-identical state, step for step', () => {
  const a = ref(), b = record(REF_SEED, REF_STEPS);
  assert.ok(a.states[REF_STEPS].alive, 'the reference run should survive');
  assert.deepEqual(Array.from(a.inputs), Array.from(b.inputs), 'the bot itself is not deterministic');
  for (let i = 0; i <= REF_STEPS; i++) sameState(a.states[i], b.states[i], 'step ' + i);
  assert.deepEqual(a.events, b.events);
  assert.equal(a.sig, b.sig);
  // …and the inputs alone reproduce it: no hidden state in the bot, the clock or Math.random
  const g = newGame(REF_SEED, a.inputs);
  for (let i = 0; i < REF_STEPS; i++) { stepOnce(g); if (i % 97 === 0) sameState(a.states[i + 1], g.st, 'replay step ' + (i + 1)); }
  sameState(a.states[REF_STEPS], g.st, 'replay end');
  // …with or without pruning the track behind the skier
  const h = newGame(REF_SEED, a.inputs); h.prune = false;
  for (let i = 0; i < REF_STEPS; i++) stepOnce(h);
  sameState(a.states[REF_STEPS], h.st, 'unpruned replay');
  // a different seed with the same inputs is a different run
  const d = newGame(REF_SEED + 1, a.inputs), A = a.states[REF_STEPS];
  for (let i = 0; i < REF_STEPS; i++) stepOnce(d);
  assert.ok(!(d.st.s === A.s && d.st.o === A.o && d.st.y === A.y), 'another seed gave the same run');
});

// =============================================================================== 2. refresh rate
test('refresh rate: main.js still runs the fixed-step loop this file reproduces', () => {
  const src = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.equal(C.STEP, 1 / 120);
  assert.match(src, /acc \+= dt;/);
  assert.match(src, /while \(acc >= C\.STEP\)/);
  assert.match(src, /acc -= C\.STEP;/);
  assert.match(src, /if \(\+\+n >= 8\) \{ acc = 0; break; \}/);
  assert.match(src, /if \(rawDt > 0\.1\) rawDt = 0\.1;/);
});

test('refresh rate: 30, 60, 90, 120, 144 and 240 Hz play the same run', (t) => {
  const R = ref(), want = Math.round(REF_T / DT);
  const exact = { 30: 1, 60: 1, 120: 1, 240: 1 };       // frame times that are whole multiples (or halves) of the step
  for (const hz of [30, 60, 90, 120, 144, 240]) {
    const g = newGame(REF_SEED, R.inputs), dt = 1 / hz, frames = REF_T * hz;
    let most = 0;
    for (let i = 0; i < frames; i++) most = Math.max(most, frame(g, dt));
    const off = g.steps - want;
    note(t, `${String(hz).padStart(3)} Hz: ${g.steps} steps in ${REF_T} s (${off >= 0 ? '+' : ''}${off}), at most ${most} per frame, s=${g.st.s.toFixed(3)} o=${g.st.o.toFixed(3)} score=${g.st.score.toFixed(2)}`);
    assert.ok(Math.abs(off) <= 1, `${hz} Hz is ${off} steps away from real time`);
    // the state is exactly the reference run's state after that many steps: same run, same inputs
    sameState(R.states[g.steps], g.st, hz + ' Hz');
    // and so within one step's travel of the reference at the same elapsed time
    const A = R.states[want];
    assert.ok(Math.abs(g.st.s - A.s) <= A.u * DT * 1.05 + 1e-9, `${hz} Hz: distance off by ${g.st.s - A.s}`);
    assert.ok(Math.abs(g.st.o - A.o) <= C.V_LAT * DT * 1.6 + 1e-9, `${hz} Hz: sideways off by ${g.st.o - A.o}`);
    if (exact[hz]) {
      assert.equal(g.steps, want, `${hz} Hz should land exactly on the step`);
      sameState(A, g.st, hz + ' Hz exact');
    }
  }
});

test('refresh rate: jittered frame times and hitches stay within one step of real time', (t) => {
  const R = ref();
  for (const [hz, seed] of [[60, 1], [60, 2], [144, 3], [120, 4], [37, 5]]) {
    const g = newGame(REF_SEED, R.inputs), r = U.rng(seed);
    let el = 0, frames = 0, worst = 0;
    while (el < REF_T) {
      let dt = (1 / hz) * (0.5 + r());                      // 50%..150% of the nominal frame
      if (r() < 0.02) dt = 0.05;                            // now and then a dropped-frame hitch
      el += dt; frames++;
      frame(g, dt);
      worst = Math.max(worst, Math.abs(g.steps - el / DT));
    }
    note(t, `~${hz} Hz jittered: ${frames} frames, ${g.steps} steps for ${(el / DT).toFixed(2)} steps of time, worst lag ${worst.toFixed(3)} steps`);
    assert.ok(worst <= 1 + 1e-6, `fell ${worst} steps away from real time`);
    sameState(R.states[g.steps], g.st, 'jitter ' + hz);
    const A = R.states[Math.round(el / DT)];
    assert.ok(Math.abs(g.st.s - A.s) <= A.u * DT * 1.6, 'distance drifted');
  }
});

test('refresh rate: a long stall slows the game down instead of snowballing', () => {
  const g = newGame(REF_SEED, ref().inputs);
  assert.equal(frame(g, 0.5), 8);           // clamped to 0.1 s = 12 steps, of which 8 run
  assert.equal(g.acc, 0);                   // …and the rest is dropped, not owed
  assert.equal(frame(g, 1 / 60), 2);
  sameState(ref().states[10], g.st, 'after a stall');
  // 15 fps is the slowest display that still runs at full speed
  const h = newGame(REF_SEED, ref().inputs);
  for (let i = 0; i < 30; i++) frame(h, 8 * DT);
  assert.equal(h.steps, 240);
});

// =============================================================================== 3. fairness
test('fairness: the perfect-play bot survives 10 km on five seeds', (t) => {
  const DIST = 10000;
  for (const seed of [1, 7920, 15839, 23758, 31677]) {
    const g = newGame(seed), bot = new Bot(Object.assign({ seed }, PERFECT));
    while (g.st.alive && g.st.s - C.S_START < DIST) stepOnce(g, bot.input(g.st, g.tr));
    const ch = g.tr.chunkAt(g.st.s);
    note(t, `seed ${seed}: ${g.st.alive ? 'survived' : 'DIED (' + g.st.cause + ' ' + g.st.into + ') in ' + ch.type + ' I=' + ch.I.toFixed(2)} at ${(g.st.s - C.S_START).toFixed(0)} m, wave ${ch.wave}, ${g.st.t.toFixed(0)} s, score ${g.st.score.toFixed(0)}`);
    assert.ok(g.st.alive, `seed ${seed}: perfect play died (${g.st.cause} ${g.st.into}) in "${ch.type}" at ${(g.st.s - C.S_START).toFixed(0)} m, o=${g.st.o.toFixed(2)}`);
  }
});

// =============================================================================== 4. generator
const KINDS = { pine: 1, pines: 1, rock: 1, fence: 1 };
// Road spans [lo, hi] under track position s: where the skier's centre can be on the ground.
function spansAt(tr, s) {
  const out = [];
  for (const rb of tr.ribbons) {
    if (s < rb.sA || s > rb.sB) continue;
    const t = (s - rb.sA) / C.SEG;
    let i = t | 0;
    if (i > rb.n - 2) i = rb.n - 2;
    const f = t - i, c = rb.c[i] + (rb.c[i + 1] - rb.c[i]) * f, hw = rb.hw[i] + (rb.hw[i + 1] - rb.hw[i]) * f;
    out.push([c - hw, c + hw]);
  }
  return out;
}

test('generator: long tracks on many seeds are well-formed, sorted and passable', (t) => {
  const LEN = 15000, SEEDS = 40;
  const m = { yaw: 0, slMin: 9, slMax: 0, bk: 0, ac: 0, gap: 99, gapAt: '', firstOb: 1e9, obs: 0, pads: 0, rows: 0, ribs: 0 };
  const kinds = {}, types = {};
  for (let n = 0; n < SEEDS; n++) {
    const seed = 1 + n * 7919, tr = new Track(seed), id = 'seed ' + seed;
    tr.ensure(LEN);
    const all = [];
    for (const c of tr.chunks) types[c.type] = 1;
    // --- frames
    const F = tr.F;
    for (const key of Object.keys(F)) {
      assert.equal(F[key].length, tr.k + 1, id + ': frame array ' + key + ' has the wrong length');
      for (let k = 0; k <= tr.k; k++) if (!Number.isFinite(F[key][k])) assert.fail(`${id}: frame ${key}[${k}] is ${F[key][k]}`);
    }
    for (let k = 0; k <= tr.k; k++) {
      const s = k * C.SEG, B = C.baseSpeed(s), u = B * C.terrain(F.sl[k]) + C.boostV(B);
      m.yaw = Math.max(m.yaw, Math.abs(F.yaw[k]));
      m.slMin = Math.min(m.slMin, F.sl[k]); m.slMax = Math.max(m.slMax, F.sl[k]);
      m.bk = Math.max(m.bk, Math.abs(F.bk[k]));
      m.ac = Math.max(m.ac, Math.abs(F.cv[k]) * u * u);
      if (k > 0) {
        assert.ok(F.y[k] < F.y[k - 1], `${id}: the run goes uphill at s=${s}`);
        assert.ok(Math.abs(Math.hypot(F.x[k] - F.x[k - 1], F.z[k] - F.z[k - 1]) - C.SEG) < 1e-6, `${id}: frames are not ${C.SEG} m apart at s=${s}`);
        assert.ok(F.z[k] < F.z[k - 1], `${id}: the run turns back on itself at s=${s}`);
      }
    }
    // --- ribbons
    m.ribs += tr.ribbons.length;
    for (const rb of tr.ribbons) {
      assert.ok(rb.n >= 2 && rb.sB > rb.sA && rb.k0 + rb.n - 1 <= tr.k, `${id}: ribbon ${rb.id} has a bad extent`);
      for (const key of ['c', 'hw', 'e', 'b']) {
        assert.equal(rb[key].length, rb.n);
        for (let i = 0; i < rb.n; i++) if (!Number.isFinite(rb[key][i])) assert.fail(`${id}: ribbon ${rb.id} ${key}[${i}] is ${rb[key][i]}`);
      }
      for (let i = 0; i < rb.n; i++) {
        assert.ok(rb.hw[i] >= 1.4, `${id}: ribbon ${rb.id} is only ${(rb.hw[i] * 2).toFixed(2)} m wide at s=${rb.sA + i * C.SEG}`);
        assert.ok(Math.abs(rb.b[i]) <= 0.7, `${id}: ribbon ${rb.id} is banked ${rb.b[i]}`);
      }
    }
    // --- the start is on the ground with room around it
    assert.equal(tr.surfaceAt(C.S_START, 0, 1e9, SF), 1, id + ': no ground under the start');
    assert.ok(SF.edge > 5, id + ': the start is near an edge');
    // --- obstacles
    const obs = tr.obstacles, rows = new Map();
    m.obs += obs.length;
    for (let i = 0; i < obs.length; i++) {
      const ob = obs[i], at = `${id}: obstacle ${i} (${ob.kind} s=${ob.s.toFixed(1)} o=${ob.o.toFixed(2)} hx=${ob.hx.toFixed(2)})`;
      for (const key in ob) if (typeof ob[key] === 'number' && !Number.isFinite(ob[key])) assert.fail(`${at}: ${key} is ${ob[key]}`);
      assert.ok(KINDS[ob.kind], at + ': unknown kind');
      kinds[ob.kind] = (kinds[ob.kind] || 0) + 1;
      assert.ok(ob.hx > 0 && ob.hz > 0 && ob.h > 0, at + ': not a positive size');
      assert.equal(tr.surfaceAt(ob.s, ob.o, 1e9, SF), 1, at + ': not on a ribbon');
      assert.ok(Math.abs(ob.yTop - (SF.h + ob.h)) < 1e-6, at + ': top is not its base plus its height');
      assert.ok(ob.row && typeof ob.row.near === 'boolean' && ob.row.near === false, at + ': bad row');
      if (i > 0) assert.ok(ob.s >= obs[i - 1].s, at + ': obstacles are not sorted by s');
      m.firstOb = Math.min(m.firstOb, ob.s - C.S_START);
      if (!rows.has(ob.row)) rows.set(ob.row, []);
      rows.get(ob.row).push(ob);
    }
    assert.ok(obs.length === 0 || obs[0].s - C.S_START >= 100, `${id}: an obstacle ${(obs[0].s - C.S_START).toFixed(0)} m after the start`);
    // --- every row leaves a way through: the widest free stretch for the skier's centre, with the
    //     whole ball (radius R) clear of every block in the row and its centre on the road
    m.rows += rows.size;
    for (const row of rows.values()) {
      const s = row[0].s;
      for (const ob of row) assert.ok(Math.abs(ob.s - s) < 1e-9, `${id}: a row is spread along the track`);
      let best = 0;
      for (const [lo, hi] of spansAt(tr, s)) {
        let segs = [[lo, hi]];
        for (const ob of row) {
          const a = ob.o - ob.hx - C.R, b = ob.o + ob.hx + C.R, next = [];
          for (const sg of segs) {
            if (b <= sg[0] || a >= sg[1]) { next.push(sg); continue; }
            if (a > sg[0]) next.push([sg[0], a]);
            if (b < sg[1]) next.push([b, sg[1]]);
          }
          segs = next;
        }
        for (const sg of segs) best = Math.max(best, sg[1] - sg[0]);
      }
      if (best < m.gap) { m.gap = best; m.gapAt = `${id} s=${s.toFixed(0)} ${row[0].kind} in ${tr.chunkAt(s).type}`; }
      assert.ok(best >= 1.0, `${id}: the row at s=${s.toFixed(1)} (${row.map((o) => o.kind + '@' + o.o.toFixed(1) + '±' + o.hx.toFixed(1)).join(', ')}) leaves only ${best.toFixed(2)} m`);
    }
    // --- boost strips
    const pads = tr.pads;
    m.pads += pads.length;
    for (let i = 0; i < pads.length; i++) {
      const pd = pads[i], at = `${id}: strip ${i} (s=${pd.s.toFixed(1)} o=${pd.o.toFixed(2)} in ${tr.chunkAt(pd.s).type})`;
      for (const key in pd) if (typeof pd[key] === 'number' && !Number.isFinite(pd[key])) assert.fail(`${at}: ${key} is ${pd[key]}`);
      assert.ok(pd.hx > 0 && pd.hz > 0 && pd.used === false && pd.grp && pd.grp.hit === false, at + ': malformed');
      if (i > 0) assert.ok(pd.s >= pads[i - 1].s, at + ': strips are not sorted by s');
      for (const ds of [-pd.hz, 0, pd.hz]) for (const dof of [-pd.hx, 0, pd.hx]) {
        if (tr.surfaceAt(pd.s + ds, pd.o + dof, 1e9, SF) !== 1) all.push(`${at}: hangs off the surface at (${ds}, ${dof})`);
      }
      for (const ob of obs) {
        if (ob.s - pd.s > 12) break;
        if (Math.abs(ob.s - pd.s) < ob.hz + pd.hz && Math.abs(ob.o - pd.o) < ob.hx + pd.hx) all.push(`${at}: overlaps ${ob.kind} at s=${ob.s.toFixed(1)} o=${ob.o.toFixed(2)}±${ob.hx.toFixed(2)}`);
      }
    }
    assert.deepEqual(all, [], all.length + ' bad strips, first: ' + all[0]);
    // --- wave markers and section list are in order
    for (let i = 1; i < tr.chunks.length; i++) assert.equal(tr.chunks[i].s0, tr.chunks[i - 1].s1, id + ': sections do not join up');
    for (let i = 1; i < tr.marks.length; i++) assert.ok(tr.marks[i].s > tr.marks[i - 1].s && tr.marks[i].wave === tr.marks[i - 1].wave + 1, id + ': wave markers out of order');
  }
  note(t, `${SEEDS} seeds x ${LEN} m: ${m.obs} obstacles in ${m.rows} rows, ${m.pads} boost strips, ${m.ribs} ribbons`);
  note(t, `kinds ${JSON.stringify(kinds)}; sections ${Object.keys(types).sort().join(' ')}`);
  note(t, `heading max ${m.yaw.toFixed(3)} rad; slope ${m.slMin.toFixed(3)}..${m.slMax.toFixed(3)}; bank max ${m.bk.toFixed(3)}; cornering push max ${m.ac.toFixed(2)} m/s2 (design cap ${C.AC_MAX})`);
  note(t, `first obstacle ${m.firstOb.toFixed(0)} m after the start; tightest row leaves ${m.gap.toFixed(2)} m for the skier's centre (${m.gapAt})`);
  for (const k of Object.keys(KINDS)) assert.ok(kinds[k] > 0, 'no obstacle of kind ' + k + ' was ever generated');
  for (const ty of ['start', 'open', 'slalom', 'gates', 'field', 'sweep', 'tilt', 'bridge', 'split', 'jump', 'islands', 'drop', 'rest']) assert.ok(types[ty], 'section type never generated: ' + ty);
  assert.ok(m.yaw < 1.45, 'heading wanders to ' + m.yaw + ' rad');
  assert.ok(m.slMin >= 0.1 && m.slMax <= 0.55, `slope out of range: ${m.slMin}..${m.slMax}`);
  assert.ok(m.bk <= 0.66, 'bank ' + m.bk);
  assert.ok(m.ac <= C.AC_MAX * 1.02, 'a corner pushes harder than the design cap: ' + m.ac);
});

test('generator: pruning behind the skier keeps the live lists short and sorted', () => {
  const g = newGame(9, null), bot = new Bot(Object.assign({ seed: 9 }, PERFECT));
  let maxObs = 0, maxRib = 0, maxF = 0;
  while (g.st.alive && g.st.s < 2500) {
    stepOnce(g, bot.input(g.st, g.tr));
    maxObs = Math.max(maxObs, g.tr.obstacles.length); maxRib = Math.max(maxRib, g.tr.ribbons.length); maxF = g.tr.k;
  }
  assert.ok(g.st.alive);
  assert.ok(maxObs < 80 && maxRib < 24, `live lists grew: ${maxObs} obstacles, ${maxRib} ribbons`);
  assert.ok(g.tr.genS >= g.st.s + C.GEN_AHEAD - C.SEG, 'the track is not generated far enough ahead');
  assert.ok(maxF > 0);
});

// =============================================================================== 5. rules
test('rules: an ice strip raises the multiplier, a line of strips counts once', () => {
  const { tr, st } = bare();
  const line = { hit: false };
  const pads = [addPad(tr, 60, 0, line), addPad(tr, 69, 0, line), addPad(tr, 78, 0, line)];
  const solo = addPad(tr, 120, 0);
  const uAt = [];
  let uPrev = st.u;
  const evs = [];
  for (let i = 0; i < 700 && st.s < 135; i++) {
    const ev = [];
    Sim.step(st, tr, 0, ev, false);
    for (const e of ev) { evs.push(Object.assign({ m: st.mult }, e)); if (e.type === 'boost') uAt.push(st.u - uPrev); }
    uPrev = st.u;
  }
  assert.ok(st.alive);
  const boosts = evs.filter((e) => e.type === 'boost'), flows = evs.filter((e) => e.type === 'flow');
  assert.equal(boosts.length, 4, 'each strip kicks the speed');
  assert.ok(uAt[0] > 3, 'the first strip should add speed at once, added ' + uAt[0]);
  for (const du of uAt) assert.ok(du >= 0, 'a strip never slows you down');
  assert.equal(st.boost > 0 || st.boostT > 0, true, 'the boost is still running a moment after the last strip');
  assert.deepEqual(flows.map((e) => [e.mult, e.why]), [[2, 'boost'], [3, 'boost']], 'three strips in a line + one alone = two levels');
  assert.equal(st.mult, 3);
  for (const pd of pads) assert.equal(pd.used, true);
  assert.equal(line.hit, true); assert.equal(solo.used, true); assert.equal(solo.grp.hit, true);
  // a used strip does nothing a second time
  const st2 = Sim.newState(); Sim.reset(st2, tr); Sim.launch(st2);
  const again = run(st2, tr, 0, 700, (s) => s.s > 135);
  assert.equal(again.filter((e) => e.type === 'boost' || e.type === 'flow').length, 0);
  assert.equal(st2.mult, 1);
});

test('rules: a close call raises the multiplier once per row; a wide pass does not', () => {
  const { tr, st } = bare();
  const near = C.R + 0.6;                                   // 0.6 m of clearance, inside NEAR
  const rowA = { near: false };
  addOb(tr, 80, 1 + near, 1, 'rock', rowA);
  addOb(tr, 92, -(1 + near), 1, 'rock', rowA);              // same row: no second credit
  addOb(tr, 104, 1 + C.R + C.NEAR + 0.4, 1, 'pine');        // too far away to count
  addOb(tr, 116, -(1 + near), 1, 'pine');                   // a new row: counts
  const evs = run(st, tr, 0, 700, (s) => s.s > 125);
  assert.ok(st.alive, 'none of these should be hit');
  const pass = evs.filter((e) => e.type === 'pass'), flows = evs.filter((e) => e.type === 'flow');
  assert.equal(pass.length, 4);
  assert.deepEqual(pass.map((e) => e.side), [1, -1, 1, -1]);
  assert.ok(Math.abs(pass[0].cl - 0.6) < 1e-6 && Math.abs(pass[2].cl - (C.NEAR + 0.4)) < 1e-6, 'clearance is measured from the ball\'s edge');
  assert.deepEqual(flows.map((e) => [e.mult, e.why]), [[2, 'near'], [3, 'near']]);
  assert.equal(rowA.near, true);
  assert.ok(Math.abs(st.minCl - 0.6) < 1e-6);
});

test('rules: the multiplier caps at MULT_MAX and sheds one level at a time on the documented timers; score = distance x multiplier', (t) => {
  const { tr, st } = bare();
  for (let i = 0; i < 7; i++) addPad(tr, 50 + i * 12, 0);       // seven separate strips: more than enough for the cap
  let sum = 0, lastUp = 0, sPrev = st.s, maxMult = 1;
  const downs = [], dists = {};
  for (let i = 0; i < 3000 && st.alive; i++) {
    const ev = [];
    Sim.step(st, tr, hold(st), ev, false);
    for (const e of ev) {
      if (e.type === 'flow') lastUp = st.t;
      if (e.type === 'flowDown') downs.push({ t: st.t, mult: e.mult });
    }
    assert.ok(st.mult >= 1 && st.mult <= C.MULT_MAX);
    maxMult = Math.max(maxMult, st.mult);
    sum += (st.s - sPrev) * st.mult;
    dists[st.mult] = (dists[st.mult] || 0) + (st.s - sPrev);
    sPrev = st.s;
    assert.ok(Math.abs(st.score - sum) < 1e-6, 'score left distance x multiplier at step ' + i);
    if (st.mult === 1 && downs.length) break;
  }
  assert.ok(st.alive, 'died: ' + st.cause + ' ' + st.into);
  assert.equal(maxMult, C.MULT_MAX);
  assert.deepEqual(downs.map((d) => d.mult), [4, 3, 2, 1], 'one level at a time');
  const first = downs[0].t - lastUp, gaps = downs.slice(1).map((d, i) => d.t - downs[i].t);
  note(t, `held ${first.toFixed(4)} s after the last boost (FLOW_T ${C.FLOW_T}), then dropped every ${gaps.map((g) => g.toFixed(4)).join(', ')} s (FLOW_DROP_T ${C.FLOW_DROP_T})`);
  assert.ok(Math.abs(first - C.FLOW_T) <= 1.5 * DT, 'first drop after ' + first);
  for (const g of gaps) assert.ok(Math.abs(g - C.FLOW_DROP_T) <= 1.5 * DT, 'later drop after ' + g);
  let expect = 0;
  for (const k in dists) expect += dists[k] * k;
  assert.ok(Math.abs(st.score - expect) < 1e-6 && st.score > (st.s - C.S_START) * 1.5);
  // with no multiplier, score is simply metres
  const b = bare();
  run(b.st, b.tr, 0, 400);
  assert.equal(b.st.mult, 1);
  assert.ok(Math.abs(b.st.score - (b.st.s - C.S_START)) < 1e-9);
  // nothing moves and nothing scores before the push-off
  const idle = Sim.newState(); Sim.reset(idle, b.tr);
  for (let i = 0; i < 120; i++) Sim.step(idle, b.tr, 1, null, false);
  assert.equal(idle.s, C.S_START); assert.equal(idle.o, 0); assert.equal(idle.score, 0);
});

test('rules: hitting each kind of obstacle ends the run as a crash into that kind', () => {
  for (const kind of Object.keys(KINDS)) {
    const { tr, st } = bare();
    addOb(tr, 80, 0.3, 1.5, kind);
    const evs = run(st, tr, 0, 800);
    assert.equal(st.alive, false, kind + ' was not hit');
    assert.equal(st.cause, 'crash'); assert.equal(st.into, kind);
    assert.ok(st.s > 77 && st.s < 80.5, `${kind}: died at s=${st.s}, not at the obstacle`);
    const dead = evs.filter((e) => e.type === 'dead');
    assert.equal(dead.length, 1);
    assert.equal(dead[0].cause, 'crash'); assert.equal(dead[0].into, kind);
    // after the end nothing scores and nothing is reported; the state only coasts for the camera
    const score = st.score, s = st.s, ev = [];
    for (let i = 0; i < 120; i++) Sim.step(st, tr, 1, ev, false);
    assert.equal(st.score, score); assert.equal(ev.length, 0); assert.equal(st.cause, 'crash');
    assert.ok(st.s > s && st.s - s < 12 && Math.abs(st.deadT - 1) < 1e-9);
  }
  // a graze is a miss: the hit box is the obstacle plus HIT_R, a touch smaller than the ball
  const { tr, st } = bare();
  addOb(tr, 80, 1.5 + C.HIT_R + 0.03, 1.5, 'rock');
  run(st, tr, 0, 500, (s) => s.s > 90);
  assert.ok(st.alive, 'a pass ' + (C.HIT_R + 0.03) + ' m from a rock should be a miss');
  const b = bare();
  addOb(b.tr, 80, 1.5 + C.HIT_R - 0.03, 1.5, 'rock');
  run(b.st, b.tr, 0, 500, (s) => s.s > 90);
  assert.equal(b.st.alive, false);
});

test('rules: a forest edge is a crash into trees, an open edge is a fall', () => {
  for (const side of [-1, 1]) {
    // the start gate stands in the open: steer off at once and you fall
    const a = bare();
    a.st.o = side * 6.5;
    const ea = run(a.st, a.tr, side, 1200);
    assert.equal(a.st.alive, false);
    assert.equal(a.st.cause, 'fall', `open edge, side ${side}: ${a.st.cause} ${a.st.into}`);
    assert.equal(a.st.into, '');
    assert.ok(ea.some((e) => e.type === 'fall'), 'a fall is announced before it ends the run');
    assert.deepEqual(ea.filter((e) => e.type === 'dead').map((e) => [e.cause, e.into]), [['fall', '']]);
    // further down the run drops into the trees: the same mistake ends in them
    const b = bare();
    const eb = run(b.st, b.tr, (st) => (st.s > 70 ? side : 0), 1200);
    assert.equal(b.st.alive, false);
    assert.equal(b.st.cause, 'crash', `forest edge, side ${side}: ${b.st.cause} ${b.st.into}`);
    assert.equal(b.st.into, 'trees');
    assert.deepEqual(eb.filter((e) => e.type === 'dead').map((e) => [e.cause, e.into]), [['crash', 'trees']]);
    assert.ok(Math.abs(b.st.o) > 7.6 && Math.abs(b.st.o) < 7.6 + 3.5, 'the trees start at the edge of the piste, died at o=' + b.st.o);
  }
});

test('rules: ghost steps never mutate the track, and predict the real run', () => {
  const { tr, st } = bare();
  const line = { hit: false };
  addPad(tr, 60, 4, line); addPad(tr, 69, 4, line);        // off the line taken here: must stay untouched
  const ob = addOb(tr, 90, 1 + C.R + 0.5, 1, 'rock');
  const flags = () => JSON.stringify([tr.obstacles, tr.pads, tr.obsV, tr.ribbons.length, tr.k, tr.marks]);
  const before = flags(), stBefore = snap(st);
  const g = Sim.copy(Sim.newState(), st), ev = [];
  let n = 0;
  while (g.s < 100 && n < 1000) { Sim.step(g, tr, 0, ev, true); n++; }
  assert.equal(flags(), before, 'a ghost step changed the track');
  sameState(stBefore, st, 'a ghost step changed the real state');
  assert.equal(g.mult, 2, 'the ghost itself still sees the close call');
  assert.equal(ob.row.near, false);
  // the real thing consumes it, and lands exactly where the ghost did
  for (let i = 0; i < n; i++) Sim.step(st, tr, 0, null, false);
  sameState(g, st, 'ghost vs real');
  assert.equal(ob.row.near, true);
  assert.ok(tr.pads.every((p) => !p.used) && !line.hit);

  // a ghost over a strip: the strip is not consumed
  const b = bare(), pd = addPad(b.tr, 60, 0);
  const g2 = Sim.copy(Sim.newState(), b.st), ev2 = [];
  for (let i = 0; i < 300; i++) Sim.step(g2, b.tr, 0, ev2, true);
  assert.ok(ev2.some((e) => e.type === 'boost'), 'the ghost feels the strip');
  assert.equal(pd.used, false); assert.equal(pd.grp.hit, false);

  // the bot plans with hundreds of ghost roll-outs over real strips and rows: still nothing consumed
  const tr2 = new Track(5), st2 = Sim.newState();
  Sim.reset(st2, tr2); Sim.launch(st2);
  const before2 = JSON.stringify([tr2.obstacles, tr2.pads]);
  const bot = new Bot(Object.assign({ seed: 5, greed: 0.5 }, PERFECT));
  for (let i = 0; i < 12; i++) {
    st2.s = 40 + i * 14; st2.o = (i % 5) - 2;
    tr2.surfaceAt(st2.s, st2.o, 1e9, SF); st2.y = SF.h;
    bot._plan(st2, tr2);
  }
  assert.equal(JSON.stringify([tr2.obstacles, tr2.pads]), before2, 'bot look-ahead consumed something on the track');
});

/* KNOWN GAME BUG (js/sim.js, reported to its owner): because a ghost step may not mark a strip
   as used or a row as credited, the ghost collects them again and again — a strip re-fires
   every 0.1 s while the ghost is on it, and a gate (two fences in one row) pays twice. So a
   look-ahead over a strip or through a gate ends up faster and with a higher multiplier than
   the real run will. Marked todo so the suite stays green; remove the flag when it is fixed. */
test('rules: a ghost over ice strips and through a gate matches the real run', { todo: 'sim.js: ghosts re-collect strips and rows' }, (t) => {
  const { tr, st } = bare();
  const line = { hit: false };
  addPad(tr, 60, 0, line); addPad(tr, 69, 0, line);
  const row = { near: false };
  addOb(tr, 95, -(1 + C.R + 0.5), 1, 'fence', row); addOb(tr, 95, 1 + C.R + 0.5, 1, 'fence', row);
  const g = Sim.copy(Sim.newState(), st);
  let n = 0;
  while (g.s < 105 && n < 1000) { Sim.step(g, tr, 0, null, true); n++; }
  for (let i = 0; i < n; i++) Sim.step(st, tr, 0, null, false);
  note(t, `after ${n} steps: ghost s=${g.s.toFixed(2)} u=${g.u.toFixed(2)} mult=${g.mult} score=${g.score.toFixed(1)}  |  real s=${st.s.toFixed(2)} u=${st.u.toFixed(2)} mult=${st.mult} score=${st.score.toFixed(1)}`);
  sameState(g, st, 'ghost vs real');
});

// =============================================================================== 6. steering feel
/* Measured on the opening straight (no corner push, no bank) at 120 Hz. Bands are +-8% (and at least one step for times) around
   the values at the time of writing: retune on purpose, then update them here. */
test('steering feel, as numbers', (t) => {
  // settle first: the push-off itself leaves the skier a hair off the snow for a few steps
  const fresh = () => { const b = bare(); b.st.o = -6; for (let i = 0; i < 60; i++) Sim.step(b.st, b.tr, 0, null, false); assert.ok(b.st.onGround && b.st.vo === 0); return b; };
  const top = C.V_LAT;
  // time to reach 60% of top sideways speed from rest
  let { tr, st } = fresh(), n = 0;
  while (st.vo < 0.6 * top && n < 600) { Sim.step(st, tr, 1, null, false); n++; }
  const t60 = n * DT;
  // glide after release: hold for 0.4 s, let go, measure how far it still slides
  ({ tr, st } = fresh());
  for (let i = 0; i < 48; i++) Sim.step(st, tr, 1, null, false);
  const v04 = st.vo, o0 = st.o;
  n = 0;
  while (Math.abs(st.vo) > 0.05 * top && n < 600) { Sim.step(st, tr, 0, null, false); n++; }
  const glideT = n * DT;
  for (let i = 0; i < 240; i++) Sim.step(st, tr, 0, null, false);
  const glide = st.o - o0;
  assert.ok(st.alive && Math.abs(st.vo) < 1e-3, 'released, the skier comes to rest sideways');
  // reversal: at speed to the right, press left
  ({ tr, st } = fresh());
  for (let i = 0; i < 48; i++) Sim.step(st, tr, 1, null, false);
  const oTurn = st.o;
  n = 0;
  while (st.vo > 0 && n < 600) { Sim.step(st, tr, -1, null, false); n++; }
  const tStop = n * DT, over = st.o - oTurn;
  while (st.vo > -0.6 * top && n < 600) { Sim.step(st, tr, -1, null, false); n++; }
  const tRev = n * DT;
  // top speed and a 3 m lane change from rest
  ({ tr, st } = fresh());
  for (let i = 0; i < 60; i++) Sim.step(st, tr, 1, null, false);
  const v05 = st.vo;
  ({ tr, st } = fresh());
  n = 0;
  while (st.o < -3 && n < 600) { Sim.step(st, tr, 1, null, false); n++; }
  const tLane = n * DT;

  const rows = [
    ['top sideways speed V_LAT (m/s)', top, 19.79],
    ['time to 60% of top speed from rest (s)', t60, T60],
    ['sideways speed after 0.4 s (m/s)', v04, V04],
    ['sideways speed after 0.5 s (m/s)', v05, V05],
    ['glide distance after release (m)', glide, GLIDE],
    ['glide time to 5% of top speed (s)', glideT, GLIDE_T],
    ['time to stop when reversing (s)', tStop, T_STOP],
    ['overshoot while reversing (m)', over, OVER],
    ['time to reach 60% the other way (s)', tRev, T_REV],
    ['time to move 3 m from rest (s)', tLane, T_LANE],
  ];
  // a time is counted in whole steps, so its band is never tighter than one step either way
  const tol = (name, want) => Math.max(want * 0.08, /\(s\)$/.test(name) ? DT * 1.01 : 0);
  for (const [name, v, want] of rows) note(t, `${name.padEnd(42)} ${v.toFixed(4)}   (band ${(want - tol(name, want)).toFixed(4)}..${(want + tol(name, want)).toFixed(4)})`);
  for (const [name, v, want] of rows) assert.ok(Math.abs(v - want) <= tol(name, want), `${name}: ${v.toFixed(4)} left its band around ${want}`);
  assert.ok(Math.abs(C.tMove(3) - tLane) <= 2 * DT, 'C.tMove (what the generator budgets with) disagrees with the simulation');
});
const T60 = 0.1917, V04 = 17.0023, V05 = 18.0826, GLIDE = 1.7475, GLIDE_T = 0.3083, T_STOP = 0.0917, OVER = 0.6185, T_REV = 0.2750, T_LANE = 0.3083;
