/* Fall Line — sound. Everything is synthesised with WebAudio at run time: no audio files.

   Three families, all into one protected output (compressor, then a soft clipper that cannot exceed 0.95):
   - the mountain: looping filtered noise for ski hiss, the carving "shhhk", low snow rumble, wind and the
     crunch of a piste edge. update() steers their gains and filters every frame, with no allocation.
   - one-shots: whooshes, chimes, whumpfs and crashes, built from short noise bursts and sine/triangle
     tones. Anything with a pitch reads the chord the music is on, so it lands in key.
   - music: a small step sequencer in D major / G lydian. Mallet plucks, a warm pad, a soft kick and
     brushed, shaker-like percussion; the layers follow the intensity of the stretch you are skiing.

   Every source that is started is given a stop time and is disconnected when it ends; `live` counts the
   sources currently alive. */
(function (root) {
  'use strict';
  const FL = root.FL;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const BPM = 124, STEP = 60 / BPM / 4, BAR = STEP * 16;
  // Two bars each: Dadd9, Gmaj7#11 (the lydian colour), Bm7, Asus2. `plk` ascends: effects index into it.
  const CHORDS = [
    { root: 50, plk: [62, 66, 69, 71, 76], pad: [57, 62, 66] },
    { root: 43, plk: [59, 62, 66, 71, 73], pad: [55, 62, 66] },
    { root: 47, plk: [59, 62, 66, 69, 74], pad: [54, 59, 62] },
    { root: 45, plk: [57, 61, 64, 69, 71], pad: [57, 61, 64] },
  ];
  const CALM_A = [0, -1, -1, -1, -1, -1, 2, -1, -1, -1, 4, -1, -1, -1, 1, -1];
  const CALM_B = [3, -1, -1, -1, 1, -1, -1, -1, -1, -1, 2, -1, -1, -1, -1, -1];
  const MID = [0, -1, 2, -1, 1, -1, 3, -1, 2, -1, 4, -1, 3, -1, 1, -1];
  const FULL = [0, 2, 1, 3, 2, 4, 3, 1, 0, 2, 4, 3, 2, 3, 1, 2];
  const BASS_M = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
  const BASS_F = [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0];
  const MASTER = 0.9;

  // shared by every one-shot source: count it out and cut its chain loose so it can be collected
  function onEnd() {
    const a = this._fl;
    if (a) { a.live--; this._fl = null; }
    if (this._out) { try { this._out.disconnect(); } catch (e) { /* already gone */ } this._out = null; }
    this.onended = null;
  }

  class Audio {
    constructor() {
      this.ctx = null; this.muted = false; this.I = 0; this.mode = 'title'; this.live = 0;
      this.step = 0; this.nextT = 0; this.k0 = -9; this.k1 = -9; this.barT = 0; this.barP = 0;
      this.chord = CHORDS[0]; this.timer = 0; this._failed = false;
      this._tv = new Float32Array(16).fill(-1e9); this._now = 0; this._ut = 0; this._pt = -9;
    }

    // Must be called from inside a user gesture the first time. Safe to call again.
    init() {
      if (this.ctx) { if (this.ctx.state !== 'running') this.resume(); return; }
      if (this._failed) return;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) { this._failed = true; return; }
      let ctx;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { this._failed = true; return; }
      try { this._build(ctx); } catch (e) {
        this._failed = true; this.ctx = null;
        try { ctx.close(); } catch (e2) { /* nothing to do */ }
        return;
      }
      this.ctx = ctx;
      this.nextT = ctx.currentTime + 0.08; this.barT = this.barP = this.nextT; this._ut = ctx.currentTime;
      this.timer = setInterval(() => this._schedule(), 25);
    }

    _build(ctx) {
      const sr = ctx.sampleRate;
      const G = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
      const F = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
      this.canPan = !!ctx.createStereoPanner;

      // output: master -> compressor -> soft clipper. The clipper is linear below 0.5 and can never pass 0.95.
      this.master = G(this.muted ? 0 : MASTER);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -17; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
      const pre = G(0.5 * 0.85), shaper = ctx.createWaveShaper(), N = 2049, curve = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1) * 2 - 1) * 2, ax = Math.abs(x);
        const y = ax < 0.5 ? ax : 0.5 + 0.45 * Math.tanh((ax - 0.5) / 0.45);
        curve[i] = x < 0 ? -y : y;
      }
      shaper.curve = curve;
      this.master.connect(comp); comp.connect(pre); pre.connect(shaper); shaper.connect(ctx.destination);
      this.out = shaper;

      // noise: white for hiss and spray, pink for wind and body. Both loop without a seam.
      const mkNoise = (secs, pink) => {
        const len = Math.floor(sr * secs), X = 2048, tmp = new Float32Array(len + X);
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < len + X; i++) {
          const w = Math.random() * 2 - 1;
          if (pink) {
            b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
            tmp[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
          } else tmp[i] = w;
        }
        const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = i < X ? tmp[i] * (i / X) + tmp[len + i] * (1 - i / X) : tmp[i];
        return buf;
      };
      this.white = mkNoise(2, false); this.pink = mkNoise(3, true);

      // a little mountain air: a generated impulse response
      const ilen = Math.floor(sr * 1.5), ir = ctx.createBuffer(2, ilen, sr);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < ilen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ilen, 2.8);
      }
      this.verb = ctx.createConvolver(); this.verb.buffer = ir;
      const vg = G(0.3); this.verb.connect(vg); vg.connect(this.master);

      // music buses
      this.music = G(0); this.musicF = F('lowpass', 2600, 0.4);
      this.music.connect(this.musicF); this.musicF.connect(this.master);
      this.mvs = G(0); this.mvs.connect(this.verb);                         // music -> reverb, follows the music level
      this.padBus = G(0.028); this.padBus.connect(this.music); this.padBus.connect(this.mvs);
      this.plk = G(1); this.plk.connect(this.music);
      const pv = G(0.5); this.plk.connect(pv); pv.connect(this.mvs);
      const echo = ctx.createDelay(1); echo.delayTime.value = STEP * 3;
      const ein = G(0.3), ef = F('lowpass', 2400, 0.5), fb = G(0.3);
      this.plk.connect(ein); ein.connect(echo); echo.connect(ef); ef.connect(fb); fb.connect(echo); ef.connect(this.music);
      this.shk = F('highpass', 5200, 0.6); this.shk.connect(this.music);
      this.bassF = F('lowpass', 520, 0.5); this.bassF.connect(this.music);

      // effect buses
      this.sfx = G(0.8); this.sfx.connect(this.master);
      this.vsend = G(0.4); this.vsend.connect(this.verb);

      // the mountain: continuous layers, steered by update()
      const loop = (buf, off) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, off); this.live++; return s; };
      const layer = (buf, off, type, f, q) => {
        const s = loop(buf, off), flt = F(type, f, q), g = G(0);
        s.connect(flt); flt.connect(g); g.connect(this.sfx);
        return { f: flt, g };
      };
      this.hiss = layer(this.white, 0.1, 'bandpass', 3000, 0.6);
      this.rumble = layer(this.pink, 0.3, 'lowpass', 170, 0.5);
      this.wind = layer(this.pink, 1.7, 'bandpass', 420, 0.5);
      this.edge = layer(this.white, 1.3, 'bandpass', 1350, 1.6);
      // the carve: a bright gritty band plus a lower body, one gain, panned to the working edge
      const cs = loop(this.white, 0.8), cb = G(0.5);
      this.carveA = F('bandpass', 3400, 1.0); this.carveB = F('bandpass', 800, 0.9); this.carveG = G(0);
      cs.connect(this.carveA); cs.connect(this.carveB); this.carveA.connect(this.carveG); this.carveB.connect(cb); cb.connect(this.carveG);
      if (this.canPan) { this.carveP = ctx.createStereoPanner(); this.carveG.connect(this.carveP); this.carveP.connect(this.sfx); } else { this.carveP = null; this.carveG.connect(this.sfx); }
    }

    setMuted(m) {
      this.muted = !!m;
      if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER, this.ctx.currentTime, 0.02);
    }

    suspend() { if (this.ctx && this.ctx.state === 'running') { const p = this.ctx.suspend(); if (p && p.catch) p.catch(() => {}); } }
    resume() { if (this.ctx && this.ctx.state !== 'running') { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); } }

    // ------------------------------------------------------------------ plumbing
    _start(src, tail, t0, t1, off) {
      src._fl = this; src._out = tail; src.onended = onEnd; this.live++;
      if (off >= 0) src.start(t0, off); else src.start(t0);
      src.stop(t1);
    }

    _env(g, t, peak, a, d) {
      const p = g.gain;
      p.setValueAtTime(0.0001, t);
      p.exponentialRampToValueAtTime(peak > 0.0002 ? peak : 0.0002, t + a);
      p.exponentialRampToValueAtTime(0.0001, t + a + d);
    }

    // effects: optional pan, optional reverb send; returns the node to cut loose when the source ends
    _route(g, pan, send) {
      let out = g;
      if (pan && this.canPan) { const p = this.ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); out = p; }
      out.connect(this.sfx);
      if (send) out.connect(this.vsend);
      return out;
    }

    _tone(type, f0, f1, t, dur, v, pan, send, a) {
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      a = a || 0.004;
      o.type = type; o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + a + dur);
      this._env(g, t, v, a, dur);
      o.connect(g);
      this._start(o, this._route(g, pan, send), t, t + a + dur + 0.03, -1);
    }

    _noise(buf, type, f0, f1, q, t, dur, v, pan, a, send) {
      const ctx = this.ctx, s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
      a = a || 0.003;
      s.buffer = buf; s.loop = true;
      fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) fl.frequency.exponentialRampToValueAtTime(f1, t + a + dur);
      this._env(g, t, v, a, dur);
      s.connect(fl); fl.connect(g);
      this._start(s, this._route(g, pan, send), t, t + a + dur + 0.03, Math.random() * 1.5);
    }

    // glassy chime: a sine and one inharmonic bell partial that dies quickly
    _bell(f, t, dur, v, pan) {
      this._tone('sine', f, f, t, dur, v, pan, true, 0.003);
      if (f * 2.76 < 11000) this._tone('sine', f * 2.76, f * 2.76, t, dur * 0.35, v * 0.2, pan, true, 0.002);
    }

    _note(i, oct) { const ch = this.chord || CHORDS[0]; return mtof(ch.plk[clamp(i | 0, 0, 4)] + 12 * (oct || 0)); }

    // ------------------------------------------------------------------ music
    _schedule() {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') return;
      const now = ctx.currentTime;
      if (this.nextT < now - 0.3) this.nextT = now + 0.05;   // woke from a stall
      while (this.nextT < now + 0.12) {
        this._stepAt(this.step, this.nextT);
        this.step++; this.nextT += STEP;
      }
    }

    _stepAt(n, t) {
      const st = n & 15, bar = n >> 4, ch = CHORDS[(bar >> 1) & 3];
      if (st === 0) { this.barP = this.barT; this.barT = t; }
      this.chord = ch;
      if ((n & 31) === 0) this._pad(t, ch, STEP * 32);
      if (this.muted) return;
      const L = this.mode === 'run' ? this.I : 0;
      const hum = 0.85 + Math.random() * 0.3;
      if (L < 0.2) {                                             // calm: pad and sparse plucks, an octave up
        const i = (bar & 1 ? CALM_B : CALM_A)[st];
        if (i >= 0) this._pluck(t, ch.plk[i] + 12, 0.15 * hum);
        return;
      }
      if (L < 0.58) {                                            // building: pulse and a light rhythm
        const i = MID[st];
        if (i >= 0) this._pluck(t, ch.plk[i] + (st === 10 ? 12 : 0), (0.13 + 0.1 * L) * hum * (st % 4 === 0 ? 1 : 0.8));
        if (st === 0 || st === 8) this._kick(t, 0.36);
        if (st % 4 === 2) this._shake(t, 0.07 * hum, 0.05);
        else if (L > 0.4 && (st & 1)) this._shake(t, 0.03 * hum, 0.03);
        if (BASS_M[st]) this._bass(t, ch.root, 0.2, STEP * 5);
        return;
      }
      // peak: the full pattern
      const acc = st % 4 === 0 ? 1 : st % 2 === 0 ? 0.76 : 0.52;
      this._pluck(t, ch.plk[FULL[st]] + (L > 0.8 && st >= 8 ? 12 : 0), (0.14 + 0.1 * L) * acc * hum);
      if (st % 4 === 0) this._kick(t, 0.38);
      this._shake(t, (st % 4 === 2 ? 0.095 : 0.04) * hum, st % 4 === 2 ? 0.06 : 0.03);
      if (st === 4 || st === 12) this._brush(t, 0.11);
      if (BASS_F[st]) this._bass(t, ch.root + (st === 13 ? 7 : 0), 0.2, STEP * 3);
    }

    // kalimba/marimba: a sine with a fast decay and a short knock two octaves up
    _pluck(t, m, v) {
      const ctx = this.ctx, f = mtof(m), o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; this._env(g, t, v, 0.003, 0.5);
      o.connect(g); g.connect(this.plk); this._start(o, g, t, t + 0.54, -1);
      const o2 = ctx.createOscillator(), g2 = ctx.createGain();
      o2.frequency.value = f * 4; this._env(g2, t, v * 0.22, 0.002, 0.07);
      o2.connect(g2); g2.connect(this.plk); this._start(o2, g2, t, t + 0.1, -1);
    }

    _kick(t, v) {
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(118, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.1);
      this._env(g, t, v, 0.004, 0.24);
      o.connect(g); g.connect(this.music); this._start(o, g, t, t + 0.28, -1);
      this.k0 = this.k1; this.k1 = t;
    }

    _shake(t, v, d) {                                            // soft attack: grains, not a tick
      const ctx = this.ctx, s = ctx.createBufferSource(), g = ctx.createGain();
      s.buffer = this.white; s.loop = true; this._env(g, t, v, 0.009, d);
      s.connect(g); g.connect(this.shk); this._start(s, g, t, t + d + 0.04, Math.random() * 1.5);
    }

    _brush(t, v) {
      const ctx = this.ctx, s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = this.white; s.loop = true; fl.type = 'bandpass'; fl.frequency.value = 1900; fl.Q.value = 0.6;
      this._env(g, t, v, 0.016, 0.14);
      s.connect(fl); fl.connect(g); g.connect(this.music); this._start(s, g, t, t + 0.19, Math.random() * 1.5);
    }

    _bass(t, m, v, d) {
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = mtof(m); this._env(g, t, v, 0.012, d);
      o.connect(g); g.connect(this.bassF); this._start(o, g, t, t + d + 0.05, -1);
    }

    _pad(t, ch, d) {
      const ctx = this.ctx, f = ctx.createBiquadFilter(), g = ctx.createGain(), p = g.gain, end = t + d + 1.85;
      f.type = 'lowpass'; f.frequency.value = 950 + 700 * this.I; f.Q.value = 0.4;
      p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(1, t + 1.4);
      p.setValueAtTime(1, t + d - 0.3); p.linearRampToValueAtTime(0.0001, t + d + 1.8);
      f.connect(g); g.connect(this.padBus);
      for (let i = 0; i < 7; i++) {                              // three notes, two detuned voices each, and a breath on top
        const o = ctx.createOscillator();
        if (i < 6) { o.type = 'triangle'; o.frequency.value = mtof(ch.pad[i >> 1]); o.detune.value = i & 1 ? 7 : -6; } else o.frequency.value = mtof(ch.pad[2] + 12);
        o.connect(f); this._start(o, i === 6 ? g : null, t, end, -1);
      }
    }

    // ------------------------------------------------------------------ one-shots
    // ice strip: a glassy zing and two bells from the chord
    boost(mult) {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      const t = ctx.currentTime, n = clamp((mult | 0) - 1, 0, 4);
      this._noise(this.white, 'highpass', 2600, 8500, 0.7, t, 0.4, 0.15, 0, 0.02, false);
      this._tone('sine', 1500, 4400, t, 0.16, 0.05, 0, true, 0.004);
      this._bell(this._note(n, 2), t + 0.02, 0.7, 0.15, -0.2);
      this._bell(this._note(n + 2 > 4 ? 4 : n + 2, 2), t + 0.09, 0.8, 0.105, 0.2);
    }

    // close call: a quick whoosh past the ear and a soft chime, higher as the multiplier climbs
    near(mult, side) {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      const t = ctx.currentTime, s = side < 0 ? -1 : side > 0 ? 1 : 0;
      this._noise(this.white, 'bandpass', 900, 3600, 1.4, t, 0.17, 0.19, s * 0.6, 0.03, false);
      this._bell(this._note(clamp((mult | 0) - 1, 0, 4), 2), t + 0.03, 0.6, 0.16, s * 0.4);
    }

    // something went by: falls in pitch, panned to its side
    pass(side, strength, kind) {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      const t = ctx.currentTime;
      if (t - this._pt < 0.035) return;                          // a row of trees is one rush, not thirty
      this._pt = t;
      const pan = (side < 0 ? -1 : side > 0 ? 1 : 0) * 0.8, v = 0.07 + 0.2 * clamp(+strength || 0, 0, 1);
      if (kind === 'fence') {                                    // slats flutter
        for (let i = 0; i < 3; i++) this._noise(this.white, 'bandpass', 2400 - i * 350, 1300 - i * 200, 2.2, t + i * 0.042, 0.05, v * 1.6 * (1 - i * 0.2), pan, 0.006, false);
      } else if (kind === 'rock') this._noise(this.white, 'bandpass', 2600, 800, 2.6, t, 0.11, v * 1.6, pan, 0.01, false);
      else if (kind === 'pine' || kind === 'pines') this._noise(this.pink, 'bandpass', 1000, 300, 0.8, t, 0.26, v * 1.5, pan, 0.05, false);
      else this._noise(this.white, 'bandpass', 1600, 450, 1.3, t, 0.2, v, pan, 0.02, false);
    }

    // whumpf
    land(v) {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      const t = ctx.currentTime, k0 = clamp((+v || 0) / 32, 0.15, 1), k = k0 * (0.4 + 0.6 * k0);
      this._tone('sine', 105, 46, t, 0.24, 0.6 * k, 0, false, 0.006);
      this._noise(this.pink, 'lowpass', 900, 160, 0.5, t, 0.3, 1.1 * k, 0, 0.012, false);
      this._noise(this.white, 'bandpass', 2800, 1200, 0.8, t + 0.01, 0.2, 0.14 * k, 0, 0.02, false);
    }

    // two pole plants and the rush of setting off
    launch() {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      const t = ctx.currentTime;
      for (let i = 0; i < 2; i++) {
        const tt = t + i * 0.13, pan = i ? 0.3 : -0.3;
        this._noise(this.white, 'bandpass', 1500, 900, 2.5, tt, 0.05, 0.22, pan, 0.004, false);
        this._tone('sine', 190, 95, tt, 0.09, 0.26, pan, false, 0.004);
      }
      this._noise(this.pink, 'bandpass', 350, 2200, 0.7, t + 0.05, 0.5, 0.6, 0, 0.35, false);
    }

    // a thud and a burst of snow, coloured by what was hit
    crash(into) {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      const t = ctx.currentTime;
      this._tone('sine', 120, 34, t, 0.5, 0.75, 0, false, 0.004);
      this._noise(this.pink, 'lowpass', 1200, 120, 0.5, t, 0.5, 1.2, 0, 0.006, false);
      this._noise(this.white, 'lowpass', 6500, 400, 0.4, t + 0.01, 0.75, 0.36, 0, 0.02, true);
      if (into === 'rock') {                                     // a hard knock
        this._tone('triangle', 520, 150, t, 0.07, 0.5, 0, false, 0.002);
        this._noise(this.white, 'highpass', 3000, 3000, 0.7, t, 0.03, 0.35, 0, 0.001, false);
      } else if (into === 'fence') {                             // wood, then the rail twangs
        this._tone('sine', 330, 160, t, 0.06, 0.34, 0, false, 0.002);
        this._tone('triangle', 233, 170, t, 0.7, 0.24, -0.15, true, 0.004);
        this._tone('triangle', 240, 173, t, 0.6, 0.17, 0.15, true, 0.004);
        this._tone('sine', 700, 466, t, 0.25, 0.08, 0, true, 0.003);
      } else {                                                   // pine, pines, trees: branches crack, needles hiss
        const nb = into === 'trees' ? 6 : 4;
        for (let i = 0; i < nb; i++) {
          this._noise(this.white, 'bandpass', 1800 + Math.random() * 2400, 1200, 3.5, t + 0.01 + i * 0.045 + Math.random() * 0.03,
            0.035, 0.42 * (1 - i * 0.1), Math.random() * 1.2 - 0.6, 0.002, false);
        }
        this._noise(this.pink, 'bandpass', 800, 350, 0.7, t + 0.02, 0.5, 0.8, 0, 0.04, false);
      }
    }

    // off the edge: the wind drops away
    fall() {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      const t = ctx.currentTime;
      this._noise(this.pink, 'bandpass', 1300, 180, 0.6, t, 1.3, 0.6, 0, 0.06, false);
      this._tone('sine', 520, 150, t, 0.9, 0.05, 0, true, 0.05);
    }

    // multiplier dropped: a quiet falling blip
    flowDown() {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      this._tone('sine', this._note(2, 1), this._note(0, 1), ctx.currentTime, 0.2, 0.09, 0, false, 0.006);
    }

    // wave gate: a bright rising chime
    gate() {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      const t = ctx.currentTime;
      this._noise(this.white, 'highpass', 4000, 9000, 0.6, t, 0.5, 0.07, 0, 0.12, false);
      for (let k = 0; k < 3; k++) this._bell(this._note(k * 2, 1), t + k * 0.075, 0.6, 0.15, (k - 1) * 0.25);
      this._bell(this._note(0, 2), t + 0.225, 0.9, 0.16, 0);
    }

    // new best: three rising notes and a held chord
    best() {
      const ctx = this.ctx; if (!ctx || this.muted) return;
      const t = ctx.currentTime;
      for (let k = 0; k < 3; k++) {
        const f = this._note(k * 2, 1), tt = t + k * 0.11;
        this._tone('triangle', f, f, tt, 0.3, 0.12, (k - 1) * 0.2, true, 0.005);
        this._bell(f * 2, tt, 0.4, 0.06, (k - 1) * 0.2);
      }
      for (let k = 0; k < 3; k++) this._bell(this._note(k * 2, 2), t + 0.36, 1.1, 0.12, (k - 1) * 0.3);
      this._tone('triangle', this._note(0, 0), this._note(0, 0), t + 0.36, 0.9, 0.12, 0, true, 0.01);
    }

    // ------------------------------------------------------------------ per frame
    // set an AudioParam target only when it has really moved: no allocation, few automation events
    _to(i, param, v, tc) {
      const tv = this._tv, d = v - tv[i], e = 0.004 * (v < 0 ? -v : v) + 1e-4;
      if (d > e || d < -e) { tv[i] = v; param.setTargetAtTime(v, this._now, tc); }
    }

    /* p: { mode, u, onGround, boost, edge, carve, air, mult, I } */
    update(p) {
      const ctx = this.ctx;
      if (!ctx || !p) return;
      const t = ctx.currentTime;
      let dt = t - this._ut; this._ut = t; this._now = t;
      if (dt < 0) dt = 0; else if (dt > 0.1) dt = 0.1;
      const mode = p.mode, run = mode === 'run';
      this.mode = mode;
      this.I += ((run ? clamp(+p.I || 0, 0, 1) : 0) - this.I) * (1 - Math.exp(-dt * 3));
      const I = this.I, b = p.boost ? 1 : 0;
      const g = run && p.onGround ? 1 : 0, air = run && !p.onGround ? 1 : 0;
      const sp = clamp(((+p.u || 0) - 22) / 58, 0, 1);
      const c = clamp(+p.carve || 0, -1, 1), ac = c < 0 ? -c : c;

      // music: under the effects in a run, calm on the title, ducked and dark when you are down
      let mg = 0.2, mf = 500;
      if (run) { mg = 0.3 + 0.05 * I; mf = 3000 + 7000 * I + 1500 * b; } else if (mode === 'title') { mg = 0.5; mf = 2600; } else if (mode === 'dead') { mg = 0.16; mf = 650; }
      this._to(0, this.music.gain, mg, mode === 'dead' ? 0.3 : 0.15);
      this._to(1, this.musicF.frequency, mf, 0.3);
      this._to(2, this.mvs.gain, mg * 0.8, 0.2);

      // skis on snow. On ice the hiss thins and brightens and the rumble falls away: glide.
      this._to(3, this.hiss.g.gain, g * (0.022 + 0.07 * sp) * (1 - 0.25 * b), 0.04);
      this._to(4, this.hiss.f.frequency, 2400 + 2400 * sp + 2600 * b, 0.06);
      this._to(5, this.carveG.gain, g * ac * Math.sqrt(ac) * (0.12 + 0.24 * sp), 0.02);
      this._to(6, this.carveA.frequency, 3000 + 1600 * sp + 900 * ac, 0.04);
      this._to(7, this.carveB.frequency, 750 + 450 * sp, 0.04);
      if (this.carveP) this._to(8, this.carveP.pan, c * 0.4, 0.03);
      this._to(9, this.rumble.g.gain, g * (0.028 + 0.044 * sp) * (1 - 0.65 * b), 0.05);
      this._to(12, this.edge.g.gain, g && p.edge ? 0.13 + 0.09 * sp : 0, 0.03);

      // wind: rises with speed and boost, and is all that is left in the air
      let wg = 0, wf = 320;
      if (run) {
        wg = (0.03 + 0.12 * sp * sp) * (1 + 0.4 * b) * (1 + air * (0.5 + 0.3 * clamp(+p.air || 0, 0, 1)));
        wf = 380 + 900 * sp + 450 * b + 150 * air;
      } else if (mode !== 'pause') wg = 0.035;
      this._to(10, this.wind.g.gain, wg, 0.1);
      this._to(11, this.wind.f.frequency, wf, 0.15);
    }

    // 1 on each kick, decaying: the visuals may breathe with it
    beat() {
      if (!this.ctx || this.mode !== 'run') return 0;
      const now = this.ctx.currentTime, k = this.k1 <= now ? this.k1 : this.k0;
      return k <= now ? Math.exp(-(now - k) * 7) : 0;
    }

    // 0..1 position inside the current bar, -1 before init
    barPhase() {
      if (!this.ctx) return -1;
      const now = this.ctx.currentTime, b = this.barT <= now ? this.barT : this.barP;
      return clamp((now - b) / BAR, 0, 1);
    }
  }

  FL.Audio = Audio;
})(typeof window !== 'undefined' ? window : globalThis);
