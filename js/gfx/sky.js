/* Fall Line — the sky: clear air, the sun, the far ranges on the horizon and the sea of cloud
   lying in the valley. One full-screen triangle at the far plane, drawn last in the opaque
   pass so it only pays for the pixels nothing else covered.

   Everything here is painted on top of flAtmo(), the colour every fogged object fades to, and
   melts back into it with distance: that is what lets the piste, the pines and the crags sink
   into this sky without an edge. */
(function (root) {
  'use strict';
  const FL = root.FL, Gfx = FL.Gfx;

  // The cloud deck: a sheet of mist a fixed depth below the camera, anchored to the world in
  // x and z so it slides past with real parallax as the run descends.
  const CELL_X = 530, CELL_Z = 220; // metres per cell of its noise: banks longer than they are wide, lying across the run
  const PER = 64;                   // the pattern repeats after this many cells: 14 km of travel at the least
  const DEEP = 210;                 // metres below the camera
  const WIND_X = 5.0, WIND_Z = 1.8; // m/s: the deck drifts even when the camera does not
  const f1 = (x) => x.toFixed(1);

  /* Shared with the scenery layer, which fades distant crags into the same mist so they never
     pop in against it. Needs `uniform vec4 uMist` (see FL.Sky.bind). */
  const MIST = `
uniform vec4 uMist;    // xy: where the camera is over the cloud deck, in cells.  zw: depth of the deck, in cells of x and of z
// Value noise that repeats every per cells, so the camera's position can wrap without a jump.
float skyNoise(vec2 p, float per){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  vec2 a = mod(i, per), b = mod(i + 1.0, per);
  return mix(mix(flHash(a), flHash(vec2(b.x, a.y)), f.x), mix(flHash(vec2(a.x, b.y)), flHash(b), f.x), f.y);
}
/* The sea of cloud in the valley, looking along unit direction d: how much of it there is.
   It lies in the mountain's shade and only catches skylight, so it is drawn in the colour of
   shaded snow, thinly: mix(colour, uAmb.rgb, skyMist(d)). The far end of the piste is seen
   against this and has to stay the brightest thing there. It thins to nothing straight down,
   where the rock under the piste and the feet of the crags dissolve into plain valley blue. */
float skyMist(vec3 d){
  float dn = -d.y;
  float band = smoothstep(0.035, 0.12, dn) * (1.0 - smoothstep(0.2, 0.38, dn));
  if (band <= 0.0) return 0.0;
  vec2 p = uMist.xy + d.xz * (uMist.zw / dn);
  float n = skyNoise(p, ${f1(PER)});
  // finer billows, dropped on slow devices and toward the horizon where they would only shimmer
  if (uMisc.w < 2.5) n += (skyNoise(p * 3.0 + 7.5, ${f1(PER * 3)}) - 0.5) * 0.4 * smoothstep(0.07, 0.17, dn);
  return smoothstep(0.52, 0.84, n) * band * 0.2;
}
`;

  const VS = `
out vec3 vDir;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vec4 q = uInvVP * vec4(p, 1.0, 1.0);
  vDir = q.xyz / q.w;        // a point on the far plane: linear across the screen, so the fragment only has to normalise
  gl_Position = vec4(p, 1.0, 1.0);
}`;

  const FS = MIST + `
in vec3 vDir;
uniform vec4 uSky;     // x: skyline seed.  y: cirrus drift
out vec4 o;
const float TAU = 6.2831853;

float span(float m){ m = abs(m); return max(1.0, m) + 0.4 * min(1.0, m); }   // ~ sqrt(1 + m*m)

/* One range of peaks, seen side-on and built like folded paper: the skyline is a broken line
   from saddle to summit to saddle, and each peak is two or three flat faces meeting at creases
   that run down from its summit. No noise: every edge is straight and sharp.
   u: azimuth as 0..1 round the horizon.  w: (sin, cos, sin, cos) of two slow waves round the
   horizon that bunch the peaks up and spread them out.  el: tangent of the elevation.
   N: peaks round the full circle.  H: height of the range (broad peaks stand taller).
   px: size of a pixel in el.
   Returns how much of the pixel the range covers; nf is the face normal as (to the right,
   up, toward the camera). */
float range(float u, vec4 w, float el, float N, float H, float seed, float px, out vec3 nf){
  float x = (u + 0.0056 * w.x + 0.0025 * w.z) * N;
  float st = 1.0 + 0.176 * w.y + 0.173 * w.w;                     // how tightly bunched just here
  float dx = N / TAU * st, Hh = H * (1.3 - 0.46 * st);            // cells per radian; height of the tallest peak there could be here
  nf = vec3(0.0, 1.0, 0.0);
  if (el > Hh + px) return 0.0;                                   // clear sky above the range: most of the band, so leave early
  float i = floor(x), f = x - i;
  float i0 = mod(i, N), i1 = mod(i + 1.0, N);
  float hp = flHash(vec2(i0, seed)), ha = flHash(vec2(i0, seed + 5.0)), hb = flHash(vec2(i1, seed + 5.0));
  float p = 0.3 + 0.4 * hp;                                       // where in its cell the summit stands
  float q = fract(hp * 37.7), hk = 0.5 + 0.5 * q * sqrt(q);       // its height: a few stand well above the rest
  float va = 0.06 + 0.34 * ha * ha, vb = 0.06 + 0.34 * hb * hb;   // the saddles either side: mostly deep
  float y = el / Hh;
  float k = 1.0 / (Hh * dx);                                      // turns "cells across per unit of height" into pixels across per pixel up

  float left = step(f, p);
  float ry = mix(mix(hk, vb, (f - p) / (1.0 - p)), mix(va, hk, f / p), left);
  float sl = mix((hk - vb) / (1.0 - p), (hk - va) / p, left) * Hh * dx;
  float cover = clamp((ry * Hh - el) / (px * span(sl)) + 0.5, 0.0, 1.0);

  // creases: two run down from the summit (the face between them looks straight at us), one
  // runs down from each saddle
  float t = clamp(1.0 - y / hk, 0.0, 1.0);
  float wF = max(0.0, fract(hp * 173.1) - 0.3) * 0.5;
  float a1 = (fract(hp * 91.3) - 0.5) * 0.3 - wF * 0.5, kz = (fract(hp * 255.7) - 0.5) * 0.16;
  float dk = kz * (t < 0.5 ? 2.0 : -2.0);                         // the summit creases kink half way down
  float cA = p + t * a1 + kz * (1.0 - abs(2.0 * t - 1.0)), cB = cA + t * wF;
  float g0 = (fract(ha * 47.1) - 0.5) * 0.2, g1 = (fract(hb * 47.1) - 0.5) * 0.2;
  float gA = g0 * clamp(1.0 - y / va, 0.0, 1.0), gB = 1.0 + g1 * clamp(1.0 - y / vb, 0.0, 1.0);
  float pw = px * dx;                                             // a pixel, in cells
  float sL = clamp((cA - f) / (pw * span((a1 + dk) / hk * k)) + 0.5, 0.0, 1.0);
  float sR = clamp((f - cB) / (pw * span((a1 + wF + dk) / hk * k)) + 0.5, 0.0, 1.0);
  float oL = clamp((gA - f) / (pw * span(g0 / va * k)) + 0.5, 0.0, 1.0);
  float oR = clamp((f - gB) / (pw * span(g1 / vb * k)) + 0.5, 0.0, 1.0);
  float sF = max(0.0, 1.0 - sL - sR);
  // every face leans its own way, so no two catch the light alike: x to the side, y toward us
  vec2 fc = sL * vec2(-0.5 - 0.45 * fract(ha * 29.3), fract(ha * 71.3)) + sR * vec2(0.5 + 0.45 * fract(hb * 13.7), fract(hb * 53.9))
          + sF * vec2((fract(hp * 311.3) - 0.5) * 0.5, 1.9);
  fc = mix(fc, vec2(0.5 + 0.45 * fract(ha * 13.7), fract(ha * 53.9)), oL);     // past a saddle's crease it is the next peak's face
  fc = mix(fc, vec2(-0.5 - 0.45 * fract(hb * 29.3), fract(hb * 71.3)), oR);
  nf = normalize(vec3(fc.x, 0.5, fc.y * 0.42 - 0.04));
  return cover;
}

/* Snow on a far face, in the light of this sky. Faces turned from the sun are steeper and show
   more rock, which keeps them darker than the bright haze behind them. k: how much snow the
   range carries.  c: how clear the air is to it. */
vec3 peak(vec3 atmo, vec3 nf, vec3 fw, float k, float c){
  vec3 n = vec3(-fw.z, 0.0, fw.x) * nf.x + vec3(0.0, nf.y, 0.0) - fw * nf.z;
  float d = clamp(dot(n, uSun.xyz) * uSun.w, 0.0, 1.0);
  return mix(atmo, flLight(mix(vec3(0.46, 0.58, 0.84), vec3(0.985, 0.985, 0.98), d) * k, n, 1.0), c);
}

void main(){
  vec3 d = normalize(vDir);
  vec3 atmo = flAtmo(d), col = atmo;
  float hl = max(length(d.xz), 1e-4), el = d.y / hl;
  float px = length(vec2(dFdx(el), dFdy(el)));

  if (d.y < 0.0) {
    // the valley: deep blue, with the cloud deck far below
    col = mix(col, uAmb.rgb, skyMist(d));
  } else if (el > 0.1 && el < 0.36) {
    /* High cirrus: a few thin combed streaks on a sheet far overhead, lying across the run.
       Kept to a band of sky (lower they would crowd the peaks, higher they would smear) and
       to the two quarters where they are seen side-on, not end-on. */
    vec2 c = d.xz / d.y;
    float n = flNoise(vec2(c.x * 0.4 + uSky.x, c.y * 2.1 + 0.55 * sin(c.x * 0.45 + c.y * 0.7) + uSky.y));
    float ci = smoothstep(0.72, 0.96, n) * smoothstep(0.1, 0.18, el) * (1.0 - smoothstep(0.22, 0.36, el));
    col = mix(col, uAmb.rgb + uSunCol.rgb, ci * 0.21 * (1.0 - smoothstep(0.45, 0.8, abs(d.x) / hl)));
  }

  if (el > -0.012 && el < 0.1) {
    /* The far ranges: three of them, each nearer one lower, crisper and less lost in the air.
       Every range sinks into the haze toward its foot, and that haze hides the feet of the
       range behind it: only summits and shoulders stand clear. */
    vec3 fw = vec3(d.x, 0.0, d.z) / hl, nA, nB, nC;
    float az = atan(d.x, -d.z), u = az / TAU + 0.5, sd = uSky.x;
    float hz = 0.65 + 0.35 * uGlow.a;                             // hazy evenings hide a little more of them
    float w1 = az * 5.0 + sd, w2 = az * 11.0 - sd * 2.3;
    vec4 w = vec4(sin(w1), cos(w1), sin(w2), cos(w2));
    float e = 0.22 * sin(az * 3.0 + sd * 1.7) * cos(az * 2.0 - sd);     // massifs: where one range stands tall the next sits low
    // worked out nearest first, so whatever a nearer range hides is never computed
    float aC = range(u + 0.65, -w, el + 0.007, 46.0, 0.034 * (0.78 + 0.22 * w.x * w.w), sd + 17.0, px, nC);
    if (aC < 1.0) {
      float aB = range(u + 0.3, vec4(w.y, -w.x, w.w, -w.z), el + 0.003, 58.0, 0.06 * (0.78 - e), sd + 9.0, px, nB);
      if (aB < 1.0) {
        float aA = range(u, w, el, 40.0, 0.094 * (0.78 + e), sd + 1.0, px, nA);
        if (aA > 0.0) col = mix(col, peak(atmo, nA, fw, 1.0, exp(-0.85 * hz) * smoothstep(0.004, 0.046, el)), aA);
      }
      if (aB > 0.0) col = mix(col, peak(atmo, nB, fw, 1.0, exp(-0.45 * hz) * smoothstep(0.0, 0.03, el)), aB);
    }
    if (aC > 0.0) col = mix(col, peak(atmo, nC, fw, 0.82, exp(-0.2 * hz) * smoothstep(-0.008, 0.012, el)), aC);
  }

  // the sun: a small clean disc, a soft glow close around it, and a wide gentle halo. The disc
  // is only a little over white, so the bloom it throws stays a glow and leaves its edge crisp.
  float s2 = max(2.0 - 2.0 * dot(d, uSun.xyz), 0.0), sa = sqrt(s2);     // angle from its centre, radians
  float aa = 2.0 * uView.w / uView.y;
  float disc = 1.0 - smoothstep(0.021 - aa, 0.021 + aa, sa);
  col = mix(col, mix(uGlow.rgb, vec3(1.0), 0.6) * (2.0 - 1360.0 * s2), disc);       // 2.0 at its centre, 1.4 at the limb
  col += uGlow.rgb * (exp(-sa * 30.0) * 0.25 + 0.1 / (1.0 + s2 * 34.0));

  o = vec4(col, 1.0);
}`;

  let prog = null;
  const S = { x: 0, z: 0, t: 0, frame: -1 };

  // Where the camera is over the cloud deck this frame. Wrapped in doubles, to a whole number of
  // repeats of the pattern, so the shader never sees a seam or a large coordinate.
  function sync(R, dt) {
    if (S.frame === R.frameNo) return;
    S.frame = R.frameNo; S.t += dt;
    const sx = CELL_X * PER, sz = CELL_Z * PER, x = R.cam.x + WIND_X * S.t, z = R.cam.z + WIND_Z * S.t;
    S.x = (((x % sx) + sx) % sx) / CELL_X;
    S.z = (((z % sz) + sz) % sz) / CELL_Z;
  }

  FL.Sky = {
    MIST,
    sync,
    // set the cloud deck's uniform on any program that includes MIST
    bind(gl, u) { if (u.uMist) gl.uniform4f(u.uMist, S.x, S.z, DEEP / CELL_X, DEEP / CELL_Z); },
  };

  Gfx.layer({
    name: 'sky', order: 90,
    init(R) { prog = R.program('sky', VS, FS); },
    prepare(R, v, dt) { sync(R, dt); },
    drawOpaque(R, v) {
      const gl = R.gl, u = prog.u;
      gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
      gl.useProgram(prog.p);
      FL.Sky.bind(gl, u);
      // every seed has its own skyline; the cirrus creeps across over minutes
      gl.uniform4f(u.uSky, (v.track.seed % 89) * 0.37, S.t * 0.004, 0, 0);
      gl.bindVertexArray(R.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
