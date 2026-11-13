/* Fall Line — stand-in layers. Plain lit boxes for everything that does not have its real
   layer yet (pines, rocks, fences, the skier, banners, boost strips), so the game is always
   playable and the snow's shadows have something to line up with. Each stand-in switches
   itself off as soon as the real layer of that name registers (see `standIn`). */
(function (root) {
  'use strict';
  const FL = root.FL, C = FL.C, Look = FL.Look, Gfx = FL.Gfx;
  const N = 512, TMP = new Float32Array(48);

  const VS = `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 iPos; layout(location=3) in vec3 iHalf; layout(location=4) in vec4 iRot; layout(location=5) in vec3 iCol;
out vec3 vW; out vec3 vN; out vec3 vCol;
void main(){
  vec3 l = aPos * iHalf;
  float cs = cos(iRot.x), sn = sin(iRot.x), fwd = -l.z;
  float y = l.y + iHalf.y + fwd * iRot.y + l.x * iRot.z;            // sheared so the base follows the slope and bank
  vW = iPos + vec3(cs * l.x - sn * l.z, y, sn * l.x + cs * l.z);
  vN = vec3(cs * aNrm.x - sn * aNrm.z, aNrm.y, sn * aNrm.x + cs * aNrm.z);
  vCol = iCol;
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS = `
in vec3 vW; in vec3 vN; in vec3 vCol; out vec4 o;
void main(){ o = vec4(flFog(flLight(vCol, normalize(vN), 1.0), vW), 1.0); }`;

  const VS_ICE = `
layout(location=0) in vec2 aPos;
layout(location=2) in vec3 iPos; layout(location=3) in vec4 iSize; layout(location=4) in vec4 iShear;
out vec2 vUV; out vec3 vW; out vec2 vHalf; out float vOn;
void main(){
  float lx = aPos.x * iSize.x, fwd = aPos.y * iSize.y;
  float cs = cos(iSize.z), sn = sin(iSize.z);
  vW = iPos + vec3(cs * lx + sn * fwd, 0.04 + fwd * iShear.x + lx * iShear.y, sn * lx - cs * fwd);
  vUV = aPos; vHalf = iSize.xy; vOn = iShear.z;
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS_ICE = `
in vec2 vUV; in vec3 vW; in vec2 vHalf; in float vOn; out vec4 o;
void main(){
  float x = abs(vUV.x), fy = vUV.y * vHalf.y;
  float c = fract(fy / 2.0 - x * 0.55 - uTime * 2.4);
  float chev = smoothstep(0.0, 0.1, c) * smoothstep(0.55, 0.45, c);
  float a = (0.55 + 0.35 * chev) * smoothstep(1.0, 0.9, x) * smoothstep(1.0, 0.85, abs(vUV.y)) * vOn;
  vec3 col = flFog(mix(vec3(0.02, 0.26, 0.62), vec3(0.45, 0.85, 1.0), chev), vW);
  o = vec4(col * a, a);
}`;

  let prog, vao, buf, iceProg, iceVao, iceBuf;
  const data = new Float32Array(N * 13), ice = new Float32Array(128 * 11);
  let n = 0;
  const box = (x, y, z, hx, hy, hz, yaw, dyds, bank, col) => {
    if (n >= N) return;
    const j = n++ * 13;
    data[j] = x; data[j + 1] = y; data[j + 2] = z; data[j + 3] = hx; data[j + 4] = hy; data[j + 5] = hz;
    data[j + 6] = yaw; data[j + 7] = dyds; data[j + 8] = bank; data[j + 9] = 0;
    data[j + 10] = col[0]; data[j + 11] = col[1]; data[j + 12] = col[2];
  };

  function init(R) {
    const gl = R.gl;
    if (prog && prog.gen === R.gen) return;
    prog = R.program('stub', VS, FS); prog.gen = R.gen;
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    R.buffer(Gfx.CUBE); R.attr(0, 3, 6, 0); R.attr(1, 3, 6, 3);
    buf = R.buffer(data.byteLength, gl.DYNAMIC_DRAW);
    R.attr(2, 3, 13, 0, 1); R.attr(3, 3, 13, 3, 1); R.attr(4, 4, 13, 6, 1); R.attr(5, 3, 13, 10, 1);
    iceProg = R.program('stub-ice', VS_ICE, FS_ICE);
    iceVao = gl.createVertexArray(); gl.bindVertexArray(iceVao);
    R.buffer(Gfx.QUAD); R.attr(0, 2, 2, 0);
    iceBuf = R.buffer(ice.byteLength, gl.DYNAMIC_DRAW);
    R.attr(2, 3, 11, 0, 1); R.attr(3, 4, 11, 3, 1); R.attr(4, 4, 11, 7, 1);
    gl.bindVertexArray(null);
  }
  function flush(R) {
    if (!n) return;
    const gl = R.gl;
    gl.useProgram(prog.p);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * 13);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n);
    gl.bindVertexArray(null);
    n = 0;
  }

  Gfx.layer({
    name: 'stub-flora', standIn: 'flora', order: 30, init,
    drawOpaque(R, v) {
      const tr = v.track, cam = R.cam, behind = v.s - v.cam.back - 12;
      for (const ob of tr.obstacles) {
        if (ob.s < behind) continue;
        const cnt = Look.trees(ob, TMP);
        if (!cnt) continue;
        const w = R.place(tr, ob), cs = Math.cos(w[3]), sn = Math.sin(w[3]);
        for (let j = 0; j < cnt; j++) {
          const d = TMP[j * 3] - ob.o, r = TMP[j * 3 + 1] * 0.6;
          box(w[0] + cs * d - cam.x, w[1] - cam.y, w[2] + sn * d - cam.z, r, TMP[j * 3 + 2] / 2, r, w[3], 0, 0, Look.COL.pine);
        }
      }
      flush(R);
    },
  });

  Gfx.layer({
    name: 'stub-props', standIn: 'props', order: 20, init,
    drawOpaque(R, v) {
      const tr = v.track, cam = R.cam, behind = v.s - v.cam.back - 12;
      for (const ob of tr.obstacles) {
        if (ob.s < behind || ob.kind === 'pine' || ob.kind === 'pines') continue;
        const w = R.place(tr, ob);
        box(w[0] - cam.x, w[1] - cam.y - 0.05, w[2] - cam.z, ob.hx, ob.h / 2, ob.hz, w[3], w[4], ob.b, ob.kind === 'fence' ? Look.COL.fence : Look.COL.rock);
      }
      for (const a of tr.arches) {
        const it = a.w || (a.w = R.place(tr, { s: a.s, o: 0, e: 0 }));
        const cs = Math.cos(it[3]), sn = Math.sin(it[3]), col = Look.rating(a.wave).col;
        for (const side of [-1, 1]) box(it[0] + cs * side * (a.hw + 1) - cam.x, it[1] - cam.y - 0.5, it[2] + sn * side * (a.hw + 1) - cam.z, 0.15, 4, 0.15, it[3], 0, 0, Look.COL.post);
        box(it[0] - cam.x, it[1] + 6.4 - cam.y, it[2] - cam.z, a.hw + 1.15, 0.55, 0.08, it[3], 0, 0, col);
      }
      flush(R);
    },
    drawBlend(R, v) {
      const gl = R.gl, tr = v.track, cam = R.cam, behind = v.s - v.cam.back - 12;
      let m = 0;
      for (const pd of tr.pads) {
        if (pd.s < behind || m >= 128) continue;
        const w = R.place(tr, pd), j = m++ * 11;
        ice[j] = w[0] - cam.x; ice[j + 1] = w[1] - cam.y; ice[j + 2] = w[2] - cam.z;
        ice[j + 3] = pd.hx; ice[j + 4] = pd.hz; ice[j + 5] = w[3]; ice[j + 6] = 0;
        ice[j + 7] = w[4]; ice[j + 8] = pd.b; ice[j + 9] = pd.used ? 0.35 : 1; ice[j + 10] = 0;
      }
      if (!m) return;
      gl.useProgram(iceProg.p);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -2);
      gl.bindVertexArray(iceVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, iceBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ice, 0, m * 11);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, m);
      gl.bindVertexArray(null);
    },
  });

  Gfx.layer({
    name: 'stub-skier', standIn: 'skier', order: 40, init,
    drawOpaque(R, v) {
      if (!v.skierOn) return;
      const sk = R.skier, cam = R.cam;
      box(sk.x - cam.x, sk.y - cam.y, sk.z - cam.z, 0.25, 0.85, 0.2, sk.yaw, 0, 0, Look.COL.jacket);
      box(sk.x - cam.x, sk.y - cam.y, sk.z - cam.z, 0.3, 0.03, 0.85, sk.yaw + Math.atan2(v.vo, Math.max(v.u, 8)), -sk.sl, 0, Look.COL.skis);
      flush(R);
    },
  });

  // Until the real sky arrives: clear air and a sun.
  let skyProg;
  Gfx.layer({
    name: 'stub-sky', standIn: 'sky', order: 90,
    init(R) {
      skyProg = R.program('stub-sky', `
out vec2 vUV;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0); }`, `
in vec2 vUV; out vec4 o;
void main(){
  vec4 q = uInvVP * vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(q.xyz / q.w);
  float s = max(dot(d, uSun.xyz), 0.0);
  o = vec4(flAtmo(d) + uGlow.rgb * (smoothstep(0.9993, 0.9997, s) * 6.0 + pow(s, 300.0) * 1.5), 1.0);
}`);
    },
    drawOpaque(R) {
      const gl = R.gl;
      gl.depthFunc(gl.LEQUAL);
      gl.useProgram(skyProg.p);
      gl.bindVertexArray(R.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
  });
  void C;
})(typeof window !== 'undefined' ? window : globalThis);
