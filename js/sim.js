/* Fall Line — simulation. One fixed 120 Hz step; no rendering, no DOM. The same code runs
   in Node for bot playtests, and can step a throw-away copy of the state to look ahead. */
(function (root) {
  'use strict';
  const FL = root.FL;
  const { clamp, damp } = FL.U;
  const C = FL.C;
  const DT = C.STEP;

  const FR = { x: 0, y: 0, z: 0, yaw: 0, sl: 0, cv: 0, bk: 0, pal: 0, int: 0 };
  const SF = { h: 0, b: 0, edge: 0, d: 0, hw: 0, rb: null, wall: 0, wallH: 0 };

  function newState() {
    return {
      t: 0, s: C.S_START, o: 0, vo: 0, y: 0, vy: 0, u: 0,
      onGround: true, air: 0, under: false, falling: false, gb: 0, edge: 9, gvy: 0,
      boost: 0, boostT: 0,
      mult: 1, flowT: 0, score: 0, minCl: 99,
      alive: true, cause: '', into: '', deadT: 0, started: false,
      // what this state has already collected, so a look-ahead copy cannot collect it twice
      padS: -1, lastGrp: 0, lastRow: 0, slope: 0, jumpBuf: 0,
    };
  }

  function reset(st, tr) {
    Object.assign(st, newState());
    tr.surfaceAt(st.s, 0, 1e9, SF);
    st.y = SF.h;
    st.slope = tr.frameAt(st.s, FR).sl;
    return st;
  }

  // Ask for a jump (keyboard, swipe or bot). Buffered briefly, so a press just before landing counts.
  function jump(st) { if (st.alive && st.started) st.jumpBuf = C.JUMP_BUF; }

  function copy(dst, src) {
    for (const k in src) dst[k] = src[k];
    return dst;
  }

  // Push off: called once when the run begins.
  function launch(st) {
    st.started = true;
    st.u = C.baseSpeed(st.s) * 0.55;
    // already moving with the ground, so the skis are on the snow (and steering at full strength) from the first step
    st.vy = st.gvy = -st.slope * st.u;
  }

  function flowUp(st, ev, why) {
    if (st.mult < C.MULT_MAX) st.mult++;
    st.flowT = C.FLOW_T;
    if (ev) ev.push({ type: 'flow', mult: st.mult, why });
  }

  // cause: 'crash' | 'fall'.  into: what was hit — 'pine' | 'pines' | 'rock' | 'fence' | 'trees' (the forest edge).
  function die(st, ev, cause, into, ob) {
    st.alive = false; st.cause = cause; st.into = into || ''; st.deadT = 0;
    if (cause === 'crash') {
      /* Hitting something stops you. Shed most of the speed at once and glance off to the side it
         was clipped on (or back toward the piste, off the forest edge), so the wreck stays in
         front of the camera instead of sliding on through whatever was hit. */
      const side = ob ? (st.o >= ob.o ? 1 : -1) : (st.vo > 0.5 ? -1 : st.vo < -0.5 ? 1 : st.o > 0 ? -1 : 1);
      st.vo = side * (2.5 + st.u * 0.05);
      st.u *= 0.26;
    }
    if (ev) ev.push({ type: 'dead', cause, into: st.into });
  }

  /* Advance one step. inp is -1, 0 or 1; events are pushed to ev when given. A ghost step
     consumes nothing on the track, so a copied state can be rolled forward to look ahead. */
  function step(st, tr, inp, ev, ghost) {
    st.t += DT;
    if (!st.alive) {
      // keep drifting forward for the camera
      st.deadT += DT;
      st.u *= Math.exp(-2.6 * DT);
      st.s += st.u * DT;
      if (st.cause === 'crash') { st.vo *= Math.exp(-3.2 * DT); st.o += st.vo * DT; }
      return;
    }
    if (!st.started) return;

    const fr = tr.frameAt(st.s, FR);
    const B = C.baseSpeed(st.s);

    // --- speed along the track
    if (st.boostT > 0) st.boostT -= DT;
    else if (st.boost > 0) st.boost = Math.max(0, st.boost - (C.boostV(B) / C.BOOST_FADE) * DT);
    const target = B * C.terrain(fr.sl) + st.boost;
    st.u += (target - st.u) * (target > st.u ? C.K_UP : C.K_DOWN) * DT;
    const sPrev = st.s, oPrev = st.o;
    st.s += st.u * DT;

    // --- sideways: steer against drag, the corner's push and the tilt of the ground
    const push = -st.u * st.u * fr.cv;
    let a;
    if (st.onGround) {
      const A = C.STEER_A * (inp * st.vo < 0 ? C.COUNTER : 1);
      a = A * inp - (inp !== 0 ? C.STEER_K : C.K_REL) * st.vo + push - C.GB * st.gb;
    } else {
      a = C.STEER_A * C.AIR_A * inp - (inp !== 0 ? C.STEER_K : C.AIR_K) * st.vo + push;
    }
    st.vo += a * DT;
    st.o += st.vo * DT;

    // --- vertical: ballistic, then resolved against whatever ribbon is underneath
    st.vy -= C.G * DT;
    st.y += st.vy * DT;
    const code = tr.surfaceAt(st.s, st.o, st.y, SF);
    // off the piste where it runs through forest: straight into the trees
    if (code !== 1 && SF.wall && st.y > SF.wallH - 2.5 && st.y < SF.wallH + 6) { die(st, ev, 'crash', 'trees'); return; }
    if (code === 1 && !st.under) {
      const h = SF.h;
      if (st.y <= h + 0.02) {
        const gvy = (h - tr.ribbonH(SF.rb, sPrev, oPrev)) / DT;
        if (!st.onGround || st.air > 0.1) {
          if (ev && st.air > 0.14) ev.push({ type: 'land', v: gvy - st.vy, air: st.air });
        }
        st.y = h; st.vy = gvy; st.gvy = gvy;
        st.onGround = true; st.air = 0; st.gb = SF.b; st.edge = SF.edge;
      } else {
        st.air += DT;
        // a hair of coyote time so tiny crests don't flicker the ball between ground and air
        if (st.air > 0.05 || st.y - h > 0.15) {
          if (st.onGround && ev && st.y - h > 0.15) ev.push({ type: 'air' });
          st.onGround = false;
        }
        st.edge = 9;
      }
    } else {
      st.air += DT;
      st.onGround = false;
      st.edge = 9;
      if (code === 2) st.under = true;
    }

    // --- the player's own jump: pressed in the air, it happens the moment the skis touch down
    if (st.jumpBuf > 0) {
      if (st.onGround && !st.falling) {
        st.vy = st.gvy + C.JUMP_V; st.onGround = false; st.air = 0.051; st.jumpBuf = 0;
        if (ev) ev.push({ type: 'jump' });
      } else st.jumpBuf -= DT;
    }

    // --- falling
    if (!st.onGround) {
      const below = fr.y - st.y;
      if (!st.falling && (st.under || (code === 0 && below > 3.5 + Math.abs(fr.bk) * 8))) {
        st.falling = true;
        if (ev) ev.push({ type: 'fall' });
      }
      if (below > 8.5 + Math.abs(fr.bk) * 8) { die(st, ev, 'fall'); return; }
    }

    // --- obstacles
    const obs = tr.obstacles;
    for (let i = 0; i < obs.length; i++) {
      const ob = obs[i];
      if (ob.s - 3 > st.s) break;
      if (ob.s + ob.hz + 1.5 < sPrev) continue;
      if (st.y >= ob.yTop - 0.15) continue;
      let ds = Math.abs(st.s - ob.s) - ob.hz, dOff = Math.abs(st.o - ob.o) - ob.hx;
      if (ds < 0) ds = 0;
      if (dOff < 0) dOff = 0;
      if (ds * ds + dOff * dOff < C.HIT_R * C.HIT_R) { die(st, ev, 'crash', ob.kind, ob); return; }
      if (sPrev < ob.s && st.s >= ob.s) {
        const cl = Math.abs(st.o - ob.o) - ob.hx - C.R;
        if (cl < st.minCl) st.minCl = cl;
        if (ev) ev.push({ type: 'pass', side: ob.o > st.o ? 1 : -1, cl, ob });
        if ((ob.hurdle || cl < C.NEAR) && !ob.row.near && ob.row.id !== st.lastRow) {
          st.lastRow = ob.row.id;
          if (!ghost) ob.row.near = true;
          flowUp(st, ev, ob.hurdle ? 'hop' : 'near');          // clearing a hurdle counts like a close call
        }
      }
    }

    // --- boost strips
    const pads = tr.pads;
    for (let i = 0; i < pads.length; i++) {
      const pd = pads[i];
      if (pd.s - 5 > st.s) break;
      if (pd.used || pd.s <= st.padS || Math.abs(st.s - pd.s) > pd.hz + 0.4 || Math.abs(st.o - pd.o) > pd.hx + 0.25) continue;
      if ((!st.onGround && st.air > 0.2) || st.boostT > C.BOOST_HOLD - 0.1) continue;
      const bv = C.boostV(B);
      st.boost = bv; st.boostT = C.BOOST_HOLD;
      st.u = Math.min(st.u + bv * 0.6, Math.max(st.u, B * C.terrain(fr.sl) + bv));
      if (ev) ev.push({ type: 'boost' });
      if (!pd.grp.hit && pd.grp.id !== st.lastGrp) flowUp(st, ev, 'boost');
      st.padS = pd.s; st.lastGrp = pd.grp.id;
      if (!ghost) { pd.used = true; pd.grp.hit = true; }
    }

    // --- flow multiplier: decays one level at a time when you coast
    if (st.mult > 1) {
      st.flowT -= DT;
      if (st.flowT <= 1e-9) {
        st.mult--; st.flowT = C.FLOW_DROP_T;
        if (ev) ev.push({ type: 'flowDown', mult: st.mult });
      }
    }
    st.score += (st.s - sPrev) * st.mult;
  }

  // ---- chase camera -------------------------------------------------------------------------
  // Stepped with the simulation (so it is as deterministic as the physics) and interpolated
  // for drawing.
  function newCam() {
    return { o: 0, h: 0, roll: 0, fov: 66, back: 6.4, trauma: 0, look: 0, kick: 0 };
  }

  function camStep(cam, st, tr) {
    const fr = tr.frameAt(st.s, FR);
    const sp = clamp((st.u - 22) / 62, 0, 1);
    const boostF = st.boost > 0 ? clamp(st.boost / 10, 0, 1) : 0;
    if (st.alive) {
      cam.o = damp(cam.o, st.o * 0.7, 9, DT);
      cam.look = damp(cam.look, st.o * 0.5 + st.vo * 0.06, 6, DT);
      cam.h = damp(cam.h, clamp(st.y - fr.y, -4, 7) * 0.5, 8, DT);
      cam.roll = damp(cam.roll, st.vo * 0.0038 - Math.atan(st.onGround ? st.gb : 0) * 0.55, 7, DT);
      cam.back = damp(cam.back, 6.4 + sp * 1.6 + boostF * 1.5, 3.2, DT);
    } else {
      cam.roll = damp(cam.roll, 0, 2, DT);
    }
    cam.kick = damp(cam.kick, boostF, st.boost > 0 ? 9 : 2.2, DT);
    cam.fov = damp(cam.fov, 64 + sp * 12, 3, DT);
    cam.trauma = Math.max(0, cam.trauma - DT * 1.9);
  }

  FL.Sim = { jump, newState, reset, copy, launch, step, newCam, camStep, DT };
})(typeof window !== 'undefined' ? window : globalThis);
