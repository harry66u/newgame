/* Fall Line — procedural track.
   The track is a centreline (a list of frames every SEG metres: position, heading, slope,
   curvature, bank) with ribbons of drivable surface painted over it in track space:
   s = distance along the line, o = sideways offset from it. Gaps are simply stretches with no
   ribbon. Everything gameplay-relevant is generated from time budgets (how long a player has to
   see, decide and move at the fastest speed possible there), which is what keeps it fair. */
(function (root) {
  'use strict';
  const FL = root.FL;
  const { clamp, lerp, smooth } = FL.U;
  const C = FL.C;
  const SEG = C.SEG;
  const TAU = Math.PI * 2;

  const FR = { x: 0, y: 0, z: 0, yaw: 0, sl: 0, cv: 0, bk: 0, pal: 0, int: 0 };
  const SF = { h: 0, b: 0, edge: 0, d: 0, hw: 0, rb: null, wall: 0, wallH: 0 };
  const hash01 = (a, b) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); };

  /* Which sections run through forest — pines right up to the edge of the piste — rather than
     along an open ridge: [left, right]. Leaving a forested edge ends the run in the trees
     instead of in a fall; it is exactly as final, just a different view. */
  const NOWALL = [0, 0];
  const WALLS = { open: [1, 1], slalom: [1, 1], gates: [1, 1], field: [1, 1], sweep: [1, 1], tilt: [1, 1] };
  // Sections that always keep their boost strips; elsewhere a share of sections go without.
  const KEEP_PADS = { start: 1, rest: 1, drop: 1, jump: 1, bridge: 1, split: 1 };

  // Which wave each section type first appears in, and how often it is picked.
  const TYPES = {
    open: { w: 0, wt: 0.6 }, slalom: { w: 0, wt: 1 }, sweep: { w: 0, wt: 0.9 }, field: { w: 0, wt: 1 },
    gates: { w: 0, wt: 1 }, bridge: { w: 1, wt: 0.9 }, jump: { w: 1, wt: 1 }, tilt: { w: 1, wt: 0.8 },
    split: { w: 2, wt: 0.85 }, islands: { w: 2, wt: 0.9 },
  };

  class Track {
    constructor(seed) {
      this.seed = seed >>> 0;
      this.rng = FL.U.rng(this.seed);
      // Scenery draws from its own stream, so nothing cosmetic can ever change a layout.
      this.vrng = FL.U.rng((this.seed ^ 0x9e3779b9) >>> 0);
      this.F = { x: [], y: [], z: [], yaw: [], sl: [], cv: [], bk: [], pal: [], int: [] };
      this.ribbons = [];
      this.obstacles = [];
      this.pads = [];
      this.crags = [];
      this.arches = [];
      this.marks = [];
      this.obsV = 0;            // bumped whenever obstacles are added (renderers cache against it)
      this.cw = NOWALL; this.noPads = false;
      this.chunks = [];
      this.freed = [];
      // walker state
      this.k = -1;
      this.x = 0; this.y = 0; this.z = 0; this.yaw = 0;
      this.sl = 0.22; this.cv = 0; this.bkF = 0.65;
      this.hw = 7.6; this.pal = 0; this.inten = 0;
      this.wave = 0; this.queue = []; this.recent = [];
      this.ribId = 0;
      this._obs = []; this._pads = [];
      this._push(0);
      this.ensure(C.GEN_AHEAD);
    }

    get genS() { return this.k * SEG; }

    // ------------------------------------------------------------------ queries
    frameAt(s, out) {
      const F = this.F;
      let t = s / SEG;
      if (t < 0) t = 0;
      const max = this.k - 0.0001;
      if (t > max) t = max;
      const i = t | 0, f = t - i, j = i + 1;
      out.x = F.x[i] + (F.x[j] - F.x[i]) * f;
      out.y = F.y[i] + (F.y[j] - F.y[i]) * f;
      out.z = F.z[i] + (F.z[j] - F.z[i]) * f;
      out.yaw = F.yaw[i] + (F.yaw[j] - F.yaw[i]) * f;
      out.sl = F.sl[i] + (F.sl[j] - F.sl[i]) * f;
      out.cv = F.cv[i] + (F.cv[j] - F.cv[i]) * f;
      out.bk = F.bk[i] + (F.bk[j] - F.bk[i]) * f;
      out.pal = F.pal[i] + (F.pal[j] - F.pal[i]) * f;
      out.int = F.int[i] + (F.int[j] - F.int[i]) * f;
      return out;
    }

    // Track space -> world. h is height above the centreline.
    worldAt(s, o, h, out) {
      const fr = this.frameAt(s, FR);
      out[0] = fr.x + Math.cos(fr.yaw) * o;
      out[1] = fr.y + h;
      out[2] = fr.z + Math.sin(fr.yaw) * o;
      return out;
    }

    /* What is under (s, o)?  Returns 1 with the surface in `out` when there is ground the ball
       at height y can be on, 2 when the only ground is above it (it has slipped underneath),
       0 over open air. */
    surfaceAt(s, o, y, out) {
      const rbs = this.ribbons, F = this.F;
      let best = -1e9, found = 0, above = 1e9;
      out.wall = 0;
      for (let r = 0; r < rbs.length; r++) {
        const rb = rbs[r];
        if (s < rb.sA || s > rb.sB) continue;
        const t = (s - rb.sA) / SEG;
        let i = t | 0;
        if (i > rb.n - 2) i = rb.n - 2;
        const f = t - i;
        const c = rb.c[i] + (rb.c[i + 1] - rb.c[i]) * f;
        const hw = rb.hw[i] + (rb.hw[i + 1] - rb.hw[i]) * f;
        const d = o - c, ad = d < 0 ? -d : d;
        const k = rb.k0 + i;
        if (ad > hw + C.EDGE) {
          // past this ribbon's edge: note it if that side is forest
          const wa = d < 0 ? rb.wl : rb.wr;
          if (wa && ad < hw + 3.5 && wa[i] > 0.5) { out.wall = 1; out.wallH = F.y[k] + (F.y[k + 1] - F.y[k]) * f + rb.e[i]; }
          continue;
        }
        const b = rb.b[i] + (rb.b[i + 1] - rb.b[i]) * f;
        const h = F.y[k] + (F.y[k + 1] - F.y[k]) * f + rb.e[i] + (rb.e[i + 1] - rb.e[i]) * f + d * b;
        if (h <= y + C.SNAP) {
          if (h > best) { best = h; found = 1; out.h = h; out.b = b; out.edge = hw - ad; out.d = d; out.hw = hw; out.rb = rb; }
        } else if (h < above) above = h;
      }
      if (found) return 1;
      if (above < 1e9) { out.h = above; return 2; }
      return 0;
    }

    // Height of one ribbon's surface, extended past its ends (used for ground velocity).
    ribbonH(rb, s, o) {
      const F = this.F;
      const t = (s - rb.sA) / SEG;
      let i = Math.floor(t);
      if (i < 0) i = 0;
      if (i > rb.n - 2) i = rb.n - 2;
      const f = t - i, k = rb.k0 + i;        // f runs outside 0..1 past either end: linear extension
      const c = rb.c[i] + (rb.c[i + 1] - rb.c[i]) * f;
      const b = rb.b[i] + (rb.b[i + 1] - rb.b[i]) * f;
      return F.y[k] + (F.y[k + 1] - F.y[k]) * f + rb.e[i] + (rb.e[i + 1] - rb.e[i]) * f + (o - c) * b;
    }

    chunkAt(s) {
      const ch = this.chunks;
      for (let i = ch.length - 1; i >= 0; i--) if (s >= ch[i].s0) return ch[i];
      return ch[0];
    }

    // ------------------------------------------------------------------ lifecycle
    ensure(sAhead) {
      while (this.genS < sAhead) this._next();
    }

    prune(sBehind) {
      const keep = (arr, test, onDrop) => {
        let n = 0;
        for (let i = 0; i < arr.length; i++) {
          if (test(arr[i])) arr[n++] = arr[i]; else if (onDrop) onDrop(arr[i]);
        }
        arr.length = n;
      };
      keep(this.ribbons, (r) => r.sB >= sBehind, (r) => this.freed.push(r));
      keep(this.obstacles, (o) => o.s + 3 >= sBehind);
      keep(this.pads, (p) => p.s + 4 >= sBehind);
      keep(this.crags, (c) => c.s >= sBehind - 80);
      keep(this.arches, (a) => a.s >= sBehind - 6);
      keep(this.marks, (m) => m.s >= sBehind);
      if (this.chunks.length > 12) this.chunks.splice(0, this.chunks.length - 12);
    }

    // ------------------------------------------------------------------ walker
    _push(bk) {
      const F = this.F, k = ++this.k;
      F.x[k] = this.x; F.y[k] = this.y; F.z[k] = this.z; F.yaw[k] = this.yaw;
      F.sl[k] = this.sl; F.cv[k] = this.cv; F.bk[k] = bk; F.pal[k] = this.pal; F.int[k] = this.inten;
    }

    /* Extend the centreline by n segments, easing toward the given targets so heading, slope
       and bank stay continuous across sections. */
    _walk(n, tg) {
      const cvF = typeof tg.cv === 'function' ? tg.cv : null;
      const slRate = tg.slRate || 0.1;
      const bankT = tg.bank === undefined ? 0.65 : tg.bank;
      const pal0 = this.pal, pal1 = tg.pal === undefined ? this.pal : tg.pal;
      const int0 = this.inten, int1 = tg.int === undefined ? this.inten : tg.int;
      const drop = tg.drop ? tg.drop / n : 0;
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / n;
        const cvT = cvF ? cvF(t) : tg.cv || 0;
        this.cv += (cvT - this.cv) * 0.2;
        if (tg.sl !== undefined) this.sl += (tg.sl - this.sl) * slRate;
        this.bkF += (bankT - this.bkF) * 0.15;
        this.yaw += this.cv * SEG;
        this.x += Math.sin(this.yaw) * SEG;
        this.z -= Math.cos(this.yaw) * SEG;
        this.y -= this.sl * SEG + drop;
        this.pal = lerp(pal0, pal1, smooth(t));
        this.inten = lerp(int0, int1, Math.min(1, t * 3));
        const uD = C.baseSpeed(this.k * SEG) * C.terrain(this.sl);
        let bk = clamp((-this.bkF * uD * uD * this.cv) / C.GB, -0.36, 0.36);
        if (tg.tilt) bk += tg.tilt(t);
        this._push(bk);
      }
    }

    // A curvature plan for a section of length L. 'S' snakes and ends on its starting heading;
    // 'C' is one sweep, biased to bring the track back toward the fall line.
    _curve(L, amt, kind) {
      const r = this.rng;
      const dir = r() < 0.5 + this.yaw * 0.55 ? -1 : 1;
      const cap = C.AC_MAX / (this.uMax * this.uMax);
      let k, f;
      if (kind === 'S') {
        k = Math.min(cap, 1.6 / L) * amt;
        f = (t) => dir * k * Math.sin(t * TAU);
      } else {
        const room = dir * this.yaw > 0 ? Math.max(0.12, 1.1 - Math.abs(this.yaw)) : 1.1 + Math.abs(this.yaw) * 0.5;
        k = Math.min(cap, Math.min(room, 1.1) / (L * 0.8)) * amt;
        f = (t) => dir * k * smooth(t / 0.12) * smooth((1 - t) / 0.12);
      }
      f.dir = dir; f.k = k;
      return f;
    }

    // ------------------------------------------------------------------ surface + content
    _rib(k0, k1, o) {
      const n = k1 - k0 + 1, F = this.F;
      const rb = {
        id: this.ribId++, k0, n, sA: k0 * SEG, sB: k1 * SEG,
        c: new Float32Array(n), hw: new Float32Array(n), e: new Float32Array(n), b: new Float32Array(n),
        capA: !!o.capA, capB: !!o.capB, wl: null, wr: null, mesh: null,
      };
      const val = (v, i) => (typeof v === 'function' ? v(i, n) : v || 0);
      for (let i = 0; i < n; i++) {
        rb.c[i] = val(o.c, i);
        rb.hw[i] = val(o.hw, i);
        rb.e[i] = val(o.e, i);
        rb.b[i] = F.bk[k0 + i] + val(o.b, i);
      }
      this.ribbons.push(rb);
      return rb;
    }

    // The ordinary full-width road, easing from the previous section's width to W.
    _main(k0, k1, W, o) {
      o = o || {};
      const from = this.hw, ease = Math.min(10, k1 - k0);
      const rb = this._rib(k0, k1, {
        hw: (i) => lerp(from, W, smooth(i / ease)), e: o.e, capA: o.capA, capB: o.capB,
      });
      const walls = o.walls || this.cw;
      const fill = (w) => {
        if (!w) return null;
        const a = new Float32Array(rb.n);
        for (let i = 0; i < rb.n; i++) a[i] = typeof w === 'function' ? w(i, rb.n) : 1;
        return a;
      };
      rb.wl = fill(walls[0]); rb.wr = fill(walls[1]);
      this.hw = W;
      return rb;
    }

    _begin(slT) {
      const s = this.genS;
      const Bn = C.baseSpeed(s), Bf = C.baseSpeed(s + 500);
      this.uNom = Bn * C.terrain(slT);
      this.uMax = Bf * Math.max(C.terrain(slT), C.terrain(this.sl)) + C.boostV(Bf);
      this.uMin = Bn * C.U_MIN_F;
    }

    _segs(m) { return Math.max(2, Math.ceil(m / SEG)); }

    /* Fairness budget: metres needed before a row of obstacles that may demand a sideways
       move of d, at the fastest speed possible here — time to notice and decide, plus a
       comfortable margin on the move itself. */
    _gapFor(d, I) {
      return this.uMax * (lerp(0.62, 0.28, I) + 1.3 * C.tMove(d));
    }

    // Where the ball's centre can pass a row of blocks ([o, hx] pairs) on a road of half-width W.
    _safeOf(blocks, W) {
      const m = C.R + 0.45;
      let segs = [[-W + 0.5, W - 0.5]];
      for (const [o, hx] of blocks) {
        const lo = o - hx - m, hi = o + hx + m, next = [];
        for (const sg of segs) {
          if (hi <= sg[0] || lo >= sg[1]) { next.push(sg); continue; }
          if (lo > sg[0]) next.push([sg[0], lo]);
          if (hi < sg[1]) next.push([hi, sg[1]]);
        }
        segs = next;
      }
      return segs.filter((sg) => sg[1] - sg[0] >= 0.5);
    }

    // Sideways distance from `prev` to the nearest point of `safe`: [worst case, best case].
    _need(prev, safe) {
      const dist = (p) => {
        let d = Infinity;
        for (const sg of safe) d = Math.min(d, p < sg[0] ? sg[0] - p : p > sg[1] ? p - sg[1] : 0);
        return d;
      };
      let worst = 0, least = Infinity;
      for (const p of prev) {
        worst = Math.max(worst, dist(p[0]), dist(p[1]));
        least = Math.min(least, dist(p[0]), dist(p[1]));
        for (let i = 0; i < safe.length - 1; i++) {
          const mid = (safe[i][1] + safe[i + 1][0]) / 2;
          if (mid > p[0] && mid < p[1]) worst = Math.max(worst, dist(mid));
        }
        for (const sg of safe) if (sg[0] < p[1] && sg[1] > p[0]) least = 0;
      }
      return [worst, least];
    }

    /* Space rows of obstacles along a section so each one is reachable from where the previous
       one could have left the player. Early on the budget covers nearly the worst case (you
       were on the far side and only reacted once past the last row); as intensity rises it
       leans on the player having read the next row before reaching this one. Returns the
       length used. */
    _layout(rows, W, I) {
      let prev = [[-W + 0.5, W - 0.5]], s = 0;
      for (const row of rows) {
        const safe = this._safeOf(row.blocks, W);
        if (!safe.length) { row.skip = true; continue; }
        const [worst, least] = this._need(prev, safe);
        const plan = row.plan === undefined ? lerp(0.35, 0.6, I) : row.plan;
        s += Math.max(this._gapFor(lerp(worst, least, s === 0 ? 0 : plan), I), row.min || 0, 16);
        row.ds = s;
        prev = safe;
      }
      return s;
    }

    _rows(s0, rows) {
      for (const row of rows) {
        if (row.skip) continue;
        const ref = { near: false, id: this._id() };
        for (const [o, hx, flag] of row.blocks) this._block(s0 + row.ds, o, hx, row.kind, ref, flag);
      }
    }

    /* An obstacle: a box in track space that ends the run on contact. `kind` only decides how
       it looks and how tall it stands — a lone pine, a line of pines, a boulder, or a run of
       safety fence (flag: which end of a fence borders an opening, -1 left / 1 right). */
    _block(s, o, hx, kind, ref, flag) {
      if (this.surfaceAt(s, o, 1e9, SF) !== 1) return null;
      const fr = this.frameAt(s, FR);
      kind = kind || (hx <= 1.25 ? 'pine' : 'rock');
      const seed = hash01(s, o);
      let h, hz;
      if (kind === 'pine') { h = 5.4 + 2.4 * seed; hz = Math.min(0.95, hx * 0.85); }
      else if (kind === 'pines') { h = 5.2 + 1.2 * seed; hz = 0.8; }
      else if (kind === 'rock') { h = 1.5 + Math.min(hx, 2.4) * 0.4 + 0.5 * seed; hz = 0.9; }
      else { h = 1.7; hz = 0.35; }
      const ob = { s, o, hx, hz, h, kind, flag: flag || 0, seed, row: ref || { near: false, id: this._id() }, e: SF.h - fr.y, b: SF.b, yTop: SF.h + h };
      this._obs.push(ob);
      return ob;
    }

    // Rows and strip groups carry a number, so a simulation state can remember which it has been paid for.
    _id() { return (this._ids = (this._ids || 0) + 1); }

    // Boost strip. Strips laid in a line share a group: each one kicks your speed, but the line
    // only counts once toward the multiplier.
    _pad(s, o, grp) {
      if (this.noPads || this.surfaceAt(s, o, 1e9, SF) !== 1 || SF.edge < 1.3) return null;
      for (const ob of this._obs) {
        if (Math.abs(ob.s - s) < ob.hz + 4.2 && Math.abs(ob.o - o) < ob.hx + 1.35) return null;
      }
      for (const p of this._pads) if (Math.abs(p.s - s) < 7 && Math.abs(p.o - o) < 2.8) return null;
      const fr = this.frameAt(s, FR);
      const pd = { s, o, hx: 1.1, hz: 3, e: SF.h - fr.y, b: SF.b, used: false, grp: grp || { hit: false, id: this._id() } };
      this._pads.push(pd);
      return pd;
    }

    _padLine(s, o, n, step) {
      const grp = { hit: false, id: this._id() };
      for (let i = 0; i < n; i++) this._pad(s + i * (step || 9), o, grp);
    }

    _flush(type, k0, I) {
      this._obs.sort((a, b) => a.s - b.s);
      this._pads.sort((a, b) => a.s - b.s);
      for (const o of this._obs) this.obstacles.push(o);
      for (const p of this._pads) this.pads.push(p);
      this._obs.length = 0; this._pads.length = 0;
      this.obsV++;
      this.chunks.push({ type, s0: k0 * SEG, s1: this.k * SEG, I, wave: this.wave, walls: this.cw });
      this._scenery(k0);
    }

    // Rock spires standing out of the valley haze, well clear of the run: something to fly past.
    _scenery(k0) {
      const r = this.vrng, F = this.F, cr = this.crags;
      let n = 0;
      for (let i = 0; i < cr.length; i++) {        // drop any an earlier section planted where this one now runs
        const c = cr[i];
        let hit = false;
        for (let k = k0; k <= this.k && !hit; k += 3) {
          const dx = c.x - F.x[k], dz = c.z - F.z[k], lim = c.r + 30;
          if (dx * dx + dz * dz < lim * lim && c.y > F.y[k] - 14) hit = true;
        }
        if (!hit) cr[n++] = c;
      }
      cr.length = n;
      for (let k = k0 + 3; k < this.k; k += 7) {
        for (let side = -1; side <= 1; side += 2) {
          if (!r.chance(0.42)) continue;
          const rad = r.range(9, 26), o = side * (rad + 46 + r() * r() * 150);
          const top = F.y[k] + (r.chance(0.16) ? r.range(6, 34) : r.range(-80, -10));
          cr.push({
            s: k * SEG, x: F.x[k] + Math.cos(F.yaw[k]) * o, y: top, z: F.z[k] + Math.sin(F.yaw[k]) * o,
            r: rad, h: 150, yaw: r() * 6.2832, seed: r(),
          });
        }
      }
    }

    // A banner over the run where a new wave begins.
    _arch(s, W) {
      this.arches.push({ s, hw: W, wave: this.wave + 1 });
    }

    // ------------------------------------------------------------------ wave planning
    _next() {
      if (!this.queue.length) this._planWave();
      const job = this.queue.shift();
      const k0 = this.k;
      this.cw = WALLS[job.type] || NOWALL;
      this.noPads = !KEEP_PADS[job.type] && !this.rng.chance(0.72);
      this['_c_' + job.type](job.I, job);
      this._flush(job.type, k0, job.I);
      if (job.type === 'rest') this.wave++;
    }

    /* A wave is a climb in intensity, a steep drop into its hardest stretch, then a wide calm
       run-out. Each wave starts a little above where the last one started. */
    _planWave() {
      const w = this.wave, r = this.rng, q = this.queue;
      if (w === 0) {
        q.push({ type: 'start', I: 0.05 }, { type: 'slalom', I: 0.16 }, { type: 'field', I: 0.24 },
          { type: 'sweep', I: 0.32 }, { type: 'gates', I: 0.36 }, { type: 'rest', I: 0 });
        this.recent = ['field', 'gates'];
        return;
      }
      const I0 = Math.min(0.16 + 0.1 * w, 0.6), I1 = Math.min(0.46 + 0.15 * w, 1);
      const n = (w === 1 ? 4 : 3 + Math.min(w, 2)) + (r.chance(0.4) ? 1 : 0);
      const fresh = Object.keys(TYPES).filter((t) => TYPES[t].w === w);
      const picks = [];
      for (let i = 0; i < n; i++) {
        let type;
        if (fresh.length && i >= 1) type = fresh.splice((r() * fresh.length) | 0, 1)[0];
        else {
          const pool = Object.keys(TYPES).filter((t) => TYPES[t].w <= w && !this.recent.includes(t));
          let total = 0;
          for (const t of pool) total += TYPES[t].wt;
          let x = r() * total;
          type = pool[pool.length - 1];
          for (const t of pool) { x -= TYPES[t].wt; if (x <= 0) { type = t; break; } }
        }
        picks.push(type);
        this.recent.push(type);
        if (this.recent.length > 3) this.recent.shift();
      }
      picks.forEach((type, i) => q.push({ type, I: lerp(I0, I1, Math.pow(i / (n - 1), 1.15)) }));
      const peak = Math.min(1, I1 + 0.12);
      q.push({ type: 'drop', I: I1 });
      const hard = ['gates', 'field', 'slalom'].filter((t) => t !== this.recent[this.recent.length - 1]);
      if (w >= 2) hard.push('islands');
      const climax = r.pick(hard);
      q.push({ type: climax, I: peak, climax: true });
      this.recent.push(climax);
      if (this.recent.length > 3) this.recent.shift();
      q.push({ type: 'rest', I: 0 });
    }

    // ------------------------------------------------------------------ sections
    _c_start() {
      const sl = 0.22;
      this._begin(sl);
      const k0 = this.k, W = 7.6;
      this._walk(58, { cv: 0, sl, int: 0.08 });
      const dir = this.rng.sign();
      this._walk(46, { cv: (t) => dir * 0.005 * Math.sin(t * Math.PI), sl: 0.24, int: 0.12 });
      this.hw = W;
      // open sky at the start gate, then the run drops into the trees
      const wall = (i) => (i >= 21 ? 1 : 0);
      this._main(k0, this.k, W, { capA: true, walls: [wall, wall] });
      // The first boost sits dead ahead; the first pines stand on the line you are already on.
      this._padLine(66, 0, 2, 10);
      this._block(132, 1.2, 1.6, 'pines');
      this._block(176, -2.4, 1.5, 'pines');
      this._pad(176, 0.9);
    }

    _c_open(I) {
      const r = this.rng, W = lerp(7.3, 5.7, I), sl = 0.2 + 0.16 * I + r.range(-0.02, 0.02);
      this._begin(sl);
      const rows = [];
      const count = I < 0.08 ? 0 : 1 + Math.round(I * 2.4 * r());
      for (let i = 0; i < count; i++) {
        const hx = r.range(0.9, lerp(1.6, 2.4, I));
        rows.push({ blocks: [[r.range(-1, 1) * (W - hx - 0.2), hx]], min: this.uNom * 0.9 });
      }
      const L = Math.max(this.uNom * r.range(2.3, 3.2), this._layout(rows, W, I) + this.uNom * 0.5);
      const k0 = this.k, s0 = k0 * SEG;
      this._walk(this._segs(L), { cv: this._curve(L, lerp(0.5, 1, I), r.chance(0.5) ? 'S' : 'C'), sl, int: I });
      this._main(k0, this.k, W);
      this._rows(s0, rows);
      // a boost tucked against an edge, or right beside a block
      const side = r.sign();
      if (rows.length && !rows[0].skip && r.chance(0.6)) {
        const [o, hx] = rows[0].blocks[0];
        const ps = o > 0 ? -1 : 1;
        this._padLine(s0 + rows[0].ds - 3, o + ps * (hx + 1.6), 2, 9);
      } else this._padLine(s0 + L * 0.35, side * (W - 1.6), 2, 10);
    }

    _c_slalom(I) {
      const r = this.rng, W = lerp(7.0, 5.7, I), sl = 0.2 + 0.18 * I;
      this._begin(sl);
      const n = 3 + Math.round(I * 2 + r());
      const ov = lerp(0.2, 1.4, I) + r.range(-0.2, 0.2);   // how far each wall reaches past centre
      let side = r.sign();
      const rows = [];
      for (let i = 0; i < n; i++) {
        const a = -side * ov, b = side * (W + 0.4);
        rows.push({ blocks: [[(a + b) / 2, Math.abs(b - a) / 2]], kind: 'pines', tip: a, side, min: this.uMax * 0.5, plan: 0.8 });
        side = -side;
      }
      const L = this._layout(rows, W, I) + this.uMax * 0.4;
      const k0 = this.k, s0 = k0 * SEG;
      this._walk(this._segs(L), { cv: this._curve(L, I * 0.5, 'S'), sl, int: I });
      this._main(k0, this.k, W);
      this._rows(s0, rows);
      // boosts on the tight line, skimming the wall tips
      rows.forEach((row, i) => { if (!row.skip && i % 2 === 1) this._pad(s0 + row.ds, row.tip - row.side * 1.6); });
    }

    _c_gates(I) {
      const r = this.rng, W = lerp(7.2, 5.9, I), sl = 0.2 + 0.18 * I;
      this._begin(sl);
      const n = 2 + Math.round(I * 2.2 + r() * 0.8);
      const wO = lerp(6.4, 3.3, I) * r.range(1, 1.15);
      const lim = W - wO / 2 - 0.4;
      let oc = r.range(-1, 1) * lim;
      const rows = [];
      for (let i = 0; i < n; i++) {
        const blocks = [];
        const l0 = -W - 0.4, l1 = oc - wO / 2, r0 = oc + wO / 2, r1 = W + 0.4;
        if (l1 - l0 > 0.6) blocks.push([(l0 + l1) / 2, (l1 - l0) / 2, 1]);
        if (r1 - r0 > 0.6) blocks.push([(r0 + r1) / 2, (r1 - r0) / 2, -1]);
        rows.push({ blocks, kind: 'fence', oc, min: this.uMax * 0.55 });
        let shift = r.sign() * r.range(2, lerp(4.5, 9, I));
        if (Math.abs(oc + shift) > lim) shift = -shift;
        oc = clamp(oc + shift, -lim, lim);
      }
      const L = this._layout(rows, W, I) + this.uMax * 0.4;
      const k0 = this.k, s0 = k0 * SEG;
      this._walk(this._segs(L), { cv: this._curve(L, I * 0.6, r.chance(0.5) ? 'S' : 'C'), sl, int: I });
      this._main(k0, this.k, W);
      this._rows(s0, rows);
      // a boost through the gap, hard against one post
      rows.forEach((row, i) => {
        if (row.skip || i % 2) return;
        const off = Math.max(0, wO / 2 - 1.6);
        this._pad(s0 + row.ds, row.oc + r.sign() * off);
      });
    }

    _c_field(I) {
      const r = this.rng, W = lerp(7.4, 6.1, I), sl = 0.2 + 0.18 * I;
      this._begin(sl);
      const nRows = 3 + Math.round(I * 3 + r());
      const open = lerp(5.6, 3.5, I);
      const rows = [];
      for (let i = 0; i < nRows; i++) {
        const want = 1 + (r.chance(0.25 + 0.45 * I) ? 1 : 0) + (I > 0.7 && r.chance(0.3) ? 1 : 0);
        const blocks = [];
        for (let j = 0, tries = 0; j < want && tries < 12; tries++) {
          const hx = r.range(0.7, 1.1), o = r.range(-1, 1) * (W - 1);
          if (blocks.every(([bo, bh]) => Math.abs(bo - o) > bh + hx + open)) { blocks.push([o, hx]); j++; }
        }
        rows.push({ blocks, kind: 'pine', min: this.uMax * lerp(0.75, 0.48, I) });
      }
      const L = this._layout(rows, W, I) + this.uMax * 0.4;
      const k0 = this.k, s0 = k0 * SEG;
      this._walk(this._segs(L), { cv: this._curve(L, lerp(0.4, 0.8, I), r.chance(0.5) ? 'S' : 'C'), sl, int: I });
      this._main(k0, this.k, W);
      this._rows(s0, rows);
      // slingshot boosts just past a pillar's shoulder
      rows.forEach((row, i) => {
        if (row.skip || i % 2 === 0) return;
        const [o, hx] = row.blocks[0];
        this._pad(s0 + row.ds + 1, o + (o > 0 ? -1 : 1) * (hx + 1.6));
      });
    }

    _c_sweep(I) {
      const r = this.rng, W = lerp(7.2, 5.9, I), sl = 0.22 + 0.16 * I;
      this._begin(sl);
      const rows = [];
      const count = I > 0.3 ? Math.round(I * 2.5 * r.range(0.6, 1)) : 0;
      for (let i = 0; i < count; i++) {
        const hx = r.range(0.9, 1.8);
        rows.push({ blocks: [[r.range(-1, 1) * (W - hx - 0.3), hx]], min: this.uNom * 0.8 });
      }
      const L = Math.max(this.uNom * r.range(2.6, 3.6), this._layout(rows, W, I) + this.uNom * 0.5);
      const flat = I > 0.55 && r.chance(0.35);
      const cv = this._curve(L, lerp(0.75, 1, I), 'C');
      this.cw = cv.dir > 0 ? [1, 0] : [0, 1];        // trees on the outside of the bend, open air on the inside
      const k0 = this.k, s0 = k0 * SEG;
      this._walk(this._segs(L), { cv, sl, bank: flat ? 0.15 : 0.65, int: I });
      this._main(k0, this.k, W);
      this._rows(s0, rows);
      // the inside line is the fast one — and the edge is right there
      this._padLine(s0 + L * 0.3, cv.dir * (W - 1.6), 3, Math.max(9, this.uNom * 0.3));
    }

    _c_tilt(I) {
      const r = this.rng, W = lerp(7.0, 5.9, I), sl = 0.22 + 0.14 * I;
      this._begin(sl);
      const bt = r.sign() * lerp(0.14, 0.28, I);
      this.cw = bt > 0 ? [0, 1] : [1, 0];            // forest on the uphill side, a drop on the downhill one
      const rows = [];
      if (I > 0.4) {
        const count = 1 + Math.round(I * 1.6 * r());
        for (let i = 0; i < count; i++) {
          const hx = r.range(0.9, 1.6);
          rows.push({ blocks: [[r.range(-1, 1) * (W - hx - 0.3), hx]], min: this.uNom * 0.9 });
        }
      }
      const L = Math.max(this.uNom * r.range(2.2, 3.1), this._layout(rows, W, I) + this.uNom * 0.5);
      const k0 = this.k, s0 = k0 * SEG;
      this._walk(this._segs(L), { cv: 0, sl, int: I, tilt: (t) => bt * smooth(t / 0.22) * smooth((1 - t) / 0.22) });
      this._main(k0, this.k, W);
      this._rows(s0, rows);
      // boosts along the high edge: you have to hold the line against the slide to get them
      this._padLine(s0 + L * 0.3, Math.sign(bt) * (W - 1.6), 3, Math.max(9, this.uNom * 0.3));
    }

    _c_bridge(I) {
      const r = this.rng, W = lerp(7.0, 5.9, I), hwN = lerp(3.1, 1.9, I), sl = 0.22 + 0.14 * I;
      this._begin(sl);
      const taper = Math.max(16, this.uMax * 0.3);
      const lead = Math.max(12, this._gapFor(W - hwN, I) - taper);
      const hold = this.uNom * (1.0 + 1.6 * I) * r.range(0.9, 1.1);
      const nL = this._segs(lead), nT = this._segs(taper), nH = this._segs(hold), nE = 6;
      const k0 = this.k, from = this.hw;
      this._walk(nL + nT, { cv: 0, sl, int: I });
      const Lh = (nH + nT) * SEG;
      this._walk(nH + nT, { cv: I > 0.45 ? this._curve(Lh, 0.5, 'S') : 0, sl, int: I });
      this._walk(nE, { cv: 0, sl, int: I });
      const n = this.k - k0;
      this._rib(k0, this.k, {
        hw: (i) => {
          if (i <= nL) return lerp(from, W, smooth(i / Math.min(10, nL)));
          if (i <= nL + nT) return lerp(W, hwN, smooth((i - nL) / nT));
          if (i <= nL + nT + nH) return hwN;
          return lerp(hwN, W, smooth((i - nL - nT - nH) / Math.min(nT, n - nL - nT - nH)));
        },
      });
      this.hw = W;
      const sH = (k0 + nL + nT) * SEG;
      this._padLine(sH + hold * 0.25, 0, 2, Math.max(10, hold * 0.35));
    }

    /* The road forks around a void: a wide safe lane, and a narrow fast one lined with boosts. */
    _c_split(I) {
      const r = this.rng, Wm = 7.4, W = lerp(7.0, 5.9, I), sl = 0.22 + 0.14 * I;
      this._begin(sl);
      const hwA = lerp(3.0, 2.3, I), hwB = lerp(2.0, 1.5, I), voidW = 2.8;
      const side = r.sign();                                    // which side the fast lane is on
      const cA = -side * (voidW / 2 + hwA), cB = side * (voidW / 2 + hwB);
      const lead = Math.max(20, this._gapFor(3, I) * 0.5), taper = Math.max(22, this._gapFor(3, I) * 0.6);
      const hold = this.uNom * r.range(1.7, 2.4);
      const nL = this._segs(lead), nT = this._segs(taper), nH = this._segs(hold), nE = 8;
      const k0 = this.k;
      this._walk(nL + nT + nH + nT + nE, { cv: 0, sl, int: I });
      this._main(k0, k0 + nL, Wm);
      const kF = k0 + nL, kM = kF + nT + nH + nT;
      const lane = (c1, hw1, sgn) => this._rib(kF, kM, {
        c: (i, n) => lerp(sgn * Wm / 2, c1, smooth(Math.min(i, n - 1 - i) / nT)),
        hw: (i, n) => lerp(Wm / 2, hw1, smooth(Math.min(i, n - 1 - i) / nT)),
      });
      lane(cA, hwA, -side);
      lane(cB, hwB, side);
      this._main(kM, this.k, W);
      const sH = (kF + nT) * SEG;
      this._padLine(sH + hold * 0.1, cB, 3, Math.max(10, hold * 0.33));
    }

    _c_jump(I) {
      const r = this.rng, W = lerp(7.2, 6.1, I), sl = 0.24 + 0.1 * I;
      this._begin(sl);
      const jumps = I > 0.6 && r.chance(0.45) ? 2 : 1;
      let kA = this.k, lead = this.uNom * 0.9;
      for (let j = 0; j < jumps; j++) {
        // The kicker is sized in time, so a jump feels the same at any pace.
        const nKick = Math.max(3, Math.round((this.uNom * 0.3) / SEG)), Lk = nKick * SEG;
        const vK = lerp(8, 12, I) * r.range(0.9, 1.1);          // lift off the lip at cruising speed
        const ke = vK / this.uNom, eK = (ke * Lk) / 2;
        const nGap = Math.max(3, Math.round((this.uMin * lerp(0.36, 0.5, I)) / SEG)), Lg = nGap * SEG;
        // Drop the far side far enough that even the slowest possible ball clears the gap.
        const tg = Lg / this.uMin;
        const D = Math.max(0.4, 0.5 * C.G * tg * tg - ke * Lg - eK + 0.6);
        this._walk(this._segs(lead) + nKick, { cv: 0, sl, int: I });
        const kLip = this.k, nRun = kLip - kA;
        this._main(kA, kLip, W, {
          capA: j > 0, capB: true,
          e: (i) => { const t = (i - (nRun - nKick)) / nKick; return t > 0 ? eK * t * t : 0; },
        });
        this._pad((kLip - nKick) * SEG - 8, 0);                  // hit it for a bigger launch
        this._walk(nGap, { cv: 0, sl, drop: D, int: I });
        kA = this.k;
        // …and keep the landing clear for as far as the fastest possible ball can fly.
        const vy = ke * this.uMax, tAir = (vy + Math.sqrt(vy * vy + 2 * C.G * (eK + D))) / C.G;
        lead = Math.max(this.uNom * 0.8, this.uMax * tAir - Lg + this.uMax * 0.4);
      }
      this._walk(this._segs(lead), { cv: 0, sl, int: I });
      this._main(kA, this.k, W + 0.4, { capA: true });
    }

    /* Stepping stones: short platforms, each a small drop and a sideways shift from the last. */
    _c_islands(I) {
      const r = this.rng, W = lerp(7.0, 6.0, I), hwI = lerp(4.2, 2.7, I), sl = 0.24 + 0.1 * I;
      this._begin(sl);
      const n = 3 + Math.round(I * 2 * r());
      const nGap = Math.max(2, Math.round((this.uMin * 0.2) / SEG)), Lg = nGap * SEG, tg = Lg / this.uMin;
      const D = Math.max(0.5, 0.5 * C.G * tg * tg + 0.45);
      const k0 = this.k;
      this._walk(this._segs(Math.max(18, this._gapFor(W - hwI + 1, I))), { cv: 0, sl, int: I });
      this._main(k0, this.k, W, { capB: true });
      let c = r.range(-1, 1);
      for (let i = 0; i < n; i++) {
        this._walk(nGap, { cv: 0, sl, drop: D, int: I });
        const kA = this.k;
        const shift = i === n - 1 ? 0 : r.sign() * r.range(1.2, hwI * 1.1);
        const Lp = Math.max(this.uMax * 0.55, this._gapFor(Math.abs(shift) + 0.3, I));
        this._walk(this._segs(Lp), { cv: 0, sl, int: I });
        const tilt = I > 0.55 ? r.sign() * lerp(0.08, 0.2, I) : 0;
        const cc = c;
        this._rib(kA, this.k, { c: cc, hw: hwI, b: tilt, capA: true, capB: true });
        if (i % 2 === 1) this._pad((kA + 3) * SEG, cc + r.sign() * (hwI - 1.6));
        let nc = c + shift;
        if (Math.abs(nc) > 4.5) nc = c - shift;
        c = nc;
      }
      this._walk(nGap, { cv: 0, sl, drop: D, int: I });
      const kA = this.k;
      this._walk(this._segs(this.uNom * 0.8), { cv: 0, sl, int: I });
      this.hw = W + 0.6;
      this._main(kA, this.k, W + 0.6, { capA: true });
    }

    /* The pitch falls away: a sharp crest you float over, then raw speed into the wave's peak. */
    _c_drop(I) {
      const W = 8;
      this._begin(0.5);
      const k0 = this.k, s0 = k0 * SEG;
      this._walk(6, { cv: 0, sl: this.sl, int: I });
      this._walk(this._segs(this.uNom * 1.4), { cv: 0, sl: 0.5, slRate: 0.3, int: Math.max(I, 0.8) });
      this._walk(this._segs(this.uNom * 0.7), { cv: 0, sl: 0.26, slRate: 0.14, int: Math.max(I, 0.8) });
      this._main(k0, this.k, W);
      this._padLine(s0 + 30, 0, 2, 12);
    }

    /* Breathing room between waves: wide, shallow, empty. The colours turn over here. */
    _c_rest() {
      const W = 8.6, sl = 0.13;
      this._begin(sl);
      const L = this.uNom * 3.6;
      const k0 = this.k, s0 = k0 * SEG;
      this._walk(this._segs(L), { cv: this._curve(L, 0.45, 'C'), sl, slRate: 0.07, pal: this.wave + 1, int: 0 });
      this._main(k0, this.k, W);
      this._padLine(s0 + L * 0.45, 0, 2, Math.max(10, this.uNom * 0.35));
      const sG = this.k * SEG - 6;
      this._arch(sG, W);
      this.marks.push({ s: sG, type: 'wave', wave: this.wave + 1 });
    }
  }

  FL.Track = Track;
})(typeof window !== 'undefined' ? window : globalThis);
