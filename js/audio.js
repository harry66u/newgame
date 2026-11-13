/* Fall Line — sound. Everything is synthesised with WebAudio at run time: no audio files.
   A small step sequencer plays a looping track whose layers follow the wave you are in
   (pad only when it is calm, drums and arpeggio as it builds), and the effects are tuned to
   the current chord so boosts and close calls land in key. */
(function (root) {
  'use strict';
  const FL = root.FL;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const BPM = 124, STEP = 60 / BPM / 4;
  // Two bars each: Am9, Fmaj7, Cmaj7, G6
  const CHORDS = [
    { root: 33, arp: [57, 60, 64, 67, 71], pad: [57, 60, 64] },
    { root: 29, arp: [53, 57, 60, 64, 67], pad: [53, 57, 60] },
    { root: 36, arp: [60, 64, 67, 71, 74], pad: [55, 60, 64] },
    { root: 31, arp: [55, 59, 62, 64, 69], pad: [55, 59, 62] },
  ];
  const ARP = [0, 2, 1, 3, 2, 4, 3, 1, 0, 2, 4, 3, 2, 3, 1, 2];
  const BASS = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0];

  class Audio {
    constructor() {
      this.ctx = null; this.muted = false; this.I = 0; this.mode = 'title';
      this.step = 0; this.nextT = 0; this.lastKick = -9; this.kicks = []; this.barT = 0;
    }

    // Must be called from inside a user gesture the first time.
    init() {
      if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      let ctx;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { return; }
      this.ctx = ctx;
      const G = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
      this.master = G(this.muted ? 0 : 0.9);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.18;
      this.master.connect(comp); comp.connect(ctx.destination);

      this.musicF = ctx.createBiquadFilter(); this.musicF.type = 'lowpass'; this.musicF.frequency.value = 900; this.musicF.Q.value = 0.4;
      this.music = G(0.0);
      this.music.connect(this.musicF); this.musicF.connect(this.master);
      this.sfx = G(0.85); this.sfx.connect(this.master);

      // a little space: generated impulse response + a tempo-synced echo
      const len = Math.floor(ctx.sampleRate * 1.8), ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
      this.verb = ctx.createConvolver(); this.verb.buffer = ir;
      const vg = G(0.22); this.verb.connect(vg); vg.connect(this.master);
      this.echo = ctx.createDelay(1); this.echo.delayTime.value = STEP * 3;
      const fb = G(0.36), ef = ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 2600;
      this.echo.connect(ef); ef.connect(fb); fb.connect(this.echo);
      const eg = G(0.3); ef.connect(eg); eg.connect(this.musicF);

      const nlen = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, nlen, ctx.sampleRate);
      const nd = this.noise.getChannelData(0);
      for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;

      // continuous layers driven by speed
      const loop = (type, f, q) => {
        const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
        const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
        const g = G(0);
        src.connect(flt); flt.connect(g); g.connect(this.sfx); src.start();
        return { flt, g };
      };
      this.wind = loop('bandpass', 500, 0.7);
      this.rumble = loop('lowpass', 110, 0.5);
      this.grind = loop('bandpass', 3200, 4);
      this.humG = G(0); this.humF = ctx.createBiquadFilter(); this.humF.type = 'lowpass'; this.humF.frequency.value = 300;
      this.humF.connect(this.humG); this.humG.connect(this.sfx);
      this.hum = [0, 7].map((det) => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 50; o.detune.value = det; o.connect(this.humF); o.start(); return o; });

      this.nextT = ctx.currentTime + 0.08;
      this.timer = setInterval(() => this._schedule(), 25);
    }

    setMuted(m) {
      this.muted = m;
      if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.02);
    }

    suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
    resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }

    // ------------------------------------------------------------------ music
    _schedule() {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') return;
      if (this.nextT < ctx.currentTime - 0.3) this.nextT = ctx.currentTime + 0.05;   // woke from a stall
      while (this.nextT < ctx.currentTime + 0.12) {
        this._stepAt(this.step, this.nextT);
        this.step++; this.nextT += STEP;
      }
    }

    _stepAt(n, t) {
      const st = n % 16, bar = Math.floor(n / 16), ch = CHORDS[Math.floor(bar / 2) % CHORDS.length];
      const I = this.I, run = this.mode === 'run';
      if (st === 0) this.barT = t;
      this.chord = ch;
      if (n % 32 === 0) this._pad(t, ch.pad, STEP * 32);
      if (!run) {
        if (st % 4 === 0) this._arp(t, ch.arp[ARP[st] % 5] + 12, 0.1);
        return;
      }
      if (I > 0.1) {
        if (st % 4 === 0) { this._kick(t, 0.8 + 0.2 * I); this.kicks.push(t); if (this.kicks.length > 8) this.kicks.shift(); }
        if (st % 4 === 2) this._hat(t, 0.16 + 0.1 * I, 0.07);
      }
      if (I > 0.45 && st % 2 === 1) this._hat(t, 0.07 + 0.05 * I, 0.03);
      if (I > 0.6 && (st === 4 || st === 12)) this._clap(t, 0.3);
      if (BASS[st]) this._bass(t, ch.root + (st === 6 || st === 13 ? 12 : 0), STEP * 1.6, 0.34 + 0.22 * I);
      const dense = I > 0.3 || st % 2 === 0;
      if (dense) this._arp(t, ch.arp[ARP[st] % 5] + (I > 0.7 && st >= 8 ? 12 : 0), 0.1 + 0.13 * I);
    }

    _env(g, t, peak, a, d) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    }

    _kick(t, v) {
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(155, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
      this._env(g, t, v * 0.9, 0.003, 0.24);
      o.connect(g); g.connect(this.music); o.start(t); o.stop(t + 0.3);
    }

    _noiseHit(t, type, f, q, v, d, dest) {
      const ctx = this.ctx, s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = this.noise; fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      this._env(g, t, v, 0.002, d);
      s.connect(fl); fl.connect(g); g.connect(dest || this.music);
      s.start(t, Math.random() * 1.5, d + 0.05);
      return { s, fl, g };
    }

    _hat(t, v, d) { this._noiseHit(t, 'highpass', 7500, 0.7, v, d); }
    _clap(t, v) { this._noiseHit(t, 'bandpass', 1700, 0.9, v, 0.13); this._noiseHit(t + 0.012, 'bandpass', 1500, 0.9, v * 0.6, 0.1); }

    _bass(t, m, d, v) {
      const ctx = this.ctx, o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o2.type = 'square';
      o.frequency.value = mtof(m); o2.frequency.value = mtof(m - 12);
      f.type = 'lowpass'; f.Q.value = 5;
      f.frequency.setValueAtTime(260 + 1300 * this.I, t); f.frequency.exponentialRampToValueAtTime(140, t + d);
      this._env(g, t, v, 0.006, d);
      o.connect(f); o2.connect(f); f.connect(g); g.connect(this.music);
      o.start(t); o2.start(t); o.stop(t + d + 0.05); o2.stop(t + d + 0.05);
    }

    _arp(t, m, v) {
      const ctx = this.ctx, o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'triangle'; o2.type = 'sawtooth'; o2.detune.value = 9;
      o.frequency.value = o2.frequency.value = mtof(m);
      const g2 = ctx.createGain(); g2.gain.value = 0.3;
      f.type = 'lowpass'; f.frequency.value = 1800 + 3600 * this.I; f.Q.value = 1.5;
      this._env(g, t, v, 0.004, 0.2);
      o.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(this.music); g.connect(this.echo);
      o.start(t); o2.start(t); o.stop(t + 0.3); o2.stop(t + 0.3);
    }

    _pad(t, notes, d) {
      const ctx = this.ctx, f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'lowpass'; f.frequency.value = 700 + 900 * this.I; f.Q.value = 0.5;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.085, t + 1.1);
      g.gain.setValueAtTime(0.085, t + d - 0.4);
      g.gain.linearRampToValueAtTime(0.0001, t + d + 1.6);
      f.connect(g); g.connect(this.music); g.connect(this.verb);
      for (const m of notes) for (const det of [-8, 7]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
        o.connect(f); o.start(t); o.stop(t + d + 1.7);
      }
    }

    // ------------------------------------------------------------------ effects
    _tone(type, f0, f1, dur, v, pan, send) {
      const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      this._env(g, t, v, 0.004, dur);
      let out = g;
      if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); out = p; }
      o.connect(g); out.connect(this.sfx);
      if (send) out.connect(this.verb);
      o.start(t); o.stop(t + dur + 0.05);
    }

    _swish(f0, f1, dur, v, pan, q) {
      const ctx = this.ctx, t = ctx.currentTime;
      const h = this._noiseHit(t, 'bandpass', f0, q || 1.2, v, dur, ctx.createGain());
      h.fl.frequency.setValueAtTime(f0, t); h.fl.frequency.exponentialRampToValueAtTime(f1, t + dur);
      h.g.disconnect();
      if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); h.g.connect(p); p.connect(this.sfx); } else h.g.connect(this.sfx);
    }

    _note(i) { const ch = this.chord || CHORDS[0]; return mtof(ch.arp[clamp(i, 0, 4)]); }

    boost(mult) {
      if (!this.ctx) return;
      this._swish(500, 4200, 0.4, 0.4, 0, 0.8);
      this._tone('sawtooth', 140, 520, 0.3, 0.12, 0, false);
      const n = clamp(mult - 1, 0, 4);
      this._tone('triangle', this._note(n) * 2, this._note(n) * 2, 0.32, 0.26, 0, true);
      this._tone('triangle', this._note(Math.min(4, n + 2)) * 2, this._note(Math.min(4, n + 2)) * 2, 0.4, 0.14, 0, true);
    }

    near(mult, side) {
      if (!this.ctx) return;
      const f = this._note(clamp(mult - 1, 0, 4)) * 4;
      this._tone('sine', f, f, 0.34, 0.24, side * 0.5, true);
      this._tone('sine', f * 1.5, f * 1.5, 0.22, 0.1, side * 0.5, true);
    }

    pass(side, strength) {
      if (!this.ctx) return;
      this._swish(1500, 380, 0.2, 0.1 + 0.4 * strength, side * 0.85, 1.5);
    }

    land(v) {
      if (!this.ctx) return;
      const k = clamp(v / 22, 0.15, 1);
      this._tone('sine', 120, 42, 0.2, 0.55 * k, 0, false);
      this._swish(900, 200, 0.12, 0.2 * k, 0, 0.8);
    }

    launch() {
      if (!this.ctx) return;
      this._swish(300, 2600, 0.45, 0.3, 0, 0.8);
      this._tone('triangle', this._note(0), this._note(0) * 2, 0.3, 0.18, 0, true);
    }

    crash() {
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const h = this._noiseHit(t, 'lowpass', 5000, 0.5, 0.85, 0.7, this.sfx);
      h.fl.frequency.setValueAtTime(5000, t); h.fl.frequency.exponentialRampToValueAtTime(140, t + 0.6);
      this._tone('sine', 95, 28, 0.6, 0.8, 0, false);
      this._tone('sawtooth', 320, 40, 0.5, 0.2, 0, true);
    }

    fall() {
      if (!this.ctx) return;
      this._tone('sine', 700, 90, 0.7, 0.2, 0, true);
    }

    flowDown() { if (this.ctx) this._tone('triangle', 330, 220, 0.14, 0.07, 0, false); }

    gate() {
      if (!this.ctx) return;
      this._swish(2400, 240, 0.7, 0.3, 0, 0.6);
      [0, 2, 4].forEach((n, i) => setTimeout(() => this.ctx && this._tone('triangle', this._note(n) * 2, this._note(n) * 2, 0.5, 0.13, 0, true), i * 70));
    }

    best() {
      if (!this.ctx) return;
      [0, 1, 2, 4].forEach((n, i) => setTimeout(() => this.ctx && this._tone('triangle', this._note(n) * 4, this._note(n) * 4, 0.45, 0.16, 0, true), i * 80));
    }

    // ------------------------------------------------------------------ per frame
    /* p: { mode, u, onGround, boost, edge, I } */
    update(p) {
      const ctx = this.ctx;
      if (!ctx) return;
      const t = ctx.currentTime, run = p.mode === 'run', sp = clamp((p.u - 8) / 80, 0, 1);
      this.mode = p.mode;
      this.I += ((run ? p.I : 0) - this.I) * 0.08;
      const set = (param, v, tc) => param.setTargetAtTime(v, t, tc);
      set(this.music.gain, p.mode === 'title' ? 0.42 : p.mode === 'dead' ? 0.3 : p.mode === 'pause' ? 0.2 : 0.62, 0.12);
      set(this.musicF.frequency, p.mode === 'title' ? 1400 : p.mode === 'run' ? 2600 + 12000 * this.I + (p.boost ? 3000 : 0) : 420, run ? 0.25 : 0.1);
      set(this.wind.g.gain, run ? sp * sp * 0.5 * (p.onGround ? 1 : 1.5) : 0, 0.08);
      set(this.wind.flt.frequency, 350 + p.u * 24 + (p.boost ? 900 : 0), 0.1);
      set(this.rumble.g.gain, run && p.onGround ? 0.25 + sp * 0.6 : 0, 0.04);
      set(this.grind.g.gain, run && p.edge ? 0.2 : 0, 0.03);
      set(this.humG.gain, run ? 0.035 + sp * 0.05 : 0, 0.1);
      const hf = 38 + p.u * 1.05 + (p.boost ? 22 : 0);
      for (const o of this.hum) set(o.frequency, hf, 0.12);
      set(this.humF.frequency, 200 + p.u * 9, 0.1);
    }

    // 1 on each kick, decaying — the visuals breathe with it
    beat() {
      if (!this.ctx || this.mode !== 'run') return 0;
      const now = this.ctx.currentTime;
      let last = -9;
      for (const k of this.kicks) if (k <= now && k > last) last = k;
      return Math.exp(-(now - last) * 7);
    }

    // 0..1 position inside the current bar
    barPhase() {
      if (!this.ctx) return -1;
      return clamp((this.ctx.currentTime - this.barT) / (STEP * 16), 0, 1);
    }
  }

  FL.Audio = Audio;
})(typeof window !== 'undefined' ? window : globalThis);
