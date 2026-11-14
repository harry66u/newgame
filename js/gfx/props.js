/* Fall Line — props: the things on the piste that are not trees.
   Boulders (faceted charcoal chunks with snow on top), safety fences (orange race netting on
   pale posts, with a red or blue gate flag where a fence borders the opening you ski through)
   and ice (the boost strips: glossy cyan let into the snow, chevrons streaming downhill).

   Four draw calls: rock chunks, posts, net panels + flags, ice. Everything is placed on the CPU
   each frame from track data (a few hundred floats), so nothing is cached but each strip's
   outline on the snow. What is drawn fills the hit box the simulation uses and no more. */
(function (root) {
  'use strict';
  const FL = root.FL, Look = FL.Look, Gfx = FL.Gfx, COL = Look.COL, hash = Look.hash;

  const MAX_ROCK = 256, MAX_BOX = 512, MAX_NET = 512, MAX_PAD = 40;
  const RS = 10, BS = 10, NS = 13, IS = 7;      // floats per rock chunk, post, net panel, ice vertex
  const ROWS = 7;                               // an ice strip is 6 one-metre steps that follow the snow
  const ZIG = 0.2;                              // fence posts step fore and aft: free-standing netting, and it fills the box's depth
  const SNOW = 'vec3(0.95, 0.96, 0.98)';

  // ---------------------------------------------------------------- boulders
  /* One unit chunk: a chamfered block (three rings of eight and an apex). The vertex shader
     pushes its corners about per instance, so one mesh gives every chunk its own facets. The
     foot ring only ever grows: at ground level the hit box is always covered. */
  const ROCK = (() => {
    const rings = [[-0.08, 1.0], [0.5, 1.04], [0.86, 0.7]], v = [];
    const pt = (r, k) => {
      k &= 7;
      const a = (k * Math.PI) / 4, m = rings[r][1] * (k & 1 ? 0.86 * Math.SQRT2 : 1);
      return [Math.cos(a) * m, rings[r][0], Math.sin(a) * m, r * 8 + k + 1];
    };
    const apex = [0, 1, 0, 40];
    let f = 0;
    const tri = (a, b, c) => { const tone = hash(++f * 1.37, 4.2); for (const p of [a, b, c]) v.push(p[0], p[1], p[2], p[3], tone); };
    for (let r = 0; r < 2; r++) for (let k = 0; k < 8; k++) {
      const a = pt(r, k), b = pt(r, k + 1), c = pt(r + 1, k + 1), d = pt(r + 1, k);
      if (k & 1) { tri(a, b, c); tri(a, c, d); } else { tri(a, b, d); tri(b, c, d); }
    }
    for (let k = 0; k < 8; k++) tri(pt(2, k), pt(2, k + 1), apex);
    return new Float32Array(v);
  })();

  const VS_ROCK = `
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aId;      // aId: corner identity, facet tone
layout(location=2) in vec3 iPos; layout(location=3) in vec3 iHalf; layout(location=4) in vec4 iRot;   // yaw, dy/ds, bank, seed
out vec3 vW; out float vH; flat out float vTone;
void main(){
  float sd = iRot.w * 61.0;
  float h1 = flHash(vec2(aId.x, sd)), h2 = flHash(vec2(aId.x + 31.0, sd + 7.0));
  vec2 lean = vec2(flHash(vec2(sd, 1.3)), flHash(vec2(sd, 2.7))) - 0.5;
  vec3 p = aPos;
  float foot = step(p.y, 0.1), top = step(0.95, p.y), mid = 1.0 - foot - top;
  p.xz *= 1.0 + foot * h1 * 0.05 + mid * (h1 - 0.42) * mix(0.14, 0.32, smoothstep(0.5, 0.86, p.y));
  p.y += mid * (h2 - 0.5) * 0.2;
  p.xz += lean * (p.y * p.y * 0.42) + top * (vec2(h1, h2) - 0.5) * 0.3;
  vec3 l = p * iHalf;
  float cs = cos(iRot.x), sn = sin(iRot.x);
  float y = l.y - l.z * iRot.y + l.x * iRot.z;                        // sheared so the foot follows slope and bank
  vW = iPos + vec3(cs * l.x - sn * l.z, y, sn * l.x + cs * l.z);
  vH = l.y; vTone = aId.y;
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS_ROCK = `
in vec3 vW; in float vH; flat in float vTone; uniform vec3 uRock; uniform vec3 uRockDark; out vec4 o;
void main(){
  vec3 n = flFacet(vW);
  if (dot(n, vW) > 0.0) n = -n;
  // snow lies on what tips upward and drifts against the foot
  float snow = max(smoothstep(0.42, 0.56, n.y), 1.0 - smoothstep(0.16, 0.2, vH + (vTone - 0.5) * 0.3));
  vec3 alb = mix(mix(uRockDark, uRock, vTone), ${SNOW}, snow);
  o = vec4(flFog(flLight(alb, n, 1.0), vW), 1.0);
}`;

  // ---------------------------------------------------------------- posts and gate poles
  const VS_BOX = `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 iPos; layout(location=3) in vec4 iHalf; layout(location=4) in vec3 iCol;   // iHalf.w: yaw
out vec3 vW; out vec3 vN; out vec3 vCol;
void main(){
  vec3 l = aPos * iHalf.xyz;
  float cs = cos(iHalf.w), sn = sin(iHalf.w);
  vW = iPos + vec3(cs * l.x - sn * l.z, l.y + iHalf.y, sn * l.x + cs * l.z);
  vN = vec3(cs * aNrm.x - sn * aNrm.z, aNrm.y, sn * aNrm.x + cs * aNrm.z);
  vCol = iCol;
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS_BOX = `
in vec3 vW; in vec3 vN; in vec3 vCol; out vec4 o;
void main(){ o = vec4(flFog(flLight(vCol, normalize(vN), 1.0), vW), 1.0); }`;

  // ---------------------------------------------------------------- netting and flags
  /* A panel hung between two points on the ground (A, B), from height y0 to y1. Kind 0 is net:
     a diamond mesh cut out with discard, taped along the top. Kind 1 is a gate flag: solid,
     pinned at A and fluttering toward its free edge. */
  const STRIP = (() => {
    const n = 6, v = [];
    for (let i = 0; i < n; i++) { const a = i / n, b = (i + 1) / n; v.push(a, 0, b, 0, b, 1, a, 0, b, 1, a, 1); }
    return new Float32Array(v);
  })();
  const VS_NET = `
layout(location=0) in vec2 aPos;
layout(location=2) in vec3 iA; layout(location=3) in vec3 iB; layout(location=4) in vec4 iParm; layout(location=5) in vec3 iCol;   // iParm: y0, y1, kind, u0 | phase
out vec3 vW; out vec2 vUV; out vec2 vEdge; out vec3 vCol; out float vKind;
void main(){
  vec3 d = iB - iA;
  float len = length(d.xz), h = mix(iParm.x, iParm.y, aPos.y), fl = iParm.z;
  vec3 p = mix(iA, iB, aPos.x);
  p.y += h;
  float ph = uTime * 5.5 + iParm.w * 6.283 - aPos.x * 4.2;
  p += normalize(vec3(-d.z, 0.0, d.x)) * (fl * aPos.x * (sin(ph) * 0.075 + sin(ph * 2.3 + 1.0) * 0.03));
  vW = p;
  vUV = vec2(iParm.w * (1.0 - fl) + aPos.x * len, h);
  vEdge = vec2(h - iParm.x, iParm.y - h);
  vCol = iCol; vKind = fl;
  gl_Position = uVP * vec4(p, 1.0);
}`;
  const FS_NET = `
in vec3 vW; in vec2 vUV; in vec2 vEdge; in vec3 vCol; in float vKind; out vec4 o;
void main(){
  vec3 n = flFacet(vW);
  if (vKind < 0.5) {
    // the holes close up with distance, so a far fence is a solid orange bar rather than shimmer
    vec2 g = vec2(vUV.x + vUV.y, vUV.x - vUV.y) / 0.2;
    vec2 c = abs(fract(g) - 0.5);
    float hole = 0.37 - max(fwidth(g.x), fwidth(g.y)) * 0.5;
    if (min(vEdge.x - 0.05, vEdge.y - 0.11) > 0.0 && max(c.x, c.y) < hole) discard;
  }
  // thin cloth: sun on either face lights it through, so it never goes dull seen from behind
  if (dot(n, uSun.xyz) < 0.0) n = -n;
  n = normalize(n + vec3(0.0, 0.5, 0.0));
  o = vec4(flFog(flLight(vCol, n, 1.0), vW), 1.0);
}`;

  // ---------------------------------------------------------------- ice
  /* aUV: x -1..1 across, y metres along (downhill positive), z 0 fresh .. 1 ridden, w seed.
     Shadows on this mountain are soft and pale; ice is the opposite on every count: saturated,
     hard-edged, moving, and it sparkles. */
  const VS_ICE = `
layout(location=0) in vec3 aPos; layout(location=1) in vec4 aUV;
out vec3 vW; out vec4 vUV;
void main(){ vW = aPos; vUV = aUV; gl_Position = uVP * vec4(aPos, 1.0); }`;
  const FS_ICE = `
in vec3 vW; in vec4 vUV; uniform vec3 uIce; uniform vec3 uDeep; out vec4 o;
void main(){
  float x = vUV.x, ax = abs(x), y = vUV.y, dull = vUV.z, live = 1.0 - dull, t = uTime;
  float dist = length(vW);
  float ed = min((1.0 - ax) * 1.1, 3.0 - abs(y)), aa = min(fwidth(ed), 0.1) + 0.003;
  // chevrons point downhill and stream that way
  float ph = (y + ax * 0.8) / 1.5 - t * 1.7, fw = fwidth(ph), c = fract(ph);
  float chev = smoothstep(0.0, 0.05 + fw, c) * (1.0 - smoothstep(0.34, 0.39 + fw, c));
  chev = mix(chev, 0.3, smoothstep(0.2, 0.55, fw)) * (0.25 + 0.75 * live);
  vec3 alb = mix(uDeep, uIce, 0.25 + 0.75 * (1.0 - ax * ax));
  alb = mix(alb, vec3(0.36, 0.88, 1.0), chev * 0.8);
  alb += vec3(0.35, 0.5, 0.55) * (pow(0.5 + 0.5 * sin(y * 0.55 - x * 0.5 - t * 3.2), 8.0) * live);   // a sheen sliding down it
  // a dark lip, then a bright bevel: the cut edge of a strip let into the snow
  float lip = 1.0 - smoothstep(0.06, 0.06 + aa, ed);
  float bev = (1.0 - smoothstep(0.12, 0.12 + aa, ed)) * (1.0 - lip);
  alb = mix(alb, vec3(0.80, 0.98, 1.0), bev * 0.9);
  alb = mix(alb, uDeep * 0.55, lip);
  alb = mix(alb, vec3(0.62, 0.74, 0.86), dull * 0.72);                // ridden: scraped dull
  vec3 col = flFog(flLight(alb, vec3(0.0, 1.0, 0.0), 1.0), vW);
  // sun glints: three at a time, each flaring at one spot then moving on. They grow with
  // distance so a far strip still winks.
  float gl = 0.0, r = 0.10 + dist * 0.0035;
  if (live > 0.02) for (int i = 0; i < 3; i++) {
    float fi = float(i), h = flHash(vec2(fi * 7.0 + 1.0, vUV.w * 97.0));
    float cyc = t * (0.55 + 0.3 * h) + h * 9.0, k = floor(cyc), tw = sin(fract(cyc) * 3.1416);
    vec2 gp = vec2((flHash(vec2(k, h * 31.0)) - 0.5) * 1.5, (fi - 1.0) * 1.9 + (flHash(vec2(h * 17.0, k)) - 0.5) * 1.5);
    vec2 dv = (vec2(x * 1.1, y) - gp) / r;
    float d2 = dot(dv, dv);
    gl += tw * tw * (exp(-d2 * 3.0) + 0.5 * exp(-abs(dv.x * dv.y) * 14.0 - d2 * 0.35));
  }
  col += (uAmb.rgb + uSunCol.rgb) * (gl * 2.4 * live * exp(-dist * 0.004));
  col += vec3(0.3, 0.8, 1.0) * (dull * live * 1.8);                  // the flash as it is ridden
  o = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- state
  let rockP, boxP, netP, iceP, rockVao, boxVao, netVao, iceVao, rockBuf, boxBuf, netBuf, iceBuf;
  const rockD = new Float32Array(MAX_ROCK * RS), boxD = new Float32Array(MAX_BOX * BS);
  const netD = new Float32Array(MAX_NET * NS), iceD = new Float32Array(MAX_PAD * (ROWS - 1) * 6 * IS);
  let nR = 0, nB = 0, nN = 0, nI = 0;
  const FR = {}, SF = { h: 0, b: 0, edge: 0, d: 0, hw: 0, rb: null, wall: 0, wallH: 0 };

  function init(R) {
    const gl = R.gl;
    rockP = R.program('props-rock', VS_ROCK, FS_ROCK);
    gl.useProgram(rockP.p);
    gl.uniform3fv(rockP.u.uRock, COL.rock); gl.uniform3fv(rockP.u.uRockDark, COL.rockDark);
    rockVao = gl.createVertexArray(); gl.bindVertexArray(rockVao);
    R.buffer(ROCK); R.attr(0, 3, 5, 0); R.attr(1, 2, 5, 3);
    rockBuf = R.buffer(rockD.byteLength, gl.DYNAMIC_DRAW);
    R.attr(2, 3, RS, 0, 1); R.attr(3, 3, RS, 3, 1); R.attr(4, 4, RS, 6, 1);

    boxP = R.program('props-post', VS_BOX, FS_BOX);
    boxVao = gl.createVertexArray(); gl.bindVertexArray(boxVao);
    R.buffer(Gfx.CUBE); R.attr(0, 3, 6, 0); R.attr(1, 3, 6, 3);
    boxBuf = R.buffer(boxD.byteLength, gl.DYNAMIC_DRAW);
    R.attr(2, 3, BS, 0, 1); R.attr(3, 4, BS, 3, 1); R.attr(4, 3, BS, 7, 1);

    netP = R.program('props-net', VS_NET, FS_NET);
    netVao = gl.createVertexArray(); gl.bindVertexArray(netVao);
    R.buffer(STRIP); R.attr(0, 2, 2, 0);
    netBuf = R.buffer(netD.byteLength, gl.DYNAMIC_DRAW);
    R.attr(2, 3, NS, 0, 1); R.attr(3, 3, NS, 3, 1); R.attr(4, 4, NS, 6, 1); R.attr(5, 3, NS, 10, 1);

    iceP = R.program('props-ice', VS_ICE, FS_ICE);
    gl.useProgram(iceP.p);
    gl.uniform3fv(iceP.u.uIce, COL.ice); gl.uniform3fv(iceP.u.uDeep, COL.iceDeep);
    iceVao = gl.createVertexArray(); gl.bindVertexArray(iceVao);
    iceBuf = R.buffer(iceD.byteLength, gl.DYNAMIC_DRAW);
    R.attr(0, 3, IS, 0); R.attr(1, 4, IS, 3);
    gl.bindVertexArray(null);
  }

  // ---------------------------------------------------------------- filling the buffers
  function box(x, y, z, hx, hy, hz, yaw, col) {
    if (nB >= MAX_BOX) return;
    const j = nB++ * BS;
    boxD[j] = x; boxD[j + 1] = y; boxD[j + 2] = z; boxD[j + 3] = hx; boxD[j + 4] = hy; boxD[j + 5] = hz; boxD[j + 6] = yaw;
    boxD[j + 7] = col[0]; boxD[j + 8] = col[1]; boxD[j + 9] = col[2];
  }
  function net(ax, ay, az, bx, by, bz, y0, y1, kind, u0, col) {
    if (nN >= MAX_NET) return;
    const j = nN++ * NS;
    netD[j] = ax; netD[j + 1] = ay; netD[j + 2] = az; netD[j + 3] = bx; netD[j + 4] = by; netD[j + 5] = bz;
    netD[j + 6] = y0; netD[j + 7] = y1; netD[j + 8] = kind; netD[j + 9] = u0;
    netD[j + 10] = col[0]; netD[j + 11] = col[1]; netD[j + 12] = col[2];
  }

  /* A boulder: a row of overlapping chunks, one per ~1.7 m of width (two or three for most).
     Each spans the full depth of the hit box, the end ones reach just past its ends, and every
     chunk stands at least 0.86 of its height with one a touch over. */
  function rock(ob, w, cam) {
    const n = Math.max(2, Math.min(6, Math.round(ob.hx / 0.85))), cw = (2 * ob.hx) / n;
    const cs = Math.cos(w[3]), sn = Math.sin(w[3]);
    const tall = Math.min(n - 1, Math.floor(hash(ob.seed * 13.7, 2.1) * n));
    for (let i = 0; i < n && nR < MAX_ROCK; i++) {
      const h1 = hash(ob.seed * 91.3 + i * 7.7, 1.7), h2 = hash(ob.seed * 37.1 + i * 3.3, 5.9), h3 = hash(ob.seed * 53.9 + i * 5.1, 8.3);
      const hw = cw * 0.5 + 0.1 + 0.1 * h1;
      let lx = -ob.hx + cw * (i + 0.5);
      if (i === 0) lx = -ob.hx - 0.04 + hw; else if (i === n - 1) lx = ob.hx + 0.04 - hw;
      const lz = (h3 - 0.5) * 0.2 * h2, hz = ob.hz + 0.04 + 0.1 * h2;
      const j = nR++ * RS;
      rockD[j] = w[0] + cs * lx - sn * lz - cam.x;
      rockD[j + 1] = w[1] + lx * ob.b - lz * w[4] - cam.y;
      rockD[j + 2] = w[2] + sn * lx + cs * lz - cam.z;
      rockD[j + 3] = hw; rockD[j + 4] = ob.h * (i === tall ? 1.04 : 0.86 + 0.14 * h1); rockD[j + 5] = hz;
      rockD[j + 6] = w[3]; rockD[j + 7] = w[4]; rockD[j + 8] = ob.b; rockD[j + 9] = h2 + i * 0.37 + ob.seed;
    }
  }

  /* A fence: posts every ~1.8 m from one end of the hit box to the other, net between them.
     The post at the end that borders the opening becomes a gate pole carrying a flag, which
     hangs back over the fence so it never reaches into the gap. */
  function fence(ob, w, cam) {
    const n = Math.max(1, Math.round((2 * ob.hx) / 1.8)), seg = (2 * ob.hx) / n;
    const cs = Math.cos(w[3]), sn = Math.sin(w[3]);
    let px = 0, py = 0, pz = 0;
    for (let j = 0; j <= n; j++) {
      const lx = -ob.hx + j * seg, lz = j & 1 ? -ZIG : ZIG;
      const x = w[0] + cs * lx - sn * lz - cam.x, y = w[1] + lx * ob.b - lz * w[4] - cam.y, z = w[2] + sn * lx + cs * lz - cam.z;
      const gate = (ob.flag > 0 && j === n) || (ob.flag < 0 && j === 0);
      if (gate) {
        const col = ob.flag > 0 ? COL.gateRed : COL.gateBlue, fw = Math.min(1.0, 2 * ob.hx) * -ob.flag;
        box(x, y - 0.12, z, 0.04, (ob.h + 1.12) / 2, 0.04, w[3], col);
        net(x, y, z, x + cs * fw, y + fw * ob.b, z + sn * fw, ob.h + 0.14, ob.h + 0.92, 1, ob.seed, col);
      } else box(x, y - 0.12, z, 0.035, (ob.h + 0.2) / 2, 0.035, w[3], COL.post);
      if (j) net(px, py, pz, x, y, z, 0.06, ob.h, 0, (j - 1) * seg, COL.fence);
      px = x; py = y; pz = z;
    }
  }

  /* The outline of an ice strip on the snow: both edges at each metre along it, relative to
     its placement, taken from the real surface so it lies flat over rolls and banks. Built once. */
  function outline(tr, pd, w) {
    const a = new Float32Array(ROWS * 6), can = typeof tr.surfaceAt === 'function';
    for (let r = 0; r < ROWS; r++) {
      const f = r - (ROWS - 1) / 2, s = pd.s + f * (pd.hz / 3);
      tr.frameAt(s, FR);
      const cs = Math.cos(FR.yaw), sn = Math.sin(FR.yaw);
      for (let e = 0; e < 2; e++) {
        const lx = (e ? 1 : -1) * pd.hx, o = pd.o + lx, flat = w[1] + (s - pd.s) * w[4] + lx * pd.b;
        let y = flat;
        if (can && tr.surfaceAt(s, o, 1e9, SF) === 1 && Math.abs(SF.h - flat) < 1.2) y = SF.h;
        const j = (r * 2 + e) * 3;
        a[j] = FR.x + cs * o - w[0]; a[j + 1] = y + 0.03 - w[1]; a[j + 2] = FR.z + sn * o - w[2];
      }
    }
    return a;
  }
  function iceVert(a, c, bx, by, bz, u, vv, dull, seed) {
    const j = nI++ * IS, k = c * 3;
    iceD[j] = a[k] + bx; iceD[j + 1] = a[k + 1] + by; iceD[j + 2] = a[k + 2] + bz;
    iceD[j + 3] = u; iceD[j + 4] = vv; iceD[j + 5] = dull; iceD[j + 6] = seed;
  }
  function pad(tr, pd, w, cam, dt) {
    const a = pd.propsLine || (pd.propsLine = outline(tr, pd, w));
    let dull = pd.propsDull || 0;
    if (pd.used && dull < 1) pd.propsDull = dull = Math.min(1, dull + dt * 5);
    const bx = w[0] - cam.x, by = w[1] - cam.y, bz = w[2] - cam.z, seed = hash(pd.s, pd.o);
    for (let r = 0; r < ROWS - 1; r++) {
      const v0 = (r - (ROWS - 1) / 2) * (pd.hz / 3), v1 = v0 + pd.hz / 3, c = r * 2;
      iceVert(a, c, bx, by, bz, -1, v0, dull, seed); iceVert(a, c + 1, bx, by, bz, 1, v0, dull, seed); iceVert(a, c + 3, bx, by, bz, 1, v1, dull, seed);
      iceVert(a, c, bx, by, bz, -1, v0, dull, seed); iceVert(a, c + 3, bx, by, bz, 1, v1, dull, seed); iceVert(a, c + 2, bx, by, bz, -1, v1, dull, seed);
    }
  }

  // ---------------------------------------------------------------- the layer
  Gfx.layer({
    name: 'props', order: 20, init,
    drawOpaque(R, v) {
      const gl = R.gl, tr = v.track, cam = R.cam, behind = v.s - v.cam.back - 12;
      const obs = tr.obstacles, pads = tr.pads;
      nR = nB = nN = nI = 0;
      for (let i = 0; i < obs.length; i++) {
        const ob = obs[i];
        if (ob.s < behind) continue;
        if (ob.kind === 'rock') rock(ob, R.place(tr, ob), cam);
        else if (ob.kind === 'fence') fence(ob, R.place(tr, ob), cam);
      }
      let np = 0;
      for (let i = 0; i < pads.length && np < MAX_PAD; i++) {
        const pd = pads[i];
        if (pd.s < behind) continue;
        pad(tr, pd, R.place(tr, pd), cam, v.dt || 0); np++;
      }
      if (nR) {
        gl.useProgram(rockP.p); gl.bindVertexArray(rockVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, rockBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, rockD, 0, nR * RS);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, ROCK.length / 5, nR);
      }
      if (nB) {
        gl.useProgram(boxP.p); gl.bindVertexArray(boxVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, boxBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, boxD, 0, nB * BS);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, nB);
      }
      if (nN) {
        gl.useProgram(netP.p); gl.bindVertexArray(netVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, netBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, netD, 0, nN * NS);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, STRIP.length / 2, nN);
      }
      if (nI) {
        // a decal: pulled toward the eye so it wins against the snow it lies on
        gl.useProgram(iceP.p); gl.bindVertexArray(iceVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, iceBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, iceD, 0, nI * IS);
        gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -2);
        gl.drawArrays(gl.TRIANGLES, 0, nI);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      gl.bindVertexArray(null);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
