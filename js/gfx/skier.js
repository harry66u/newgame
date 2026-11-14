/* Fall Line — the skier. A low-poly figure built from 22 tapered boxes in one instanced draw:
   two skis with tips, boots, legs, hips, torso, arms, mitts, helmet with a goggle band, poles.
   Posed on the CPU every frame: a handful of pose numbers (hip height, spine pitch, where the
   hands go) are blended between stances, the limbs are solved with two-bone IK, and everything
   is eased with critically damped springs so it is the same at any frame rate.
   Body space: x right, y up (the snow's normal), z forward (where the skis point). */
(function (root) {
  'use strict';
  const FL = root.FL, U = FL.U, Look = FL.Look, Gfx = FL.Gfx, COL = Look.COL;
  const { clamp, smooth } = U;

  const NP = 22, ST = 16;                              // parts; floats per part: centre3, axisX3, axisY3, axisZ3, colour3, taper
  const LEAN = 0.61;                                   // 35 degrees at full carve
  const SHIN = 0.40, THIGH = 0.42, UARM = 0.29, FARM = 0.27;
  // part slots: 0-3 skis and tips, 4-5 poles (the gear that comes off), then per side from 6:
  // boot, shin, thigh, upper arm, forearm, mitt; 18 hips, 19 torso, 20 helmet, 21 goggle band
  const data = new Float32Array(NP * ST);

  // pose numbers: hip height, hip fore/aft, spine pitch, hand out / up / forward of the shoulder,
  // pole direction (side, up, forward), half stance, how far the head follows the spine, elbows out
  const SKI = new Float32Array([0.70, -0.08, 0.55, 0.24, -0.30, 0.34, 0.28, -0.42, -0.86, 0.17, 0.40, 0.75]);
  const TUCK = new Float32Array([0.50, -0.20, 1.18, -0.14, -0.10, 0.42, 0.10, 0.10, -1.0, 0.15, 0.20, 0.25]);
  const TITLE = new Float32Array([0.87, -0.02, 0.10, 0.12, -0.50, 0.16, 0.10, -1.0, 0.20, 0.15, 0.15, 0.40]);
  const AIR = new Float32Array([0.52, -0.04, 0.42, 0.40, -0.02, 0.10, 0.50, -0.20, -0.80, 0.19, 0.30, 0.60]);
  const P = new Float32Array(12);

  // springs: 0 lean, 1 carve heading, 2 tuck, 3 air, 4 flail, 5 landing compression, 6 title
  const SX = new Float32Array(8), SV = new Float32Array(8);
  function spring(i, target, w, dt) {
    const f = 1 + 2 * dt * w, hoo = dt * w * w, hhoo = dt * hoo, di = 1 / (f + hhoo), x = SX[i], vv = SV[i];
    SX[i] = (f * x + dt * vv + hhoo * target) * di;
    SV[i] = (vv + hoo * (target - x)) * di;
  }

  // ---- body space -> anchor-relative world ------------------------------------------------------
  let aX = 0, aY = 0, aZ = 0;                          // anchor in the world (doubles): the feet, or where the crash began
  let oX = 0, oY = 0, oZ = 0;                          // body origin relative to the anchor
  let Rx = 1, Ry = 0, Rz = 0, Ux = 0, Uy = 1, Uz = 0, Fx = 0, Fy = 0, Fz = -1;
  let gradX = 0, gradZ = 0;                            // slope of the snow under the skier (dy/dx, dy/dz)

  function setBasis(h, sk, bank, k) {
    const cs = Math.cos(h), sn = Math.sin(h);
    gradX = -sk.sl * sk.sn + bank * sk.cs; gradZ = sk.sl * sk.cs + bank * sk.sn;
    let fy = (gradX * sn - gradZ * cs) * k, ry = (gradX * cs + gradZ * sn) * k;
    let l = 1 / Math.hypot(1, fy); Fx = sn * l; Fy = fy * l; Fz = -cs * l;
    l = 1 / Math.hypot(1, ry); Rx = cs * l; Ry = ry * l; Rz = sn * l;
    Ux = Ry * Fz - Rz * Fy; Uy = Rz * Fx - Rx * Fz; Uz = Rx * Fy - Ry * Fx;
    l = 1 / Math.hypot(Ux, Uy, Uz); Ux *= l; Uy *= l; Uz *= l;
    Rx = Fy * Uz - Fz * Uy; Ry = Fz * Ux - Fx * Uz; Rz = Fx * Uy - Fy * Ux;
  }

  function put(i, cx, cy, cz, ax, ay, az, bx, by, bz, dx, dy, dz, col, taper) {
    const j = i * ST;
    data[j] = oX + Rx * cx + Ux * cy + Fx * cz; data[j + 1] = oY + Ry * cx + Uy * cy + Fy * cz; data[j + 2] = oZ + Rz * cx + Uz * cy + Fz * cz;
    data[j + 3] = Rx * ax + Ux * ay + Fx * az; data[j + 4] = Ry * ax + Uy * ay + Fy * az; data[j + 5] = Rz * ax + Uz * ay + Fz * az;
    data[j + 6] = Rx * bx + Ux * by + Fx * bz; data[j + 7] = Ry * bx + Uy * by + Fy * bz; data[j + 8] = Rz * bx + Uz * by + Fz * bz;
    data[j + 9] = Rx * dx + Ux * dy + Fx * dz; data[j + 10] = Ry * dx + Uy * dy + Fy * dz; data[j + 11] = Rz * dx + Uz * dy + Fz * dz;
    data[j + 12] = col[0]; data[j + 13] = col[1]; data[j + 14] = col[2]; data[j + 15] = taper;
  }

  // A prism from a to b, hw wide along the hint direction and hd deep, narrowing by `taper` at b.
  function bone(i, ax, ay, az, bx, by, bz, hw, hd, hx, hy, hz, col, taper) {
    let yx = bx - ax, yy = by - ay, yz = bz - az;
    const L = Math.hypot(yx, yy, yz) || 1e-4;
    yx /= L; yy /= L; yz /= L;
    let d = hx * yx + hy * yy + hz * yz, xx = hx - d * yx, xy = hy - d * yy, xz = hz - d * yz, xl = Math.hypot(xx, xy, xz);
    if (xl < 0.05) {                                    // hint runs along the bone: any square-on axis will do
      if (Math.abs(yz) < 0.9) { xx = -yz * yx; xy = -yz * yy; xz = 1 - yz * yz; } else { xx = -yy * yx; xy = 1 - yy * yy; xz = -yy * yz; }
      xl = Math.hypot(xx, xy, xz);
    }
    xx /= xl; xy /= xl; xz /= xl;
    const zx = xy * yz - xz * yy, zy = xz * yx - xx * yz, zz = xx * yy - xy * yx, hl = L * 0.5;
    put(i, (ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5, xx * hw, xy * hw, xz * hw, yx * hl, yy * hl, yz * hl, zx * hd, zy * hd, zz * hd, col, taper);
  }

  // Two-bone IK from a toward b: the joint lands in (jx,jy,jz), bent toward the hint; the end
  // actually reached (b, or as far as the limb stretches) in (ex,ey,ez).
  let jx = 0, jy = 0, jz = 0, ex = 0, ey = 0, ez = 0;
  function ik(ax, ay, az, bx, by, bz, l1, l2, hx, hy, hz) {
    let dx = bx - ax, dy = by - ay, dz = bz - az, d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) { dx = 0; dy = -1; dz = 0; d = 1; }
    dx /= d; dy /= d; dz /= d;
    d = clamp(d, Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.985);
    ex = ax + dx * d; ey = ay + dy * d; ez = az + dz * d;
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const p = hx * dx + hy * dy + hz * dz;
    let px = hx - p * dx, py = hy - p * dy, pz = hz - p * dz, pl = Math.hypot(px, py, pz);
    if (pl < 1e-4) { px = 0; py = 0; pz = 1; pl = 1; }
    jx = ax + dx * a + px * h / pl; jy = ay + dy * a + py * h / pl; jz = az + dz * a + pz * h / pl;
  }

  /* Build every part from the blended pose numbers in P.
     lean: radians into the turn (+ right). wTuck, wFl: 0..1. tb: radians to stand back upright
     against the slope (title). br: breathing -1..1. gear: also emit skis and poles. */
  function pose(lean, wTuck, wFl, tb, br, comp, gear, t) {
    const c = clamp(lean / LEAN, -1, 1), ac = Math.abs(c), kArm = 1 - 0.8 * wTuck;
    const aL = lean * 1.08, e = lean * 0.9, se = Math.sin(e), ce = Math.cos(e);
    // hips: inside the turn and a little lower; the legs follow by IK, long outside, short inside
    const hipH = Math.max(0.42, P[0] - 0.05 * ac * (1 - wTuck) + br * 0.006 - comp);
    const hx = Math.sin(aL) * hipH * 0.95, hy = Math.cos(aL) * Math.cos(tb) * hipH, hz = P[1] - Math.sin(tb) * hipH;
    const pr = lean * 0.7, pxx = Math.cos(pr), pxy = -Math.sin(pr);
    // spine: pitched forward, rolled much less than the legs so the shoulders stay nearer level
    const th = P[2] - tb + 0.06 * ac + comp * 1.3 + br * 0.015 + wFl * 0.3 * Math.sin(t * 6.3);
    const rho = lean * 0.35, cth = Math.cos(th);
    const sx = Math.sin(rho) * cth, sy = Math.cos(rho) * cth, sz = Math.sin(th);
    let tx = Math.cos(rho), ty = -Math.sin(rho), tz = c * 0.22;             // shoulder line, turned to face down the hill
    const tl = 1 / Math.hypot(tx, ty, tz); tx *= tl; ty *= tl; tz *= tl;
    const scx = hx + sx * 0.5, scy = hy + sy * 0.5, scz = hz + sz * 0.5;
    const st = P[9] + 0.07 * ac, lift = Math.abs(se) * 0.05;

    for (let s = 0; s < 2; s++) {
      const sd = s ? 1 : -1, b = 6 + s * 6;
      // feet: outside ski a little ahead; kicking when they have gone off an edge
      const fx = sd * st, fy = lift + wFl * (0.1 + 0.1 * sd * Math.sin(t * 7.1));
      const fz = -sd * c * 0.09 + wFl * 0.2 * Math.sin(t * 9 + sd * 1.4);
      if (gear) {
        bone(s * 2, fx, fy + 0.016, fz - 0.70, fx, fy + 0.016, fz + 0.84, 0.06, 0.016, ce, -se, 0, COL.skis, 0.85);
        bone(s * 2 + 1, fx, fy + 0.016, fz + 0.84, fx, fy + 0.085, fz + 1.0, 0.051, 0.014, ce, -se, 0, COL.skis, 0.5);
      }
      bone(b, fx + se * 0.03, fy + ce * 0.03, fz + 0.03, fx + se * 0.22, fy + ce * 0.22, fz + 0.03, 0.065, 0.135, ce, -se, 0, COL.glove, 0.8);
      // leg: solved up from the ankle so any shortfall hides inside the hips
      ik(fx + se * 0.14, fy + ce * 0.14, fz, hx + sd * 0.10 * pxx, hy + sd * 0.10 * pxy, hz, SHIN, THIGH, c * 0.6 - sd * 0.04, 0.1, 1);
      const knx = jx, kny = jy, knz = jz;
      bone(b + 1, knx, kny, knz, fx + se * 0.18, fy + ce * 0.18, fz, 0.072, 0.082, pxx, pxy, 0, COL.pants, 0.8);
      bone(b + 2, ex, ey, ez, knx, kny, knz, 0.088, 0.098, pxx, pxy, 0, COL.pants, 0.82);
      // arm: inside hand reaches for the snow, outside arm out and up for balance
      const shx = scx - sx * 0.05 + sd * 0.2 * tx, shy = scy - sy * 0.05 + sd * 0.2 * ty, shz = scz - sz * 0.05 + sd * 0.2 * tz;
      const ins = sd * c > 0 ? ac * kArm : 0, out = sd * c < 0 ? ac * kArm : 0;
      const Hx = shx + sd * (P[3] + ins * 0.14 + out * 0.2 + wFl * 0.15);
      let Hy = shy + P[4];
      Hy += (0.14 - Hy) * ins * 0.75;
      Hy += out * 0.12 + br * 0.008 + wFl * (0.25 + 0.3 * Math.sin(t * 12 + sd * 1.3));
      const Hz = shz + P[5] + out * 0.06 - ins * 0.04 + wFl * 0.25 * Math.cos(t * 10 + sd);
      ik(shx, shy, shz, Hx, Hy, Hz, UARM, FARM, sd * P[11], -0.7, -0.5);
      const elx = jx, ely = jy, elz = jz, hax = ex, hay = ey, haz = ez;
      bone(b + 3, shx, shy, shz, elx, ely, elz, 0.068, 0.068, tx, ty, tz, COL.jacket, 0.85);
      bone(b + 4, elx, ely, elz, hax, hay, haz, 0.058, 0.058, tx, ty, tz, COL.jacket, 0.85);
      let ux = hax - elx, uy = hay - ely, uz = haz - elz;
      const ul = 1 / (Math.hypot(ux, uy, uz) || 1); ux *= ul; uy *= ul; uz *= ul;
      bone(b + 5, hax - ux * 0.01, hay - uy * 0.01, haz - uz * 0.01, hax + ux * 0.13, hay + uy * 0.13, haz + uz * 0.13, 0.06, 0.065, tx, ty, tz, COL.glove, 0.9);
      if (gear) {
        let dx = sd * P[6], dy = P[7], dz = P[8];
        const dl = 1 / Math.hypot(dx, dy, dz), len = 1.08; dx *= dl; dy *= dl; dz *= dl;
        const gx = hax + ux * 0.06, gy = hay + uy * 0.06, gz = haz + uz * 0.06;
        if (gy + dy * len < 0.02) {                     // the tip rests on the snow instead of going through it
          const ny = Math.max(-1, (0.02 - gy) / len), k = Math.sqrt(Math.max(0, 1 - ny * ny)) / (Math.hypot(dx, dz) || 1e-4);
          dx *= k; dz *= k; dy = ny;
        }
        bone(4 + s, gx - dx * 0.1, gy - dy * 0.1, gz - dz * 0.1, gx + dx * len, gy + dy * len, gz + dz * len, 0.015, 0.015, 1, 0, 0, COL.glove, 0.6);
      }
    }
    bone(18, hx + pxy * 0.10, hy - pxx * 0.10, hz, hx - pxy * 0.08, hy + pxx * 0.08, hz, 0.17, 0.12, pxx, pxy, 0, COL.pants, 1);
    bone(19, scx, scy, scz, hx + sx * 0.02, hy + sy * 0.02, hz + sz * 0.02, 0.21, 0.125, tx, ty, tz, COL.jacket, 0.8);
    // head: held up to look down the hill rather than following the spine
    const hw = P[10];
    let ux = sx * hw + Math.sin(rho * 0.5) * (1 - hw), uy = sy * hw + (1 - hw), uz = sz * hw;
    const ul = 1 / Math.hypot(ux, uy, uz); ux *= ul; uy *= ul; uz *= ul;
    const cx = scx + sx * 0.03 + ux * 0.15, cy = scy + sy * 0.03 + uy * 0.15, cz = scz + sz * 0.03 + uz * 0.15;
    bone(20, cx - ux * 0.125, cy - uy * 0.125, cz - uz * 0.125, cx + ux * 0.125, cy + uy * 0.125, cz + uz * 0.125, 0.12, 0.132, tx, ty, 0, COL.helmet, 0.8);
    bone(21, cx, cy, cz + 0.012, cx + ux * 0.07, cy + uy * 0.07, cz + uz * 0.07 + 0.012, 0.128, 0.14, tx, ty, 0, COL.goggles, 0.9);
  }

  // ---- animation state --------------------------------------------------------------------------
  let fresh = true, clock = 0, count = 0, scale = 1;

  function animate(v, dt) {
    const title = v.mode === 'title', air = !v.onGround && v.air > 0.08, ac = Math.abs(v.carve);
    const leanT = title ? 0 : v.carve * LEAN * (air ? 0.4 : 1);
    const headT = title ? 0 : clamp(Math.atan2(v.vo, Math.max(v.u, 6)) * 1.6, -0.6, 0.6);
    let tuckT = 0;
    if (v.mode === 'run' && v.onGround && !v.falling) {
      tuckT = v.boost > 0 ? 1 - 0.45 * ac : v.inp === 0 ? clamp(1 - ac * 4, 0, 1) * clamp((v.u - 24) / 8, 0, 1) : 0;
    }
    const airT = air && !title ? 1 : 0, flT = v.falling ? 1 : 0, titT = title ? 1 : 0;
    if (fresh) {
      fresh = false; SV.fill(0);
      SX[0] = leanT; SX[1] = headT; SX[2] = tuckT; SX[3] = airT; SX[4] = flT; SX[5] = 0; SX[6] = titT;
      return;
    }
    spring(0, leanT, 26, dt);                           // v.carve is already eased: stay tight to it
    spring(1, headT, 15, dt);
    spring(2, tuckT, tuckT > SX[2] ? 6 : 13, dt);       // settle into the tuck, snap out of it to turn
    spring(3, airT, 13, dt);
    spring(4, flT, 9, dt);
    spring(5, 0, 14, dt);
    spring(6, titT, 5, dt);
  }

  // Pose the live skier at R.skier.
  function build(R, v) {
    const sk = R.skier;
    const wTuck = clamp(SX[2], 0, 1), wFl = clamp(SX[4], 0, 1), wAir = clamp(Math.max(SX[3], wFl), 0, 1), wTit = clamp(SX[6], 0, 1);
    setBasis(sk.yaw + SX[1], sk, v.gb * (1 - wAir), 1 - 0.75 * wAir);
    aX = sk.x; aY = sk.y; aZ = sk.z; oX = oY = oZ = 0;
    for (let i = 0; i < 12; i++) {
      let p = SKI[i] + (TUCK[i] - SKI[i]) * wTuck;
      p += (AIR[i] - p) * wAir;
      P[i] = p + (TITLE[i] - p) * wTit;
    }
    // standing still they are upright against gravity, not square to the slope
    pose(SX[0], wTuck, wFl, wTit * Math.asin(clamp(-Fy, -0.7, 0.7)), wTit * Math.sin(clock * 1.7), Math.max(0, SX[5]), true, clock);
  }

  // ---- the yard sale ----------------------------------------------------------------------------
  // The body tumbles on as one flailing figure; skis and poles come off and spin away on their own.
  let pend = false, crashOn = false, crashT = 0, crashN = 0, gY0 = 0, gGX = 0, gGZ = 0, flailK = 1;
  const BD = new Float32Array(18);                     // body: centre, velocity, spin, basis (right, up, forward)
  const GR = new Float32Array(4 * 9);                  // loose gear, per group: position, velocity, spin
  const LP = new Float32Array(6 * ST);                 // gear parts relative to their group
  const GI = new Uint8Array([0, 0, 1, 1, 2, 3]), G0 = new Uint8Array([0, 2, 4, 5]);
  const G = 15;

  let rkx = 0, rky = 1, rkz = 0, rc = 1, rs = 0;
  function setRot(wx, wy, wz, dt) {
    const w = Math.hypot(wx, wy, wz);
    if (w < 1e-6) { rc = 1; rs = 0; return; }
    rkx = wx / w; rky = wy / w; rkz = wz / w; rc = Math.cos(w * dt); rs = Math.sin(w * dt);
  }
  function rot(a, o) {
    const x = a[o], y = a[o + 1], z = a[o + 2], d = (rkx * x + rky * y + rkz * z) * (1 - rc);
    a[o] = x * rc + (rky * z - rkz * y) * rs + rkx * d;
    a[o + 1] = y * rc + (rkz * x - rkx * z) * rs + rky * d;
    a[o + 2] = z * rc + (rkx * y - rky * x) * rs + rkz * d;
  }
  // Bounce the point at a[o] (velocity at a[o+3]) off the snow plane under the crash.
  function hit(a, o, r, rest, fric) {
    const gy = gY0 + gGX * a[o] + gGZ * a[o + 2] + r;
    if (a[o + 1] >= gy) return false;
    a[o + 1] = gy;
    const il = 1 / Math.hypot(gGX, 1, gGZ), nx = -gGX * il, nz = -gGZ * il;
    const vn = a[o + 3] * nx + a[o + 4] * il + a[o + 5] * nz;
    if (vn < 0) {
      a[o + 3] = (a[o + 3] - (1 + rest) * vn * nx) * fric; a[o + 4] = (a[o + 4] - (1 + rest) * vn * il) * fric; a[o + 5] = (a[o + 5] - (1 + rest) * vn * nz) * fric;
    }
    return true;
  }

  function startCrash(R, v) {
    const sk = R.skier, soft = v.calm ? 0.4 : 1;
    build(R, v);                                        // where everything is at the moment of impact
    gGX = gradX; gGZ = gradZ; gY0 = v.hAbove < 30 ? -v.hAbove : -1e4;
    crashN++; crashOn = true; crashT = 0; flailK = v.calm ? 0.4 : 1;
    // they hit something: most of the speed is gone, the rest carries them on down the hill
    let k = v.calm ? 0.35 : 0.6;
    const sp = Math.hypot(sk.vx, sk.vz) * k;
    if (sp > 24) k *= 24 / sp;
    const bvx = sk.vx * k, bvz = sk.vz * k, side = v.vo < 0 ? -1 : 1;
    BD[0] = Ux * 0.6; BD[1] = Uy * 0.6; BD[2] = Uz * 0.6;
    BD[3] = bvx + Rx * side * 1.5 * soft; BD[4] = sk.vy * 0.3 + 4.5 * soft; BD[5] = bvz + Rz * side * 1.5 * soft;
    BD[6] = (-Rx * 6.5 + Fx * side * 1.6) * soft; BD[7] = (-Ry * 6.5 + Fy * side * 1.6) * soft; BD[8] = (-Rz * 6.5 + Fz * side * 1.6) * soft;
    BD[9] = Rx; BD[10] = Ry; BD[11] = Rz; BD[12] = Ux; BD[13] = Uy; BD[14] = Uz; BD[15] = Fx; BD[16] = Fy; BD[17] = Fz;
    LP.set(data.subarray(0, 6 * ST));
    for (let g = 0; g < 4; g++) {
      const o = g * 9, j = G0[g] * ST, sgn = g & 1 ? 1 : -1;
      const r1 = Look.hash(g + crashN * 7.3, 1.7), r2 = Look.hash(g * 3.1, crashN + 4.1), r3 = Look.hash(g * 5.7 + 2.2, crashN * 1.3);
      GR[o] = data[j]; GR[o + 1] = data[j + 1]; GR[o + 2] = data[j + 2];
      const lat = sgn * (2.5 + 4 * r2) * soft, f = 0.8 + 0.5 * r1;
      GR[o + 3] = bvx * f + Rx * lat; GR[o + 4] = (4 + 4 * r3) * soft; GR[o + 5] = bvz * f + Rz * lat;
      const w = (8 + 8 * r1) * (v.calm ? 0.3 : 1), a = r1 - 0.5, b = r2 - 0.5, c = r3 - 0.5, n = 1 / (Math.hypot(a, b, c) || 1);
      GR[o + 6] = (Rx * a + Ux * b + Fx * c) * n * w; GR[o + 7] = (Ry * a + Uy * b + Fy * c) * n * w; GR[o + 8] = (Rz * a + Uz * b + Fz * c) * n * w;
    }
    for (let p = 0; p < 6; p++) { const j = p * ST, o = GI[p] * 9; LP[j] -= GR[o]; LP[j + 1] -= GR[o + 1]; LP[j + 2] -= GR[o + 2]; }
  }

  function stepCrash(dt) {
    crashT += dt;
    if (crashT > 1.75) { crashOn = false; return; }
    // the body: ballistic, bouncing down the slope, shedding speed and spin each time it lands
    const drag = Math.exp(-1.2 * dt);
    BD[3] *= drag; BD[5] *= drag; BD[4] -= G * dt;
    BD[0] += BD[3] * dt; BD[1] += BD[4] * dt; BD[2] += BD[5] * dt;
    if (hit(BD, 0, 0.36, 0.3, 0.85)) { const k = Math.exp(-3 * dt); BD[6] *= k; BD[7] *= k; BD[8] *= k; }
    setRot(BD[6], BD[7], BD[8], dt);
    rot(BD, 9); rot(BD, 12); rot(BD, 15);
    Rx = BD[9]; Ry = BD[10]; Rz = BD[11]; Ux = BD[12]; Uy = BD[13]; Uz = BD[14]; Fx = BD[15]; Fy = BD[16]; Fz = BD[17];
    oX = BD[0] - Ux * 0.6; oY = BD[1] - Uy * 0.6; oZ = BD[2] - Uz * 0.6;
    P.set(AIR);
    pose(0, 0, flailK, 0, 0, 0, false, clock);
    for (let g = 0; g < 4; g++) {
      const o = g * 9;
      GR[o + 4] -= G * dt;
      GR[o] += GR[o + 3] * dt; GR[o + 1] += GR[o + 4] * dt; GR[o + 2] += GR[o + 5] * dt;
      if (hit(GR, o, 0.06, 0.4, 0.75)) { const k = Math.exp(-5 * dt); GR[o + 6] *= k; GR[o + 7] *= k; GR[o + 8] *= k; }
      setRot(GR[o + 6], GR[o + 7], GR[o + 8], dt);
      for (let p = 0; p < 6; p++) {
        if (GI[p] !== g) continue;
        const j = p * ST;
        rot(LP, j); rot(LP, j + 3); rot(LP, j + 6); rot(LP, j + 9);
        data[j] = GR[o] + LP[j]; data[j + 1] = GR[o + 1] + LP[j + 1]; data[j + 2] = GR[o + 2] + LP[j + 2];
        for (let q = 3; q < ST; q++) data[j + q] = LP[j + q];
      }
    }
    count = NP; scale = 1 - smooth((crashT - 1.4) / 0.35);  // then they are gone, shrinking away rather than popping
  }

  // ---- the layer --------------------------------------------------------------------------------
  const VS = `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 iPos; layout(location=3) in vec3 iAx; layout(location=4) in vec3 iAy; layout(location=5) in vec3 iAz; layout(location=6) in vec4 iCol;
uniform vec4 uOrg;                                     // xyz: anchor - camera.  w: scale of every part about its own centre
out vec3 vW; out vec3 vN; out vec3 vCol;
void main(){
  float t = mix(1.0, iCol.w, aPos.y * 0.5 + 0.5);
  vec3 l = vec3(aPos.x * t, aPos.y, aPos.z * t) * uOrg.w;
  vW = uOrg.xyz + iPos + iAx * l.x + iAy * l.y + iAz * l.z;
  vN = normalize(iAx) * aNrm.x + normalize(iAy) * aNrm.y + normalize(iAz) * aNrm.z;
  vCol = iCol.rgb;
  gl_Position = uVP * vec4(vW, 1.0);
}`;
  const FS = `
in vec3 vW; in vec3 vN; in vec3 vCol; out vec4 o;
void main(){ o = vec4(flFog(flLight(vCol, normalize(vN), 1.0), vW), 1.0); }`;

  let prog, vao, buf;

  Gfx.layer({
    name: 'skier', order: 40,
    init(R) {
      const gl = R.gl;
      if (prog && prog.gen === R.gen) return;
      prog = R.program('skier', VS, FS); prog.gen = R.gen;
      vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      R.buffer(Gfx.CUBE); R.attr(0, 3, 6, 0); R.attr(1, 3, 6, 3);
      buf = R.buffer(data.byteLength, gl.DYNAMIC_DRAW);
      R.attr(2, 3, ST, 0, 1); R.attr(3, 3, ST, 3, 1); R.attr(4, 3, ST, 6, 1); R.attr(5, 3, ST, 9, 1); R.attr(6, 4, ST, 12, 1);
      gl.bindVertexArray(null);
    },
    prepare(R, v) {
      const dt = clamp(v.dt, 0, 0.05);
      clock += dt; count = 0; scale = 1;
      if (pend) { pend = false; if (!v.skierOn) startCrash(R, v); }
      if (crashOn) { stepCrash(dt); return; }
      if (!v.skierOn) return;
      animate(v, dt);
      build(R, v);
      count = NP;
    },
    drawOpaque(R) {
      if (!count || !prog) return;
      const gl = R.gl, cam = R.cam;
      gl.useProgram(prog.p);
      gl.uniform4f(prog.u.uOrg, aX - cam.x, aY - cam.y, aZ - cam.z, scale);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * ST);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
      gl.bindVertexArray(null);
    },
    onEvent(R, e) {
      if (e.type === 'land') {
        // a critically damped kick: peaks at 1/w and is back up in about 0.3 s
        SV[5] += clamp(e.v / 20, 0.25, 1) * 0.2 * 14 * Math.E;
      } else if (e.type === 'dead' && e.cause === 'crash') pend = true;   // posed next frame, when R.skier is where they stopped
    },
    reset() {
      fresh = true; pend = false; crashOn = false; count = 0; scale = 1;
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
