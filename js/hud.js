/* Fall Line — everything drawn in the DOM over the game: score, multiplier, call-outs, the
   title, the result, pause. main.js only ever talks to it through FL.Hud.
   The score and the multiplier bar are written every frame, so both only touch the DOM when
   what is shown would change, and nothing here allocates on that path. */
(function (root) {
  'use strict';
  const FL = root.FL, C = FL.C, Look = FL.Look;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => {
    const s = String(Math.max(0, Math.floor(n)));
    let out = '';
    for (let i = 0; i < s.length; i++) { if (i && (s.length - i) % 3 === 0) out += ','; out += s[i]; }
    return out;
  };

  /* A piste rating as a trail sign shows it: green circle, blue square, black diamonds.
     Drawn as SVG, never as glyphs, so it is the same shape on every device. */
  function symbol(r) {
    const step = 17, w = 24 + (r.n - 1) * step;
    let shapes = '';
    for (let i = 0; i < r.n; i++) {
      const x = i * step;
      shapes += r.sym === 'circle' ? '<circle cx="' + (12 + x) + '" cy="12" r="8.8"/>'
        : r.sym === 'square' ? '<rect x="' + (4 + x) + '" y="4" width="16" height="16" rx="1.2"/>'
        : '<path d="M' + (12 + x) + ' 1.6l8.2 10.4-8.2 10.4-8.2-10.4z"/>';
    }
    return '<svg class="sym" viewBox="0 0 ' + w + ' 24" style="width:' + (w / 24).toFixed(3) + 'em" fill="' + r.hexCol + '" aria-hidden="true">' + shapes + '</svg>';
  }

  // The multiplier bar moves in whole steps so its transform strings can be made once.
  const BAR_STEPS = 96, BAR = [];
  for (let i = 0; i <= BAR_STEPS; i++) BAR.push('scaleX(' + (i / BAR_STEPS).toFixed(4) + ')');

  const SAY = [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)', offset: 0.12 }, { opacity: 1, transform: 'translateY(0)', offset: 0.78 }, { opacity: 0, transform: 'translateY(-4px)' }];
  const SAY_CALM = [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }];
  const SHORT = { duration: 1200, easing: 'ease-out' }, LONG = { duration: 2600, easing: 'ease-out' };
  const POP = [{ transform: 'scale(1.4)' }, { transform: 'scale(1)' }], POP_T = { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1)' };
  const mql = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const calm = () => !!(mql && mql.matches);

  let el = null, cells = [], shown = -1, multShown = 1, barShown = -1, best = 0, onMute = null;
  let callAnim = null, callPri = 0, callUntil = 0;

  const Hud = {
    fmt,
    /* opts: { best, muted, touch } */
    init(opts) {
      el = {
        score: $('score'), flow: $('flow'), mult: $('mult'), fill: $('flowfill'), call: $('call'), callsym: $('callsym'), calltxt: $('calltxt'),
        best: $('best'), mute: $('mute'), pause: $('pause'), final: $('final'), record: $('record'), dist: $('dist'), reachsym: $('reachsym'), reachtxt: $('reachtxt'),
      };
      best = opts.best || 0;
      document.body.classList.toggle('touch', !!opts.touch);
      // Under the name, the three signs every skier knows: the runs get harder in this order.
      let legend = '';
      for (let i = 0; i < 3 && i < Look.RATINGS.length; i++) legend += symbol(Look.RATINGS[i]);
      $('runs').innerHTML = legend;
      Hud.setMuted(!!opts.muted);
      Hud.setBest(best);
      // A pointer click gives focus back to the game; a keyboard one (detail 0) keeps its focus ring.
      el.mute.addEventListener('click', (e) => { if (onMute) onMute(); if (e.detail) el.mute.blur(); });
    },
    onMute(fn) { onMute = fn; },
    isMuteTarget(t) { return !!el && (t === el.mute || el.mute.contains(t)); },
    setTouch(on) { document.body.classList.toggle('touch', !!on); },
    setMuted(m) {
      el.mute.setAttribute('aria-pressed', m ? 'true' : 'false');
      el.mute.title = m ? 'Sound is off (M)' : 'Sound is on (M)';
      el.mute.classList.toggle('off', !!m);
    },
    setBest(n) { best = n; el.best.classList.remove('new'); el.best.textContent = n > 0 ? 'Best ' + fmt(n) : ''; },
    // 'title' | 'run' | 'dead'
    setMode(mode) {
      document.body.dataset.mode = mode;
      if (mode === 'run') {
        if (callAnim) { callAnim.cancel(); callAnim = null; }
        callPri = 0; callUntil = 0;
        multShown = 1; barShown = -1;
        el.mult.textContent = '×1'; el.flow.className = '';
        Hud.setBest(best);
        shown = -1; Hud.setScore(0);
      }
    },
    setPaused(p) { el.pause.hidden = !p; },
    // Every frame. Each digit sits in its own fixed-width cell, so nothing shifts as they change.
    setScore(n) {
      n = Math.floor(n);
      if (n === shown) return;
      shown = n;
      const s = fmt(n);
      while (cells.length < s.length) { const c = document.createElement('span'); el.score.appendChild(c); cells.push({ el: c, ch: '' }); }
      while (cells.length > s.length) el.score.removeChild(cells.pop().el);
      for (let i = 0; i < s.length; i++) {
        const c = cells[i], ch = s[i];
        if (c.ch !== ch) { c.ch = ch; c.el.textContent = ch; c.el.className = ch === ',' ? 'sep' : ''; }
      }
    },
    // Every frame. mult 1..5, frac 0..1 = how long the current level has left
    setFlow(mult, frac) {
      if (mult !== multShown) {
        const up = mult > multShown;
        multShown = mult;
        el.mult.textContent = '×' + mult;
        el.flow.className = mult > 1 ? (mult >= C.MULT_MAX ? 'on max' : 'on') : '';
        if (up && el.mult.animate && !calm()) el.mult.animate(POP, POP_T);
      }
      if (mult > 1) {
        const q = frac <= 0 ? 0 : frac >= 1 ? BAR_STEPS : (frac * BAR_STEPS + 0.5) | 0;
        if (q !== barShown) { barShown = q; el.fill.style.transform = BAR[q]; }
      }
    },
    // A short call-out under the multiplier. tone: 'boost' | 'close' | 'best' | 'wave'
    say(text, tone) {
      const now = performance.now(), pri = tone === 'wave' || tone === 'best' ? 2 : 1;
      if (pri < callPri && now < callUntil) return;       // a new run or a new best keeps the floor for a moment
      callPri = pri; callUntil = now + (pri > 1 ? 1700 : 0);
      el.calltxt.textContent = text;
      el.call.className = tone || '';
      if (callAnim) callAnim.cancel();
      if (el.call.animate) callAnim = el.call.animate(calm() ? SAY_CALM : SAY, pri > 1 ? LONG : SHORT);
    },
    // The multiplier went up. why: 'boost' | 'near'
    flow(mult, why) { Hud.say(why === 'near' ? 'Close call' : 'Ice', why === 'near' ? 'close' : 'boost'); },
    // A new, harder run begins. wave is 0-based.
    wave(wave) {
      const r = Look.rating(wave);
      el.callsym.innerHTML = symbol(r);
      Hud.say(r.name + ' run', 'wave');
    },
    newBest() { el.best.textContent = 'New best'; el.best.classList.add('new'); Hud.say('New best', 'best'); },
    /* r: { score, best, isNew, dist (m along the run), vert (m of vertical drop), wave } */
    over(r) {
      const rt = Look.rating(r.wave || 0), sc = fmt(r.score);
      el.reachsym.innerHTML = symbol(rt);
      el.reachtxt.textContent = 'Reached ' + rt.name.toLowerCase();
      el.final.textContent = sc;
      el.final.className = sc.length > 8 ? 'long' : '';
      el.record.textContent = r.isNew ? 'New best' : r.best > 0 ? 'Best ' + fmt(r.best) : '';
      el.record.className = r.isNew ? 'new' : '';
      el.dist.textContent = fmt(r.dist) + ' m run, ' + fmt(r.vert) + ' m vertical';
      best = r.best;
      Hud.setScore(r.score);
      Hud.setMode('dead');
    },
    fail() { $('fail').hidden = false; $('title').hidden = true; $('over').hidden = true; $('hud').hidden = true; },
  };
  FL.Hud = Hud;
})(window);
