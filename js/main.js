/* Fall Line — game loop, input and run control. Simulation in js/sim.js, drawing in js/gfx/,
   DOM in js/hud.js, sound in js/audio.js; this file wires them together. */
(function () {
  'use strict';
  const FL = window.FL, { C, Sim, Track, U, Hud } = FL;
  const { clamp, damp, lerp } = U;
  const qs = new URLSearchParams(location.search);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: play on without saving */ } },
  };
  const calm = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);

  const canvas = document.getElementById('gl');
  let best = Math.max(0, +store.get('fallline.best', 0) || 0);
  const audio = new FL.Audio();
  audio.muted = store.get('fallline.muted', '0') === '1';
  Hud.init({ best, muted: audio.muted, touch: coarse });

  let R;
  try {
    R = new FL.Gfx.Renderer(canvas, {
      mobile: coarse, notch: qs.has('q') ? +qs.get('q') : undefined, lockQuality: qs.has('q'), preserve: qs.has('shot'),
      only: qs.has('only') ? qs.get('only').split(',') : null,
    });
  } catch (err) {
    Hud.fail();
    console.error(err);
    return;
  }

  const newSeed = () => (qs.has('seed') ? +qs.get('seed') : (Math.random() * 4294967296) >>> 0);
  let track = new Track(newSeed());
  const st = Sim.newState(), prev = Sim.newState(), cam = Sim.newCam(), camP = Sim.newCam();
  Sim.reset(st, track); Sim.copy(prev, st);

  let mode = 'title', paused = false, acc = 0, last = 0, ts = 1, tsTarget = 1, tReal = 0;
  let flash = 0, fade = 1, veil = 0, deadAt = 0, pruneT = 0, beaten = false, passSide = 1, fallbackBar = 0;
  let wave = 0, y0 = st.y, carve = 0, lastInp = 0;
  const ev = [];
  const SF = { h: 0, b: 0, edge: 0, d: 0, hw: 0, rb: null, wall: 0, wallH: 0 };
  const FRM = { x: 0, y: 0, z: 0, yaw: 0, sl: 0, cv: 0, bk: 0, pal: 0, int: 0 };

  /* The view: everything the renderer and its layers may read about this frame.
     Documented field by field in docs/DESIGN.md. */
  const view = {
    track, mode: 'title', time: 0, dt: 0, rawDt: 0.016, calm,
    s: 0, o: 0, y: 0, u: 0, vo: 0, vy: 0, inp: 0, carve: 0,
    onGround: true, air: 0, hAbove: 0, edge: 9, edgeSide: 1, gb: 0, falling: false,
    boost: 0, mult: 1, wave: 0,
    alive: true, skierOn: true, cause: '', into: '', deadT: 0,
    cam: Sim.newCam(), beat: 0, bar: 0, flash: 0, fade: 1, veil: 0,
  };

  // ------------------------------------------------------------------ run control
  const showMute = () => Hud.setMuted(audio.muted);
  const toggleMute = () => { audio.setMuted(!audio.muted); store.set('fallline.muted', audio.muted ? '1' : '0'); showMute(); };
  Hud.onMute(() => { audio.init(); toggleMute(); });

  function start() {
    Sim.launch(st);
    mode = 'run'; ts = tsTarget = 1; acc = 0; wave = 0; y0 = st.y;
    Hud.setMode('run');
    audio.launch();
  }

  function restart() {
    const old = track;
    track = view.track = new Track(newSeed());
    R.releaseTrack(old); R.reset();
    Sim.reset(st, track); Sim.copy(prev, st);
    Object.assign(cam, Sim.newCam()); Object.assign(camP, cam);
    beaten = false; flash = 0; fade = 0.35; veil = 0; carve = 0;
    start();
  }

  function onDead(e) {
    mode = 'dead'; deadAt = tReal; ts = tsTarget = 0.28;
    cam.trauma = calm ? 0.25 : e.cause === 'crash' ? 1 : 0.55;
    flash = calm ? 0 : e.cause === 'crash' ? 0.22 : 0.06;
    if (e.cause === 'crash') audio.crash(e.into); else audio.land(26);
    const score = Math.floor(st.score), isNew = score > best;
    if (isNew) { best = score; store.set('fallline.best', String(best)); }
    Hud.over({ score, best, isNew: isNew && score > 0, dist: st.s - C.S_START, vert: Math.max(0, y0 - st.y), wave });
  }

  function setPaused(p) {
    if (p === paused || (p && mode !== 'run')) return;
    paused = p;
    Hud.setPaused(p);
    if (p) audio.suspend();
    else { audio.resume(); ts = 0.25; tsTarget = 1; last = 0; }
  }

  // Any key or tap: start, retry or resume. Returns true if it did something.
  function press() {
    audio.init();
    if (paused) { setPaused(false); return true; }
    if (mode === 'title') { start(); return true; }
    if (mode === 'dead' && tReal - deadAt > 0.4) { restart(); return true; }
    return false;
  }

  function handle(e) {
    switch (e.type) {
      case 'boost': audio.boost(st.mult); cam.trauma = Math.max(cam.trauma, calm ? 0 : 0.28); break;
      case 'flow':
        if (e.why === 'near') { audio.near(st.mult, passSide); cam.trauma = Math.max(cam.trauma, calm ? 0 : 0.34); }
        Hud.flow(e.mult, e.why);
        break;
      case 'flowDown': audio.flowDown(); break;
      case 'pass': passSide = e.side; if (e.cl < 4.5) audio.pass(e.side, clamp(1 - e.cl / 4.5, 0, 1), e.ob.kind); break;
      case 'land': audio.land(e.v); cam.trauma = Math.max(cam.trauma, calm ? 0 : clamp(e.v / 42, 0.12, 0.55)); break;
      case 'fall': audio.fall(); break;
      case 'dead': onDead(e); break;
    }
    R.onEvent(e, view);
  }

  // ------------------------------------------------------------------ input
  const input = { left: false, right: false, lastSide: 0, dir: 0 };
  const touches = [];                                   // active pointers, oldest first
  function refreshDir() {
    if (touches.length) input.dir = touches[touches.length - 1].side;       // newest finger wins
    else input.dir = input.left && input.right ? input.lastSide : input.left ? -1 : input.right ? 1 : 0;
  }
  function key(side, down) {
    if (side < 0) input.left = down; else input.right = down;
    if (down) input.lastSide = side;
    refreshDir();
  }
  const SIDE = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
  const IGNORE = { Tab: 1, ShiftLeft: 1, ShiftRight: 1, ControlLeft: 1, ControlRight: 1, AltLeft: 1, AltRight: 1, MetaLeft: 1, MetaRight: 1, CapsLock: 1 };
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const side = SIDE[e.code];
    if (side) { key(side, true); e.preventDefault(); }
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'ArrowDown') e.preventDefault();
    if (e.repeat) return;
    Hud.setTouch(false);
    if (e.code === 'KeyM') { audio.init(); toggleMute(); return; }
    if (e.code === 'KeyP' || e.code === 'Escape') { if (mode === 'run') setPaused(!paused); return; }
    if (IGNORE[e.code] || /^F\d+$/.test(e.code)) return;
    press();
  });
  window.addEventListener('keyup', (e) => { const side = SIDE[e.code]; if (side) key(side, false); });
  window.addEventListener('blur', () => { input.left = input.right = false; touches.length = 0; refreshDir(); if (mode === 'run' && !hook.manual) setPaused(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (mode === 'run') setPaused(true); else audio.suspend(); } else if (!paused) audio.resume(); });

  const sideOf = (x) => (x < window.innerWidth / 2 ? -1 : 1);
  window.addEventListener('pointerdown', (e) => {
    if (Hud.isMuteTarget(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType !== 'mouse') Hud.setTouch(true);
    e.preventDefault();
    if (press() && mode !== 'run') return;
    touches.push({ id: e.pointerId, side: sideOf(e.clientX) });
    refreshDir();
  }, { passive: false });
  window.addEventListener('pointermove', (e) => {
    for (const t of touches) if (t.id === e.pointerId) { t.side = sideOf(e.clientX); refreshDir(); }
  });
  const lift = (e) => {
    for (let i = touches.length - 1; i >= 0; i--) if (touches[i].id === e.pointerId) touches.splice(i, 1);
    refreshDir();
  };
  window.addEventListener('pointerup', lift);
  window.addEventListener('pointercancel', lift);
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  // stop iOS rubber-banding / double-tap zoom stealing the first frames of a run
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  const dirty = () => { R.dirtySize = true; };
  window.addEventListener('resize', dirty);
  window.addEventListener('orientationchange', dirty);
  if (window.ResizeObserver) new ResizeObserver(dirty).observe(canvas);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); setPaused(true); });
  canvas.addEventListener('webglcontextrestored', () => { R.init(); });

  // ------------------------------------------------------------------ loop
  /* FL.game: a handle for tests and tools.
       bot        — function (state, track) -> -1 | 0 | 1 that replaces player input
       ff(sec)    — run the simulation ahead without drawing
       manual     — set true to stop the game driving itself from requestAnimationFrame
       tick(dt)   — then draw exactly one frame, advancing by dt seconds                    */
  const hook = FL.game = {
    st, cam, R, audio, press, input, view, bot: null, manual: false,
    get track() { return track; }, get mode() { return mode; }, get paused() { return paused; }, get wave() { return wave; },
  };

  function stepOnce() {
    Sim.copy(prev, st); Object.assign(camP, cam);
    ev.length = 0;
    lastInp = mode === 'run' ? (hook.bot ? hook.bot(st, track) : input.dir) : 0;
    Sim.step(st, track, lastInp, ev, false);
    Sim.camStep(cam, st, track);
    for (let i = 0; i < ev.length; i++) handle(ev[i]);
    while (track.marks.length && track.marks[0].s <= st.s) {
      const m = track.marks.shift();
      wave = m.wave;
      if (mode === 'run') { audio.gate(); Hud.wave(wave); }
    }
    track.ensure(st.s + C.GEN_AHEAD);
  }
  hook.ff = (sec) => {
    for (let i = 0, n = Math.round(sec / C.STEP); i < n && mode === 'run'; i++) {
      stepOnce();
      if (i % 30 === 0) track.prune(st.s - C.PRUNE_BEHIND);
    }
    R.reset();
  };
  hook.tick = (dt) => advance(dt);

  function frame(now) {
    requestAnimationFrame(frame);
    if (hook.manual) return;
    if (!last) last = now;
    let rawDt = (now - last) / 1000;
    last = now;
    if (rawDt > 0.1) rawDt = 0.1;
    if (rawDt < 0) rawDt = 0;
    if (paused) { if (R.dirtySize) draw(0, rawDt); return; }
    advance(rawDt);
  }

  function advance(rawDt) {
    tReal += rawDt;
    ts = damp(ts, tsTarget, 3.2, rawDt);
    const dt = rawDt * ts;

    if (mode === 'title') {
      cam.o = Math.sin(tReal * 0.33) * 1.5; cam.look = -cam.o * 0.5; cam.back = 8.6; cam.fov = 60; cam.h = 0.3;
      Sim.copy(prev, st); Object.assign(camP, cam);
      acc = 0;
    } else {
      acc += dt;
      let n = 0;
      while (acc >= C.STEP) {
        stepOnce();
        acc -= C.STEP;
        if (++n >= 8) { acc = 0; break; }       // a long stall slows the game instead of snowballing
      }
    }
    pruneT += rawDt;
    if (pruneT > 0.25) { pruneT = 0; track.prune(st.s - C.PRUNE_BEHIND); }

    if (mode === 'run') {
      const sc = Math.floor(st.score);
      Hud.setScore(sc);
      Hud.setFlow(st.mult, st.flowT / C.FLOW_T);
      if (!beaten && best > 0 && sc > best) { beaten = true; Hud.newBest(); audio.best(); }
    }
    flash = damp(flash, 0, 7, rawDt);
    fade = damp(fade, 1, 9, rawDt);
    veil = damp(veil, mode === 'dead' ? 0.62 : 0, 5, rawDt);
    draw(dt, rawDt);
  }

  function draw(dt, rawDt) {
    const a = mode === 'title' ? 1 : acc / C.STEP, v = view;
    v.s = lerp(prev.s, st.s, a); v.o = lerp(prev.o, st.o, a); v.y = lerp(prev.y, st.y, a);
    v.u = lerp(prev.u, st.u, a); v.vo = lerp(prev.vo, st.vo, a); v.vy = lerp(prev.vy, st.vy, a);
    v.inp = mode === 'run' ? lastInp : 0;
    v.onGround = st.onGround; v.air = st.air; v.gb = st.gb; v.falling = st.falling;
    v.boost = st.boost; v.mult = st.mult; v.wave = wave;
    v.alive = st.alive; v.cause = st.cause; v.into = st.into; v.deadT = st.deadT;
    v.skierOn = st.alive || st.cause === 'fall';
    // how hard the skier is turning, -1 left .. 1 right, eased: what lean, spray and edge noise follow
    const want = mode === 'run' && st.alive ? clamp(v.inp * 0.75 + (st.vo / C.V_LAT) * 0.55, -1, 1) : 0;
    carve = damp(carve, want, st.onGround ? 11 : 4, dt);
    v.carve = carve;
    const c = v.cam;
    c.o = lerp(camP.o, cam.o, a); c.h = lerp(camP.h, cam.h, a); c.roll = lerp(camP.roll, cam.roll, a) * (calm ? 0.3 : 1);
    c.fov = lerp(camP.fov, cam.fov, a); c.back = lerp(camP.back, cam.back, a); c.look = lerp(camP.look, cam.look, a);
    c.kick = lerp(camP.kick, cam.kick, a) * (calm ? 0.3 : 1); c.trauma = cam.trauma;
    // what is under the skier right now: height above it, and which edge is close
    const code = track.surfaceAt(v.s, v.o, v.y + 0.3, SF);
    v.hAbove = code === 1 ? Math.max(0, v.y - SF.h) : 40;
    v.edge = code === 1 && st.onGround ? SF.edge : 9;
    v.edgeSide = SF.d < 0 ? -1 : 1;
    v.time = tReal; v.dt = dt; v.rawDt = rawDt; v.mode = mode;
    v.flash = flash; v.fade = fade; v.veil = veil;
    v.beat = audio.beat();
    let bar = audio.barPhase();
    if (bar < 0 || mode !== 'run') { fallbackBar = (fallbackBar + rawDt / 1.94) % 1; bar = fallbackBar; }
    v.bar = bar;
    R.frame(dt, v);
    audio.update({
      mode: paused ? 'pause' : mode, u: v.u, onGround: st.onGround, boost: st.boost > 0, edge: v.edge < 0.55,
      carve, air: st.air, mult: st.mult, I: track.frameAt(st.s, FRM).int,
    });
  }

  requestAnimationFrame(frame);
})();
