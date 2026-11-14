/* Fall Line — powder. Spray off the skis that answers speed and how hard the skier is carving,
   bursts on landings, boosts, close calls and wipe-outs, and spindrift off an open lip.

   One pool of particles, one instanced draw of soft round sprites. Each sprite is shaded as a
   little ball of snow under the same sun as everything else: the sunward side goes white, the
   body keeps the blue of the shade, and that is what lets white spray read on white snow.

   Two kinds of motion share the pool. "Carried" particles live in the skier's moving frame and
   stream back on the apparent wind, so the plume trails beside and behind the skier at any
   speed instead of vanishing past the camera in a tenth of a second. "World" particles (a
   pine shedding snow, a crash) stay where they happened. Heights are kept above a ground
   plane, which also lets the shader fade a sprite out where it meets the snow.

   Other layers reach the pool through FL.Gfx.fx.puff(x, y, z, vx, vy, vz, amount). */
(function (root) {
  'use strict';
  const FL = root.FL, Gfx = FL.Gfx;
  const MAX = 900, IF = 10, rnd = Math.random;

  // ---------------------------------------------------------------- the pool (struct of arrays)
  const X = new Float64Array(MAX), Z = new Float64Array(MAX), GD = new Float64Array(MAX);   // world x, z; own ground plane offset
  const H = new Float32Array(MAX);                                                          // height above the ground plane
  const VX = new Float32Array(MAX), VH = new Float32Array(MAX), VZ = new Float32Array(MAX);
  const GX = new Float32Array(MAX), GZ = new Float32Array(MAX);                             // ground gradient (world particles)
  const AGE = new Float32Array(MAX), LIFE = new Float32Array(MAX);
  const S0 = new Float32Array(MAX), S1 = new Float32Array(MAX), AL = new Float32Array(MAX);
  const HARD = new Float32Array(MAX), GLINT = new Float32Array(MAX), SEED = new Float32Array(MAX), SQ = new Float32Array(MAX);
  const DRAG = new Float32Array(MAX), GRAV = new Float32Array(MAX), WN = new Float32Array(MAX), BNC = new Float32Array(MAX);
  const CAR = new Uint8Array(MAX);
  const ALL = [X, Z, GD, H, VX, VH, VZ, GX, GZ, AGE, LIFE, S0, S1, AL, HARD, GLINT, SEED, SQ, DRAG, GRAV, WN, BNC, CAR];
  const data = new Float32Array(MAX * IF);
  let n = 0, steal = 0, qK = 1;

  // The snow under the skier as a plane: carried particles ride it, new world particles copy it.
  const G = { x: 0, y: 0, z: 0, gx: 0, gz: 0, ok: false };

  // events wait here until the next frame, when the skier's position is fresh
  const PT = new Uint8Array(16), PA = new Float32Array(16);
  let pn = 0, passSide = 1, crashed = false;
  let accSpray = 0, accChip = 0, accLip = 0, accDrift = 0;
  let lvx = 0, lvz = 0;                                // the skier's last velocity while alive (for the wipe-out)

  function add(x, z, h, vx, vh, vz, life, s0, s1, alpha, carried) {
    let i;
    if (n < MAX) i = n++; else { steal = (steal + 37) % MAX; i = steal; }   // full: something old gives way
    X[i] = x; Z[i] = z; H[i] = h; VX[i] = vx; VH[i] = vh; VZ[i] = vz;
    AGE[i] = 0; LIFE[i] = life; S0[i] = s0; S1[i] = s1; AL[i] = alpha;
    CAR[i] = carried ? 1 : 0; WN[i] = carried ? 1 : 0;
    GX[i] = G.gx; GZ[i] = G.gz; GD[i] = G.y - G.gx * G.x - G.gz * G.z;
    HARD[i] = 0; GLINT[i] = 0; SQ[i] = 1; DRAG[i] = 1.8; GRAV[i] = 5; BNC[i] = 0; SEED[i] = rnd();
    return i;
  }

  /* Public: a soft burst of snow at a world position. amount ~1 is a small puff. Safe at any
     time, including before the layer has been initialised (the pool is plain arrays). */
  function puff(x, y, z, vx, vy, vz, amount) {
    if (!(amount > 0) || !(x === x && y === y && z === z)) return;
    const am = Math.min(amount, 4), cnt = Math.max(1, Math.round(am * 7 * qK)), sp = 0.25 + 0.2 * Math.sqrt(am);
    let fl = G.ok ? G.y + G.gx * (x - G.x) + G.gz * (z - G.z) : y - 3;     // best guess at the snow below it
    if (fl > y - 0.1) fl = y - 0.1; else if (fl < y - 14) fl = y - 14;
    vx = vx || 0; vy = vy || 0; vz = vz || 0;
    for (let j = 0; j < cnt; j++) {
      const px = x + (rnd() - 0.5) * 2 * sp, pz = z + (rnd() - 0.5) * 2 * sp;
      const i = add(px, pz, Math.max(0.05, y - fl + (rnd() - 0.5) * sp), vx + (rnd() - 0.5) * 1.6, vy + rnd() * 1.2 - 0.3, vz + (rnd() - 0.5) * 1.6,
        0.6 + 0.6 * rnd(), 0.16 + 0.12 * rnd(), 0.55 + 0.5 * rnd(), Math.min(0.5, 0.26 + 0.2 * am), false);
      GD[i] = fl - GX[i] * x - GZ[i] * z;
      DRAG[i] = 2.2; GRAV[i] = 4;
    }
  }
  Gfx.fx = { puff, count: () => n };                   // count: live particles, for tests and the stats line

  // ---------------------------------------------------------------- shaders
  const VS = `
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 iPos;   // xyz: centre, camera-relative.  w: radius
layout(location=2) in vec4 iA;     // alpha, height above the snow, hardness, glint
layout(location=3) in vec2 iB;     // seed, vertical squash
out vec2 vUV; out vec4 vP; out vec4 vFog; out vec3 vSunV; out vec2 vS;
void main(){
  vec3 back = cross(uCamR.xyz, uCamU.xyz);
  float dist = length(iPos.xyz);
  float a = iA.x * smoothstep(1.0, 3.6, dist);          // never a white-out as something passes the lens
  vec3 w = iPos.xyz + (uCamR.xyz * aPos.x + uCamU.xyz * (aPos.y * iB.y)) * iPos.w;
  // height of this corner above the snow, in units of the fade: the sprite melts into the
  // ground instead of being cut by it
  float hv = (iA.y + aPos.y * iB.y * iPos.w * uCamU.y) / max(iPos.w * iB.y * 0.55, 0.02);
  vUV = aPos; vP = vec4(a, hv, iA.z, iA.w);
  vS = vec2(iB.x, clamp(iA.y / 1.3, 0.0, 1.0));
  vSunV = vec3(dot(uSun.xyz, uCamR.xyz), dot(uSun.xyz, uCamU.xyz), dot(uSun.xyz, back));
  vFog = vec4(flAtmo(iPos.xyz / max(dist, 1e-3)), (1.0 - exp(-pow(dist * uFogP.x, uFogP.y))) * uFogP.z);
  gl_Position = a > 0.004 ? uVP * vec4(w, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
  const FS = `
in vec2 vUV; in vec4 vP; in vec4 vFog; in vec3 vSunV; in vec2 vS; out vec4 o;
void main(){
  float q = 1.0 - dot(vUV, vUV);
  if (q <= 0.0) discard;
  float den = mix(q * q, smoothstep(0.0, 0.35, q), vP.z);
  float a = vP.x * den * clamp(vP.y, 0.0, 1.0);
  // a ball of snow under the morning sun: white where it faces the sun and along its thin
  // back-lit edge, the blue of the shade through its body. Higher in the plume catches more.
  float d = dot(vec3(vUV, sqrt(q)), vSunV);
  float lit = clamp(d * 0.55 + 0.70 + vS.y * 0.28, 0.0, 1.0);
  float rim = (1.0 - q) * max(-vSunV.z, 0.0) * 0.3;
  vec3 col = uAmb.rgb + uSunCol.rgb * min(lit + rim, 1.0);
  // chips of ice: the only thing here allowed over 1.0, so only they bloom
  float tw = 0.5 + 0.5 * sin(uTime * 34.0 + vS.x * 90.0);
  col = mix(col, vec3(0.70, 0.93, 1.0) * (1.1 + 2.7 * tw * tw), vP.w);
  col = mix(col, vFog.rgb, vFog.a);
  o = vec4(col * a, a);
}`;

  let prog = null, vao = null, buf = null;
  function init(R) {
    const gl = R.gl;
    prog = R.program('snowfx', VS, FS);
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    R.buffer(Gfx.QUAD); R.attr(0, 2, 2, 0);
    buf = R.buffer(data.byteLength, gl.DYNAMIC_DRAW);
    R.attr(1, 4, IF, 0, 1); R.attr(2, 4, IF, 4, 1); R.attr(3, 2, IF, 8, 1);
    gl.bindVertexArray(null);
  }

  // ---------------------------------------------------------------- bursts
  // 1 land, 2 boost, 3 close call, 4 wipe-out, 5 over the edge.  (hx, hz): unit heading; (rx, rz): its right.
  function burst(code, a, R, v, hx, hz, rx, rz) {
    const sk = R.skier, calm = v.calm ? 0.55 : 1;
    if (code === 1) {                                   // touch-down: a ring of snow kicked out from under the skis
      const k = Math.min(1.5, 0.45 + a / 9), cnt = Math.round(Math.min(64, 10 + a * 4) * calm * qK);
      for (let j = 0; j < cnt; j++) {
        const an = rnd() * 6.283, sp = (1.4 + 3.4 * rnd()) * k;
        add(sk.x + Math.cos(an) * 0.3, sk.z + Math.sin(an) * 0.3, 0.08, Math.cos(an) * sp, (0.7 + 2.3 * rnd()) * k, Math.sin(an) * sp,
          0.5 + 0.45 * rnd(), 0.15 + 0.08 * rnd(), 0.55 + 0.55 * rnd() * k, 0.42, true);
      }
    } else if (code === 2) {                            // ice strip: a kick of snow and a scatter of sparkling chips
      const cs = Math.round(18 * qK), cc = Math.round(26 * qK * calm);
      for (let j = 0; j < cs; j++) {
        const lat = (rnd() - 0.5) * 5;
        add(sk.x + rx * lat * 0.12, sk.z + rz * lat * 0.12, 0.08, rx * lat - hx * rnd() * 2, 0.8 + 2.4 * rnd(), rz * lat - hz * rnd() * 2,
          0.45 + 0.4 * rnd(), 0.14, 0.5 + 0.45 * rnd(), 0.4, true);
      }
      for (let j = 0; j < cc; j++) chip(sk, hx, hz, rx, rz, 1);
    } else if (code === 3) {                            // a close call: a quick puff on the side it happened
      const cnt = Math.round(14 * qK);
      for (let j = 0; j < cnt; j++) {
        const lat = a * (0.45 + 0.5 * rnd()), al = rnd() * 1.2 - 0.6;
        add(sk.x + rx * lat + hx * al, sk.z + rz * lat + hz * al, 0.15 + 0.5 * rnd(), rx * a * (0.5 + 2 * rnd()), 0.8 + 2 * rnd(), rz * a * (0.5 + 2 * rnd()),
          0.4 + 0.35 * rnd(), 0.14, 0.5 + 0.4 * rnd(), 0.4, true);
      }
    } else if (code === 4) {                            // wipe-out: the snow explodes, a few lumps tumble out of it
      let bx = sk.vx, bz = sk.vz;
      if (Math.hypot(bx, bz) < 3) { bx = lvx; bz = lvz; }
      const cnt = Math.round((v.calm ? 46 : 110) * qK), lumps = v.calm ? 5 : 14;
      for (let j = 0; j < cnt; j++) {
        const an = rnd() * 6.283, sp = (1.2 + 5.2 * rnd()) * calm, carry = 0.12 + 0.34 * rnd();
        const i = add(sk.x + Math.cos(an) * 0.4, sk.z + Math.sin(an) * 0.4, 0.2 + 0.9 * rnd(), bx * carry + Math.cos(an) * sp, (1.2 + 5.6 * rnd()) * calm, bz * carry + Math.sin(an) * sp,
          0.8 + 0.9 * rnd(), 0.24 + 0.16 * rnd(), (0.95 + 0.85 * rnd()) * (v.calm ? 0.75 : 1), 0.52, false);
        DRAG[i] = 1.7; GRAV[i] = 4.2;
      }
      for (let j = 0; j < lumps; j++) {
        const an = rnd() * 6.283, sp = 2 + 5 * rnd(), carry = 0.25 + 0.4 * rnd(), s = 0.06 + 0.09 * rnd();
        const i = add(sk.x, sk.z, 0.4 + 0.6 * rnd(), bx * carry + Math.cos(an) * sp, 3 + 5 * rnd(), bz * carry + Math.sin(an) * sp, 1 + 0.8 * rnd(), s, s, 1, false);
        HARD[i] = 0.85; DRAG[i] = 0.3; GRAV[i] = 9.8; BNC[i] = 0.35;
      }
    } else if (code === 5) {                            // over the lip: the last of the snow goes with them
      const cnt = Math.round(26 * qK);
      for (let j = 0; j < cnt; j++) {
        const i = add(sk.x + (rnd() - 0.5) * 0.8, sk.z + (rnd() - 0.5) * 0.8, 0.1 + 0.4 * rnd(), sk.vx * 0.5 + (rnd() - 0.5) * 3, 0.8 + 2 * rnd(), sk.vz * 0.5 + (rnd() - 0.5) * 3,
          0.7 + 0.5 * rnd(), 0.18, 0.7 + 0.5 * rnd(), 0.42, false);
        GD[i] -= 25; H[i] += 25; GRAV[i] = 3;           // nothing under it: let it fall away
      }
    }
  }

  // one sparkling chip of ice thrown up from the skis; k scales how hard
  function chip(sk, hx, hz, rx, rz, k) {
    const lat = (rnd() - 0.5) * 7 * k, fw = rnd() * 3 * k, s = 0.03 + 0.035 * rnd();
    const i = add(sk.x + rx * lat * 0.08 - hx * rnd() * 0.8, sk.z + rz * lat * 0.08 - hz * rnd() * 0.8, 0.06, rx * lat + hx * fw, (1.2 + 3.6 * rnd()) * k, rz * lat + hz * fw,
      0.45 + 0.5 * rnd(), s, s, 1, true);
    HARD[i] = 1; GLINT[i] = 1; DRAG[i] = 1; GRAV[i] = 8; WN[i] = 0.7; BNC[i] = 0.4;
  }

  // ---------------------------------------------------------------- per frame
  function prepare(R, v, dt) {
    const sk = R.skier, cam = R.cam;
    if (!(dt > 0)) dt = 0; else if (dt > 0.05) dt = 0.05;
    qK = R.notch >= 3 ? 0.5 : 1;
    const alive = v.alive && v.mode !== 'dead', u = alive ? v.u : 0, vo = alive ? v.vo : 0;
    const cs = sk.cs, sn = sk.sn;
    let hx = sn * u + cs * vo, hz = -cs * u + sn * vo;
    const hl = Math.hypot(hx, hz);
    if (hl > 1) { hx /= hl; hz /= hl; } else { hx = sn; hz = -cs; }
    const rx = -hz, rz = hx;
    if (alive) { lvx = sk.vx; lvz = sk.vz; }

    // the snow under the skier
    G.x = sk.x; G.z = sk.z;
    if (v.onGround) { G.y = sk.y; G.gx = -sk.sl * sn + v.gb * cs; G.gz = sk.sl * cs + v.gb * sn; }
    else if (v.hAbove < 40 && !v.falling) G.y = sk.y - v.hAbove;
    else if (alive) G.y += (G.gx * sk.vx + G.gz * sk.vz) * dt;
    G.ok = true;

    // ---- move what is alive
    /* Carried particles ride along with the skier (all of the forward motion, most of the
       sideways, so a carve leaves its spray out where it was thrown) and relax toward the
       apparent wind, which streams them back. */
    const cdx = (sn * u + cs * vo * 0.6) * dt, cdz = (-cs * u + sn * vo * 0.6) * dt;
    const wind = alive ? 4 + u * 0.14 : 0, wx = -hx * wind, wz = -hz * wind;
    for (let i = 0; i < n;) {
      const age = AGE[i] + dt;
      if (age >= LIFE[i]) {
        n--;
        if (i !== n) for (let a = 0; a < ALL.length; a++) ALL[a][i] = ALL[a][n];
        continue;
      }
      AGE[i] = age;
      const k = 1 - Math.exp(-DRAG[i] * dt), w = WN[i];
      VX[i] += (wx * w - VX[i]) * k; VZ[i] += (wz * w - VZ[i]) * k;
      VH[i] -= GRAV[i] * dt + VH[i] * k * 0.6;
      X[i] += VX[i] * dt; Z[i] += VZ[i] * dt; H[i] += VH[i] * dt;
      if (CAR[i]) { X[i] += cdx; Z[i] += cdz; }
      i++;
    }

    // ---- events since the last frame
    if (pn > 3) pn = 0;                                 // a fast-forward queued a pile of them: stale, except a wipe-out
    for (let j = 0; j < pn; j++) burst(PT[j], PA[j], R, v, hx, hz, rx, rz);
    pn = 0;
    // the wipe-out is read from the state, not the event, so it cannot be missed or doubled
    if (v.alive) crashed = false;
    else if (!crashed) { crashed = true; if (v.cause === 'crash' && v.deadT < 0.6) burst(4, 0, R, v, hx, hz, rx, rz); }

    // ---- steady emission, by time so 60 and 120 Hz get the same snow
    if (alive && v.skierOn && v.onGround && u > 6 && dt > 0) {
      const carve = v.carve || 0, k = Math.min(1, Math.abs(carve)), pw = Math.pow(k, 1.3);
      const sp = Math.max(0.55, Math.min(1.45, u / 38));
      // spray off the skis: a mist when running straight, a rooster tail in a hard carve
      accSpray += Math.min(640, 500 * Math.min(u / 45, 1.6) * (0.15 + pw)) * qK * dt;
      let m = 0;
      while (accSpray >= 1 && m++ < 48) {
        accSpray -= 1;
        const side = k > 0.1 ? (carve > 0 ? -1 : 1) : (rnd() < 0.5 ? -1 : 1);       // thrown to the outside of the turn
        const along = 0.2 - 1.1 * rnd(), lat = side * (0.08 + 0.26 * rnd()), thr = 0.35 + 0.65 * rnd();
        const out = side * (0.8 + 4.6 * pw * thr) * sp + (rnd() - 0.5) * 1.3, back = rnd() * 1.6;
        const up = (0.5 + 5.4 * pw * thr * (0.5 + 0.5 * rnd())) * Math.min(sp, 1.25);
        const i = add(sk.x + hx * along + rx * lat, sk.z + hz * along + rz * lat, 0.05, rx * out - hx * back, up, rz * out - hz * back,
          0.34 + 0.34 * rnd() + 0.22 * pw, 0.1 + 0.07 * rnd(), 0.28 + 0.36 * rnd() + 0.22 * pw, (0.36 + 0.36 * pw) * (qK < 1 ? 1.2 : 1), true);
        GRAV[i] = 6.5;
        const pre = rnd() * dt;                          // spread births across the frame
        AGE[i] = pre; X[i] += VX[i] * pre; Z[i] += VZ[i] * pre; H[i] += VH[i] * pre;
      }
      if (accSpray > 1) accSpray = 0;
      // on a boost the skis keep shedding sparks of ice
      if (v.boost > 0) {
        accChip += 46 * Math.min(1, v.boost / 6) * qK * dt;
        while (accChip >= 1) { accChip -= 1; chip(sk, hx, hz, rx, rz, 0.55); }
      }
      // spindrift: wisps blown off the lip when riding right along an edge
      if (v.edge < 0.6) {
        const es = v.edgeSide < 0 ? -1 : 1;
        accLip += 110 * (1 - Math.max(0, v.edge) / 0.6) * Math.min(1, u / 30) * qK * dt;
        while (accLip >= 1) {
          accLip -= 1;
          const lat = es * (Math.max(0, v.edge) + 0.3 * rnd()), al = rnd() * 3 - 1.8, o = es * (0.7 + 1.9 * rnd());
          const i = add(sk.x + cs * lat + hx * al, sk.z + sn * lat + hz * al, 0.05 + 0.2 * rnd(), cs * o, 0.3 + 0.9 * rnd(), sn * o,
            0.5 + 0.4 * rnd(), 0.12, 0.5 + 0.4 * rnd(), 0.3, true);
          SQ[i] = 0.6; GRAV[i] = 1.4; DRAG[i] = 2.5;
        }
      }
      // at real speed, low drift scuds across the snow around the skier
      if (u > 42 && v.edge > 1) {
        accDrift += 40 * Math.min(1, (u - 42) / 25) * qK * dt;
        while (accDrift >= 1) {
          accDrift -= 1;
          const al = 3 + 12 * rnd(), lat = (rnd() * 2 - 1) * Math.min(4.5, v.edge - 0.5);
          const i = add(sk.x + hx * al + cs * lat, sk.z + hz * al + sn * lat, 0.05, 1.8 + rnd(), 0.15, 0.6, 0.3 + 0.25 * rnd(), 0.3, 0.75 + 0.3 * rnd(), 0.15, false);
          SQ[i] = 0.34; GRAV[i] = 0.4; DRAG[i] = 0.8;
        }
      }
    } else { accSpray = 0; accChip = 0; accLip = 0; accDrift = 0; }

    // ---- fill the instance buffer, camera-relative
    const cx = cam.x, cy = cam.y, cz = cam.z, Gy = G.y, Gx = G.x, Gz = G.z, ggx = G.gx, ggz = G.gz;
    for (let i = 0, j = 0; i < n; i++, j += IF) {
      const age = AGE[i], g = 1 - age / LIFE[i], size = S0[i] + (S1[i] - S0[i]) * (1 - g * g), hard = HARD[i];
      // rest on the snow rather than sink into it; lumps and chips bounce
      const hmin = size * SQ[i] * (hard > 0.5 ? 0.7 : 0.3);
      if (H[i] < hmin) {
        H[i] = hmin;
        if (VH[i] < 0) { VH[i] = -VH[i] * BNC[i]; if (hard > 0.5) { VX[i] *= 0.7; VZ[i] *= 0.7; } }
      }
      const x = X[i], z = Z[i];
      const fl = CAR[i] ? Gy + ggx * (x - Gx) + ggz * (z - Gz) : GD[i] + GX[i] * x + GZ[i] * z;
      data[j] = x - cx; data[j + 1] = fl + H[i] - cy; data[j + 2] = z - cz; data[j + 3] = size;
      data[j + 4] = AL[i] * (hard > 0.5 ? Math.min(1, g * 5) : g * Math.sqrt(g) * Math.min(1, 0.25 + age * 22));
      data[j + 5] = H[i]; data[j + 6] = hard; data[j + 7] = GLINT[i];
      data[j + 8] = SEED[i]; data[j + 9] = SQ[i];
    }
  }

  function drawBlend(R) {
    if (!n || !prog) return;
    const gl = R.gl;
    gl.useProgram(prog.p);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * IF);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    gl.bindVertexArray(null);
  }

  function onEvent(R, e) {
    const t = e.type;
    let code = 0, a = 0;
    if (t === 'pass') { passSide = e.side < 0 ? -1 : 1; return; }
    if (t === 'land') { code = 1; a = Math.abs(e.v) || 0; }
    else if (t === 'boost') code = 2;
    else if (t === 'flow') { if (e.why !== 'near') return; code = 3; a = passSide; }
    else if (t === 'fall') code = 5;
    else return;
    if (pn < 16) { PT[pn] = code; PA[pn] = a; pn++; }
  }

  function reset() { n = 0; pn = 0; crashed = false; accSpray = accChip = accLip = accDrift = 0; lvx = lvz = 0; G.ok = false; }

  Gfx.layer({ name: 'snowfx', order: 60, init, prepare, drawBlend, onEvent, reset });
})(typeof window !== 'undefined' ? window : globalThis);
