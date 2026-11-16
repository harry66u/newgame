/* Fall Line — resort and terrain-park dressing: chairlift towers with their cables and chairs,
   park fun boxes, and the pennant flags that line a park.

   Towers and boxes are obstacles (their hit boxes are exact: a tower's concrete footing is its
   footprint, a box is its box). Cables, chairs and flags are decoration and never collide; the
   cables hang well above anyone on skis. Everything here is a handful of instanced draws, filled
   each frame from the track's lists: one for boxy parts, one for round parts (tower columns,
   sheave wheels), one for cables, one for flag cloth. */
(function (root) {
  'use strict';
  const FL = root.FL, U = FL.U, Look = FL.Look, Gfx = FL.Gfx;
  const v3 = (c) => 'vec3(' + c.map((x) => x.toFixed(4)).join(', ') + ')';

  const AHEAD = 260;            // metres ahead worth drawing (fog has most of it by then)
  const ARM = 2.4;              // crossarm half-span: where the cables run
  const WHEEL = 0.32;           // sheave radius; the cable rides on top, 0.3 m under the crossarm
  const CHAIR_GAP = 13, CHAIR_V = 2;   // metres between chairs, their speed along the cable
  const SAG = 0.02, SAG_MAX = 1.5;     // mid-span sag per metre of span
  const FLAG_POLE = 2.6;
  const IF = 14, MAXC = 1024, MAXR = 160, MAXK = 96, MAXF = 160;
  const CSEG = 20, FCOL = 6;    // cable and flag segments

  const STEEL = U.hex('#6c7a91'), CONCRETE = U.hex('#8f9298'), SHEAVE = U.hex('#2b313b');
  const SEAT = U.hex('#2b3a5e'), CHARCOAL = U.hex('#2a2d33'), STRIPE = U.hex('#f2f4f7');
  const CABLE = U.hex('#30353e'), POLE = Look.COL.post, ORANGE = Look.COL.fence;
  const HUES = ['#1fb5c9', '#d43f9a', '#8cc63f', '#7a5ad6'].map(U.hex);

  // Boxy and round parts share one shader. iPos is the bottom centre of the part; the part is
  // sheared so its base follows the slope (iRot.y, rise per metre forward) and bank (iRot.z),
  // and tapered toward the top (iRot.w). iCol.w = 1 lays a round part on its side (a wheel
  // turning along the track). Nothing is ever drawn thinner than about a pixel.
  const VS_PART = `
layout(location=0) in vec3 aPos;
layout(location=2) in vec3 iPos; layout(location=3) in vec3 iHalf; layout(location=4) in vec4 iRot; layout(location=5) in vec4 iCol;
out vec3 vW; out vec3 vCol;
void main(){
  vec3 p = iCol.w > 0.5 ? aPos.yxz : aPos;
  vec3 hf = max(iHalf, vec3(length(iPos) * uView.w / uView.y * 1.2));
  vec3 l = p * hf;
  l.xz *= mix(1.0, iRot.w, p.y * 0.5 + 0.5);
  float cs = cos(iRot.x), sn = sin(iRot.x);
  float y = l.y + hf.y - l.z * iRot.y + l.x * iRot.z;
  vW = iPos + vec3(cs * l.x - sn * l.z, y, sn * l.x + cs * l.z);
  vCol = iCol.rgb;
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS_PART = `
in vec3 vW; in vec3 vCol; out vec4 o;
void main(){ o = vec4(flFog(flLight(vCol, flFacet(vW), 1.0), vW), 1.0); }`;

  // A cable: a parabola from A to B sagging iA.w in the middle, as a ribbon turned to face the eye.
  const VS_CABLE = `
layout(location=0) in vec2 aT;                       // t 0..1 along, side -1/1
layout(location=2) in vec4 iA; layout(location=3) in vec3 iB;
out vec3 vW;
void main(){
  float t = aT.x;
  vec3 d = iB - iA.xyz, p = iA.xyz + d * t;
  p.y -= 4.0 * iA.w * t * (1.0 - t);
  vec3 tg = d; tg.y -= 4.0 * iA.w * (1.0 - 2.0 * t);
  vec3 sd = normalize(cross(tg, p));
  vW = p + sd * aT.y * max(0.022, length(p) * uView.w / uView.y * 0.75);
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS_CABLE = `
in vec3 vW; out vec4 o;
void main(){ o = vec4(flFog(flLight(${v3(CABLE)}, vec3(0.0, 1.0, 0.0), 1.0), vW), 1.0); }`;

  // A pennant streaming out from its pole (local +x), fluttering harder toward its tip.
  const VS_FLAG = `
layout(location=0) in vec2 aUV;                      // u 0..1 pole to tip, v 0 bottom edge, 1 top edge
layout(location=2) in vec4 iA; layout(location=3) in vec4 iB;   // foot xyz camera-relative, yaw | rgb, phase
out vec3 vW; out vec3 vCol;
void main(){
  float u = aUV.x, ph = iB.w;
  float y = mix(1.86 + 0.33 * u, 2.52 - 0.33 * u, aUV.y) - 0.06 * u * u;
  float z = u * (0.11 * sin(uTime * 7.0 - u * 5.5 + ph) + 0.035 * sin(uTime * 15.0 - u * 11.0 + ph * 1.7));
  float x = 0.035 + u * 0.95 * (0.97 + 0.03 * cos(uTime * 7.0 - u * 5.5 + ph));
  float cs = cos(iA.w), sn = sin(iA.w);
  vW = iA.xyz + vec3(cs * x - sn * z, y, sn * x + cs * z);
  vCol = iB.rgb;
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS_FLAG = `
in vec3 vW; in vec3 vCol; out vec4 o;
void main(){
  vec3 n = flFacet(vW);
  float thru = max(dot(-n, uSun.xyz), 0.0) * 0.35;   // low sun behind the cloth shines through it
  o = vec4(flFog(flLight(vCol, n, 1.0) + vCol * uSunCol.rgb * thru, vW), 1.0);
}`;

  let partProg, cubeVao, cubeBuf, rndVao, rndBuf, rndCount = 0;
  let cabProg, cabVao, cabBuf, flagProg, flagVao, flagBuf;
  const CD = new Float32Array(MAXC * IF), RD = new Float32Array(MAXR * IF);
  const KD = new Float32Array(MAXK * 7), FD = new Float32Array(MAXF * 8);
  let nc = 0, nr = 0, nk = 0, nf = 0, clock = 0;
  const SF = { h: 0, b: 0, edge: 0, d: 0, hw: 0, rb: null, wall: 0, wallH: 0 };
  const FR = { x: 0, y: 0, z: 0, yaw: 0, sl: 0, cv: 0, bk: 0, pal: 0, int: 0 };

  // Each lift's last tower seen behind the skier, kept after the track prunes it so the span
  // overhead does not vanish while it is still on screen.
  const MEM_N = 8, memLift = new Float64Array(MEM_N).fill(NaN), memOb = new Array(MEM_N).fill(null);
  let memTrack = null;
  // This frame's latest tower per lift.
  const lastLift = new Float64Array(16), lastOb = new Array(16).fill(null);

  // An 8-sided prism, y -1..1, flats facing the axes (positions only: shading is per facet).
  function prism() {
    const out = [], N = 8;
    for (let i = 0; i < N; i++) {
      const a0 = ((i + 0.5) / N) * Math.PI * 2, a1 = ((i + 1.5) / N) * Math.PI * 2;
      const x0 = Math.cos(a0), z0 = Math.sin(a0), x1 = Math.cos(a1), z1 = Math.sin(a1);
      out.push(x0, -1, z0, x1, -1, z1, x1, 1, z1, x0, -1, z0, x1, 1, z1, x0, 1, z0);
      out.push(0, 1, 0, x0, 1, z0, x1, 1, z1, 0, -1, 0, x1, -1, z1, x0, -1, z0);
    }
    rndCount = out.length / 3;
    return new Float32Array(out);
  }
  function strip(n) {
    const out = new Float32Array((n + 1) * 4);
    for (let i = 0; i <= n; i++) { out[i * 4] = i / n; out[i * 4 + 1] = 0; out[i * 4 + 2] = i / n; out[i * 4 + 3] = 1; }
    return out;
  }
  function cableStrip() {
    const out = strip(CSEG);
    for (let i = 1; i < out.length; i += 2) out[i] = out[i] * 2 - 1;
    return out;
  }

  /* One part. (bx, by, bz): camera-relative base point of the thing it belongs to; (ox, oy, oz)
     its offset in that thing's frame (x right, z back); the slope and bank shear carries over to
     the offset so parts of one sheared thing stay joined. */
  function part(round, bx, by, bz, ox, oy, oz, hx, hy, hz, yaw, dyds, bank, taper, col, side) {
    let D, j;
    if (round) { if (nr >= MAXR) return; D = RD; j = nr++ * IF; } else { if (nc >= MAXC) return; D = CD; j = nc++ * IF; }
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    D[j] = bx + cs * ox - sn * oz; D[j + 1] = by + oy - oz * dyds + ox * bank; D[j + 2] = bz + sn * ox + cs * oz;
    D[j + 3] = hx; D[j + 4] = hy; D[j + 5] = hz;
    D[j + 6] = yaw; D[j + 7] = dyds; D[j + 8] = bank; D[j + 9] = taper;
    D[j + 10] = col[0]; D[j + 11] = col[1]; D[j + 12] = col[2]; D[j + 13] = side;
  }

  function tower(ob, w, cam) {
    const x = w[0] - cam.x, y = w[1] - cam.y, z = w[2] - cam.z, yaw = w[3], h = ob.h;
    // the footing is exactly the hit box, from below the snow to head height
    part(0, x, y, z, 0, -0.5, 0, ob.hx, 0.875, ob.hz, yaw, w[4], ob.b || 0, 1, CONCRETE, 0);
    part(0, x, y, z, 0, 1.0, 0, ob.hx * 0.96, 0.55, ob.hz * 0.96, yaw, 0, 0, 1, STEEL, 0);
    part(1, x, y, z, 0, 2.05, 0, 0.42, (h + 0.25 - 2.05) / 2, 0.42, yaw, 0, 0, 0.6, STEEL, 0);
    part(0, x, y, z, 0, h - 0.17, 0, ARM + 0.28, 0.17, 0.17, yaw, 0, 0, 1, STEEL, 0);
    for (let side = -1; side <= 1; side += 2) {
      part(0, x, y, z, side * (ARM + 0.13), h - 0.66, 0, 0.05, 0.25, 0.06, yaw, 0, 0, 1, STEEL, 0);
      part(1, x, y, z, side * ARM, h - 0.3 - 2 * WHEEL, 0, 0.07, WHEEL, WHEEL, yaw, 0, 0, 1, SHEAVE, 1);
    }
  }

  function chair(x, y, z, yaw) {
    part(0, x, y, z, 0, -2.12, 0.33, 0.035, 1.06, 0.035, yaw, 0, 0, 1, STEEL, 0);       // hanger
    part(0, x, y, z, 0, -2.12, 0.08, 0.5, 0.025, 0.26, yaw, 0, 0, 1, STEEL, 0);         // frame under the seat
    part(0, x, y, z, 0, -2.08, -0.02, 0.52, 0.05, 0.25, yaw, 0, 0, 1, SEAT, 0);         // seat
    part(0, x, y, z, 0, -1.98, 0.27, 0.52, 0.27, 0.04, yaw, 0, 0, 1, SEAT, 0);          // backrest
  }

  // Cables and chairs between two towers of one lift.
  function span(A, B, cam, gap) {
    const wa = A.w, wb = B.w, L = Math.max(1, B.s - A.s), sag = Math.min(SAG_MAX, L * SAG);
    for (let side = -1; side <= 1; side += 2) {
      const ax = wa[0] + Math.cos(wa[3]) * side * ARM - cam.x, ay = wa[1] + A.h - 0.3 - cam.y, az = wa[2] + Math.sin(wa[3]) * side * ARM - cam.z;
      const bx = wb[0] + Math.cos(wb[3]) * side * ARM - cam.x, by = wb[1] + B.h - 0.3 - cam.y, bz = wb[2] + Math.sin(wb[3]) * side * ARM - cam.z;
      if (nk < MAXK) {
        const j = nk++ * 7;
        KD[j] = ax; KD[j + 1] = ay; KD[j + 2] = az; KD[j + 3] = sag; KD[j + 4] = bx; KD[j + 5] = by; KD[j + 6] = bz;
      }
      // right-hand cable carries chairs down the hill, the left one back up; both face where they go
      const down = side > 0, off = down ? clock * CHAIR_V : gap * 0.5 - clock * CHAIR_V;
      const yaw = Math.atan2(bx - ax, -(bz - az)) + (down ? 0 : Math.PI);
      let u = A.s + (((off - A.s) % gap) + gap) % gap;
      for (; u < B.s; u += gap) {
        const f = (u - A.s) / L;
        if (f < 0.03 || f > 0.97) continue;                     // not through the sheaves
        chair(ax + (bx - ax) * f, ay + (by - ay) * f - 4 * sag * f * (1 - f) - 0.05, az + (bz - az) * f, yaw);
      }
    }
  }

  function funBox(ob, w, cam) {
    const x = w[0] - cam.x, y = w[1] - cam.y, z = w[2] - cam.z, yaw = w[3], dy = w[4], b = ob.b || 0, h = ob.h;
    const t = Math.min(0.14, ob.hx * 0.15);
    part(0, x, y, z, 0, -0.1, 0, ob.hx, (h - 0.06 + 0.1) / 2, ob.hz, yaw, dy, b, 1, CHARCOAL, 0);
    part(0, x, y, z, 0, h - 0.06, 0, ob.hx - t, 0.03, ob.hz, yaw, dy, b, 1, ORANGE, 0);
    for (let side = -1; side <= 1; side += 2) part(0, x, y, z, side * (ob.hx - t / 2), h - 0.06, 0, t / 2, 0.03, ob.hz, yaw, dy, b, 1, STRIPE, 0);
  }

  // Where a flag stands: cached on it, [x, y, z, yaw streaming outward].
  function plantFlag(tr, f) {
    const fr = tr.frameAt(f.s, FR);
    const x = fr.x + Math.cos(fr.yaw) * f.o, z = fr.z + Math.sin(fr.yaw) * f.o;
    let y = fr.y;
    if (tr.surfaceAt(f.s, f.o, 1e9, SF) !== 0) y = SF.h;
    return (f.fw = [x, y, z, fr.yaw + (f.o < 0 ? Math.PI : 0)]);
  }

  function liftSlot(lift) {
    for (let i = 0; i < nl; i++) if (lastLift[i] === lift) return i;
    if (nl >= lastLift.length) return -1;
    lastLift[nl] = lift; lastOb[nl] = null;
    for (let m = 0; m < MEM_N; m++) if (memLift[m] === lift) { lastOb[nl] = memOb[m]; break; }
    return nl++;
  }
  function remember(ob) {
    let free = -1;
    for (let m = 0; m < MEM_N; m++) {
      if (memLift[m] === ob.lift) { memOb[m] = ob; return; }
      if (free < 0 && (memOb[m] === null)) free = m;
    }
    if (free < 0) free = (ob.lift >>> 0) % MEM_N;
    memLift[free] = ob.lift; memOb[free] = ob;
  }
  function forget() { memLift.fill(NaN); memOb.fill(null); }
  let nl = 0;

  function upload(R, buf, data, n, stride) {
    const gl = R.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * stride);
  }

  Gfx.layer({
    name: 'resort', order: 24,
    init(R) {
      const gl = R.gl;
      partProg = R.program('resort-part', VS_PART, FS_PART);
      cabProg = R.program('resort-cable', VS_CABLE, FS_CABLE);
      flagProg = R.program('resort-flag', VS_FLAG, FS_FLAG);
      const inst = () => { R.attr(2, 3, IF, 0, 1); R.attr(3, 3, IF, 3, 1); R.attr(4, 4, IF, 6, 1); R.attr(5, 4, IF, 10, 1); };
      cubeVao = gl.createVertexArray(); gl.bindVertexArray(cubeVao);
      R.buffer(Gfx.CUBE); R.attr(0, 3, 6, 0);
      cubeBuf = R.buffer(CD.byteLength, gl.DYNAMIC_DRAW); inst();
      rndVao = gl.createVertexArray(); gl.bindVertexArray(rndVao);
      R.buffer(prism()); R.attr(0, 3, 3, 0);
      rndBuf = R.buffer(RD.byteLength, gl.DYNAMIC_DRAW); inst();
      cabVao = gl.createVertexArray(); gl.bindVertexArray(cabVao);
      R.buffer(cableStrip()); R.attr(0, 2, 2, 0);
      cabBuf = R.buffer(KD.byteLength, gl.DYNAMIC_DRAW); R.attr(2, 4, 7, 0, 1); R.attr(3, 3, 7, 4, 1);
      flagVao = gl.createVertexArray(); gl.bindVertexArray(flagVao);
      R.buffer(strip(FCOL)); R.attr(0, 2, 2, 0);
      flagBuf = R.buffer(FD.byteLength, gl.DYNAMIC_DRAW); R.attr(2, 4, 8, 0, 1); R.attr(3, 4, 8, 4, 1);
      gl.bindVertexArray(null);
    },
    reset() { forget(); clock = 0; },
    releaseTrack(R, tr) { if (memTrack === tr) { forget(); memTrack = null; } },
    prepare(R, v, dt) { clock += v.dt || 0; if (clock > 1e5) clock -= 1e5; },
    drawOpaque(R, v) {
      const gl = R.gl, tr = v.track, cam = R.cam, behind = v.s - v.cam.back - 12, ahead = v.s + AHEAD;
      const gap = R.notch >= 4 ? CHAIR_GAP * 2 : CHAIR_GAP;
      if (memTrack !== tr) { forget(); memTrack = tr; }
      nc = nr = nk = nf = nl = 0;
      for (const ob of tr.obstacles) {
        if (ob.s > ahead + 120) break;
        if (ob.kind === 'box') {
          if (ob.s >= behind && ob.s <= ahead) funBox(ob, R.place(tr, ob), cam);
        } else if (ob.kind === 'tower') {
          R.place(tr, ob);
          const li = liftSlot(ob.lift), prev = li >= 0 ? lastOb[li] : null;
          const linked = prev && prev !== ob && prev.s < ob.s && ob.s - prev.s < 160 && prev.s <= ahead && prev.w;
          if (linked && ob.s >= behind) span(prev, ob, cam, gap);
          if (ob.s >= behind && (ob.s <= ahead || linked)) tower(ob, ob.w, cam);
          if (li >= 0) lastOb[li] = ob;
          if (ob.s < v.s) remember(ob);
        }
      }
      const flags = tr.flags;
      if (flags) {
        for (let i = 0; i < flags.length; i++) {
          const f = flags[i];
          if (f.s < behind || f.s > ahead || nf >= MAXF) continue;
          const w = f.fw || plantFlag(tr, f), x = w[0] - cam.x, y = w[1] - cam.y, z = w[2] - cam.z;
          part(0, x, y, z, 0, -0.4, 0, 0.035, (FLAG_POLE + 0.4) / 2, 0.035, w[3], 0, 0, 1, POLE, 0);
          const c = HUES[(f.hue | 0) & 3], j = nf++ * 8;
          FD[j] = x; FD[j + 1] = y; FD[j + 2] = z; FD[j + 3] = w[3];
          FD[j + 4] = c[0]; FD[j + 5] = c[1]; FD[j + 6] = c[2]; FD[j + 7] = (Look.hash(f.s, f.o) * 6.283) % 6.283;
        }
      }
      if (nc || nr) {
        gl.useProgram(partProg.p);
        if (nc) { gl.bindVertexArray(cubeVao); upload(R, cubeBuf, CD, nc, IF); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, nc); }
        if (nr) { gl.bindVertexArray(rndVao); upload(R, rndBuf, RD, nr, IF); gl.drawArraysInstanced(gl.TRIANGLES, 0, rndCount, nr); }
      }
      if (nk) {
        gl.useProgram(cabProg.p);
        gl.bindVertexArray(cabVao); upload(R, cabBuf, KD, nk, 7);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (CSEG + 1) * 2, nk);
      }
      if (nf) {
        gl.useProgram(flagProg.p);
        gl.bindVertexArray(flagVao); upload(R, flagBuf, FD, nf, 8);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (FCOL + 1) * 2, nf);
      }
      gl.bindVertexArray(null);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
