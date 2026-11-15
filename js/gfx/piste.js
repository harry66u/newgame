/* Fall Line — the piste: snow you ski on, the forest shoulder beside it, and the rock that
   falls away beneath. Also where every shadow on the snow is drawn. Shadows are analytic —
   each pine, boulder and fence near a stretch of snow is handed to the shader as a shape and
   projected along the sun — so they are soft, exact, and cost no extra pass. */
(function (root) {
  'use strict';
  const FL = root.FL, C = FL.C, Look = FL.Look, Gfx = FL.Gfx;
  const SEG = C.SEG, WALL = Look.WALL;
  const PART = 26;            // sections per mesh part: keeps the caster list for each draw short
  const NC = 16;              // shadow casters per part
  const DEPTH = 130;          // how far the rock is drawn below the snow before haze takes it
  const BATTER = 0.11;        // the faces lean outward going down
  const f1 = (x) => x.toFixed(3);

  const VS = `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec4 aA; layout(location=3) in vec4 aB;
uniform vec3 uOrigin;
out vec3 vW; out vec3 vN; out vec4 vA; out vec4 vB; out vec2 vSh;
void main(){
  vW = aPos + uOrigin; vN = aNrm; vA = aA; vB = aB;
  // which way shadows fall, seen in track space: x across the piste (+ = right), y along it (+ = downhill)
  float cy = cos(aB.w), sy = sin(aB.w);
  vSh = vec2(dot(uShadow.xy, vec2(cy, sy)), dot(uShadow.xy, vec2(sy, -cy)));
  gl_Position = uVP * vec4(vW, 1.0);
}`;

  const FS = `
in vec3 vW; in vec3 vN; in vec4 vA; in vec4 vB; in vec2 vSh;
uniform vec4 uCA[${NC}]; uniform vec4 uCB[${NC}]; uniform int uNC;
out vec4 o;
const float W_INSET = ${f1(WALL.inset)}, W_SP = ${f1(WALL.spacing)}, W_HMIN = ${f1(WALL.hMin)}, W_HMAX = ${f1(WALL.hMax)}, W_R = ${f1(WALL.r)};

// A pine at p (base radius r, height h): a long tapering shadow with a stepped edge for its tiers.
float pineShadow(vec2 q, vec2 p, float r, float h){
  vec2 S = uShadow.xy * (h * uShadow.z), rel = q - p;
  float t = clamp(dot(rel, S) / dot(S, S), 0.0, 1.0);
  float d = length(rel - S * t);
  float soft = 0.08 + 0.8 * t * t;                        // the penumbra opens up toward the tip
  float wid = r * (1.0 - t) * (0.78 + 0.36 * fract(t * 3.0 + 0.2));
  return 1.0 - smoothstep(-soft * 0.5, soft, d - wid);
}
// A boulder or a run of fence: a footprint (centre A.xy, along axis B.xy, half-length B.z,
// half-depth B.w) of height A.z, swept along the sun.
float slabShadow(vec2 q, vec4 A, vec4 B){
  vec2 rel = q - A.xy, ax = B.xy, pr = vec2(-ax.y, ax.x);
  vec2 S = uShadow.xy * (A.z * uShadow.z);
  float a = dot(rel, ax), b = dot(rel, pr), Sa = dot(S, ax), Sb = dot(S, pr);
  float t = clamp(abs(Sb) > abs(Sa) ? b / Sb : a / Sa, 0.0, 1.0);
  float soft = 0.10 + 0.55 * t;
  return (1.0 - smoothstep(-soft, soft, abs(a - t * Sa) - B.z)) * (1.0 - smoothstep(-soft, soft, abs(b - t * Sb) - B.w));
}
// The forest edge on one side (side = 1 right, -1 left): a band of shade under the trees and
// a fringe of pointed tree-shadows reaching out across the piste when the sun is behind them.
float wallShadow(float off, float hw, float s, float side, vec2 sd){
  float lx = sd.x * side;
  if (lx > -0.04) return 0.0;
  float dl = (hw + W_INSET) - off * side;                 // sideways distance from the line of trunks
  float len = dl / -lx;                                   // how far along the ground the sun ray has come
  float sc = s - len * sd.y;                              // where along the tree line that ray started
  float cell = floor(sc / W_SP), fc = fract(sc / W_SP) - 0.5;
  float rnd = flHash(vec2(cell, side * 7.0 + 3.0));
  float h = mix(W_HMIN, W_HMAX, rnd);
  // Art over physics: with the sun square-on, true shadows would stripe the whole piste.
  // Keep the fringe to the sunward third so the run stays bright and easy to read.
  float full = min(h * uShadow.z, (3.2 + 3.0 * rnd) / -lx), t = len / full;
  float wid = W_R * (1.0 - t) * (0.78 + 0.36 * fract(t * 3.0 + 0.2));
  float soft = 0.08 + 0.8 * t * t;
  float teeth = (1.0 - smoothstep(-soft * 0.5, soft, abs(fc) * W_SP * -lx - wid)) * step(t, 1.0);
  float mass = 1.0 - smoothstep(0.9, 2.4, dl);
  return max(teeth, mass);
}
float skierShadow(vec2 q){
  float h = uSkier.w;
  if (h > 50.0) return 0.0;
  vec2 p = uSkier.xz + uShadow.xy * (h * uShadow.z);      // it lands further off the higher the skier is
  vec2 S = uShadow.xy * (1.65 * uShadow.z), rel = q - p;
  float t = clamp(dot(rel, S) / dot(S, S), 0.0, 1.0);
  float d = length(rel - S * t);
  float soft = 0.10 + 0.45 * t + h * 0.14;
  return (1.0 - smoothstep(-soft * 0.4, soft, d - mix(0.36, 0.15, t))) * (0.9 / (1.0 + h * 0.18));
}

void main(){
  vec3 col, n = normalize(vN);
  if (vB.z < 0.5) {
    float off = vA.x, hw = vA.y, s = vA.z;
    float edge = hw - abs(off);                           // > 0 on the piste, < 0 out on the shoulder
    float onP = smoothstep(-0.1, 0.3, edge);
    float wall = off < 0.0 ? vB.x : vB.y;                 // is the nearer side forest?

    float sh = 0.0;
    for (int i = 0; i < uNC; i++) {
      vec4 A = uCA[i], B = uCB[i];
      sh = max(sh, A.w < 0.5 ? pineShadow(vW.xz, A.xy, B.x, A.z) : slabShadow(vW.xz, A, B) * (A.w > 1.5 ? 0.5 : 1.0));
    }
    if (vB.y > 0.5) sh = max(sh, wallShadow(off, hw, s, 1.0, vSh));
    if (vB.x > 0.5) sh = max(sh, wallShadow(off, hw, s, -1.0, vSh));
    sh = max(sh, smoothstep(0.1, 1.5, -edge) * 0.93);     // under the trees
    sh = max(sh, skierShadow(vW.xz));
    float lit = 1.0 - sh;

    // wind-packed drifts: broad and soft, something for the eye to slide past
    float n1 = flNoise(vec2(off * 0.21, s * 0.13)), n2 = flNoise(vec2(off * 0.83 + 9.0, s * 0.47));
    float drift = (n1 - 0.5) * 1.3 + (n2 - 0.5) * 0.7;
    // corduroy left by the groomer, running down the fall line
    float cor = sin(off * 27.0) * onP * clamp(1.0 - fwidth(off) * 7.0, 0.0, 1.0);
    float rough = (1.0 - onP) * (flNoise(vec2(off * 2.3, s * 2.1)) - 0.5);
    // an open edge is a cornice: it rolls away from the light before it drops
    float lip = (1.0 - smoothstep(0.0, 0.7, edge)) * (1.0 - step(0.5, wall));
    float tex = 1.0 + drift * 0.085 + cor * 0.028 + rough * 0.12 - lip * 0.17;
    col = flLight(vec3(0.965, 0.972, 0.985) * tex, n, lit);
    col = mix(col, col * vec3(0.86, 0.93, 1.03), clamp(-drift, 0.0, 1.0) * 0.5);

    // low sun on snow: a sheen down the slope toward it, and glints close to the camera
    vec3 V = normalize(-vW);
    float rs = max(dot(reflect(-V, n), uSun.xyz), 0.0);
    col += uSunCol.rgb * pow(rs, 20.0) * 0.45 * lit;
    float dist = length(vW);
    vec2 gp = (vW.xz + uCamW.xz) * 9.0;
    float g = flHash(mod(floor(gp), 4608.0));               // periodic with uCamW's 512 m wrap, so glints stay put across it
    float gd = length(fract(gp) - (vec2(g, fract(g * 57.3)) * 0.6 + 0.2));
    col += uSunCol.rgb * step(0.93, g) * smoothstep(0.15, 0.02, gd) * (0.3 + pow(rs, 2.0)) * exp(-dist / 18.0) * lit * 4.0;

    // course dye: a blue line across the snow just before a jump's lip
    float band = smoothstep(0.46, 0.54, vA.w) * (1.0 - smoothstep(0.80, 0.88, vA.w)) * onP;
    col = mix(col, flLight(vec3(0.05, 0.27, 0.74), n, lit), band * 0.78);
  } else {
    // rock: flat facets like the crags around it, snow lying on the ones that tip upward, a
    // ragged cap of snow under the lip, and all of it sinking into the valley haze
    float depth = vA.x * vA.y;
    vec3 along = normalize(vec3(n.z, 0.0, -n.x));           // horizontal direction across the face
    float a = vA.z;                                         // distance along the face, carried by the mesh: stays put for good
    vec2 p = vec2(a * 0.36 + depth * 0.09, depth * 0.3);
    vec2 cell = floor(p), f = fract(p);
    float tri = step(1.0, f.x + f.y);                       // each cell is two triangular facets
    float h1 = flHash(cell + tri * 17.3), h2 = flHash(cell * 1.7 + tri * 5.1 + 3.0);
    vec3 fn = normalize(n + along * (h1 - 0.5) * 1.1 + vec3(0.0, 1.0, 0.0) * (h2 - 0.5) * 1.1);
    vec3 rock = mix(vec3(0.060, 0.082, 0.125), vec3(0.125, 0.16, 0.225), h2);
    float lipLine = 0.35 + 1.5 * flNoise(vec2(a * 0.55, 1.0)) + 0.5 * flNoise(vec2(a * 2.4, 7.0));
    float snow = max(1.0 - smoothstep(lipLine * 0.6, lipLine, depth), smoothstep(0.50, 0.58, fn.y) * exp(-depth / 30.0) * 0.9);
    col = flLight(mix(rock, vec3(0.95, 0.96, 0.98), snow), fn, 1.0);
    col = mix(col, uValley.rgb, 1.0 - exp(-depth / 40.0));
  }
  o = vec4(flFog(col, vW), 1.0);
}`;

  const CA = new Float32Array(NC * 4), CB = new Float32Array(NC * 4), TMP = new Float32Array(48);
  let prog = null;

  function freeMesh(R, rb) {
    const m = rb.mesh;
    if (m && m.gen === R.gen) for (const p of m.parts) { R.gl.deleteVertexArray(p.vao); R.gl.deleteBuffer(p.vb); R.gl.deleteBuffer(p.ib); }
    rb.mesh = null;
  }

  function build(R, tr, rb) {
    const gl = R.gl, F = tr.F, parts = [], N = rb.n;
    // forest shoulders ease in and out over a few sections rather than stepping
    const soft = (arr, i) => {
      if (!arr) return 0;
      let sum = 0;
      for (let d = -4; d <= 4; d++) sum += arr[Math.max(0, Math.min(N - 1, i + d))] * (5 - Math.abs(d));
      return Math.min(1, sum / 19);
    };
    const lipMark = rb.capB && rb.e[N - 1] > 0.3;
    for (let a = 0; a < N - 1; a += PART) {
      const b = Math.min(N - 1, a + PART), n = b - a + 1;
      const capA = rb.capA && a === 0, capB = rb.capB && b === N - 1;
      const v = new Float32Array((n * 8 + (capA ? 4 : 0) + (capB ? 4 : 0)) * 14);
      const idx = new Uint16Array((n - 1) * 30 + (capA ? 6 : 0) + (capB ? 6 : 0));
      const kO = rb.k0 + a, ox = F.x[kO], oy = F.y[kO], oz = F.z[kO];
      let vi = 0, ii = 0;
      const put = (x, y, z, nx, ny, nz, a0, a1, a2, a3, b0, b1, b2, b3) => {
        v[vi++] = x - ox; v[vi++] = y - oy; v[vi++] = z - oz; v[vi++] = nx; v[vi++] = ny; v[vi++] = nz;
        v[vi++] = a0; v[vi++] = a1; v[vi++] = a2; v[vi++] = a3; v[vi++] = b0; v[vi++] = b1; v[vi++] = b2; v[vi++] = b3;
      };
      const ends = [];
      for (let j = 0; j < n; j++) {
        const i = a + j, k = rb.k0 + i, yaw = F.yaw[k], cs = Math.cos(yaw), sn = Math.sin(yaw);
        const c = rb.c[i], hw = rb.hw[i], e = rb.e[i], bk = rb.b[i], s = k * SEG;
        const wl = rb.wl ? rb.wl[i] : 0, wr = rb.wr ? rb.wr[i] : 0;
        const swL = soft(rb.wl, i) * WALL.shoulder, swR = soft(rb.wr, i) * WALL.shoulder;
        const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1);
        const dy = (F.y[rb.k0 + i1] + rb.e[i1] - F.y[rb.k0 + i0] - rb.e[i0]) / ((i1 - i0) * SEG);
        let nx = -bk * cs - dy * sn, ny = 1, nz = cs * dy - bk * sn;
        const nl = 1 / Math.hypot(nx, ny, nz); nx *= nl; ny *= nl; nz *= nl;
        const mark = lipMark && i === N - 1 ? 1 : 0;
        const at = (o, lift) => [F.x[k] + cs * o, F.y[k] + e + (o - c) * bk + lift, F.z[k] + sn * o];
        const pSL = at(c - hw - swL, swL * 0.06), pL = at(c - hw, 0), pR = at(c + hw, 0), pSR = at(c + hw + swR, swR * 0.06);
        // snow: shoulder, edge, edge, shoulder
        put(pSL[0], pSL[1], pSL[2], nx, ny, nz, -hw - swL, hw, s, mark, wl, wr, 0, yaw);
        put(pL[0], pL[1], pL[2], nx, ny, nz, -hw, hw, s, mark, wl, wr, 0, yaw);
        put(pR[0], pR[1], pR[2], nx, ny, nz, hw, hw, s, mark, wl, wr, 0, yaw);
        put(pSR[0], pSR[1], pSR[2], nx, ny, nz, hw + swR, hw, s, mark, wl, wr, 0, yaw);
        // rock faces down each side
        const bL = [pSL[0] - cs * DEPTH * BATTER, pSL[1] - DEPTH, pSL[2] - sn * DEPTH * BATTER];
        const bR = [pSR[0] + cs * DEPTH * BATTER, pSR[1] - DEPTH, pSR[2] + sn * DEPTH * BATTER];
        put(pSL[0], pSL[1], pSL[2], -cs * 0.985, 0.17, -sn * 0.985, 0, DEPTH, s, 0, 0, 0, 1, yaw);
        put(bL[0], bL[1], bL[2], -cs * 0.985, 0.17, -sn * 0.985, 1, DEPTH, s, 0, 0, 0, 1, yaw);
        put(pSR[0], pSR[1], pSR[2], cs * 0.985, 0.17, sn * 0.985, 0, DEPTH, s, 0, 0, 0, 1, yaw);
        put(bR[0], bR[1], bR[2], cs * 0.985, 0.17, sn * 0.985, 1, DEPTH, s, 0, 0, 0, 1, yaw);
        if (j === 0 || j === n - 1) ends.push({ pSL, pSR, bL, bR, sn, cs, s, yaw });
      }
      for (let j = 0; j < n - 1; j++) {
        const p = j * 8, q = p + 8;
        for (const c of [0, 1, 2]) { idx[ii++] = p + c; idx[ii++] = p + c + 1; idx[ii++] = q + c; idx[ii++] = p + c + 1; idx[ii++] = q + c + 1; idx[ii++] = q + c; }
        for (const c of [4, 6]) { idx[ii++] = p + c; idx[ii++] = p + c + 1; idx[ii++] = q + c; idx[ii++] = p + c + 1; idx[ii++] = q + c + 1; idx[ii++] = q + c; }
      }
      // where the snow simply stops (a gap), close the end with a wall of rock
      const cap = (E, dir) => {
        const base = vi / 14, nx = E.sn * dir, nz = -E.cs * dir;
        const capW = Math.hypot(E.pSR[0] - E.pSL[0], E.pSR[2] - E.pSL[2]);     // facets keep their size across the end wall
        put(E.pSL[0], E.pSL[1], E.pSL[2], nx, 0.1, nz, 0, DEPTH, E.s, 0, 0, 0, 1, E.yaw);
        put(E.pSR[0], E.pSR[1], E.pSR[2], nx, 0.1, nz, 0, DEPTH, E.s + capW, 0, 0, 0, 1, E.yaw);
        put(E.bL[0], E.bL[1], E.bL[2], nx, 0.1, nz, 1, DEPTH, E.s, 0, 0, 0, 1, E.yaw);
        put(E.bR[0], E.bR[1], E.bR[2], nx, 0.1, nz, 1, DEPTH, E.s + capW, 0, 0, 0, 1, E.yaw);
        idx[ii++] = base; idx[ii++] = base + 1; idx[ii++] = base + 2; idx[ii++] = base + 1; idx[ii++] = base + 3; idx[ii++] = base + 2;
      };
      if (capA) cap(ends[0], -1);
      if (capB) cap(ends[ends.length - 1], 1);
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const vb = R.buffer(v);
      R.attr(0, 3, 14, 0); R.attr(1, 3, 14, 3); R.attr(2, 4, 14, 6); R.attr(3, 4, 14, 10);
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      parts.push({ vao, vb, ib, count: ii, ox, oy, oz, sA: (rb.k0 + a) * SEG, sB: (rb.k0 + b) * SEG, cast: [], obsV: -1 });
    }
    rb.mesh = { gen: R.gen, parts };
  }

  // The shapes that can throw a shadow onto this stretch of snow, in world space. Shadows fall
  // back up the slope, so that is anything standing on it or a little way downhill of it.
  function casters(R, tr, part) {
    if (part.obsV === tr.obsV) return part.cast;
    const list = part.cast, lo = part.sA - 3, hi = part.sB + 18;
    list.length = 0;
    for (const ob of tr.obstacles) {
      if (ob.s < lo) continue;
      if (ob.s > hi) break;
      const w = R.place(tr, ob), cs = Math.cos(w[3]), sn = Math.sin(w[3]);
      const n = Look.trees(ob, TMP);
      if (n) {
        for (let j = 0; j < n; j++) {
          const d = TMP[j * 3] - ob.o;
          list.push({ x: w[0] + cs * d, z: w[2] + sn * d, h: TMP[j * 3 + 2], type: 0, b0: TMP[j * 3 + 1], b1: 0, b2: 0, b3: 0, s: ob.s });
        }
      } else list.push({ x: w[0], z: w[2], h: ob.h, type: ob.kind === 'fence' ? 2 : 1, b0: cs, b1: sn, b2: ob.hx, b3: ob.hz, s: ob.s });
    }
    if (list.length > NC) {
      const mid = (part.sA + part.sB) / 2;
      list.sort((p, q) => Math.abs(p.s - mid) - Math.abs(q.s - mid));
      list.length = NC;
    }
    part.obsV = tr.obsV;
    return list;
  }

  Gfx.layer({
    name: 'piste', order: 10,
    init(R) { prog = R.program('piste', VS, FS); },
    freeRibbon(R, rb) { freeMesh(R, rb); },
    drawOpaque(R, v) {
      const gl = R.gl, tr = v.track, cam = R.cam, u = prog.u;
      const behind = v.s - v.cam.back - 16, simple = R.notch >= 4;
      gl.useProgram(prog.p);
      for (const rb of tr.ribbons) {
        if (rb.sB < behind) continue;
        if (!rb.mesh || rb.mesh.gen !== R.gen) build(R, tr, rb);
        for (const p of rb.mesh.parts) {
          if (p.sB < behind) continue;
          const list = casters(R, tr, p), n = simple ? Math.min(6, list.length) : list.length;
          for (let i = 0; i < n; i++) {
            const c = list[i], j = i * 4;
            CA[j] = c.x - cam.x; CA[j + 1] = c.z - cam.z; CA[j + 2] = c.h; CA[j + 3] = c.type;
            CB[j] = c.b0; CB[j + 1] = c.b1; CB[j + 2] = c.b2; CB[j + 3] = c.b3;
          }
          gl.uniform1i(u.uNC, n);
          if (n) { gl.uniform4fv(u.uCA, CA, 0, n * 4); gl.uniform4fv(u.uCB, CB, 0, n * 4); }
          gl.uniform3f(u.uOrigin, p.ox - cam.x, p.oy - cam.y, p.oz - cam.z);
          gl.bindVertexArray(p.vao);
          gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_SHORT, 0);
        }
      }
      gl.bindVertexArray(null);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
