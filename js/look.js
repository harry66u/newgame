/* Fall Line — the look, in one place.
   Light, colour and the sizes things are drawn at. Every renderer module reads from here so
   the mountain stays one world: the same sun, the same snow, shadows that match what casts
   them. All colours are linear RGB arrays unless a name ends in Hex. */
(function (root) {
  'use strict';
  const FL = root.FL, U = FL.U;
  const { hex, lerp, smooth } = U;

  // ---- sun -----------------------------------------------------------------------------------
  // Fixed in the world. The run heads roughly toward -Z; the sun sits ahead and off to the
  // right, low enough that everything throws a long shadow back up the slope toward the camera.
  const ELEV = (28 * Math.PI) / 180, AZ = (32 * Math.PI) / 180;       // azimuth: from -Z toward +X
  const SUN = [Math.sin(AZ) * Math.cos(ELEV), Math.sin(ELEV), -Math.cos(AZ) * Math.cos(ELEV)];
  const SHADOW = [-Math.sin(AZ), Math.cos(AZ)];     // unit ground direction (x, z) that shadows fall in
  const COT = 1 / Math.tan(ELEV);                   // shadow length per metre of height

  // ---- moods ---------------------------------------------------------------------------------
  // One per wave, cycling: bluebird, noon, whiteout, golden hour, alpenglow, last light, moonlight. `lit` is snow in full sun, `shade` is snow in shadow: the whole
  // lighting model is "cool sky fill + warm sun = lit", so those two colours define the light.
  const MOODS = [
    { name: 'bluebird', skyTop: '#1757c2', skyHor: '#a6d0f5', valley: '#143f88', lit: '#fffdf6', shade: '#8db4ea', glow: '#fff3d4', fog: 0.0040, haze: 0.9 },
    { name: 'high noon', skyTop: '#104bb8', skyHor: '#b6daf8', valley: '#12408e', lit: '#ffffff', shade: '#97bdf0', glow: '#ffffff', fog: 0.0036, haze: 0.7 },
    { name: 'whiteout', skyTop: '#7f90ab', skyHor: '#d3dbe6', valley: '#64738c', lit: '#f4f6f9', shade: '#c6d0de', glow: '#ffffff', fog: 0.0085, haze: 2.4 },
    { name: 'golden hour', skyTop: '#2f5fc0', skyHor: '#f8cfa4', valley: '#3a4a98', lit: '#ffefd6', shade: '#96a0e2', glow: '#ffc98a', fog: 0.0046, haze: 1.5 },
    { name: 'alpenglow', skyTop: '#3b3f92', skyHor: '#ffa2b2', valley: '#4a3b80', lit: '#ffdbe5', shade: '#9289dc', glow: '#ffa6b4', fog: 0.0050, haze: 1.6 },
    { name: 'last light', skyTop: '#182f72', skyHor: '#eeb0b4', valley: '#243474', lit: '#fbe3e4', shade: '#8497dc', glow: '#ffb4a0', fog: 0.0048, haze: 1.3 },
    { name: 'moonlight', skyTop: '#0a1330', skyHor: '#2c3d72', valley: '#08112c', lit: '#c3d1f2', shade: '#41568f', glow: '#d6e2ff', fog: 0.0060, haze: 0.9 },
  ].map((m) => {
    const lit = hex(m.lit), shade = hex(m.shade);
    return {
      name: m.name, skyTop: hex(m.skyTop), skyHor: hex(m.skyHor), valley: hex(m.valley), lit, shade,
      sun: [Math.max(0, lit[0] - shade[0]), Math.max(0, lit[1] - shade[1]), Math.max(0, lit[2] - shade[2])],
      glow: hex(m.glow), fog: m.fog, haze: m.haze,
    };
  });
  const KEYS = ['skyTop', 'skyHor', 'valley', 'lit', 'shade', 'sun', 'glow'];
  const newMood = () => ({ skyTop: [0, 0, 0], skyHor: [0, 0, 0], valley: [0, 0, 0], lit: [0, 0, 0], shade: [0, 0, 0], sun: [0, 0, 0], glow: [0, 0, 0], fog: 0, haze: 0 });
  // p is the track's palette coordinate: wave index, easing to the next across each rest section.
  function mood(p, out) {
    const n = MOODS.length, i0 = Math.floor(p), f = smooth(p - i0);
    const a = MOODS[((i0 % n) + n) % n], b = MOODS[(((i0 + 1) % n) + n) % n];
    for (const k of KEYS) U.mix3(out[k], a[k], b[k], f);
    out.fog = lerp(a.fog, b.fog, f); out.haze = lerp(a.haze, b.haze, f);
    return out;
  }

  // ---- materials -----------------------------------------------------------------------------
  const COL = {
    snow: hex('#ffffff'),
    pine: hex('#1c4a37'), pineLight: hex('#2c6a4b'), trunk: hex('#4b3626'),
    rock: hex('#59667c'), rockDark: hex('#39445a'),
    fence: hex('#ff5630'), post: hex('#e9eef5'),
    ice: hex('#23bfe8'), iceDeep: hex('#0f86c8'),
    jacket: hex('#e62a6f'), bib: hex('#f6f8fb'), pants: hex('#1b2a4b'), helmet: hex('#f4f6fa'), goggles: hex('#ff9d2e'), skis: hex('#ffcc33'), glove: hex('#141b2b'),
    gateRed: hex('#f0353b'), gateBlue: hex('#1f6fe0'),
  };

  // ---- piste ratings: each wave is a harder run ------------------------------------------------
  const RATINGS = [
    { name: 'Green', sym: 'circle', n: 1, hexCol: '#17a05a' },
    { name: 'Blue', sym: 'square', n: 1, hexCol: '#1e6fe0' },
    { name: 'Black', sym: 'diamond', n: 1, hexCol: '#14171c' },
    { name: 'Double black', sym: 'diamond', n: 2, hexCol: '#14171c' },
    { name: 'Extreme', sym: 'diamond', n: 3, hexCol: '#14171c' },
  ].map((r) => Object.assign(r, { col: hex(r.hexCol) }));
  const rating = (wave) => RATINGS[Math.max(0, Math.min(RATINGS.length - 1, wave | 0))];

  // ---- sizes ---------------------------------------------------------------------------------
  const hash = (a, b) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); };

  // The forest that lines walled stretches of piste. First row of trunks stands `inset` beyond
  // the edge with boughs reaching back to it; rows repeat every `rowGap` out to the shoulder.
  const WALL = { inset: 1.15, spacing: 2.35, rows: 3, rowGap: 2.4, hMin: 5.2, hMax: 8.6, r: 1.15, shoulder: 9.5 };

  /* The pines an obstacle is drawn as (and casts shadows as). Fills `out` with
     [offset across the piste, base radius, height] per tree and returns how many.
     'pine' is one tree exactly as wide as its hit box; 'pines' is a row that fills its box. */
  function trees(ob, out) {
    if (ob.kind === 'pine') { out[0] = ob.o; out[1] = ob.hx + 0.05; out[2] = ob.h; return 1; }
    if (ob.kind !== 'pines') return 0;
    const n = Math.max(2, Math.round((2 * ob.hx) / 1.55)), step = (2 * ob.hx) / n;
    for (let j = 0; j < n; j++) {
      out[j * 3] = ob.o - ob.hx + step * (j + 0.5);
      out[j * 3 + 1] = step * 0.5 + 0.14;
      out[j * 3 + 2] = ob.h * (0.84 + 0.34 * hash(ob.s + j * 3.7, ob.o));
    }
    return n;
  }

  FL.Look = { SUN, SHADOW, COT, ELEV, AZ, MOODS, mood, newMood, COL, RATINGS, rating, WALL, trees, hash };
})(typeof window !== 'undefined' ? window : globalThis);
