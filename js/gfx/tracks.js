/* Fall Line — ski tracks and crystals in the air.
   Two quiet layers that make speed and turning visible on a white mountain:

   'tracks'  the two grooves the skis leave, a ribbon built from the skier's own path. A run of
             turns leaves S-curves on the snow behind you; a jump leaves a gap.
   'dust'    sparse ice crystals hanging in the air along the route. They glint in the sun and
             streak past with speed. No state at all: every crystal is a hash of its instance
             id, wrapped into a box that travels with the camera. */
(function (root) {
  'use strict';
  const FL = root.FL, Gfx = FL.Gfx;

  // =================================================================== tracks
  const STEP = 0.35;            // metres of travel between samples
  const LEN = 45;               // metres of track kept; it fades out toward the old end
  const CAP = 160;              // ring size: CAP * STEP comfortably more than LEN
  const SKI = 0.16;             // each ski this far either side of the path
  const HW0 = 0.06, HW1 = 0.10; // ribbon half-width: the groove alone, plus this much at a full carve (matches the shader)
  const LIFT = 0.02;            // laid just above the surface
  const TAIL = 0.8;             // the track starts behind the ski tails, never under the skis
  const WARP = 12;              // moved further than this in one frame: a restart, not skiing
  const VF = 6;                 // floats per vertex: camera-relative position, side -1/1, alpha, carve

  const VS = `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aK;
out vec3 vK;
void main(){
  vK = aK;
  vec4 c = uVP * vec4(aPos, 1.0);
  // Depth only: as if the ribbon were a little nearer the eye, more with distance, so the
  // grooves never z-fight the snow they lie on. (k scales w too, hence the divide.)
  float d = max(length(aPos), 0.5), k = 1.0 - (0.04 + 0.012 * d) / d;
  c.z = (uVP * vec4(aPos * k, 1.0)).z / k;
  gl_Position = c;
}`;
  const FS = `
in vec3 vK; out vec4 o;
void main(){
  float hw = ${HW0.toFixed(3)} + ${HW1.toFixed(3)} * vK.z;
  float x = abs(vK.x) * hw;                                   // metres from the middle of this ski's track
  float groove = 1.0 - smoothstep(0.02, 0.05 + fwidth(x), x); // the thin line an edge leaves
  float e = 1.0 - vK.x * vK.x;
  float smear = e * e * vK.z;                                 // the wider scrape of a hard carve
  float a = (groove * 0.46 + smear * 0.20) * vK.y;
  // Multiplied over the snow: a groove is snow turned away from the sun, so it takes the
  // colour of the shade in whatever mood the light is in.
  vec3 shade = uAmb.rgb / max(uAmb.rgb + uSunCol.rgb, vec3(1e-3));
  o = vec4(mix(vec3(1.0), shade, a), 1.0);
}`;

  // The path, a ring of samples in world space (doubles: a run goes a long way from the origin).
  const px = new Float64Array(CAP), py = new Float64Array(CAP), pz = new Float64Array(CAP), od = new Float64Array(CAP);
  const rx = new Float32Array(CAP), ry = new Float32Array(CAP), rz = new Float32Array(CAP), cv = new Float32Array(CAP);
  const brk = new Uint8Array(CAP);            // 1: this sample starts a new strip (after air, or a restart)
  const verts = new Float32Array((CAP + 1) * 4 * VF);
  let head = 0, count = 0;                    // next slot to write; samples held
  let odo = 0;                                // metres travelled: a sample's age is odo minus its own reading
  let have = false, lx = 0, ly = 0, lz = 0;   // where the skier was last frame
  let chain = false;                          // the newest sample can be joined to the skier (grounded since it was laid)
  let sx = 0, sy = 0, sz = 0, sOdo = 0;       // the newest sample
  let nSlots = 0;
  let tProg, tVao, tBuf;

  function clear() { head = 0; count = 0; odo = 0; have = false; chain = false; nSlots = 0; }

  function commit(x, y, z, o, rX, rY, rZ, c, b) {
    px[head] = x; py[head] = y; pz[head] = z; od[head] = o;
    rx[head] = rX; ry[head] = rY; rz[head] = rZ; cv[head] = c; brk[head] = b;
    head = (head + 1) % CAP; if (count < CAP) count++;
    sx = x; sy = y; sz = z; sOdo = o;
  }

  // One cross-section: four vertices, the two edges of each ski's ribbon.
  function put(slot, x, y, z, rX, rY, rZ, c, a) {
    const hw = HW0 + HW1 * c;
    let o = slot * 4 * VF;
    for (let k = -1; k <= 1; k += 2) {
      for (let side = -1; side <= 1; side += 2) {
        const off = k * SKI + side * hw;
        verts[o] = x + rX * off; verts[o + 1] = y + rY * off + LIFT; verts[o + 2] = z + rZ * off;
        verts[o + 3] = side; verts[o + 4] = a; verts[o + 5] = c;
        o += VF;
      }
    }
  }

  function tInit(R) {
    const gl = R.gl;
    tProg = R.program('tracks', VS, FS);
    tVao = gl.createVertexArray(); gl.bindVertexArray(tVao);
    tBuf = R.buffer(verts.byteLength, gl.DYNAMIC_DRAW);
    R.attr(0, 3, VF, 0); R.attr(1, 3, VF, 3);
    // Fixed indices joining each cross-section to the next. A break in the track is not a gap
    // in the indices: both sides of it are drawn with zero alpha, so nothing can ever show
    // across a jump, a restart or the seam of the ring.
    const idx = new Uint16Array(CAP * 12);
    for (let j = 0, n = 0; j < CAP; j++) {
      for (let k = 0; k < 2; k++) {
        const a = j * 4 + k * 2;
        idx[n++] = a; idx[n++] = a + 1; idx[n++] = a + 4; idx[n++] = a + 1; idx[n++] = a + 5; idx[n++] = a + 4;
      }
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  function tPrepare(R, v) {
    const sk = R.skier, cam = R.cam;
    const d = have ? Math.hypot(sk.x - lx, sk.y - ly, sk.z - lz) : 0;
    if (!have || d > WARP) { count = 0; head = 0; odo = 0; chain = false; }
    else if (v.alive) odo += d;               // after a wipe-out the tracks that led there stay as they are
    have = true; lx = sk.x; ly = sk.y; lz = sk.z;

    // The skis point where the skier is going, so "right" is square to the velocity; and the
    // snow rises along it by the bank and the fall of the slope.
    let rX = sk.cs, rZ = sk.sn;
    const sp = Math.hypot(sk.vx, sk.vz);
    if (sp > 2) { rX = -sk.vz / sp; rZ = sk.vx / sp; }
    const rY = v.gb * (rX * sk.cs + rZ * sk.sn) - sk.sl * (rX * sk.sn - rZ * sk.cs);
    const carve = Math.min(1, Math.abs(v.carve));

    const on = v.onGround && v.alive && v.skierOn && !v.falling;
    if (!on) chain = false;
    else if (!chain) { commit(sk.x, sk.y, sk.z, odo, rX, rY, rZ, carve, 1); chain = true; }
    else {
      const gap = odo - sOdo, n = Math.floor(gap / STEP);
      if (n > 0) {
        const ax = sx, ay = sy, az = sz, ao = sOdo;
        for (let k = 1; k <= n; k++) {
          const t = (k * STEP) / gap;
          commit(ax + (sk.x - ax) * t, ay + (sk.y - ay) * t, az + (sk.z - az) * t, ao + k * STEP, rX, rY, rZ, carve, 0);
        }
      }
    }

    // Forget what has faded out, then lay the ribbon out relative to the camera.
    while (count > 0 && odo - od[(head - count + CAP) % CAP] > LEN + STEP) count--;
    const start = (head - count + CAP) % CAP;
    nSlots = 0;
    for (let i = 0; i < count; i++) {
      const j = (start + i) % CAP;
      const ends = brk[j] || (i + 1 < count ? brk[(j + 1) % CAP] : !chain);   // first or last of its strip
      const age = odo - od[j], t = Math.max(0, 1 - age / LEN);
      const a = ends ? 0 : Math.min(1, Math.max(0, (age - TAIL) / 0.9)) * t * (2 - t);
      put(nSlots++, px[j] - cam.x, py[j] - cam.y, pz[j] - cam.z, rx[j], ry[j], rz[j], cv[j], a);
    }
    // the live end, so the ribbon follows the skier smoothly instead of in sample-sized steps
    if (chain && count) put(nSlots++, sk.x - cam.x, sk.y - cam.y, sk.z - cam.z, rX, rY, rZ, carve, 0);
  }

  function tDraw(R) {
    if (nSlots < 2) return;
    const gl = R.gl;
    gl.useProgram(tProg.p);
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR);                       // multiply
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -2);
    gl.bindVertexArray(tVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, tBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts, 0, nSlots * 4 * VF);
    gl.drawElements(gl.TRIANGLES, (nSlots - 1) * 12, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  Gfx.layer({ name: 'tracks', order: 12, init: tInit, prepare: tPrepare, drawBlend: tDraw, reset: clear });

  // =================================================================== crystals in the air
  const CRYSTALS = 448;
  const SHUTTER = 0.008;        // seconds of travel a streak covers

  /* The box is 64 x 16 x 64 m (512 m, the wrap of uCamW, is a whole number of each) and rides
     ahead of the camera. Crystals fade toward its faces, so wrapping is never seen. */
  const DVS = `
uniform vec4 uMove;   // xyz: how far the air slid past the camera during the exposure, m.  w: amount
uniform vec3 uFwd;    // camera forward
out vec3 vK;
const vec3 BOX = vec3(64.0, 16.0, 64.0);
void main(){
  float id = float(gl_InstanceID);
  vec2 q = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 h = vec3(flHash(vec2(id, 1.7)), flHash(vec2(id, 5.3)), flHash(vec2(id, 9.1)));
  float k = flHash(vec2(id, 13.7)), g = flHash(vec2(id, 21.3)), rare = flHash(vec2(id, 33.1));
  float sp = uMisc.y, bo = uMisc.z;

  // home, drifting and settling slowly (0.16 m/s: a whole number of boxes in the hour uTime wraps at)
  vec3 w = h * BOX + vec3(sin(uTime * 0.31 + k * 40.0) * 0.5, -0.16 * uTime, cos(uTime * 0.27 + k * 23.0) * 0.5);
  vec3 c = uFwd * 22.0 + vec3(0.0, 4.0, 0.0);
  vec3 p = mod(w - uCamW.xyz - c + BOX * 0.5, BOX) - BOX * 0.5;
  vec3 e = abs(p) / (BOX * 0.5);
  float fade = (1.0 - smoothstep(0.7, 1.0, e.x)) * (1.0 - smoothstep(0.6, 1.0, e.y)) * (1.0 - smoothstep(0.7, 1.0, e.z));
  p += c;
  float dist = max(length(p), 1e-3);
  fade *= smoothstep(2.5, 7.0, dist) * (1.0 - smoothstep(18.0, 40.0, dist));
  // more of them the faster you go; each eases in rather than popping
  fade *= clamp((0.2 + 0.8 * smoothstep(0.0, 0.55, sp) + 0.3 * bo - g) * 6.0, 0.0, 1.0);

  // a streak along the way the air is passing, drawn as a ribbon facing the eye
  vec3 mv = uMove.xyz * (1.0 + 0.6 * bo);
  float len = length(mv);
  vec3 ax = len > 1e-4 ? mv / len : uCamU.xyz;
  vec3 view = p / dist;
  vec3 sd = cross(ax, view);
  float sl = length(sd);
  vec3 up = sl > 0.02 ? (ax - view * dot(view, ax)) / sl : uCamU.xyz;
  sd = sl > 0.02 ? sd / sl : uCamR.xyz;
  float r0 = mix(0.012, 0.028, k);
  float r = max(r0, dist * uView.w * 1.6 / uView.y);          // never thinner than most of a pixel: dimmer instead
  vec3 pos = p + ax * (q.y * len * 0.5) + up * (q.y * r) + sd * (q.x * r);

  float sun = pow(max(dot(view, uSun.xyz), 0.0), 3.0);         // the ones toward the sun flash brightest
  float tw = 0.65 + 0.35 * sin(uTime * (1.5 + 3.0 * h.x) + k * 50.0);
  float glint = step(0.85, rare) * (1.8 + 2.4 * sun);          // only a few are bright enough to bloom
  float i = (0.50 + 0.60 * k + glint) * (0.55 + 0.7 * sp + 0.5 * bo) * tw;
  vK = vec3(q, i * fade * sqrt(r0 / r) * uMove.w);
  gl_Position = uVP * vec4(pos, 1.0);
}`;
  const DFS = `
in vec3 vK; out vec4 o;
void main(){
  float a = 1.0 - vK.x * vK.x, b = 1.0 - vK.y * vK.y;
  o = vec4((uAmb.rgb + uSunCol.rgb) * 0.6 + uGlow.rgb * 0.4, 0.0) * (a * a * b * vK.z);
}`;

  let dProg, cHave = false, cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0, amount = 1;

  function dInit(R) { dProg = R.program('dust', DVS, DFS); }

  // The streaks follow what the camera really did (not the skier), so they shorten in slow
  // motion and stop when the camera stops.
  function dPrepare(R, v) {
    const cam = R.cam, raw = v.rawDt;
    const dx = cam.x - cx, dy = cam.y - cy, dz = cam.z - cz, d = Math.hypot(dx, dy, dz);
    if (cHave && raw > 1e-4 && d < WARP) {
      const k = 1 - Math.exp(-raw * 18), s = Math.min(1, 120 * raw / Math.max(d, 1e-6)) / raw;
      vx += (dx * s - vx) * k; vy += (dy * s - vy) * k; vz += (dz * s - vz) * k;
    } else if (!cHave || d >= WARP) { vx = vy = vz = 0; }
    cHave = true; cx = cam.x; cy = cam.y; cz = cam.z;
    amount = (v.mode === 'title' ? 0.7 : 1) * (v.calm ? 0.7 : 1);
  }

  function dDraw(R) {
    const gl = R.gl;
    gl.useProgram(dProg.p);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform4f(dProg.u.uMove, -vx * SHUTTER, -vy * SHUTTER, -vz * SHUTTER, amount);
    gl.uniform3f(dProg.u.uFwd, R.camF[0], R.camF[1], R.camF[2]);
    gl.bindVertexArray(R.emptyVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, R.notch >= 3 ? CRYSTALS >> 1 : CRYSTALS);
    gl.bindVertexArray(null);
  }

  Gfx.layer({ name: 'dust', order: 62, init: dInit, prepare: dPrepare, drawBlend: dDraw, reset() { cHave = false; } });
})(typeof window !== 'undefined' ? window : globalThis);
