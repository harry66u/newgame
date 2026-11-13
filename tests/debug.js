// node tests/debug.js <seed> <maxDist> — replay the perfect bot and dump the last moments before a death
const path = require('path');
for (const f of ['util', 'track', 'sim']) require(path.join('..', 'js', f + '.js'));
require('./bot.js');
const { C, Sim, Track, Bot } = FL;
const seed = +process.argv[2], maxDist = +(process.argv[3] || 30000);
const opts = process.argv[4] ? JSON.parse(process.argv[4]) : { delay: 0, horizon: 1.8, period: 4 };
const tr = new Track(seed), st = Sim.newState(), bot = new Bot(Object.assign({ seed }, opts)), ev = [];
Sim.reset(st, tr); Sim.launch(st);
const log = []; let steps = 0;
while (st.alive && st.s - C.S_START < maxDist) {
  tr.ensure(st.s + C.GEN_AHEAD);
  if (steps % 30 === 0) tr.prune(st.s - C.PRUNE_BEHIND);
  const inp = bot.input(st, tr);
  Sim.step(st, tr, inp, ev, false);
  log.push(`s=${st.s.toFixed(1)} o=${st.o.toFixed(2)} vo=${st.vo.toFixed(1)} y=${st.y.toFixed(2)} u=${st.u.toFixed(1)} g=${st.onGround ? 1 : 0} air=${st.air.toFixed(2)} under=${st.under ? 1 : 0} fall=${st.falling ? 1 : 0} inp=${inp} tgt=${bot.target.toFixed(1)} gb=${st.gb.toFixed(2)}`);
  if (log.length > 400) log.shift();
  steps++;
}
if (st.alive) { console.log('survived'); process.exit(0); }
const ch = tr.chunkAt(st.s);
console.log('DIED', st.cause, 'chunk', ch, 'dist', st.s);
for (let i = 0; i < log.length; i += 8) console.log(log[i]);
console.log('ribbons near:');
for (const rb of tr.ribbons) if (rb.sB > st.s - 120 && rb.sA < st.s + 60) console.log(`  [${rb.sA}..${rb.sB}] c=${rb.c[0].toFixed(1)}..${rb.c[rb.n - 1].toFixed(1)} hw=${rb.hw[0].toFixed(1)}..${rb.hw[rb.n - 1].toFixed(1)} b=${rb.b[1].toFixed(2)} capA=${rb.capA} capB=${rb.capB}`);
console.log('obstacles near:');
for (const ob of tr.obstacles) if (Math.abs(ob.s - st.s) < 80) console.log(`  s=${ob.s.toFixed(0)} o=${ob.o.toFixed(1)} hx=${ob.hx.toFixed(1)}`);
