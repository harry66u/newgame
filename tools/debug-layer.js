/* Fall Line — debug overlay, injected by tools/shot.mjs --debug (never shipped).
   Draws what the simulation actually collides with, over what the renderer shows:
   red boxes = obstacle hit boxes, green = boost strips, red rails = where leaving the piste ends the run. */
(function () {
  'use strict';
  const FL = window.FL, C = FL.C, Gfx = FL.Gfx;
  const N = 400, data = new Float32Array(N * 13);
  let prog, vao, buf, n = 0;
  const VS = `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 iPos; layout(location=3) in vec3 iHalf; layout(location=4) in vec4 iRot; layout(location=5) in vec3 iCol;
out vec3 vL; out vec3 vH; out vec3 vCol; out vec3 vN;
void main(){
  vec3 l = aPos * iHalf;
  float cs = cos(iRot.x), sn = sin(iRot.x), fwd = -l.z;
  float y = l.y + iHalf.y + fwd * iRot.y + l.x * iRot.z;
  vL = l; vH = iHalf; vCol = iCol; vN = aNrm;
  gl_Position = uVP * vec4(iPos + vec3(cs * l.x - sn * l.z, y, sn * l.x + cs * l.z), 1.0);
}`;
  const FS = `
in vec3 vL; in vec3 vH; in vec3 vCol; in vec3 vN; out vec4 o;
void main(){
  vec3 e = vH - abs(vL), an = abs(vN);
  float d = an.x > 0.5 ? min(e.y, e.z) : an.y > 0.5 ? min(e.x, e.z) : min(e.x, e.y);
  float line = 1.0 - smoothstep(0.0, fwidth(d) * 1.5, d - 0.02);
  float a = 0.16 + 0.8 * line;
  o = vec4(vCol * a, a);
}`;
  const box = (x, y, z, hx, hy, hz, yaw, dyds, bank, r, g, b) => {
    if (n >= N) return;
    const j = n++ * 13;
    data[j] = x; data[j + 1] = y; data[j + 2] = z; data[j + 3] = hx; data[j + 4] = hy; data[j + 5] = hz;
    data[j + 6] = yaw; data[j + 7] = dyds; data[j + 8] = bank; data[j + 9] = 0; data[j + 10] = r; data[j + 11] = g; data[j + 12] = b;
  };
  const FR = {};
  Gfx.layer({
    name: 'debug', order: 95,
    init(R) {
      const gl = R.gl;
      prog = R.program('debug', VS, FS);
      vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      R.buffer(Gfx.CUBE); R.attr(0, 3, 6, 0); R.attr(1, 3, 6, 3);
      buf = R.buffer(data.byteLength, gl.DYNAMIC_DRAW);
      R.attr(2, 3, 13, 0, 1); R.attr(3, 3, 13, 3, 1); R.attr(4, 4, 13, 6, 1); R.attr(5, 3, 13, 10, 1);
      gl.bindVertexArray(null);
    },
    drawBlend(R, v) {
      const gl = R.gl, tr = v.track, cam = R.cam, behind = v.s - v.cam.back - 12, F = tr.F;
      n = 0;
      for (const ob of tr.obstacles) {
        if (ob.s < behind || ob.s > v.s + 160) continue;
        const w = R.place(tr, ob);
        box(w[0] - cam.x, w[1] - cam.y, w[2] - cam.z, ob.hx, ob.h / 2, ob.hz, w[3], w[4], ob.b, 1, 0.1, 0.1);
      }
      for (const pd of tr.pads) {
        if (pd.s < behind || pd.s > v.s + 160) continue;
        const w = R.place(tr, pd);
        box(w[0] - cam.x, w[1] - cam.y, w[2] - cam.z, pd.hx, 0.05, pd.hz, w[3], w[4], pd.b, 0.1, 1, 0.3);
      }
      // the lines that end a run: each ribbon's edge plus the grace the simulation allows
      for (const rb of tr.ribbons) {
        for (let i = 0; i < rb.n - 1; i += 2) {
          const k = rb.k0 + i, s = k * C.SEG;
          if (s < behind || s > v.s + 120) continue;
          const cs = Math.cos(F.yaw[k]), sn = Math.sin(F.yaw[k]);
          for (const side of [-1, 1]) {
            const o = rb.c[i] + side * (rb.hw[i] + C.EDGE);
            const wall = side < 0 ? rb.wl && rb.wl[i] > 0.5 : rb.wr && rb.wr[i] > 0.5;
            box(F.x[k] + cs * o - cam.x, F.y[k] + rb.e[i] + side * rb.hw[i] * rb.b[i] - cam.y, F.z[k] + sn * o - cam.z, 0.03, 0.25, 1.0, F.yaw[k], (F.y[k + 1] - F.y[k]) / C.SEG, 0, 1, wall ? 0.6 : 0.1, wall ? 0.0 : 0.1);
          }
        }
      }
      // the skier's own collision size
      const sk = R.skier;
      box(sk.x - cam.x, sk.y - cam.y, sk.z - cam.z, C.HIT_R, 0.9, C.HIT_R, sk.yaw, 0, 0, 1, 1, 0.2);
      if (!n) return;
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(prog.p);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * 13);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n);
      gl.bindVertexArray(null);
      void FR;
    },
  });
})();
