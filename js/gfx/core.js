/* Fall Line — renderer core.
   Owns the WebGL2 context, the camera, the shared per-frame uniform block, the light model
   every material uses, and the post chain (bloom + tone map). What is actually drawn comes
   from layers that register with FL.Gfx.layer(): the piste, the sky, pines, the skier, snow.

   Everything is drawn relative to the camera (positions are differenced in doubles on the
   CPU), so precision holds however far a run goes. Quality steps down by itself if the device
   cannot hold its refresh rate. */
(function (root) {
  'use strict';
  const FL = root.FL, U = FL.U, C = FL.C, M4 = U.M4, Look = FL.Look;
  const { clamp } = U;

  // ---------------------------------------------------------------- shared GLSL
  /* Prepended to every layer shader. One uniform block, filled once a frame, plus the handful
     of functions that make separate modules look like one place. */
  const BLOCK = `
layout(std140) uniform Frame {
  mat4 uVP;        // camera-relative world -> clip
  mat4 uInvVP;
  vec4 uSun;       // xyz: unit direction TO the sun.  w: diffuse scale
  vec4 uSunCol;    // rgb: sunlight = lit snow minus shaded snow
  vec4 uAmb;       // rgb: sky fill = the colour of white snow in shadow
  vec4 uBounce;    // rgb: light thrown back up off the snow
  vec4 uSkyTop;    // rgb: sky overhead
  vec4 uSkyHor;    // rgb: sky at the horizon (the haze colour)
  vec4 uValley;    // rgb: the depths below the horizon
  vec4 uFogP;      // x: density  y: exponent  z: max amount
  vec4 uShadow;    // xy: unit ground direction (x,z) shadows fall in.  z: shadow length per metre of height
  vec4 uCamW;      // xyz: camera world position wrapped to 512 m (for stable world-anchored patterns).  w: time, seconds
  vec4 uMisc;      // x: music beat 1->0  y: speed 0..1  z: boost 0..1  w: quality notch, 0 best .. 5
  vec4 uView;      // xy: render size in px  z: aspect  w: tan(fovY / 2)
  vec4 uSkier;     // xyz: the skier's feet, camera-relative.  w: height above the snow (99 when there is no skier)
  vec4 uGlow;      // rgb: glow around the sun.  a: how hazy the air is
  vec4 uCamR;      // xyz: camera right, world
  vec4 uCamU;      // xyz: camera up, world
};
#define uTime uCamW.w
float flHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float flNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(flHash(i), flHash(i + vec2(1.0, 0.0)), f.x), mix(flHash(i + vec2(0.0, 1.0)), flHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Clear-air colour looking along unit direction d: sky above the horizon, the blue depths of
// the valley below it. No sun disc, no mountains. Everything distant fades to this.
vec3 flAtmo(vec3 d){
  float e = d.y;
  vec3 c = e >= 0.0 ? mix(uSkyHor.rgb, uSkyTop.rgb, 1.0 - exp(-e * 6.5))
                    : mix(uSkyHor.rgb, uValley.rgb, 1.0 - exp(e * 9.0));
  float s = max(dot(d, uSun.xyz), 0.0);
  return c + uGlow.rgb * (pow(s, 6.0) * 0.10 + pow(s, 40.0) * 0.22) * uGlow.a;
}
// Aerial perspective. w is the camera-relative position of the fragment.
vec3 flFog(vec3 col, vec3 w){
  float dist = length(w);
  float f = (1.0 - exp(-pow(dist * uFogP.x, uFogP.y))) * uFogP.z;
  return mix(col, flAtmo(w / max(dist, 1e-4)), f);
}
/* The light. Cool sky fill plus warm sun adds up to white on snow; take the sun away (sh = 0)
   and what is left is the soft blue of the shade. n: unit world normal.  sh: 1 in sun .. 0 in
   cast shadow. Use it for everything, so everything sits in the same morning. */
vec3 flLight(vec3 albedo, vec3 n, float sh){
  float d = clamp(dot(n, uSun.xyz) * uSun.w, 0.0, 1.25) * sh;
  vec3 amb = uAmb.rgb * (0.62 + 0.38 * n.y) + uBounce.rgb * (0.5 - 0.5 * n.y);
  return albedo * (amb + uSunCol.rgb * d);
}
`;
  const FRAG = `
// Flat-facet normal from the camera-relative position: the low-poly look, no normals needed.
vec3 flFacet(vec3 w){ return normalize(cross(dFdx(w), dFdy(w))); }
`;
  const VS_HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n' + BLOCK;
  const FS_HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n' + BLOCK + FRAG;

  const VS_FS = `
out vec2 vUV;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0); }`;

  const FS_DOWN = `
in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel; uniform float uThresh;
out vec4 o;
vec3 pre(vec3 c){
  if (uThresh <= 0.0) return c;
  float b = max(c.r, max(c.g, c.b));
  float k = clamp((b - uThresh) / 0.7, 0.0, 1.0);
  return c * k * k;
}
void main(){
  vec3 c = pre(texture(uTex, vUV).rgb) * 4.0;
  c += pre(texture(uTex, vUV + uTexel * vec2(-1.0, -1.0)).rgb);
  c += pre(texture(uTex, vUV + uTexel * vec2( 1.0, -1.0)).rgb);
  c += pre(texture(uTex, vUV + uTexel * vec2(-1.0,  1.0)).rgb);
  c += pre(texture(uTex, vUV + uTexel * vec2( 1.0,  1.0)).rgb);
  o = vec4(min(c / 8.0, vec3(10.0)), 1.0);
}`;

  const FS_UP = `
in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel;
out vec4 o;
void main(){
  vec3 c = texture(uTex, vUV + uTexel * vec2(-2.0, 0.0)).rgb + texture(uTex, vUV + uTexel * vec2(2.0, 0.0)).rgb
         + texture(uTex, vUV + uTexel * vec2(0.0, -2.0)).rgb + texture(uTex, vUV + uTexel * vec2(0.0, 2.0)).rgb;
  c += (texture(uTex, vUV + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUV + uTexel * vec2(1.0, 1.0)).rgb
      + texture(uTex, vUV + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUV + uTexel * vec2(1.0, -1.0)).rgb) * 2.0;
  o = vec4(c / 12.0 * 0.85, 1.0);
}`;

  const FS_COMP = `
in vec2 vUV; uniform sampler2D uScene; uniform sampler2D uBloom;
uniform float uBloomK; uniform float uBlur; uniform float uFlash; uniform float uFade; uniform float uVeil;
out vec4 o;
float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// Straight through the mid-tones so colours stay true, then a soft shoulder so sunlit snow
// rolls off into white instead of clipping.
vec3 tone(vec3 c){
  vec3 x = max(c, 0.0), hi = 0.76 + 0.24 * tanh((x - 0.76) / 0.24);
  return mix(x, hi, step(0.76, x));
}
void main(){
  vec2 c = vUV - 0.5;
  float r2 = dot(c, c);
  vec3 col;
  if (uBlur > 0.002) {
    // speed: the frame smears outward from the centre (samples jittered so it reads as grain, not ghosts)
    vec2 dir = c * uBlur * r2 * 0.3;
    float j = hash(gl_FragCoord.xy + fract(uTime) * 37.0);
    col = vec3(0.0);
    for (int i = 0; i < 5; i++) col += texture(uScene, vUV - dir * (float(i) + j)).rgb * (1.0 - float(i) * 0.14);
    col /= 3.6;
  } else col = texture(uScene, vUV).rgb;
  col += texture(uBloom, vUV).rgb * uBloomK;
  col *= 1.0 - smoothstep(0.2, 1.0, r2 * 1.7) * 0.24;
  // after a wipe-out the scene drains toward a cold, quiet blue so the result reads on top of it
  float lum = dot(col, vec3(0.3, 0.55, 0.15));
  col = mix(col, vec3(0.42, 0.56, 0.86) * (0.25 + lum * 0.55), uVeil);
  col = tone(col * uFade) + uFlash;
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  col += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

  // ---------------------------------------------------------------- geometry helpers
  // 36 vertices, position + normal, a cube from -1..1.
  const CUBE = (() => {
    const v = [], faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const n of faces) {
      const a = n[0] ? [0, 1, 0] : [1, 0, 0], b = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
      const corner = (sa, sb) => v.push(n[0] + a[0] * sa + b[0] * sb, n[1] + a[1] * sa + b[1] * sb, n[2] + a[2] * sa + b[2] * sb, n[0], n[1], n[2]);
      corner(-1, -1); corner(1, -1); corner(1, 1); corner(-1, -1); corner(1, 1); corner(-1, 1);
    }
    return new Float32Array(v);
  })();
  const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

  const FA = { x: 0, y: 0, z: 0, yaw: 0, sl: 0, cv: 0, bk: 0, pal: 0, int: 0 };
  const FB = { x: 0, y: 0, z: 0, yaw: 0, sl: 0, cv: 0, bk: 0, pal: 0, int: 0 };
  // Quality notches, best first: [MSAA samples, resolution scale, bloom levels]
  const NOTCH = [[4, 1, 4], [4, 0.85, 4], [0, 0.85, 4], [0, 0.7, 3], [0, 0.56, 3], [0, 0.45, 3]];
  const NU = 104;                                     // floats in the Frame block

  const layers = [];

  class Renderer {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.opts = opts || {};
      this.notch = this.opts.notch === undefined ? (this.opts.mobile ? 1 : 0) : this.opts.notch;
      this.lockQuality = !!this.opts.lockQuality;
      this.maxDpr = this.opts.maxDpr || 2;
      this.only = this.opts.only || null;             // debug: draw just these layers
      this.cam = { x: 0, y: 0, z: 0 };
      this.camR = [1, 0, 0]; this.camU = [0, 1, 0]; this.camF = [0, 0, -1];
      this.proj = M4.create(); this.view = M4.create(); this.vp = M4.create(); this.inv = M4.create();
      this.aspect = 1; this.tanFov = 1;
      // the skier in world space, refreshed every frame before any layer runs
      this.skier = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, cs: 1, sn: 0, sl: 0, bk: 0 };
      this.mood = Look.newMood();
      this.fd = new Float32Array(NU);
      this.frames = []; this.refresh = 16.7; this.warm = 0;
      this.blur = 0;
      this.frameNo = 0;
      this.init();
    }

    get layers() { return layers; }

    init() {
      const gl = this.gl = this.canvas.getContext('webgl2', {
        antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!this.opts.preserve,
      });
      if (!gl) throw new Error('WebGL2 unavailable');
      this.hdr = !!gl.getExtension('EXT_color_buffer_float');
      this.gen = (this.gen || 0) + 1;                 // GPU objects made against an older context are stale
      this.ubo = gl.createBuffer();
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, NU * 4, gl.DYNAMIC_DRAW);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);
      this.P = {
        down: this.program('down', VS_FS, FS_DOWN), up: this.program('up', VS_FS, FS_UP), comp: this.program('comp', VS_FS, FS_COMP),
      };
      this.emptyVao = gl.createVertexArray();
      this.targets = null;
      for (const L of layers) { L.dead = false; this._call(L, 'init'); }
      this.dirtySize = false;
      this.resize(true);
    }

    // ------------------------------------------------------------ services for layers
    /* Compile a layer program. vs / fs are shader bodies: the version line, precision, the
       Frame block and the fl* functions are added for you. Returns { p, u } where u maps each
       active uniform name (arrays without the [0]) to its location. */
    program(name, vs, fs) {
      const gl = this.gl;
      const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(s); gl.deleteShader(s);
          throw new Error('[' + name + '] ' + (type === gl.VERTEX_SHADER ? 'vertex' : 'fragment') + ' shader: ' + log);
        }
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, VS_HEAD + vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS_HEAD + fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('[' + name + '] link: ' + gl.getProgramInfoLog(p));
      const bi = gl.getUniformBlockIndex(p, 'Frame');
      if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, bi, 0);
      const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i), loc = gl.getUniformLocation(p, info.name);
        if (loc) u[info.name.replace(/\[0\]$/, '')] = loc;
      }
      return { p, u };
    }

    // ARRAY_BUFFER from data (or a byte size), left bound.
    buffer(data, usage) {
      const gl = this.gl, b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW);
      return b;
    }

    // Float attribute on the bound buffer. stride/offset in floats; divisor 1 for per-instance.
    attr(loc, size, stride, offset, divisor) {
      const gl = this.gl;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
      if (divisor) gl.vertexAttribDivisor(loc, divisor);
    }

    /* World placement of something standing on the track (an obstacle or boost strip: anything
       with s, o, e). Cached on the item. Returns [x, y, z, yaw, dy/ds] in world space, y at
       ground level. Subtract R.cam before sending positions to the GPU. */
    place(tr, it) {
      if (it.w) return it.w;
      tr.frameAt(it.s, FB);
      const k = Math.max(0, Math.min(tr.k - 1, Math.floor(it.s / C.SEG)));
      return (it.w = [FB.x + Math.cos(FB.yaw) * it.o, FB.y + it.e, FB.z + Math.sin(FB.yaw) * it.o, FB.yaw, (tr.F.y[k + 1] - tr.F.y[k]) / C.SEG]);
    }

    has(name) { for (const L of layers) if (L.name === name && !L.dead) return true; return false; }

    // ------------------------------------------------------------ targets
    _target(w, h) {
      const gl = this.gl, tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, this.hdr ? gl.RGBA16F : gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fbo, tex, w, h };
    }

    resize(force) {
      const gl = this.gl, cv = this.canvas;
      const cw = cv.clientWidth || cv.width || 1, ch = cv.clientHeight || cv.height || 1;
      const [msaa, scale, levels] = NOTCH[this.notch];
      const dpr = Math.min(root.devicePixelRatio || 1, this.maxDpr);
      let w = Math.max(64, Math.round(cw * dpr * scale)), h = Math.max(64, Math.round(ch * dpr * scale));
      const maxPx = 3.4e6, px = w * h;                 // keep the pixel count sane on very large displays
      if (px > maxPx) { const k = Math.sqrt(maxPx / px); w = Math.round(w * k); h = Math.round(h * k); }
      if (!force && this.targets && this.targets.w === w && this.targets.h === h && this.targets.notch === this.notch) return;
      cv.width = w; cv.height = h;
      this._freeTargets();
      const T = this.targets = { w, h, notch: this.notch, bloom: [] };
      T.scene = this._target(w, h);
      const samples = Math.min(msaa, gl.getParameter(gl.MAX_SAMPLES));
      T.depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, T.depth);
      if (samples > 1) {
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
        T.color = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, T.color);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, this.hdr ? gl.RGBA16F : gl.RGBA8, w, h);
        T.ms = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.ms);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, T.color);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, T.depth);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          // multisampled float targets are not guaranteed everywhere: fall back to no MSAA
          gl.deleteFramebuffer(T.ms); gl.deleteRenderbuffer(T.color); T.ms = null; T.color = null;
          gl.bindRenderbuffer(gl.RENDERBUFFER, T.depth);
          gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
        }
      } else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      if (!T.ms) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fbo);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, T.depth);
      }
      let bw = w, bh = h;
      for (let i = 0; i < levels; i++) {
        bw = Math.max(4, bw >> 1); bh = Math.max(4, bh >> 1);
        T.bloom.push(this._target(bw, bh));
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    _freeTargets() {
      const gl = this.gl, T = this.targets;
      if (!T) return;
      const del = (t) => { if (t) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); } };
      del(T.scene); T.bloom.forEach(del);
      if (T.ms) gl.deleteFramebuffer(T.ms);
      if (T.color) gl.deleteRenderbuffer(T.color);
      gl.deleteRenderbuffer(T.depth);
      this.targets = null;
    }

    /* Watch real frame pacing and step quality down when the device keeps missing its refresh.
       It never steps back up: without GPU timers there is no way to know there is headroom. */
    _pace(dtMs) {
      if (this.lockQuality) return;
      this.warm++;
      if (this.warm < 45) return;                     // ignore shader warm-up and first-frame hitches
      const fr = this.frames;
      fr.push(dtMs);
      if (fr.length < 90) return;
      const sorted = fr.slice().sort((a, b) => a - b);
      const fast = Math.min(sorted[9], 16.9);         // the cadence the display can actually reach
      if (fast < this.refresh || this.refresh > 16.8) this.refresh = Math.max(fast, 4);
      let slow = 0;
      for (const d of fr) if (d > this.refresh * 1.45) slow++;
      fr.length = 0;
      if (slow > 22 && this.notch < NOTCH.length - 1) { this.notch++; this.resize(); this.warm = 20; }
    }

    // ------------------------------------------------------------ layers
    _call(L, fn, a, b) {
      if (L.dead || !L[fn]) return;
      try { L[fn](this, a, b); } catch (err) {
        L.dead = true;
        console.error('[gfx] layer "' + L.name + '" failed in ' + fn + ' and was switched off:', err);
      }
    }

    _on(L) {
      if (L.dead) return false;
      if (this.only && this.only.indexOf(L.name) < 0) return false;
      if (L.standIn && this.has(L.standIn)) return false;
      return true;
    }

    onEvent(e, v) { for (const L of layers) if (this._on(L)) this._call(L, 'onEvent', e, v); }
    reset() { this.blur = 0; for (const L of layers) this._call(L, 'reset'); }
    // A whole track is being thrown away (a new run): let every layer drop what it cached on it.
    releaseTrack(tr) {
      for (const L of layers) {
        for (const rb of tr.ribbons) this._call(L, 'freeRibbon', rb);
        for (const rb of tr.freed) this._call(L, 'freeRibbon', rb);
        this._call(L, 'releaseTrack', tr);
      }
      tr.freed.length = 0;
    }

    // ------------------------------------------------------------ camera
    _camera(v) {
      const tr = v.track, c = v.cam, cv = this.canvas;
      const aspect = this.aspect = cv.width / cv.height;
      const tall = clamp((1.25 - aspect) / 0.75, 0, 1);          // portrait screens sit higher and further back
      const back = c.back + tall * 3.2, camH = 2.9 + tall * 2.1;
      tr.frameAt(v.s - back, FA);
      const ahead = 15 + v.u * 0.13;
      tr.frameAt(v.s + ahead, FB);
      const tr2 = c.trauma * c.trauma, t = v.time;
      const shx = tr2 * (Math.sin(t * 61) + Math.sin(t * 97.3)) * 0.14, shy = tr2 * (Math.sin(t * 71) + Math.sin(t * 113.1)) * 0.12;
      const rumble = clamp((v.u - 45) / 45, 0, 1) * 0.012 * (v.mode === 'run' ? 1 : 0);
      const ex = FA.x + Math.cos(FA.yaw) * c.o + shx;
      const ey = FA.y + camH + c.h + c.o * FA.bk + shy + Math.sin(t * 47) * rumble;
      const ez = FA.z + Math.sin(FA.yaw) * c.o;
      const tx = FB.x + Math.cos(FB.yaw) * c.look, ty = FB.y + 1.1 + c.h * 0.7, tz = FB.z + Math.sin(FB.yaw) * c.look;
      let dx = tx - ex, dy = ty - ey, dz = tz - ez;
      const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      // roll: the up vector leans into the turn
      const roll = c.roll + tr2 * Math.sin(t * 53) * 0.03;
      const hl = Math.hypot(dx, dz) || 1, rx = -dz / hl, rz = dx / hl;
      const ux = rx * Math.sin(roll), uy = Math.cos(roll), uz = rz * Math.sin(roll);
      M4.lookDir(this.view, dx, dy, dz, ux, uy, uz);
      const fovDeg = c.fov + c.kick * 8;
      const fov = 2 * Math.atan(Math.tan((fovDeg * Math.PI) / 360) * Math.pow(clamp(1.5 / aspect, 1, 2.2), 0.8));
      this.tanFov = Math.tan(fov / 2);
      M4.perspective(this.proj, fov, aspect, 0.3, 1400);
      M4.mul(this.vp, this.proj, this.view);
      M4.invert(this.inv, this.vp);
      this.cam.x = ex; this.cam.y = ey; this.cam.z = ez;
      const m = this.view;
      this.camR[0] = m[0]; this.camR[1] = m[4]; this.camR[2] = m[8];
      this.camU[0] = m[1]; this.camU[1] = m[5]; this.camU[2] = m[9];
      this.camF[0] = dx; this.camF[1] = dy; this.camF[2] = dz;
    }

    _frameBlock(v) {
      const tr = v.track, sk = this.skier, cam = this.cam, f = this.fd, md = this.mood;
      tr.frameAt(v.s, FA);
      sk.yaw = FA.yaw; sk.cs = Math.cos(FA.yaw); sk.sn = Math.sin(FA.yaw); sk.sl = FA.sl; sk.bk = FA.bk;
      sk.x = FA.x + sk.cs * v.o; sk.y = v.y; sk.z = FA.z + sk.sn * v.o;
      sk.vx = sk.sn * v.u + sk.cs * v.vo; sk.vy = v.vy; sk.vz = -sk.cs * v.u + sk.sn * v.vo;
      Look.mood(tr.frameAt(v.s + 30, FB).pal, md);
      f.set(this.vp, 0); f.set(this.inv, 16);
      const S = Look.SUN;
      f[32] = S[0]; f[33] = S[1]; f[34] = S[2]; f[35] = 1 / 0.62;
      f[36] = md.sun[0]; f[37] = md.sun[1]; f[38] = md.sun[2]; f[39] = 1;
      f[40] = md.shade[0]; f[41] = md.shade[1]; f[42] = md.shade[2]; f[43] = 1;
      f[44] = md.lit[0] * 0.34; f[45] = md.lit[1] * 0.34; f[46] = md.lit[2] * 0.34; f[47] = 1;
      f[48] = md.skyTop[0]; f[49] = md.skyTop[1]; f[50] = md.skyTop[2]; f[51] = 1;
      f[52] = md.skyHor[0]; f[53] = md.skyHor[1]; f[54] = md.skyHor[2]; f[55] = 1;
      f[56] = md.valley[0]; f[57] = md.valley[1]; f[58] = md.valley[2]; f[59] = 1;
      f[60] = md.fog; f[61] = 1.5; f[62] = 0.97; f[63] = 0;
      f[64] = Look.SHADOW[0]; f[65] = Look.SHADOW[1]; f[66] = Look.COT; f[67] = 0;
      f[68] = ((cam.x % 512) + 512) % 512; f[69] = ((cam.y % 512) + 512) % 512; f[70] = ((cam.z % 512) + 512) % 512; f[71] = v.time % 3600;
      f[72] = v.beat; f[73] = clamp((v.u - 25) / 60, 0, 1); f[74] = clamp(v.boost / 10, 0, 1); f[75] = this.notch;
      f[76] = this.targets.w; f[77] = this.targets.h; f[78] = this.aspect; f[79] = this.tanFov;
      f[80] = sk.x - cam.x; f[81] = sk.y - cam.y; f[82] = sk.z - cam.z; f[83] = v.skierOn ? v.hAbove : 99;
      f[84] = md.glow[0]; f[85] = md.glow[1]; f[86] = md.glow[2]; f[87] = md.haze;
      f[88] = this.camR[0]; f[89] = this.camR[1]; f[90] = this.camR[2]; f[91] = 0;
      f[92] = this.camU[0]; f[93] = this.camU[1]; f[94] = this.camU[2]; f[95] = 0;
      const gl = this.gl;
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, f);
    }

    // ------------------------------------------------------------ frame
    /* dt: seconds of visual time to advance (already scaled for slow motion). v: the view
       state assembled by main.js — see docs/DESIGN.md for every field. */
    frame(dt, v) {
      const gl = this.gl;
      if (gl.isContextLost()) return;
      if (this.dirtySize) { this.dirtySize = false; this.resize(); }
      this._pace(v.rawDt * 1000);
      this.frameNo++;
      const T = this.targets, P = this.P;
      // ribbons that have scrolled out behind the camera: every layer frees what it hung on them
      const freed = v.track.freed;
      if (freed.length) {
        for (const L of layers) for (let i = 0; i < freed.length; i++) this._call(L, 'freeRibbon', freed[i]);
        freed.length = 0;
      }
      this._camera(v);
      this._frameBlock(v);
      for (const L of layers) if (this._on(L)) this._call(L, 'prepare', v, dt);

      gl.bindFramebuffer(gl.FRAMEBUFFER, T.ms || T.scene.fbo);
      gl.viewport(0, 0, T.w, T.h);
      gl.depthMask(true);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);

      for (const L of layers) {
        if (!L.drawOpaque || !this._on(L)) continue;
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
        gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.POLYGON_OFFSET_FILL);
        this._call(L, 'drawOpaque', v);
      }
      for (const L of layers) {
        if (!L.drawBlend || !this._on(L)) continue;
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
        gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.CULL_FACE); gl.disable(gl.POLYGON_OFFSET_FILL);
        this._call(L, 'drawBlend', v);
      }
      gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.blendEquation(gl.FUNC_ADD);

      if (T.ms) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.ms); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.scene.fbo);
        gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }

      // bloom: only what is brighter than sunlit snow — glints, ice, the sun itself
      gl.bindVertexArray(this.emptyVao);
      gl.activeTexture(gl.TEXTURE0);
      let pr = P.down;
      gl.useProgram(pr.p);
      gl.uniform1i(pr.u.uTex, 0);
      let src = T.scene;
      for (let i = 0; i < T.bloom.length; i++) {
        const dst = T.bloom[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(pr.u.uTexel, 1 / src.w, 1 / src.h);
        gl.uniform1f(pr.u.uThresh, i === 0 ? (this.hdr ? 1.02 : 0.93) : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = dst;
      }
      pr = P.up;
      gl.useProgram(pr.p);
      gl.uniform1i(pr.u.uTex, 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = T.bloom.length - 1; i > 0; i--) {
        const s2 = T.bloom[i], dst = T.bloom[i - 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, s2.tex);
        gl.uniform2f(pr.u.uTexel, 0.5 / s2.w, 0.5 / s2.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);

      // composite to the screen
      const run = v.mode === 'run' ? 1 : 0, calm = v.calm ? 0 : 1;
      const want = run * calm * (clamp((v.u - 34) / 60, 0, 1) * 0.35 + (v.boost > 0 ? 0.7 : 0));
      this.blur += (want - this.blur) * (1 - Math.exp(-5 * dt));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, T.w, T.h);
      pr = P.comp;
      gl.useProgram(pr.p);
      gl.uniform1i(pr.u.uScene, 0); gl.uniform1i(pr.u.uBloom, 1);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.bloom[0].tex);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.scene.tex);
      gl.uniform1f(pr.u.uBloomK, this.hdr ? 0.5 : 0.35);
      gl.uniform1f(pr.u.uBlur, this.blur);
      gl.uniform1f(pr.u.uFlash, v.flash); gl.uniform1f(pr.u.uFade, v.fade); gl.uniform1f(pr.u.uVeil, v.veil);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }
  }

  FL.Gfx = {
    Renderer, CUBE, QUAD, NOTCH,
    /* Register a layer. Fields (all optional except name):
         name, order            — lower order draws first within each pass
         standIn: 'other'       — this layer is a placeholder; it switches itself off once a layer called 'other' exists
         init(R)                — create GPU resources; called again if the context is restored
         prepare(R, v, dt)      — once a frame before any drawing: animate, fill buffers
         drawOpaque(R, v)       — depth test + write on, blending off
         drawBlend(R, v)        — depth test on, depth write off, premultiplied-alpha blending on
         onEvent(R, e, v)       — a simulation event (boost, flow, pass, land, air, fall, dead…)
         reset(R)               — a new run is starting
         freeRibbon(R, rb)      — this ribbon is gone for good: free anything you cached on it
         releaseTrack(R, track) — a whole track is being discarded (freeRibbon has already run for its ribbons) */
    layer(def) {
      for (let i = 0; i < layers.length; i++) if (layers[i].name === def.name) layers.splice(i, 1);
      layers.push(def);
      layers.sort((a, b) => (a.order || 0) - (b.order || 0));
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
