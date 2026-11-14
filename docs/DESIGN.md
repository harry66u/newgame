# Fall Line — design and build notes

Fall Line is an endless downhill run in the browser: you steer a skier left and right down a
steep, procedurally generated ridge-line piste; it gets faster in waves; you end in a crash or a
fall; one tap and you go again. It should be as simple to play as *Slope* and feel far more
polished. No menus, no progression, no clutter.

This file is the contract between the parts. If you are writing one module, read sections 1–5
fully, then your module's brief.

## 1. The look

**Crisp alpine morning, not neon.** Bright white slopes, pine trees, soft blue shadows, clean
low sun, powder spray that reacts to speed and turns. Clean, modern, high quality.

- **Stylised, not realistic.** Low-poly, flat-shaded, faceted objects (pines, rocks, the skier)
  on smooth, softly-shaded snow. No textures, no outlines, no image assets: every surface is
  procedural. Think paper-clean shapes in beautiful light.
- **Light is the art.** Everything is lit by one function (`flLight`): cool sky fill plus warm
  sun adds up to white on snow, and where the sun is blocked what is left is the soft blue of
  the shade. Never hard-code a "final" colour; give an albedo to `flLight` and fog it with
  `flFog`, and your thing will sit in the same morning (and the same golden hour) as the rest.
- **Colour means something.** White and pale blue are snow: safe. Dark things standing on the
  white (deep green pines, charcoal rock) and anything safety-orange (fences) end your run.
  Glossy cyan ice is speed, the reward. The skier is raspberry pink so they never get lost.
  Do not use these colours for anything else.
- **The piste is a ridge.** It hangs high above a deep blue valley. Beyond an open edge is
  air, so the snow reads as a bright ribbon on a darker, bluer ground: that contrast is what
  makes the edge legible. Along forested stretches pines stand right up to the edge instead.
- **Depth through air.** Distance fades everything toward the sky/valley colour behind it.
  Nothing pops in; nothing ends in a hard line.
- **Restraint.** One idea per element, done well. If a detail does not make the game read
  better or feel faster, leave it out.

Four lighting moods cycle with the waves (bluebird morning, high noon, golden hour, last
light). All colours come from `FL.Look` (js/look.js): sun direction, moods, material
albedos, the forest-edge dimensions, and how big each obstacle is drawn.

## 2. World and coordinates

- World: +Y up. A track heading of yaw 0 points along **−Z**; +X is to the right. Metres.
- Track space: `s` = distance along the centreline, `o` = offset to the right of it,
  height above the centreline surface.
- `track.frameAt(s, out)` gives the centreline frame: `x y z yaw sl cv bk pal int`
  (position, heading, slope as drop per metre, curvature, bank, palette/mood coordinate,
  intensity 0..1). World position of track point (s, o, h):
  `x + cos(yaw)*o, y + h, z + sin(yaw)*o`. Forward (horizontal) is `(sin yaw, −cos yaw)` in
  (x, z); right is `(cos yaw, sin yaw)`.
- **Camera-relative rendering.** Positions sent to the GPU are relative to the camera:
  subtract `R.cam.{x,y,z}` in JavaScript (doubles) first. `uVP` expects camera-relative
  positions. For static geometry, store positions relative to a nearby origin and pass
  `origin − cam` as a uniform.
- The sun is fixed in the world (`FL.Look.SUN`), ahead and to the right, 28° up. Shadows fall
  back up the slope toward the camera, about 1.9 m per metre of height.

## 3. Files and who owns them

```
index.html            page, CSS                         HUD
fonts/                embedded type                     HUD
js/util.js            maths, RNG, tuning constants      core
js/look.js            sun, moods, materials, sizes      core
js/track.js           the generator and track queries   core
js/sim.js             physics, scoring, camera rig      core
js/main.js            loop, input, run control          core
js/hud.js             DOM overlay (FL.Hud)              HUD
js/audio.js           sound (FL.Audio)                  audio
js/gfx/core.js        renderer core, shared GLSL, post  core
js/gfx/piste.js       snow, shoulders, rock, shadows    core
js/gfx/stub.js        stand-ins until real layers land  core
js/gfx/sky.js         sky, sun, far mountains, valley   sky
js/gfx/scenery.js     rock spires in the mid-distance   sky
js/gfx/flora.js       pines: obstacles and forest       flora
js/gfx/props.js       boulders, safety fences, ice strips  props
js/gfx/markers.js     run banners, piste marker poles   markers
js/gfx/skier.js       the skier                         skier
js/gfx/snowfx.js      powder spray, bursts, spindrift   snowfx
js/gfx/tracks.js      ski tracks, crystals in the air   tracks
tests/, tools/        bots, playtests, screenshots, build  tests/build
```

