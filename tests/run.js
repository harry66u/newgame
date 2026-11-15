/* Headless playtests:  node tests/run.js <mode> [seeds] [maxDist]
     fair   — perfect bot; any death means a layout was not beatable
     human  — delayed, imprecise bots; how far does an ordinary player get?
     chunks — what the generator actually produces */
const path = require('path');
for (const f of ['util', 'track', 'sim']) require(path.join('..', 'js', f + '.js'));
require('./bot.js');
const { C, Sim, Track, Bot } = FL;

function play(seed, botOpts, maxDist, onStep) {
  const tr = new Track(seed), st = Sim.newState(), bot = new Bot(Object.assign({ seed }, botOpts)), ev = [];
  Sim.reset(st, tr); Sim.launch(st);
  let steps = 0, flowSum = 0, boosts = 0, nears = 0, maxU = 0;
  while (st.alive && st.s - C.S_START < maxDist) {
    tr.ensure(st.s + C.GEN_AHEAD);
    if (steps % 30 === 0) tr.prune(st.s - C.PRUNE_BEHIND);
    ev.length = 0;
    Sim.step(st, tr, bot.input(st, tr), ev, false);
    for (const e of ev) { if (e.type === 'boost') boosts++; if (e.type === 'flow' && e.why === 'near') nears++; }
    flowSum += st.mult; if (st.u > maxU) maxU = st.u;
    if (onStep) onStep(st, tr, ev);
    steps++;
  }
  const ch = tr.chunkAt(st.s);
  return { seed, dist: st.s - C.S_START, score: st.score, time: st.t, alive: st.alive, cause: st.cause, chunk: ch.type, I: ch.I, wave: ch.wave,
    into: st.s - ch.s0, flow: flowSum / steps, boosts, nears, maxU, o: st.o };
}

const mode = process.argv[2] || 'fair';
const nSeeds = +(process.argv[3] || 8), maxDist = +(process.argv[4] || 15000), seed0 = +(process.argv[5] || 1);
const t0 = Date.now();

if (mode === 'fair') {
  let deaths = 0;
  for (let i = 0; i < nSeeds; i++) {
    const r = play(seed0 + i * 7919, { delay: 0, horizon: 1.8, period: 4 }, maxDist);
    if (!r.alive) deaths++;
    console.log(`seed ${r.seed}: ${r.alive ? 'SURVIVED' : 'DIED ' + r.cause + ' in ' + r.chunk + ' I=' + r.I.toFixed(2) + ' +' + r.into.toFixed(0) + 'm o=' + r.o.toFixed(1)} dist ${r.dist.toFixed(0)} wave ${r.wave} t ${r.time.toFixed(0)}s maxU ${r.maxU.toFixed(1)}`);
  }
  console.log(`deaths ${deaths}/${nSeeds}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
} else if (mode === 'human') {
  const kinds = {
    novice: { delay: 0.34, horizon: 0.95, period: 14, noise: 0.9, twoStage: false },
    average: { delay: 0.26, horizon: 1.1, period: 12, noise: 0.6, twoStage: false },
    good: { delay: 0.19, horizon: 1.3, period: 9, noise: 0.35, twoStage: false },
    greedy: { delay: 0.19, horizon: 1.3, period: 9, noise: 0.35, twoStage: false, greed: 0.5 },
  };
  for (const [name, opts] of Object.entries(kinds)) {
    const rs = [];
    for (let i = 0; i < nSeeds; i++) rs.push(play(seed0 + i * 7919, opts, maxDist));
    rs.sort((a, b) => a.dist - b.dist);
    const q = (p) => rs[Math.min(rs.length - 1, Math.floor(p * rs.length))];
    const by = {};
    for (const r of rs) if (!r.alive) { const k = r.cause + ':' + r.chunk; by[k] = (by[k] || 0) + 1; }
    const avg = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    console.log(`${name.padEnd(8)} dist p10 ${q(0.1).dist.toFixed(0)} p50 ${q(0.5).dist.toFixed(0)} p90 ${q(0.9).dist.toFixed(0)} | time p50 ${q(0.5).time.toFixed(0)}s | score p50 ${q(0.5).score.toFixed(0)} | flow ${avg((r) => r.flow).toFixed(2)} boosts/km ${(avg((r) => r.boosts / r.dist) * 1000).toFixed(1)} nears/km ${(avg((r) => r.nears / r.dist) * 1000).toFixed(1)}`);
    console.log('   deaths:', Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', '));
  }
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
} else if (mode === 'chunks') {
  const tr = new Track(seed0);
  const all = [];
  let seen = 0;
  while (tr.genS < maxDist) {
    tr.ensure(tr.genS + 1);
    for (const c of tr.chunks) if (c.s0 >= seen) { all.push(c); seen = c.s1; }
  }
  let w = -1, t = 0;
  for (const c of all) {
    const u = C.baseSpeed(c.s0);
    if (c.wave !== w) { w = c.wave; console.log(`--- wave ${w} @ ${c.s0}m  base ${u.toFixed(1)} m/s  t≈${t.toFixed(0)}s`); }
    const dur = (c.s1 - c.s0) / u; t += dur;
    console.log(`  ${c.type.padEnd(8)} I=${c.I.toFixed(2)} len ${(c.s1 - c.s0).toString().padStart(4)}m  ≈${dur.toFixed(1)}s`);
  }
}
