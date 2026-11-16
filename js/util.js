/* Fall Line — shared math, RNG and tuning constants.
   Plain scripts on a single global (FL) so the game runs from file:// with no build step,
   and the same files load in Node for headless playtests. */
(function (root) {
  'use strict';
  const FL = root.FL = root.FL || {};

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const sstep = (a, b, x) => smooth((x - a) / (b - a));
  // Frame-rate independent exponential approach.
  const damp = (a, b, k, dt) => b + (a - b) * Math.exp(-k * dt);

  // mulberry32 — small, fast, deterministic.
  function rng(seed) {
    let a = seed >>> 0;
    const f = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = (lo, hi) => lo + (hi - lo) * f();
    f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
    f.chance = (p) => f() < p;
    f.sign = () => (f() < 0.5 ? -1 : 1);
    f.pick = (arr) => arr[Math.floor(f() * arr.length)];
    return f;
  }

  // ---- mat4 (column-major Float32Array) -------------------------------------------------
  const M4 = {
    create: () => new Float32Array(16),
    perspective(out, fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      out.fill(0);
      out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1; out[14] = 2 * far * near * nf;
      return out;
    },
    // Rotation-only view matrix for a camera sitting at the origin (camera-relative rendering).
    lookDir(out, dx, dy, dz, ux, uy, uz) {
      let l = 1 / Math.hypot(dx, dy, dz); dx *= l; dy *= l; dz *= l;
      // right = dir x up
      let rx = dy * uz - dz * uy, ry = dz * ux - dx * uz, rz = dx * uy - dy * ux;
      l = 1 / Math.hypot(rx, ry, rz); rx *= l; ry *= l; rz *= l;
      // true up = right x dir
      const vx = ry * dz - rz * dy, vy = rz * dx - rx * dz, vz = rx * dy - ry * dx;
      out[0] = rx; out[1] = vx; out[2] = -dx; out[3] = 0;
      out[4] = ry; out[5] = vy; out[6] = -dy; out[7] = 0;
      out[8] = rz; out[9] = vz; out[10] = -dz; out[11] = 0;
      out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
      return out;
    },
    mul(out, a, b) {
      for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
      }
      return out;
    },
    invert(out, m) {
      const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
      const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return null;
      det = 1 / det;
      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return out;
    },
  };

  // ---- quaternion [x,y,z,w] — only what the rolling ball needs ---------------------------
  const Q = {
    // out = rotation(axis, angle) * q   (axis must be normalised)
    rotate(q, ax, ay, az, angle) {
      const h = angle * 0.5, s = Math.sin(h), c = Math.cos(h);
      const bx = ax * s, by = ay * s, bz = az * s, bw = c;
      const x = q[0], y = q[1], z = q[2], w = q[3];
      q[0] = bw * x + bx * w + by * z - bz * y;
      q[1] = bw * y - bx * z + by * w + bz * x;
      q[2] = bw * z + bx * y - by * x + bz * w;
      q[3] = bw * w - bx * x - by * y - bz * z;
      const l = 1 / Math.hypot(q[0], q[1], q[2], q[3]);
      q[0] *= l; q[1] *= l; q[2] *= l; q[3] *= l;
      return q;
    },
    toMat3(out, q) {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, yx = y * x2, yy = y * y2, zx = z * x2, zy = z * y2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      out[0] = 1 - yy - zz; out[3] = yx - wz; out[6] = zx + wy;
      out[1] = yx + wz; out[4] = 1 - xx - zz; out[7] = zy - wx;
      out[2] = zx - wy; out[5] = zy + wx; out[8] = 1 - xx - yy;
      return out;
    },
  };

  // ---- colour -----------------------------------------------------------------------------
  const toLin = (c) => Math.pow(c, 2.2);
  // "#rrggbb" -> linear [r,g,b]
  function hex(h) {
    const n = parseInt(h.slice(1), 16);
    return [toLin(((n >> 16) & 255) / 255), toLin(((n >> 8) & 255) / 255), toLin((n & 255) / 255)];
  }
  const mix3 = (out, a, b, t) => { out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t); return out; };

  FL.U = { clamp, lerp, smooth, sstep, damp, rng, M4, Q, hex, mix3 };

  // ---- tuning ---------------------------------------------------------------------------------
  // Everything that defines how the game plays lives here, so the generator (which has to
  // promise every layout is beatable) and the simulation agree on the same numbers.
  const C = {
    STEP: 1 / 120,        // fixed simulation step: play is identical at any display refresh rate
    SEG: 2,               // metres between track cross-sections
    R: 0.5,               // ball radius
    G: 50,                // gravity (heavy on purpose: the ball stays planted and jumps are snappy)
    S_START: 24,          // where on the track a run begins
    GEN_AHEAD: 420,
    PRUNE_BEHIND: 46,

    // Speed. Base pace is a function of distance, so every stretch of track has a known speed
    // range the generator can design for. Steeper ground = faster.
    baseSpeed: (s) => 44 + 46 * (1 - Math.exp(-Math.max(0, s) / 3500)),
    terrain: (sl) => clamp(1 + 0.9 * (sl - 0.26), 0.86, 1.2),
    U_MIN_F: 0.84,        // lowest speed (as a fraction of base) the generator has to allow for
    boostV: (B) => 7 + 0.12 * B,
    BOOST_HOLD: 0.6,
    BOOST_FADE: 1.3,
    K_UP: 2.4,            // how fast speed climbs to its target …
    K_DOWN: 0.9,          // … and how slowly it bleeds off (momentum)

    // Steering: constant push against linear drag. Heavy on purpose: the skier carries momentum,
    // keeps sliding when you let go, and has to be caught with a counter-steer. Takes practice.
    STEER_A: 72,
    STEER_K: 2.9,
    K_REL: 2.2,
    COUNTER: 1.35,         // extra bite when steering against current motion
    AIR_A: 0.4,
    JUMP_V: 10.5,         // pop off the snow when you jump: about a metre of height, 0.4 s of air
    JUMP_BUF: 0.14,       // a jump pressed this long before touching down still happens on landing
    HURDLE_H: 0.8,        // height of the low fences across the piste that you have to jump
    AIR_K: 2.2,
    GB: 60,               // sideways pull of a tilted surface, per unit of bank
    AC_MAX: 24,           // strongest cornering push the generator will ask the player to hold

    EDGE: 0.2,            // how far the ball's centre may hang over an edge
    SNAP: 0.6,            // a ball this far below a lip still makes the landing
    HIT_R: 0.42,          // collision radius — a touch smaller than the ball, grazes are misses
    NEAR: 1.15,           // clearance that counts as a close call

    MULT_MAX: 5,
    FLOW_T: 3.5,          // seconds a multiplier level holds without a new boost or close call
    FLOW_DROP_T: 1.75,    // then it sheds a level this often
  };
  C.V_LAT = C.STEER_A / C.STEER_K;
  // Time to move sideways by d metres from rest at full steer.
  C.tMove = (d) => {
    if (d <= 0) return 0;
    const k = C.STEER_K, vT = C.V_LAT;
    let lo = 0, hi = 3;
    for (let i = 0; i < 24; i++) {
      const t = (lo + hi) / 2;
      if (vT * (t - (1 - Math.exp(-k * t)) / k) < d) lo = t; else hi = t;
    }
    return hi;
  };
  FL.C = C;
})(typeof window !== 'undefined' ? window : globalThis);