Plain scripts on one global, `FL`; no modules, no build step, so the game runs from
`file://`. Every file is an IIFE `(function (root) { 'use strict'; … })(window)`.
Load order is fixed in index.html. **Only edit the files you own.** If you need something from
a file you do not own, say so in your report rather than changing it.

## 4. Writing a renderer layer

A layer is an object registered with `FL.Gfx.layer({...})`. The core calls it:

```js
FL.Gfx.layer({
  name: 'flora',            // unique; registering 'flora' switches off the stand-in 'stub-flora'
  order: 30,                // lower draws first within each pass
  init(R) {},               // create programs/buffers. Called again if the GL context is restored: recreate everything.
  prepare(R, v, dt) {},     // once a frame before any drawing: animate, fill instance buffers
  drawOpaque(R, v) {},      // depth test + write on, blending off, culling off
  drawBlend(R, v) {},       // depth test on, depth write OFF, blending on: premultiplied alpha (ONE, ONE_MINUS_SRC_ALPHA)
  onEvent(R, e, v) {},      // simulation events, see below
  reset(R) {},              // a new run starts: clear particles, trails, per-run state
  freeRibbon(R, rb) {},     // this ribbon has scrolled away (or its track was discarded): free what you cached on it
  releaseTrack(R, track) {} // a whole track is being discarded; freeRibbon has already been called for its ribbons
});
```

- The core sets the GL state described above before each call. Change what you need
  (blend function, polygon offset, depth func) and do not worry about restoring it, but always
  leave `gl.bindVertexArray(null)` when you finish.
- Cache per-ribbon GPU data on the ribbon under your own key (`rb.flora = {gen: R.gen, …}`),
  rebuild it when `gen !== R.gen`, and free it in `freeRibbon`. A new run makes a new Track.
- If any call throws, the core logs it and switches that layer off; the game carries on.
  A shader that fails to compile throws from `R.program`, so a broken shader shows up as
  `layerName(DEAD)` in `tools/shot.mjs` output. Treat that as a failure to fix.
- Orders in use: piste 10, tracks 12, props 20, markers 22, flora 30, skier 40, scenery 50,
  snowfx 60, dust 62, sky 90
  (the sky draws last in the opaque pass with `gl.depthFunc(gl.LEQUAL)` at depth 1).

### R, the renderer

| | |
|---|---|
| `R.gl` | the WebGL2 context |
| `R.program(name, vs, fs)` | compile a program. Pass shader **bodies**: `#version 300 es`, precision, the `Frame` uniform block and the `fl*` functions are prepended for you. Returns `{ p, u }`, `u` = uniform locations by name. Use `layout(location=N)` on attributes. |
| `R.buffer(dataOrByteSize, usage)` | new ARRAY_BUFFER, left bound |
| `R.attr(loc, size, strideFloats, offsetFloats, divisor)` | float attribute on the bound buffer |
| `R.place(track, item)` | world placement of anything with `s, o, e` (obstacle, boost strip): `[x, y, z, yaw, dyds]`, cached on the item, y at ground level |
| `R.cam` | `{x, y, z}` camera world position (doubles) |
| `R.camR, R.camU, R.camF` | camera right / up / forward, world unit vectors |
| `R.skier` | `{x, y, z, vx, vy, vz, yaw, cs, sn, sl, bk}` the skier's feet in world space, world velocity, and the track frame under them (cs/sn = cos/sin of yaw) |
| `R.mood` | current interpolated mood: `skyTop skyHor valley lit shade sun glow` (linear rgb), `fog`, `haze` |
| `R.notch` | quality 0 (best) … 5. Scale counts/detail down as it rises; the core lowers resolution and MSAA itself |
| `R.gen` | increments when the GL context is recreated; tag cached GPU objects with it |
| `R.emptyVao` | for full-screen triangles drawn from `gl_VertexID` |
| `R.has(name)` | is a live layer with this name registered |
| `FL.Gfx.CUBE` / `FL.Gfx.QUAD` | Float32Array geometry: cube −1..1 as 36 × (pos3, normal3); quad −1..1 as 6 × pos2 |

