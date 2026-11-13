/* Playtest bots. They drive the real simulation by rolling ghost copies of the state forward
   and picking the steering target that survives. Not shipped with the game.
     perfect  — no reaction delay, long look-ahead: if it dies, the track was unfair (or it found a bug)
     human    — reacts late, sees less far, aims imprecisely: a stand-in for a real player
     greedy   — human, but chases boosts and close calls */
(function (root) {
  'use strict';
  const FL = root.FL, C = FL.C, Sim = FL.Sim;

  const ctrl = (g, tgt) => { const e = tgt - g.o - g.vo * 0.11; return e > 0.3 ? 1 : e < -0.3 ? -1 : 0; };

  class Bot {
    constructor(o) {
      o = o || {};
      this.delay = o.delay || 0;            // seconds before a new decision takes effect
      this.horizon = o.horizon || 1.8;      // seconds of look-ahead
      this.period = o.period || 6;          // steps between decisions
      this.noise = o.noise || 0;            // metres of aiming error
      this.greed = o.greed || 0;
      this.twoStage = o.twoStage !== false;
      this.rng = FL.U.rng(o.seed || 1);
      this.target = 0; this.pending = []; this.tick = 0;
      this.g = Sim.newState();
      this.lanes = [];
      for (let x = -9; x <= 9.01; x += 1.125) this.lanes.push(x);
    }

    // returns { ok, score }
    _roll(st, tr, t1, t2, sw, H) {
      const g = Sim.copy(this.g, st);
      g.minCl = 99;
      let minEdge = 9;
      const s0 = g.score;
      for (let i = 0; i < H; i++) {
        Sim.step(g, tr, ctrl(g, i < sw ? t1 : t2), null, true);
        if (!g.alive || g.falling || g.under) return { ok: false, score: i };
        if (g.onGround && g.edge < minEdge) minEdge = g.edge;
      }
      let score = 1000 + Math.min(minEdge, 1.6) * 14 + Math.min(Math.max(g.minCl, 0), 1.6) * 14 - Math.abs(t1) * 0.4;
      if (this.greed) score += (g.score - s0) * this.greed - Math.min(minEdge, 1.6) * 8 - Math.min(Math.max(g.minCl, 0), 1.6) * 10;
      return { ok: true, score };
    }

    _plan(st, tr) {
      const H = Math.round(this.horizon / C.STEP);
      const cur = this._roll(st, tr, this.target, this.target, H, H);
      // keep a working plan most of the time; look for a better line a few times a second
      if (cur.ok && !this.greed && (this.tick / this.period) % 4 !== 0) return this.target;
      let best = cur.ok ? cur.score + 3 : -1, bestT = this.target, anyOk = cur.ok;
      for (const t of this.lanes) {
        const r = this._roll(st, tr, t, t, H, H);
        if (r.ok) anyOk = true;
        const sc = r.score - (r.ok ? Math.abs(t - this.target) * 0.6 : 0);
        if (sc > best) { best = sc; bestT = t; }
      }
      if (!anyOk && this.twoStage) {
        for (const sw of [0.2, 0.4, 0.65, 0.9]) {
          const swN = Math.round(sw / C.STEP);
          for (const t1 of this.lanes) for (const t2 of this.lanes) {
            if (t1 === t2) continue;
            const r = this._roll(st, tr, t1, t2, swN, H);
            if (r.score > best) { best = r.score; bestT = t1; }
          }
          if (best >= 1000) break;
        }
      }
      return bestT;
    }

    input(st, tr) {
      if (this.tick % this.period === 0) {
        let t = this._plan(st, tr);
        if (this.noise) t += (this.rng() + this.rng() + this.rng() - 1.5) * this.noise * 1.4;
        if (this.delay) this.pending.push({ at: st.t + this.delay, t });
        else this.target = t;
      }
      this.tick++;
      while (this.pending.length && this.pending[0].at <= st.t) this.target = this.pending.shift().t;
      return ctrl(st, this.target);
    }
  }

  FL.Bot = Bot;
})(typeof window !== 'undefined' ? window : globalThis);
