/* Fall Line — pines. The trees that end a run (a lone pine, a row of them jutting into the
   piste) and the forest that walls the piste in where it runs through the woods.

   One stylised tree: stacked tiers of boughs, each a cone folded like paper so its lower edge
   is a zig-zag of bough tips; snow lying out toward those tips; a short trunk; a low mound of
   snow at its foot. It is cut three ways — eight boughs round for the obstacles, seven for the
   front row of the forest, a lighter three-tier tree for the rows behind — and all three are
   posed by one vertex shader from 16 floats per tree. Obstacle pines are refilled every frame
   (there are few, and they shake when you brush past); the forest is one static instance
   buffer per ribbon, planted the first time that ribbon is drawn. */
(function (root) {
  'use strict';
  const FL = root.FL, C = FL.C, U = FL.U, Look = FL.Look, Gfx = FL.Gfx;
  const SEG = C.SEG, WALL = Look.WALL, SP = WALL.spacing, hash = Look.hash;
  const TAU = Math.PI * 2;
  const IF = 16;                // floats per tree
  const MAXOB = 192;            // obstacle pines drawn at once
  const NEAR = 1.3;             // pass a pine closer than this (metres) and it shivers
  const FAR = 600;              // forest trees are drawn out to here; they shrink into the haze over the last stretch rather than pop
  const v3 = (c) => 'vec3(' + c.map((x) => x.toFixed(4)).join(', ') + ')';

  // ---------------------------------------------------------------- the tree
  /* The unit pine. Radii are in base radii, bough heights run 0..1 up the crown (the vertex
     shader decides where the crown starts and how tall the tree is). Each tier is a cone
     folded like paper: ridges run out to the bough tips, valleys end in the notches between
     them, so its lower edge is the zig-zag that says "pine". Non-indexed, so every facet can
     carry its own numbers. Per vertex:
       unit direction x,z · radius · height  |  t · u · kind · open  |  snow line
       t     along a bough: 0.3 where it comes out from under the tier above, 1 at its tip
       u     across a facet: 0 on the ridge, 1 in the valley
       kind  0 boughs, 1 trunk, 2 snow mound (for 1 and 2 the height is metres above the ground)
       open  0 tucked right under the tier above .. 1 (and beyond) open to the sky
       snow line  the t beyond which snow lies on this facet */
  function pineMesh(P) {
    const out = [], N = P.rimY.length;
    const at = (v) => [v[0] * v[2], v[6] ? v[3] : 0.5 + v[3] * 6, v[1] * v[2]];
    const tri = (a, b, c, line) => {
      const A = at(a), B = at(b), D = at(c);
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
      const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
      // wound anticlockwise seen from outside, so gl_FrontFacing tells the top of a bough from its underside
      if (nx * (A[0] + B[0] + D[0]) + nz * (A[2] + B[2] + D[2]) < 0) { const t = b; b = c; c = t; }
      for (const v of [a, b, c]) { for (let i = 0; i < 8; i++) out.push(v[i]); out.push(line); }
    };
    const ring = (j, n, r, y, t, u, kind, open) => { const a = (j / n) * TAU; return [Math.cos(a), Math.sin(a), r, y, t, u, kind, open]; };
    // top tier first: each tier hides the neck of the one below, so the depth test throws more away
    for (let i = N - 1; i >= 0; i--) {
      const top = i === N - 1, S = P.sides[i], yr = P.rimY[i], rr = P.rimR[i], ya = P.apexY[i], yn = top ? 1 : P.rimY[i + 1];
      const fJ = (yn - yr) / (ya - yr);                  // how much of a bough shows below the tier above
      const tA = top ? 0 : 1 - 0.7 / fJ, oA = top ? 1 : (tA - 0.3) / 0.32, oR = top ? 1 : 0.7 / 0.32;
      const turn = i * 0.5 + hash(i * 3.1, S) * 0.4;     // tiers are turned against each other so their ridges do not line up
      for (let j = 0; j < S; j++) {
        const h = hash(i * 7.3 + j * 1.9, S * 0.37), h2 = hash(i * 2.9 + j * 5.3, S * 0.71);
        // snow lies out toward the bough ends; the odd bough has shed its load, and the low tiers carry less
        const line = P.line + P.bare[i] + (h < 0.14 ? 0.5 : (h - 0.5) * 0.24), wide = 0.75 + 0.6 * h2;
        const A = [0, 0, 0, ya, tA, 0.5 * wide, 0, oA], T = ring(j + turn, S, rr * P.tip, yr, 1, 0, 0, oR);
        const n0 = ring(j - 0.5 + turn, S, rr * P.pleat[i], yr + P.lift * rr, 1, wide, 0, oR);
        const n1 = ring(j + 0.5 + turn, S, rr * P.pleat[i], yr + P.lift * rr, 1, wide, 0, oR);
        tri(A, n0, T, line); tri(A, T, n1, line);
      }
    }
    // the trunk runs from under the snow up into the lowest boughs
    for (let j = 0; j < P.trunk; j++) tri([0, 0, 0, 2.4, 2, 0, 1, 1], ring(j, P.trunk, 0.2, -0.6, 2, 0, 1, 1), ring(j + 1, P.trunk, 0.2, -0.6, 2, 0, 1, 1), 9);
    for (let j = 0; j < P.mound; j++) tri([0, 0, 0, 0.3, 2, 0, 2, 1], ring(j, P.mound, 0.82, -0.05, 2, 0, 2, 1), ring(j + 1, P.mound, 0.82, -0.05, 2, 0, 2, 1), 9);
    return new Float32Array(out);
  }
  const VF = 9;                 // floats per vertex of the unit pine
  const TALL = { rimY: [0, 0.27, 0.51, 0.72], rimR: [1, 0.78, 0.58, 0.41], apexY: [0.44, 0.66, 0.9, 1], tip: 1.06, pleat: [0.84, 0.78, 0.76, 0.76], lift: 0.05, line: 0.64, bare: [0.18, 0.05, 0, -0.06] };
  // boughs round each tier, bottom to top: fewer toward the tip, where the facets get small
  const MESH = [
    pineMesh(Object.assign({ sides: [8, 8, 7, 5], trunk: 4, mound: 8 }, TALL)),  // obstacles: round enough to fill a hit box from any side
    pineMesh(Object.assign({ sides: [7, 7, 6, 4], trunk: 4, mound: 5 }, TALL)),  // the forest's front row
    // the rows behind it: three tiers, and only as many folds as a tree half hidden needs (it is their upper tiers that show)
    pineMesh({ sides: [4, 5, 4], trunk: 3, mound: 0, rimY: [0, 0.35, 0.65], rimR: [1, 0.71, 0.47], apexY: [0.56, 0.9, 1], tip: 1.1, pleat: [0.74, 0.74, 0.74], lift: 0.06, line: 0.7, bare: [0.1, 0, -0.06] }),
  ];
  // x: how much further out the snow starts in a valley than on a ridge · y: the t beyond which the bough tips are bare
  const TIER = new Float32Array([0.14, 0.95]);

  const VS = `
layout(location=0) in vec4 aP;   // unit direction x,z · radius · height
layout(location=1) in vec4 aQ;   // t · u · kind · open
layout(location=6) in float aS;  // snow line
layout(location=2) in vec4 iA;   // foot of the tree (relative to uOrigin) · seed
layout(location=3) in vec4 iB;   // base radius * (cos, sin) of its turn · height · snow load 0..1
layout(location=4) in vec4 iC;   // slope of the ground under it (dy/dx, dy/dz) · lean x,z (metres at the tip)
layout(location=5) in vec4 iD;   // unit x,z pointing away from the piste · metres beyond its edge (< 0: stands on the piste) · sun on its lower half 0..1 (+2 if the snow at its foot is in the sun)
uniform vec3 uOrigin;
uniform vec4 uHit;               // a crash into the forest — xy: where (x,z, camera-relative) · z: 1 / reach
uniform vec4 uHitB;              // xy: how the trees there are swaying right now · z: how much snow they have dropped
out vec3 vW; out vec4 vT; out vec4 vAlb; out vec4 vFog;
const vec3 PINE = ${v3(Look.COL.pine)}, PINE_L = ${v3(Look.COL.pineLight)}, TRUNK = ${v3(Look.COL.trunk)}, SNOW = vec3(0.965, 0.972, 0.985);
void main(){
  vec3 foot = iA.xyz + uOrigin;
  float seed = iA.w, H = iB.z, kind = aQ.z;
  float bough = 1.0 - step(0.5, kind), mound = step(1.5, kind);
  float y0 = 0.3 + 0.03 * H;                                      // where the lowest boughs hang
  // every tree splits its height between the tiers a little differently, and is a little fuller or leaner
  float f = aP.w + sin(aP.w * 6.2832) * (fract(seed * 7.31) - 0.5) * 0.09;
  float y = mix(aP.w, y0 + (H - y0) * f, bough);
  float up = clamp((y - y0) / (H - y0), 0.0, 1.0);                // 0 at the lowest boughs .. 1 at the tip
  vec2 d = vec2(aP.x * iB.x - aP.y * iB.y, aP.x * iB.y + aP.y * iB.x) * aP.z;     // metres out from the trunk
  d *= 1.0 + (fract(seed * 9.17) - 0.5) * 0.2 * sin(up * 3.1416) * bough;
  // skied into the forest: the trees around the spot are knocked and drop their snow
  float hit = clamp(1.0 - distance(foot.xz, uHit.xy) * uHit.z, 0.0, 1.0);
  vec2 lean = iC.zw + uHitB.xy * hit * (0.5 + fract(seed * 3.7));
  float bend = max(y, 0.0) / H;
  vec3 p = vec3(d.x, y + mound * dot(iC.xy, d), d.y);            // the mound lies along the slope
  p.xz += lean * bend * bend;
  // far off, where the haze has all but taken them, trees dwindle to nothing: none ever pops in
  vW = foot + p * (1.0 - smoothstep(${(FAR - 80).toFixed(1)}, ${FAR.toFixed(1)}, length(foot)));
  gl_Position = uVP * vec4(vW, 1.0);

  // sunlight: a tree out on the piste gets all of it; in the forest only the crowns clear their neighbours
  float inForest = step(0.0, iD.z), deep = inForest * smoothstep(0.6, 4.2, iD.z);
  float footSun = step(1.5, iD.w), low = iD.w - 2.0 * footSun;
  float sun = mix(low, 1.0, smoothstep(0.30, 0.72, up));
  // the mound is lit like the snow it sits in: the shoulder darkens under the trees exactly as piste.js draws it; out on the piste it is in the tree's own shadow
  float heap = inForest * footSun * (1.0 - 0.93 * smoothstep(0.1, 1.5, iD.z + dot(d, iD.xy)));
  float lit = mix(mix(0.3 * low, sun, bough), heap, mound);
  vec3 green = mix(PINE, PINE_L, 0.12 + 0.5 * fract(seed * 13.7) + 0.22 * up) * (1.0 - 0.42 * deep * (1.0 - up));
  vAlb = vec4(mix(mix(TRUNK, green, bough), SNOW, mound), aQ.w);
  // snow shaken loose slides off toward the tips
  vT = vec4(aQ.x, aQ.y, lit, aS + (1.0 - iB.w * (1.0 - uHitB.z * hit)) * 0.7);
  // haze per vertex: a tree is small against the distances the air changes over
  vec3 f0 = flFog(vec3(0.0), vW), f1 = flFog(vec3(1.0), vW);
  vFog = vec4(f0, f1.g - f0.g);
}`;

  const FS = `
in vec3 vW; in vec4 vT; in vec4 vAlb; in vec4 vFog;
uniform vec2 uTier;              // x: how much further out the snow starts in a valley than on a ridge · y: where the bare bough tips begin
out vec4 o;
const vec3 SNOW = vec3(0.93, 0.95, 0.98);
void main(){
  vec3 n = flFacet(vW);
  float top = float(gl_FrontFacing);                             // 1 on the upper side of a bough, 0 underneath it
  float t = vT.x, w = fwidth(t) * 0.75 + 0.003;
  // snow: from the snow line (further out in the valleys than on the ridges) to just short of the tips
  float line = vT.w + vT.y * uTier.x;
  float snow = smoothstep(line - w, line + w, t) * (1.0 - smoothstep(uTier.y - w, uTier.y + w, t)) * top;
  float open = clamp(vAlb.a, 0.0, 1.0);
  open *= 2.0 - open;                                            // dark only close in under the tier above
  vec3 alb = mix(vAlb.rgb * (0.4 + 0.6 * open) * (0.6 + 0.4 * top), SNOW, snow);
  vec3 col = flLight(alb, n, vT.z * top * (0.25 + 0.75 * open));
  o = vec4(col * vFog.a + vFog.rgb, 1.0);
}`;

  // ---------------------------------------------------------------- state
  let prog = null, gen = -1, obVao = null, obBuf = null, nOb = 0;
  const tpl = [null, null, null];                      // the three cuts of the tree, as vertex buffers
  const obData = new Float32Array(MAXOB * IF), TMP = new Float32Array(48);
  let scratch = new Float32Array(IF * 1024), scratchS = new Float32Array(1024);
  // a crash into the forest edge: where, how long ago, and which way the trees were knocked
  const hit = { on: false, t: 0, x: 0, z: 0, ax: 0, az: 0 };
  const PA = [0, 0, 0], PB = [0, 0, 0], EA = [0, 0, 0], EB = [0, 0, 0], SA = [0, 0, 0], SB = [0, 0, 0];
  const PL = { y: 0, gx: 0, gz: 0 };

  // flHash from the shared GLSL, in 32-bit floats: the piste shader sizes each forest tree's
  // shadow from it, so the front row takes its heights from the same number.
  const fr = Math.fround;
  function glHash(px, py) {
    const k = fr(0.1031), c = fr(33.33);
    let x = fr(px * k), y = fr(py * k);
    x = fr(x - Math.floor(x)); y = fr(y - Math.floor(y));
    let z = x;
    const d = fr(fr(fr(x * fr(y + c)) + fr(y * fr(z + c))) + fr(z * fr(x + c)));
    x = fr(x + d); y = fr(y + d); z = fr(z + d);
    const m = fr(fr(x + y) * z);
    return m - Math.floor(m);
  }

  function init(R) {
    const gl = R.gl;
    gen = R.gen;
    prog = R.program('flora', VS, FS);
    for (let i = 0; i < 3; i++) tpl[i] = { buf: R.buffer(MESH[i]), count: MESH[i].length / VF };
    obVao = gl.createVertexArray(); gl.bindVertexArray(obVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, tpl[0].buf); R.attr(0, 4, VF, 0); R.attr(1, 4, VF, 4); R.attr(6, 1, VF, 8);
    obBuf = R.buffer(obData.byteLength, gl.DYNAMIC_DRAW);
    for (let a = 0; a < 4; a++) R.attr(2 + a, 4, IF, a * 4, 1);
    gl.bindVertexArray(null);
  }

  // ---------------------------------------------------------------- obstacle pines
  function fillObstacles(R, v, dt) {
    const tr = v.track, cam = R.cam, obs = tr.obstacles, behind = v.s - v.cam.back - 12, data = obData;
    let n = 0;
    for (let i = 0; i < obs.length && n < MAXOB; i++) {
      const ob = obs[i];
      if (ob.s < behind) continue;
      const cnt = Look.trees(ob, TMP);
      if (!cnt) continue;
      const w = R.place(tr, ob), cs = Math.cos(w[3]), sn = Math.sin(w[3]);
      const gx = w[4] * sn + ob.b * cs, gz = -w[4] * cs + ob.b * sn;
      const sk = ob.flora;
      if (sk) sk.t += dt;
      for (let j = 0; j < cnt && n < MAXOB; j++) {
        const off = TMP[j * 3] - ob.o, r = TMP[j * 3 + 1], h = TMP[j * 3 + 2];
        const seed = hash(ob.seed * 61.3 + j * 7.7, ob.s * 0.37 + 1.3), turn = seed * TAU;
        const la = hash(seed * 91.1, 2.7) * TAU, lm = h * 0.028 * hash(seed * 33.7, 5.1);
        let lx = Math.cos(la) * lm, lz = Math.sin(la) * lm, snow = 0.84 + 0.16 * hash(seed * 17.9, 8.3);
        if (sk) {
          // the tree that was brushed sways hardest; its neighbours in a row answer a beat later
          const dj = Math.abs(j - sk.j), t = sk.t - dj * 0.06, amp = sk.k * (dj === 0 ? 1 : dj === 1 ? 0.45 : dj === 2 ? 0.18 : 0);
          if (amp > 0 && t > 0) {
            const sway = amp * Math.exp(-3.0 * t) * Math.sin(15 * t);
            lx += sk.ax * sway; lz += sk.az * sway;
            snow *= 1 - Math.min(1, amp * 1.5) * U.smooth(t / 0.3);
          }
        }
        const q = n++ * IF;
        data[q] = w[0] + cs * off - cam.x; data[q + 1] = w[1] + off * ob.b - cam.y; data[q + 2] = w[2] + sn * off - cam.z; data[q + 3] = seed;
        data[q + 4] = r * Math.cos(turn); data[q + 5] = r * Math.sin(turn); data[q + 6] = h; data[q + 7] = snow;
        data[q + 8] = gx; data[q + 9] = gz; data[q + 10] = lx; data[q + 11] = lz;
        data[q + 12] = 0; data[q + 13] = 0; data[q + 14] = -1; data[q + 15] = 1;
      }
    }
    nOb = n;
  }

  // ---------------------------------------------------------------- the forest edge
  /* Height and slope of the plane through a, b, c at (px, pz). Returns how far inside the
     triangle the point is (negative outside), or -9 if the triangle has no area. */
  function plane(a, b, c, px, pz, out) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const det = ux * vz - uz * vx;
    if (Math.abs(det) < 1e-5) return -9;
    const dx = px - a[0], dz = pz - a[2], l1 = (dx * vz - dz * vx) / det, l2 = (ux * dz - uz * dx) / det;
    out.y = a[1] + l1 * uy + l2 * vy;
    out.gx = (uy * vz - vy * uz) / det; out.gz = (ux * vy - vx * uy) / det;
    return Math.min(l1, l2, 1 - l1 - l2);
  }

  function freeForest(R, rb) {
    const f = rb.flora;
    if (f && f.buf && f.gen === R.gen) { R.gl.deleteVertexArray(f.vao0); R.gl.deleteVertexArray(f.vao1); R.gl.deleteBuffer(f.buf); }
    rb.flora = null;
  }

  /* Plant one ribbon's forest: every tree on both sides, for as many rows as this quality
     level draws. Front-row trees first, then the rows behind, each in order of s so the part
     that has gone by can be skipped when drawing. */
  function plant(R, tr, rb, rows) {
    const gl = R.gl, F = tr.F, N = rb.n;
    const fl = (rb.flora = { gen: R.gen, rows, buf: null, vao0: null, vao1: null, n0: 0, n1: 0, s0: null, s1: null, i0: 0, i1: 0, j0: 0, j1: 0, p0: -1, p1: -1, ox: 0, oy: 0, oz: 0 });
    if ((!rb.wl && !rb.wr) || N < 2) return fl;
    const c0 = Math.ceil(rb.sA / SP - 0.5), c1 = Math.ceil(rb.sB / SP - 0.5) - 1;     // tree centres at (cell + 0.5) * SP within [sA, sB)
    const cells = c1 - c0 + 1;
    if (cells <= 0) return fl;
    const cap = cells * 2 * rows;
    if (scratch.length < cap * IF) { scratch = new Float32Array(cap * IF); scratchS = new Float32Array(cap); }
    const data = scratch, sOf = scratchS, ox = F.x[rb.k0], oy = F.y[rb.k0], oz = F.z[rb.k0];
    // how wide the snow shoulder is at section i: the same easing piste.js builds it with
    const soft = (arr, i) => {
      let sum = 0;
      for (let d = -4; d <= 4; d++) sum += arr[Math.max(0, Math.min(N - 1, i + d))] * (5 - Math.abs(d));
      return Math.min(1, sum / 19) * WALL.shoulder;
    };
    // a point on section i's cross-section, d metres beyond the piste edge on `side`
    const cross = (i, side, d, out) => {
      const k = rb.k0 + i, yaw = F.yaw[k], o = rb.c[i] + side * (rb.hw[i] + d);
      out[0] = F.x[k] + Math.cos(yaw) * o; out[1] = F.y[k] + rb.e[i] + (o - rb.c[i]) * rb.b[i] + d * 0.06; out[2] = F.z[k] + Math.sin(yaw) * o;
      return out;
    };
    let n = 0;
    const tree = (cell, side, row, arr) => {
      const sc = (cell + 0.5) * SP, i0 = Math.max(0, Math.min(N - 2, Math.floor((sc - rb.sA) / SEG)));
      if (!(arr[i0] > 0.5)) return;                       // the same test the simulation makes for "into the trees"
      const h1 = hash(cell * 0.731 + row * 17.1, side * 3.3 + 0.7), h2 = hash(cell * 1.913 + row * 5.3, side * 7.9 + 2.1), h3 = hash(cell * 2.377 + row * 9.7, side * 1.3 + 4.9);
      let s, d, r, h;
      if (row === 0) {
        // the front row keeps to the line the piste's shadows are drawn from: nudged only outward, and only a little
        s = sc + (h1 - 0.5) * 0.36; d = WALL.inset + h2 * 0.28; r = WALL.r;
        h = WALL.hMin + (WALL.hMax - WALL.hMin) * glHash(cell, side * 7 + 3);
      } else {
        // behind it the forest loosens: taller, less regular, with gaps (none when a single row has to close the view)
        if (h3 < (row > 1 ? 0.3 : rows > 2 ? 0.12 : 0)) return;
        s = sc + (h1 - 0.5) * 1.5; d = WALL.inset + row * WALL.rowGap + (h2 - 0.5) * 1.1; r = WALL.r * (0.94 + 0.3 * h3);
        h = WALL.hMin + (WALL.hMax - WALL.hMin) * (0.3 + 0.95 * hash(cell * 3.11 + row * 2.3, side * 5.7 + 9.1));
      }
      const t = Math.max(0, Math.min(N - 1.001, (s - rb.sA) / SEG)), i = Math.floor(t), f = t - i;
      const swA = soft(arr, i), swB = soft(arr, i + 1);
      if (row > 0 && d + r * 0.4 > swA + (swB - swA) * f) return;          // no snow out there to stand on
      cross(i, side, d, PA); cross(i + 1, side, d, PB);
      const x = PA[0] + (PB[0] - PA[0]) * f, z = PA[2] + (PB[2] - PA[2]) * f;
      // the ground: whichever of the two triangles piste.js draws under this spot
      cross(i, side, 0, EA); cross(i + 1, side, 0, EB); cross(i, side, swA, SA); cross(i + 1, side, swB, SB);
      let in1, in2, y, gx, gz;
      if (side < 0) { in1 = plane(SA, EA, SB, x, z, PL); y = PL.y; gx = PL.gx; gz = PL.gz; in2 = plane(EA, EB, SB, x, z, PL); }
      else { in1 = plane(EA, SA, EB, x, z, PL); y = PL.y; gx = PL.gx; gz = PL.gz; in2 = plane(SA, SB, EB, x, z, PL); }
      if (in2 > in1) { y = PL.y; gx = PL.gx; gz = PL.gz; }
      if (in1 < -8 && in2 < -8) { y = PA[1] + (PB[1] - PA[1]) * f; gx = 0; gz = 0; }
      const yaw = F.yaw[rb.k0 + i] + (F.yaw[rb.k0 + i + 1] - F.yaw[rb.k0 + i]) * f;
      const outX = Math.cos(yaw) * side, outZ = Math.sin(yaw) * side;
      // which rows the low sun reaches below the crown: the front row when it shines across the piste, the back row when it comes from behind
      const across = Look.SHADOW[0] * outX + Look.SHADOW[1] * outZ;
      const sun = row === 0 ? U.sstep(-0.04, 0.3, across) : row === rows - 1 ? U.sstep(0.04, -0.3, across) * 0.8 : 0;
      const footSun = across > -0.04 ? 2 : 0;             // piste.js shades the foot of this wall only when the sun is behind it
      const seed = hash(cell * 1.37 + row * 23.9, side * 2.9 + 6.3), turn = seed * TAU;
      const la = hash(seed * 91.1, 2.7) * TAU, lm = h * 0.022 * hash(seed * 33.7, 5.1), away = h * (row === 0 ? 0.012 : 0);
      const q = n * IF;
      data[q] = x - ox; data[q + 1] = y - oy; data[q + 2] = z - oz; data[q + 3] = seed;
      data[q + 4] = r * Math.cos(turn); data[q + 5] = r * Math.sin(turn); data[q + 6] = h; data[q + 7] = 0.84 + 0.16 * hash(seed * 17.9, 8.3);
      data[q + 8] = gx; data[q + 9] = gz; data[q + 10] = Math.cos(la) * lm + outX * away; data[q + 11] = Math.sin(la) * lm + outZ * away;
      data[q + 12] = outX; data[q + 13] = outZ; data[q + 14] = d; data[q + 15] = sun + footSun;
      sOf[n++] = sc;
    };
    for (let cell = c0; cell <= c1; cell++) { if (rb.wl) tree(cell, -1, 0, rb.wl); if (rb.wr) tree(cell, 1, 0, rb.wr); }
    const n0 = n;
    for (let cell = c0; cell <= c1; cell++) {
      for (let row = 1; row < rows; row++) { if (rb.wl) tree(cell, -1, row, rb.wl); if (rb.wr) tree(cell, 1, row, rb.wr); }
    }
    if (!n) return fl;
    fl.n0 = n0; fl.n1 = n - n0; fl.ox = ox; fl.oy = oy; fl.oz = oz;
    fl.s0 = sOf.slice(0, n0); fl.s1 = sOf.slice(n0, n);
    fl.buf = R.buffer(data.subarray(0, n * IF));
    for (let g = 0; g < 2; g++) {
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, tpl[1 + g].buf); R.attr(0, 4, VF, 0); R.attr(1, 4, VF, 4); R.attr(6, 1, VF, 8);
      gl.bindBuffer(gl.ARRAY_BUFFER, fl.buf);
      for (let a = 0; a < 4; a++) R.attr(2 + a, 4, IF, (g ? n0 * IF : 0) + a * 4, 1);
      if (g) fl.vao1 = vao; else fl.vao0 = vao;
    }
    gl.bindVertexArray(null);
    return fl;
  }

  // Draw trees first..end of one group of a ribbon's instances (the rest are behind the camera, or too far off to see).
  function drawGroup(gl, vao, buf, base, first, end, last, tplCount) {
    if (end - first <= 0) return last;
    gl.bindVertexArray(vao);
    if (first !== last) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (let a = 0; a < 4; a++) gl.vertexAttribPointer(2 + a, 4, gl.FLOAT, false, IF * 4, (base + first) * IF * 4 + a * 16);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, tplCount, end - first);
    return first;
  }

  // ---------------------------------------------------------------- reactions
  function puff(x, y, z, vx, vy, vz, amount) {
    const fx = Gfx.fx;                                   // the snow layer, if it has arrived
    if (!fx || typeof fx.puff !== 'function') return;
    try { fx.puff(x, y, z, vx, vy, vz, amount); } catch (err) { /* a problem in another layer must not take the trees down */ }
  }

  /* Tree j of obstacle `ob` was brushed (k < 1) or hit (k >= 1): it sways along (ax, az) and
     the snow comes off its boughs. */
  function shake(R, v, ob, j, k, ax, az) {
    const sk = ob.flora || (ob.flora = { j: 0, t: 0, k: 0, ax: 0, az: 0 });
    const calm = v.calm ? 0.5 : 1, m = 1 / (Math.hypot(ax, az) || 1);
    sk.j = j; sk.t = 0; sk.k = k * calm; sk.ax = ax * m * 0.55; sk.az = az * m * 0.55;
    const n = Look.trees(ob, TMP);
    if (j >= n) return;
    const w = R.place(v.track, ob), off = TMP[j * 3] - ob.o, h = TMP[j * 3 + 2], sp = R.skier;
    const x = w[0] + Math.cos(w[3]) * off, y = w[1] + off * ob.b, z = w[2] + Math.sin(w[3]) * off, drag = k >= 1 ? 0.3 : 0.14;
    for (let i = 0; i < 3; i++) puff(x, y + h * (0.24 + 0.22 * i), z, sp.vx * drag, k >= 1 ? 1.5 : -0.5, sp.vz * drag, Math.min(1, k) * calm * (1 - i * 0.2));
  }

  function onEvent(R, e, v) {
    const sp = R.skier;
    if (e.type === 'pass') {
      const ob = e.ob;
      if (!ob || e.cl >= NEAR || (ob.kind !== 'pine' && ob.kind !== 'pines')) return;
      // in a row it is the end tree, the one the skier squeezed past
      const j = ob.kind === 'pines' && e.side < 0 ? Look.trees(ob, TMP) - 1 : 0;
      const k = 0.3 + 0.5 * (1 - Math.max(0, e.cl) / NEAR);
      shake(R, v, ob, j, k, sp.sn * 0.6 + sp.cs * e.side, -sp.cs * 0.6 + sp.sn * e.side);
    } else if (e.type === 'dead' && e.cause === 'crash') {
      if (e.into === 'pine' || e.into === 'pines') {
        let best = null, bd = 1e9;
        for (const ob of v.track.obstacles) {
          if (ob.s > v.s + 8) break;
          if (ob.s < v.s - 8 || (ob.kind !== 'pine' && ob.kind !== 'pines')) continue;
          const d = Math.abs(ob.s - v.s) + Math.max(0, Math.abs(ob.o - v.o) - ob.hx) * 2;
          if (d < bd) { bd = d; best = ob; }
        }
        if (!best) return;
        const n = Look.trees(best, TMP);
        let j = 0;
        for (let i = 1; i < n; i++) if (Math.abs(TMP[i * 3] - v.o) < Math.abs(TMP[j * 3] - v.o)) j = i;
        const side = TMP[j * 3] >= v.o ? 1 : -1;
        shake(R, v, best, j, 1.25, sp.sn + sp.cs * side * 0.5, -sp.cs + sp.sn * side * 0.5);
      } else if (e.into === 'trees') {
        const side = v.o < 0 ? -1 : 1, calm = v.calm ? 0.5 : 1;
        hit.on = true; hit.t = 0; hit.x = sp.x + sp.cs * side * 0.9; hit.z = sp.z + sp.sn * side * 0.9;
        hit.ax = (sp.sn * 0.8 + sp.cs * side * 0.6) * 0.5 * calm; hit.az = (-sp.cs * 0.8 + sp.sn * side * 0.6) * 0.5 * calm;
        for (let i = 0; i < 4; i++) puff(hit.x + sp.sn * (i - 1) * 1.2, sp.y + 1.2 + 1.3 * ((i * 2) % 3), hit.z - sp.cs * (i - 1) * 1.2, sp.vx * 0.25, 1.2, sp.vz * 0.25, calm * (1 - i * 0.15));
      }
    }
  }

  // ---------------------------------------------------------------- layer
  Gfx.layer({
    name: 'flora', order: 30, init, onEvent,
    reset() { hit.on = false; hit.t = 0; nOb = 0; },
    freeRibbon(R, rb) { freeForest(R, rb); },
    prepare(R, v, dt) {
      fillObstacles(R, v, dt);
      if (hit.on) hit.t += dt;
    },
    drawOpaque(R, v) {
      if (gen !== R.gen) return;
      const gl = R.gl, tr = v.track, cam = R.cam, u = prog.u, behind = v.s - v.cam.back - 12, ahead = v.s + FAR + 60;
      const rows = R.notch >= 3 ? Math.min(2, WALL.rows) : WALL.rows;
      gl.useProgram(prog.p);
      gl.uniform2fv(u.uTier, TIER);
      if (hit.on) {
        const sway = Math.exp(-3.0 * hit.t) * Math.sin(13 * hit.t);
        gl.uniform4f(u.uHit, hit.x - cam.x, hit.z - cam.z, 1 / 5, 0);
        gl.uniform4f(u.uHitB, hit.ax * sway, hit.az * sway, 0.95 * U.smooth(hit.t / 0.35), 0);
      } else { gl.uniform4f(u.uHit, 0, 0, 0, 0); gl.uniform4f(u.uHitB, 0, 0, 0, 0); }
      // nearest things first, so what stands behind them fails the depth test early
      if (nOb) {
        gl.uniform3f(u.uOrigin, 0, 0, 0);
        gl.bindVertexArray(obVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, obBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, obData, 0, nOb * IF);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, tpl[0].count, nOb);
      }
      for (const rb of tr.ribbons) {
        if (rb.sB < behind || rb.sA > ahead || (!rb.wl && !rb.wr)) continue;
        let fl = rb.flora;
        if (!fl || fl.gen !== R.gen || fl.rows !== rows) { freeForest(R, rb); fl = plant(R, tr, rb, rows); }
        if (!fl.buf) continue;
        // each group is in order of s: step past what has gone by, and up to what has come into range
        while (fl.i0 < fl.n0 && fl.s0[fl.i0] < behind) fl.i0++;
        while (fl.i1 < fl.n1 && fl.s1[fl.i1] < behind) fl.i1++;
        while (fl.j0 < fl.n0 && fl.s0[fl.j0] < ahead) fl.j0++;
        while (fl.j1 < fl.n1 && fl.s1[fl.j1] < ahead) fl.j1++;
        gl.uniform3f(u.uOrigin, fl.ox - cam.x, fl.oy - cam.y, fl.oz - cam.z);
        fl.p0 = drawGroup(gl, fl.vao0, fl.buf, 0, fl.i0, fl.j0, fl.p0, tpl[1].count);
        fl.p1 = drawGroup(gl, fl.vao1, fl.buf, fl.n0, fl.i1, fl.j1, fl.p1, tpl[2].count);
      }
      gl.bindVertexArray(null);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