### Shared GLSL (already in every shader)

```glsl
uniform Frame {
  mat4 uVP;        // camera-relative world -> clip
  mat4 uInvVP;
  vec4 uSun;       // xyz: unit direction TO the sun.  w: diffuse scale
  vec4 uSunCol;    // rgb: sunlight = lit snow minus shaded snow
  vec4 uAmb;       // rgb: sky fill = colour of white snow in shadow
  vec4 uBounce;    // rgb: light thrown back up off the snow
  vec4 uSkyTop;    // rgb
  vec4 uSkyHor;    // rgb: sky at the horizon = haze colour
  vec4 uValley;    // rgb: the depths below the horizon
  vec4 uFogP;      // x density, y exponent, z max
  vec4 uShadow;    // xy: unit ground direction (x,z) shadows fall in. z: shadow length per metre of height
  vec4 uCamW;      // xyz: camera world position wrapped to 512 m. w: time (s)
  vec4 uMisc;      // x: music beat 1->0. y: speed 0..1. z: boost 0..1. w: quality notch
  vec4 uView;      // xy: render size px. z: aspect. w: tan(fovY/2)
  vec4 uSkier;     // xyz: skier's feet, camera-relative. w: height above snow (99 = no skier)
  vec4 uGlow;      // rgb: glow around the sun. a: haziness
  vec4 uCamR;      // xyz: camera right
  vec4 uCamU;      // xyz: camera up
};
#define uTime uCamW.w
float flHash(vec2 p);                         // 0..1
float flNoise(vec2 p);                        // smooth value noise 0..1
vec3  flAtmo(vec3 dir);                       // clear-air colour along a unit direction (sky above, valley below)
vec3  flFog(vec3 col, vec3 camRelPos);        // aerial perspective: ALWAYS finish opaque colours with this
vec3  flLight(vec3 albedo, vec3 n, float sh); // the light. n: unit world normal. sh: 1 in sun .. 0 in cast shadow
vec3  flFacet(vec3 camRelPos);                // fragment only: flat-facet world normal from derivatives
```

Colours are linear; the target is HDR and tone-mapped at the end. Sunlit snow is about 1.0.
Only values above ~1.05 bloom, so use that for glints, ice sparkle and the sun, nothing else.
For billboards use `uCamR`/`uCamU`. Blended layers must output premultiplied alpha.

### v, the view state for this frame

`v.track` the Track · `v.mode` `'title' | 'run' | 'dead'` · `v.time` seconds (real) ·
`v.dt` visual seconds this frame (already slow-motion scaled; use it for your animation) ·
`v.calm` true if the player asked for reduced motion (tone down shake, flashes, big bursts)

Skier: `v.s v.o` track position · `v.y` feet height (world) · `v.u` speed along the track
(m/s, ~28 at the start to ~75 late) · `v.vo` sideways speed (m/s, up to ±20) · `v.vy` ·
`v.inp` steering input −1/0/1 · `v.carve` −1..1, eased: how hard they are turning and which
way (use this for lean, spray and edge sound) · `v.onGround` · `v.air` seconds airborne ·
`v.hAbove` metres above the snow · `v.edge` metres to the nearest piste edge when grounded ·
`v.edgeSide` −1/1 · `v.gb` bank of the snow under them · `v.falling` · `v.boost` m/s of
active boost (0 = none) · `v.mult` 1..5 · `v.wave` · `v.alive` · `v.skierOn` draw the skier? ·
`v.cause` `'crash' | 'fall'` · `v.into` what was hit (`pine pines rock fence trees`) ·
`v.deadT` seconds since the run ended · `v.cam` the camera rig

### Events (`onEvent(R, e, v)`)

`{type:'boost'}` hit an ice strip · `{type:'flow', mult, why:'boost'|'near'}` multiplier went
up · `{type:'flowDown', mult}` · `{type:'pass', ob, side, cl}` passed obstacle `ob`; `side` is
which side of the skier it was on (−1 left, 1 right), `cl` the clearance in metres ·
`{type:'air'}` left the ground · `{type:'land', v, air}` touched down (`v` = impact speed
m/s, `air` = seconds) · `{type:'fall'}` went off an edge · `{type:'dead', cause, into}`.

### The track's data

