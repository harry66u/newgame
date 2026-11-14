/* Fall Line — piste furniture that is not an obstacle: the marker poles that line every open
   edge, and the start-gate banner hung over the piste where a harder run begins.

   Nothing here collides. The poles are there to be whipped past (one every 12 m is the
   metronome that tells you how fast you are going) and to draw the edge of the ridge; the
   banner tells you what you have just skied into. Poles are static instances, planted once per
   ribbon; a banner is one small mesh posed by uniforms, since there is rarely more than one. */
(function (root) {
  'use strict';
  const FL = root.FL, C = FL.C, U = FL.U, Look = FL.Look, Gfx = FL.Gfx;
  const SEG = C.SEG;
  const v3 = (c) => 'vec3(' + c.map((x) => x.toFixed(4)).join(', ') + ')';
  const f1 = (x) => x.toFixed(4);

  // ---- poles
  const GAP = 12;               // metres between poles (at s multiples of this, so both edges keep step)
  const OUT = 0.02;             // how far beyond the edge a pole stands: right on the lip (the rock falls away sheer beyond it)
  const POLE_H = 1.5, LEAN = 0.07, SUNK = 0.35;  // SUNK: the shaft carries on down into the snow, so a pole never floats on a bank
  const SHAFT = 0.045, SLEEVE = 0.08;            // half-widths
  const FAR = 400;              // poles grow out of nothing over the last stretch before this, so none pop in
  const IF = 8, MAXP = 512;     // floats per pole; most poles one ribbon can carry
  const ORANGE = U.hex('#ff7a1a');               // the top of a right-hand pole, as on a real piste

  // ---- banner
  const SPAN = 1.2;             // posts stand this far outside the piste edges
  const LIFT = 6.5, BH = 1.3;   // bottom edge of the fabric above the snow; its height
  const PW = 0.11;              // post half-width
  const POST_SUNK = 14;         // open edges drop away into rock: the posts are footed well down the face
  const COLS = 24;              // fabric columns: enough for the sag and the sway to read as curves
  const CREST = 1.75;           // the middle of the banner stands up into a crest this many times its height, carrying the symbol
  const SYM = { circle: 0, square: 1, diamond: 2 };

  const VS_POLE = `
layout(location=0) in vec3 aPos; layout(location=1) in vec4 aNrm;     // aNrm.w: 0 shaft, 1 band, 2 tip
layout(location=2) in vec4 iA;                                        // xyz: foot, relative to uOrg.  w: yaw
layout(location=3) in vec4 iB;                                        // x: -1 left edge, 1 right edge.  yzw: the run's colour
uniform vec3 uOrg;
out vec3 vW; out vec3 vN; out vec3 vCol;
void main(){
  vec3 foot = iA.xyz + uOrg;
  float d = length(foot);
  // never thinner than about a pixel, so a far pole is a steady line instead of a flicker
  float fat = max(1.0, d * uView.w / uView.y * ${f1(1.25 / SHAFT)});
  float y = aPos.y * (1.0 - smoothstep(${f1(FAR * 0.8)}, ${f1(FAR)}, d));
  float cs = cos(iA.w), sn = sin(iA.w);
  float lx = aPos.x * fat + iB.x * ${f1(LEAN)} * y, lz = aPos.z * fat;   // leaning out over the edge a touch
  vW = foot + vec3(cs * lx - sn * lz, y, sn * lx + cs * lz);
  vN = vec3(cs * aNrm.x - sn * aNrm.z, aNrm.y, sn * aNrm.x + cs * aNrm.z);
  vCol = aNrm.w < 0.5 ? ${v3(Look.COL.post)} : (aNrm.w > 1.5 && iB.x > 0.0 ? ${v3(ORANGE)} : iB.yzw);
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS_POLE = `
in vec3 vW; in vec3 vN; in vec3 vCol; out vec4 o;
void main(){ o = vec4(flFog(flLight(vCol, normalize(vN), 1.0), vW), 1.0); }`;

  const VS_BAN = `
layout(location=0) in vec4 aP;      // posts: a cube corner. fabric: x -1..1 across, y 0..1 up.  w: 0 post, 1 fabric
layout(location=1) in vec4 aN;      // posts: normal, w: which post (-1 left, 1 right)
uniform vec4 uAt;                   // xyz: the centreline under the banner, camera-relative.  w: yaw
uniform vec4 uDim;                  // x: half-span to the posts.  y, z: ground at the left / right post, relative to uAt.y.  w: height of the fabric's bottom edge
uniform float uPh, uCnt;
out vec3 vW; out vec3 vN; out vec3 vUV;   // vUV: x metres from the middle, y 0..1 up the fabric (on up to CREST in the crest), z 1 fabric, 2 crest
void main(){
  float cs = cos(uAt.w), sn = sin(uAt.w);
  vec3 l, n;
  if (aP.w < 0.5) {
    float fat = ${f1(PW)} * max(1.0, length(uAt.xyz) * uView.w / uView.y * ${f1(1.3 / PW)});
    float g = aN.w < 0.0 ? uDim.y : uDim.z;
    l = vec3(aN.w * uDim.x + aP.x * fat, mix(g - ${f1(POST_SUNK)}, g + uDim.w + ${f1(BH + 0.35)}, aP.y * 0.5 + 0.5), aP.z * fat);
    n = aN.xyz; vUV = vec3(0.0);
  } else {
    // pinned at the posts, sagging between them, the loose bottom edge swinging more than the top
    // the crest is cut from the same cloth: it hangs and swings as the banner does where it is sewn on
    float u = aP.w > 1.5 ? aP.x * (uCnt * ${f1(0.525 * CREST)} + 0.4) / (uDim.x - ${f1(PW)}) : aP.x;
    float env = 1.0 - u * u, ph = uTime * 1.6 + u * 2.2 + uPh, ph2 = uTime * 4.3 + u * 9.0 + uPh * 1.7;
    float amp = 0.10 + 0.12 * (1.0 - aP.y);
    float z = env * (amp * sin(ph) + 0.03 * sin(ph2));
    float dz = env * (amp * 2.2 * cos(ph) + 0.27 * cos(ph2)) - 2.0 * u * (amp * sin(ph) + 0.03 * sin(ph2));
    l = vec3(u * (uDim.x - ${f1(PW)}), mix(uDim.y, uDim.z, u * 0.5 + 0.5) + uDim.w + aP.y * ${f1(BH)} - env * mix(0.34, 0.16, aP.y), z + (aP.w > 1.5 ? 0.06 : 0.0));
    n = normalize(vec3(-dz / uDim.x * 6.0, 0.1, 1.0));          // folds exaggerated: they are what makes it cloth
    vUV = vec3(l.x, aP.y, aP.w);
  }
  vW = uAt.xyz + vec3(cs * l.x - sn * l.z, l.y, sn * l.x + cs * l.z);
  vN = vec3(cs * n.x - sn * n.z, n.y, sn * n.x + cs * n.z);
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS_BAN = `
in vec3 vW; in vec3 vN; in vec3 vUV;
uniform vec4 uCol;                  // rgb: the run's colour.  w: its symbol, 0 circle, 1 square, 2 diamond
uniform float uCnt;                 // how many of them, side by side
out vec4 o;
void main(){
  vec3 n = normalize(vN), alb = ${v3(Look.COL.post)};
  float thru = 0.0;
  if (vUV.z > 0.5) {
    if (dot(n, vW) > 0.0) n = -n;                               // cloth has two sides: light the one we see
    float m;
    if (vUV.z > 1.5) {
      // the crest: the run's symbol, big enough to read from well up the slope, in a white border
      vec2 p = vec2(vUV.x, (vUV.y - ${f1(CREST * 0.5)}) * ${f1(BH)}) / ${f1(CREST)};
      float k = clamp(floor(p.x / 1.05 + uCnt * 0.5), 0.0, uCnt - 1.0);
      p.x -= (k - (uCnt - 1.0) * 0.5) * 1.05;
      vec2 a = abs(p);
      float d = uCol.w < 0.5 ? length(p) - 0.44 : (uCol.w < 1.5 ? max(a.x, a.y) - 0.38 : a.x * 1.2 + a.y - 0.50);
      float aa = fwidth(d) + 1e-4;
      float e = min(uCnt * ${f1(0.525 * CREST)} + 0.4 - abs(vUV.x), (${f1(CREST * 0.5)} - abs(vUV.y - ${f1(CREST * 0.5)})) * ${f1(BH)});   // metres in from its edge
      float ew = fwidth(e) + 1e-4;
      m = max(1.0 - smoothstep(-aa, aa, d), 1.0 - smoothstep(0.10 - ew, 0.10 + ew, e));
    } else {
      float fw = fwidth(vUV.y) + 1e-4;
      m = smoothstep(0.42 - fw, 0.42 + fw, abs(vUV.y - 0.5));       // a white hem top and bottom
    }
    alb = mix(uCol.rgb, vec3(0.95), m);
    thru = max(dot(-n, uSun.xyz), 0.0) * 0.42;                  // the low sun is behind it: some comes through the cloth
  }
  o = vec4(flFog(flLight(alb, n, 1.0) + alb * uSunCol.rgb * thru, vW), 1.0);
}`;

  let poleProg, poleMesh, poleCount = 0, banProg, banVao, banCount = 0;
  const P = new Float32Array(MAXP * IF);
  const SF = { wall: 0, wallH: 0, h: 0, b: 0, edge: 0, d: 0, hw: 0, rb: null };
  const FR = { x: 0, y: 0, z: 0, yaw: 0, sl: 0, cv: 0, bk: 0, pal: 0, int: 0 };

  // Boxes cut from the unit cube: [half-width, y0, y1, part] each -> pos3, normal3, part.
  function poleGeo() {
    const boxes = [[SHAFT, -SUNK, 0.72, 0], [SLEEVE, 0.72, 1.24, 1], [SLEEVE, 1.24, POLE_H, 2]];
    const cube = Gfx.CUBE, out = new Float32Array(boxes.length * 36 * 7);
    let j = 0;
    for (const b of boxes) {
      for (let i = 0; i < 36; i++) {
        const q = i * 6;
        out[j++] = cube[q] * b[0]; out[j++] = b[1] + (cube[q + 1] * 0.5 + 0.5) * (b[2] - b[1]); out[j++] = cube[q + 2] * b[0];
        out[j++] = cube[q + 3]; out[j++] = cube[q + 4]; out[j++] = cube[q + 5]; out[j++] = b[3];
      }
    }
    poleCount = boxes.length * 36;
    return out;
  }

  // Two posts, a strip of cloth and the crest in the middle of it, 8 floats a vertex (see VS_BAN).
  function bannerGeo() {
    const cube = Gfx.CUBE, out = new Float32Array((78 + COLS * 6) * 8);
    let j = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 36; i++) {
        const q = i * 6;
        out[j++] = cube[q]; out[j++] = cube[q + 1]; out[j++] = cube[q + 2]; out[j++] = 0;
        out[j++] = cube[q + 3]; out[j++] = cube[q + 4]; out[j++] = cube[q + 5]; out[j++] = side;
      }
    }
    const put = (u, v, kind) => { out[j++] = u; out[j++] = v; out[j++] = 0; out[j++] = kind; j += 4; };
    for (let c = 0; c < COLS; c++) {
      const u0 = (c / COLS) * 2 - 1, u1 = ((c + 1) / COLS) * 2 - 1;
      put(u0, 0, 1); put(u1, 0, 1); put(u1, 1, 1); put(u0, 0, 1); put(u1, 1, 1); put(u0, 1, 1);
    }
    put(-1, 0, 2); put(1, 0, 2); put(1, CREST, 2); put(-1, 0, 2); put(1, CREST, 2); put(-1, CREST, 2);
    banCount = 78 + COLS * 6;
    return out;
  }

  // Is this side of the ribbon forest at, or within a couple of sections of, section i?
  function wooded(w, i, n) {
    if (!w) return false;
    for (let a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2); a <= b; a++) if (w[a] > 0.01) return true;
    return false;
  }

  function freePoles(R, rb) {
    const m = rb.markers;
    if (m && m.buf && m.gen === R.gen) { R.gl.deleteVertexArray(m.vao); R.gl.deleteBuffer(m.buf); }
    rb.markers = null;
  }

  // Plant one ribbon's poles: once, the first time it comes into range.
  function plant(R, tr, rb) {
    const gl = R.gl, F = tr.F, N = rb.n;
    const m = (rb.markers = { gen: R.gen, n: 0, vao: null, buf: null, ox: F.x[rb.k0], oy: F.y[rb.k0], oz: F.z[rb.k0] });
    let n = 0;
    for (let s = Math.ceil(rb.sA / GAP) * GAP; s < rb.sB && n < MAXP - 1; s += GAP) {
      const i = Math.round((s - rb.sA) / SEG);
      if (i > N - 1) break;
      const hw = rb.hw[i];
      if (hw < 2.5) continue;                                   // bridges and beams stay bare
      const k = rb.k0 + i, yaw = F.yaw[k], cs = Math.cos(yaw), sn = Math.sin(yaw);
      const col = Look.rating(tr.chunkAt(s).wave).col;
      for (let side = -1; side <= 1; side += 2) {
        if (wooded(side < 0 ? rb.wl : rb.wr, i, N)) continue;
        // an edge with more snow beyond it (a kicker laid on the piste, a branch joining) is not the edge of the run
        if (tr.surfaceAt(s, rb.c[i] + side * (hw + C.EDGE + 0.5), 1e9, SF) !== 0 || SF.wall) continue;
        const o = rb.c[i] + side * (hw + OUT), j = n++ * IF;
        P[j] = F.x[k] + cs * o - m.ox;
        P[j + 1] = F.y[k] + rb.e[i] + side * (hw + OUT) * rb.b[i] - m.oy;
        P[j + 2] = F.z[k] + sn * o - m.oz;
        P[j + 3] = yaw; P[j + 4] = side;
        P[j + 5] = col[0]; P[j + 6] = col[1]; P[j + 7] = col[2];
      }
    }
    if (!n) return m;
    m.n = n;
    m.vao = gl.createVertexArray(); gl.bindVertexArray(m.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, poleMesh); R.attr(0, 3, 7, 0); R.attr(1, 4, 7, 3);
    m.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
    gl.bufferData(gl.ARRAY_BUFFER, P, gl.STATIC_DRAW, 0, n * IF);
    R.attr(2, 4, IF, 0, 1); R.attr(3, 4, IF, 4, 1);
    gl.bindVertexArray(null);
    return m;
  }

  // Where a banner stands: [x, y, z, yaw, ground at the left post, ground at the right post (both relative to y)].
  function stand(tr, a) {
    tr.frameAt(a.s, FR);
    let h = FR.y, b = FR.bk;
    if (tr.surfaceAt(a.s, 0, 1e9, SF) === 1) { h = SF.h; b = SF.b; }
    const span = a.hw + SPAN;
    return (a.mk = [FR.x, FR.y, FR.z, FR.yaw, h - FR.y - span * b, h - FR.y + span * b]);
  }

  Gfx.layer({
    name: 'markers', order: 22,
    init(R) {
      const gl = R.gl;
      poleProg = R.program('markers-pole', VS_POLE, FS_POLE);
      poleMesh = R.buffer(poleGeo());
      banProg = R.program('markers-banner', VS_BAN, FS_BAN);
      banVao = gl.createVertexArray(); gl.bindVertexArray(banVao);
      R.buffer(bannerGeo()); R.attr(0, 4, 8, 0); R.attr(1, 4, 8, 4);
      gl.bindVertexArray(null);
    },
    freeRibbon(R, rb) { freePoles(R, rb); },
    drawOpaque(R, v) {
      const gl = R.gl, tr = v.track, cam = R.cam, behind = v.s - v.cam.back - 12, ahead = v.s + FAR + 20;
      let u = poleProg.u;
      gl.useProgram(poleProg.p);
      for (const rb of tr.ribbons) {
        if (rb.sB < behind || rb.sA > ahead) continue;
        let m = rb.markers;
        if (!m || m.gen !== R.gen) m = plant(R, tr, rb);
        if (!m.n) continue;
        gl.uniform3f(u.uOrg, m.ox - cam.x, m.oy - cam.y, m.oz - cam.z);
        gl.bindVertexArray(m.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, poleCount, m.n);
      }
      let on = false;
      for (const a of tr.arches) {
        if (a.s < behind) continue;
        if (!on) { on = true; u = banProg.u; gl.useProgram(banProg.p); gl.bindVertexArray(banVao); }
        const w = a.mk || stand(tr, a), r = Look.rating(a.wave);
        gl.uniform4f(u.uAt, w[0] - cam.x, w[1] - cam.y, w[2] - cam.z, w[3]);
        // a portrait screen flies its camera much higher (see the core's camera): hang the cloth clear of it
        gl.uniform4f(u.uDim, a.hw + SPAN, w[4], w[5], LIFT + (R.tall || 0) * 3.4);
        gl.uniform4f(u.uCol, r.col[0], r.col[1], r.col[2], SYM[r.sym] || 0);
        gl.uniform1f(u.uCnt, r.n);
        gl.uniform1f(u.uPh, (a.s * 0.37) % 6.283);
        gl.drawArrays(gl.TRIANGLES, 0, banCount);
      }
      gl.bindVertexArray(null);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
