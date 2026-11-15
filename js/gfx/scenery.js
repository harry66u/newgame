/* Fall Line — scenery: the rock spires that stand in the valley beside the run. Something to
   fly past, and the measure of how high the piste hangs.

   Every crag is the same small mesh — a main spire of stacked seven-sided rings and two
   lesser needles — pushed into its own shape in the vertex shader from the crag's seed: walls
   and ledges, a lean, a ragged outline, needles tall or short or missing. Facets are
   flat-shaded from derivatives, snow lies on whatever faces the sky, and the foot of each one
   dissolves into the valley so no bottom edge is ever seen. They are drawn bluer and hazier
   than anything on the piste: scenery, never an obstacle. */
(function (root) {
  'use strict';
  const FL = root.FL, Gfx = FL.Gfx, COL = FL.Look.COL;
  const MAX = 96, STRIDE = 8;                 // instances per frame, floats per instance
  const FADE_IN = 315, FADE_LEN = 100;        // crags appear ~420 m ahead: by then they must be pure air
  // the sky owns the cloud deck in the valley; far crags fade into the same mist it draws
  const MIST = FL.Sky ? FL.Sky.MIST : 'float skyMist(vec3 d){ return 0.0; }\n';
  const v3 = (c, k) => 'vec3(' + c.map((x) => (x * k).toFixed(4)).join(', ') + ')';

  const VS = `
layout(location=0) in vec3 aV;            // x: side, y: ring down from the summit (-1 = the summit itself), z: which spire (0 main, 1-2 needles)
layout(location=1) in vec3 iPos;          // the crag's highest point, camera-relative
layout(location=2) in vec4 iA;            // x: radius of the body  y: depth drawn  z: yaw  w: seed
layout(location=3) in float iFade;        // 0 = here .. 1 = only just in range, still lost in the air
out vec3 vW; out vec4 vL; flat out vec3 vI;
// The main spire, as shares of its height and of the body radius. After the rim of the summit
// cap, rings come in pairs: the foot of a wall, then the rim of the ledge that wall stands on.
const float RD[7] = float[7](0.0, 0.150, 0.165, 0.300, 0.318, 0.620, 1.000);
const float RA[7] = float[7](0.30, 0.50, 0.52, 0.66, 0.68, 0.88, 1.10);
const float L1[7] = float[7](0.0, 0.0, 0.3, 0.3, 0.3, 0.3, 0.3);          // + the upper ledge
const float L2[7] = float[7](0.0, 0.0, 0.0, 0.0, 0.3, 0.3, 0.3);          // + the lower ledge
// The needles that stand beside it: slimmer, no ledges.
const float ND[4] = float[4](0.0, 0.24, 0.52, 1.0);
const float NR[4] = float[4](0.38, 0.62, 0.94, 1.45);
void main(){
  float sd = iA.w * 57.0 + 3.0, j = aV.y, part = aV.z, side = aV.x + part * 83.0, id = side + j * 9.0 + 20.0;
  // one pair of numbers for each side of a spire, so its walls stay flat from top to bottom; a little more for each corner
  vec2 hs = vec2(flHash(vec2(side, sd)), flHash(vec2(side, sd + 4.3)));
  float hv = flHash(vec2(id, sd + 1.7));
  // what kind of crag this is: how wide each ledge, how tall the summit cap, which way it leans
  vec4 k = vec4(flHash(vec2(1.0, sd)), flHash(vec2(2.0, sd)), flHash(vec2(3.0, sd)), flHash(vec2(4.0, sd)));
  // this spire: where it stands, how far below the crag's top its own top is, how stout, how many sides
  vec2 c = vec2(0.0);
  float top = 0.0, body = iA.x, n = 7.0, th = iA.z, cap = 0.6 + 1.0 * k.z;
  if (part > 0.5) {
    vec4 q = vec4(flHash(vec2(part * 11.0 + 5.0, sd)), flHash(vec2(part * 11.0 + 6.0, sd)), flHash(vec2(part * 11.0 + 7.0, sd)), flHash(vec2(part * 11.0 + 8.0, sd)));
    th = (q.x + part * 0.4) * 6.2832;
    c = vec2(cos(th), sin(th)) * iA.x * (0.62 + 0.45 * q.y);
    top = iA.y * (0.06 + 0.24 * q.z); body = iA.x * (0.4 + 0.3 * q.w); n = 5.0; cap = 0.5 + 1.5 * fract(q.z * 9.0);
    if (fract(q.w * 7.0) > 0.78) { top = iA.y * 0.55; c = vec2(0.0); }    // some crags go without this needle: it stays inside the rock
  }
  float tall = iA.y - top, tier = floor((j + 1.0) * 0.5);
  float ang = (aV.x + (hs.y - 0.5) * 0.7) * (6.2832 / n) + th + j * 0.07;
  vec2 dir = vec2(cos(ang), sin(ang));
  // every level is tilted its own way: the cap, each ledge
  float ta = flHash(vec2(tier + part * 7.0 + 40.0, sd)) * 6.2832;
  float tilt = dot(dir, vec2(cos(ta), sin(ta)));
  float depth = top, rad = body * 0.1;
  if (j < 0.0) dir = -vec2(cos(ta), sin(ta));              // the summit stands toward the high side of its cap
  else if (part < 0.5) {
    int r = int(j);
    rad = body * (RA[r] + L1[r] * (0.1 + 0.9 * k.x) + L2[r] * (0.1 + 0.6 * k.y)) * (0.76 + 0.48 * hs.x) * (0.86 + 0.28 * hv);
    // the cap is as tall as it is wide, give or take: gentle ones hold snow, steep ones stand bare
    depth += r == 0 ? body * RA[0] * cap * (1.0 + 0.5 * tilt) : tall * (RD[r] + (r == 6 ? 0.0 : 0.03 * tilt));
    // each tier steps sideways its own way: a broad ledge on one side, a sheer drop on the other
    c = (vec2(flHash(vec2(tier + 60.0, sd)), flHash(vec2(tier + 70.0, sd))) - 0.5) * iA.x * min(tier, 2.0) * 0.22;
  } else {
    int r = int(j);
    rad = body * NR[r] * (0.76 + 0.48 * hs.x) * (0.86 + 0.28 * hv);
    depth += r == 0 ? body * NR[0] * cap * (1.0 + 0.5 * tilt) : tall * (ND[r] + (r == 3 ? 0.0 : 0.04 * tilt));
  }
  vec2 lean = vec2(cos(k.w * 6.2832), sin(k.w * 6.2832)) * (0.16 * fract(k.w * 17.0));
  vec3 l = vec3(dir.x * rad + c.x + lean.x * depth, -depth, dir.y * rad + c.y + lean.y * depth);
  vW = iPos + l;
  vL = vec4(l.x, depth, l.z, depth / iA.y);
  vI = vec3(sd, iFade, flHash(vec2(id, sd + 2.2)));       // the last: a shade of its own for each face
  gl_Position = uVP * vec4(vW, 1.0);
}`;

  const FS = MIST + `
in vec3 vW; in vec4 vL; flat in vec3 vI;
out vec4 o;
void main(){
  vec3 n = flFacet(vW);
  float depth = vL.y;
  vec3 rock = mix(${v3(COL.rockDark, 1)}, ${v3(COL.rock, 1.1)}, vI.z);
  // snow lies on whatever faces the sky: summit caps and ledges. Old, wind-scoured snow, a
  // shade bluer and duller than the groomed piste, so no cap ever looks like somewhere to ski.
  float snow = smoothstep(0.46, 0.6, n.y);
  vec3 col = flLight(mix(rock, vec3(0.8, 0.86, 0.96), snow), n, 1.0);
  // below the summit it sinks into the valley's blue, and is gone well before the mesh ends
  col = mix(col, uValley.rgb, max(1.0 - exp(-max(depth - 8.0, 0.0) / 50.0), smoothstep(0.5, 0.86, vL.w)));
  col = flFog(col, vW * 1.15);                                    // further off than it is: scenery sits deeper in the air
  if (vI.y > 0.0) {
    // just come into range: nothing yet but the air and the mist behind it
    vec3 dir = normalize(vW);
    col = mix(col, mix(flAtmo(dir), uAmb.rgb, skyMist(dir)), vI.y);
  }
  o = vec4(col, 1.0);
}`;

  let prog = null, vao = null, ibuf = null, count = 0;
  const inst = new Float32Array(MAX * STRIDE);

  function init(R) {
    const gl = R.gl;
    prog = R.program('scenery', VS, FS);
    // the mesh: only (side, ring, spire) per vertex; the vertex shader does the rest
    const verts = [], idx = [];
    const spire = (part, sides, rings) => {
      const base = verts.length / 3, at = (j, k) => base + 1 + j * sides + (k % sides);
      verts.push(0, -1, part);
      for (let j = 0; j < rings; j++) for (let k = 0; k < sides; k++) verts.push(k, j, part);
      for (let k = 0; k < sides; k++) idx.push(base, at(0, k + 1), at(0, k));
      for (let j = 0; j < rings - 1; j++) {
        for (let k = 0; k < sides; k++) {
          const a = at(j, k), b = at(j, k + 1), c = at(j + 1, k), d = at(j + 1, k + 1);
          // the diagonal alternates; both halves end on the same corner, so a whole wall takes that corner's shade
          if ((j + k) & 1) idx.push(b, d, a, d, c, a); else idx.push(a, b, c, b, d, c);
        }
      }
    };
    spire(0, 7, 7); spire(1, 5, 4); spire(2, 5, 4);
    count = idx.length;
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    R.buffer(new Float32Array(verts)); R.attr(0, 3, 3, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    ibuf = R.buffer(inst.byteLength, gl.DYNAMIC_DRAW);
    R.attr(1, 3, STRIDE, 0, 1); R.attr(2, 4, STRIDE, 3, 1); R.attr(3, 1, STRIDE, 7, 1);
    gl.bindVertexArray(null);
  }

  Gfx.layer({
    name: 'scenery', order: 50, init,
    prepare(R, v, dt) { if (FL.Sky) FL.Sky.sync(R, dt); },
    drawOpaque(R, v) {
      const gl = R.gl, cam = R.cam, list = v.track.crags;
      let fx = R.camF[0], fz = R.camF[2];
      const fl = Math.hypot(fx, fz) || 1;
      fx /= fl; fz /= fl;
      let n = 0;
      for (let i = 0; i < list.length && n < MAX; i++) {
        const c = list[i], dx = c.x - cam.x, dz = c.z - cam.z;
        if (dx * fx + dz * fz < -(c.r * 3 + 10)) continue;          // wholly behind the camera
        let fade = (c.s - v.s - FADE_IN) / FADE_LEN;
        if (fade >= 1) continue;                                    // not in range yet
        fade = fade <= 0 ? 0 : fade * fade * (3 - 2 * fade);
        const j = n++ * STRIDE;
        inst[j] = dx; inst[j + 1] = c.y - cam.y; inst[j + 2] = dz;
        inst[j + 3] = c.r; inst[j + 4] = c.h; inst[j + 5] = c.yaw; inst[j + 6] = c.seed; inst[j + 7] = fade;
      }
      if (!n) return;
      gl.useProgram(prog.p);
      if (FL.Sky) FL.Sky.bind(gl, prog.u);
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, n * STRIDE);
      gl.drawElementsInstanced(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0, n);
      gl.bindVertexArray(null);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