- `track.F` — centreline arrays indexed by section `k` (`s = k*2`): `x y z yaw sl cv bk pal int`.
- `track.ribbons` — drivable surfaces. Each: `k0` first section, `n` sections, `sA`/`sB` its
  s-range, and per-section `Float32Array`s `c` (centre offset), `hw` (half-width), `e` (height
  above the centreline), `b` (bank: surface height is `F.y + e + (o − c)*b`), plus `wl`/`wr`:
  per-section 0/1 (or `null`), 1 where that side is forest. `capA`/`capB`: the snow ends there (a gap).
- `track.obstacles` (sorted by `s`): `s, o, hx` (half-width across the piste), `hz` (half-depth
  along it), `h` (height), `kind` (`'pine' | 'pines' | 'rock' | 'fence'`), `flag` (fence only:
  1 if its right end borders the opening you ski through, −1 if its left end does), `seed` 0..1,
  `e`, `b` (bank there). The hit box is exactly `hx` × `hz`; **what you draw must fill it and
  not look smaller than it**, or deaths will feel unfair.
- `track.pads` — boost strips (ice): `s, o, hx (1.1), hz (3), e, b, used`.
- `track.crags` — scenery positions: `x, y (top), z, r, h, yaw, seed, s`.
- `track.arches` — `{ s, hw, wave }`: a banner over the piste where wave `wave` begins.
- Items behind the camera are pruned for you; anything in these lists is worth drawing.
  Skip items with `s < v.s − v.cam.back − 12`.
- `FL.Look.trees(ob, out)` gives the pines a `'pine'`/`'pines'` obstacle is made of
  (`[offset, base radius, height]` each) — the snow's shadows use the same numbers.
- `FL.Look.WALL` — the forest edge: first row of trunks `inset` (1.15 m) beyond the piste edge,
  one tree every `spacing` (2.35 m) with centres at `(cell + 0.5) * spacing` in s, `rows` rows
  `rowGap` apart, heights `hMin..hMax`, base radius `r`, on a snow shoulder `shoulder` wide.
  The piste shader draws their shadows from these numbers, so keep to them.

## 5. Budgets and rules

- **120 fps on a laptop, 60 on a phone.** No allocations per frame in anything you write:
  preallocate typed arrays, reuse scratch objects, no closures or array literals in hot paths.
- Draw calls: a handful per layer. Instance everything that repeats. Static things (a forest
  along a chunk of track) go in a static buffer built once, drawn with an origin uniform.
- Fragment cost is what hurts on phones: keep shaders short, no loops over more than a few
  items, no more than ~3 noise lookups per fragment for large surfaces.
- Respect `R.notch`: at 3 and above, halve particle counts and skip secondary detail.
- Everything visual must be deterministic from track data and `seed`s (use `FL.Look.hash`),
  never from `Math.random()`, so a seed always looks the same. Particles may use randomness.
- Game play is identical at every refresh rate because the simulation runs in fixed 120 Hz
  steps. Layers animate with `v.dt` and must not assume a frame rate.
- Comments say why, briefly. Match the style of the existing files.

## 6. Looking at your work

```bash
node tools/shot.mjs --out /path/shot.png                      # 9 s into a run, best quality
node tools/shot.mjs --out a.png --state title
node tools/shot.mjs --out a.png --until slalom --frames 40    # inside a slalom section
node tools/shot.mjs --out a.png --ff 20 --steer L40,R40 --frames 80 --every 20   # a motion strip while carving
node tools/shot.mjs --out a.png --ff 20 --steer L40,R40 --frames 80 --every 20 --sheet 3   # ...as ONE contact sheet
node tools/sheet.mjs --out all.png --cols 3 a.png b.png c.png   # tile separate shots into one image
node tools/shot.mjs --out a.png --only piste,flora            # just these layers
node tools/shot.mjs --out a.png --size 390x844 --touch --dpr 2   # a phone
node tools/shot.mjs --out a.png --until field --debug          # overlay the real hit boxes and kill lines
node tools/shot.mjs --help-ish: see the comment at the top of the file for every option
```

It drives the real page with a bot, renders frames at exactly 1/60 s, prints which layers
are alive, and exits 1 on any console error. Look at the PNGs: that is the test. Section
types you can ask for with `--until`: start, open, slalom, gates, field, sweep, tilt,
bridge, split, jump, islands, drop, rest. Seeds 1–9 give different tracks.

`node tests/run.js fair 4 15000` replays a perfect-play bot (must print `deaths 0/4`);
`node tests/run.js human 16 15000` shows how far imperfect players get.
