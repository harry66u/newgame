/* Fall Line — everything drawn in the DOM over the game: score, multiplier, call-outs, the
   title, the result, pause. main.js only ever talks to it through FL.Hud. */
(function (root) {
  'use strict';
  const FL = root.FL, C = FL.C, Look = FL.Look;
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const fmt = (n) => {
    const s = String(Math.max(0, Math.floor(n)));
    let out = '';
    for (let i = 0; i < s.length; i++) { if (i && (s.length - i) % 3 === 0) out += ','; out += s[i]; }
    return out;
  };

  let el = null, cells = [], shown = -1, multShown = 1, best = 0, onMute = null;

  const Hud = {
    fmt,
    /* opts: { best, muted, touch } */
    init(opts) {
      el = { score: $('score'), flow: $('flow'), mult: $('mult'), bar: $('flowbar'), call: $('call'), best: $('best'), mute: $('mute'), pause: $('pause') };
      best = opts.best || 0;
      document.body.classList.toggle('touch', !!opts.touch);
      Hud.setMuted(!!opts.muted);
      Hud.setBest(best);
      el.mute.addEventListener('click', () => { if (onMute) onMute(); el.mute.blur(); });
    },
    onMute(fn) { onMute = fn; },
    isMuteTarget(t) { return !!el && (t === el.mute || el.mute.contains(t)); },
    setTouch(on) { document.body.classList.toggle('touch', on); },
    setMuted(m) { el.mute.setAttribute('aria-pressed', m ? 'true' : 'false'); el.mute.classList.toggle('off', m); },
    setBest(n) { best = n; el.best.textContent = n > 0 ? 'Best ' + fmt(n) : ''; },
    // 'title' | 'run' | 'dead'
    setMode(mode) {
      document.body.dataset.mode = mode;
      if (mode === 'run') { el.score.classList.remove('gold'); shown = -1; Hud.setScore(0); Hud.setFlow(1, 0); }
    },
    setPaused(p) { el.pause.hidden = !p; },
    setScore(n) {
      if (n === shown) return;
      shown = n;
      const s = fmt(n);
      while (cells.length < s.length) { const c = document.createElement('span'); el.score.appendChild(c); cells.push({ el: c, ch: '' }); }
      while (cells.length > s.length) el.score.removeChild(cells.pop().el);
      for (let i = 0; i < s.length; i++) {
        const c = cells[i];
        if (c.ch !== s[i]) { c.ch = s[i]; c.el.textContent = s[i]; c.el.className = s[i] === ',' ? 'sep' : ''; }
      }
    },
    // mult 1..5, frac 0..1 = how long the current level has left
    setFlow(mult, frac) {
      if (mult !== multShown) {
        const up = mult > multShown;
        multShown = mult;
        el.mult.textContent = '×' + mult;
        el.flow.classList.toggle('on', mult > 1);
        el.flow.classList.toggle('max', mult >= C.MULT_MAX);
        if (up && el.mult.animate) el.mult.animate([{ transform: 'scale(1.55)' }, { transform: 'scale(1)' }], { duration: 280, easing: 'cubic-bezier(.2,.9,.3,1)' });
      }
      if (mult > 1) el.bar.style.transform = 'scaleX(' + clamp(frac, 0, 1).toFixed(3) + ')';
    },
    // A short call-out under the score. tone: 'boost' | 'close' | 'best' | 'wave'
    say(text, tone) {
      el.call.textContent = text;
      el.call.className = tone || '';
      if (el.call.animate) {
        el.call.animate(
          [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none', offset: 0.14 }, { opacity: 1, offset: 0.7 }, { opacity: 0, transform: 'translateY(-6px)' }],
          { duration: 1150, easing: 'ease-out' });
      }
    },
    // The multiplier went up. why: 'boost' | 'near'
    flow(mult, why) {
      const max = mult >= C.MULT_MAX ? '  ×' + mult + ' max' : '';
      Hud.say((why === 'near' ? 'Close call' : 'Ice') + max, why === 'near' ? 'close' : 'boost');
    },
    // A new, harder run begins. wave is 0-based.
    wave(wave) { Hud.say(Look.rating(wave).name + ' run', 'wave'); },
    newBest() { el.score.classList.add('gold'); Hud.say('New best', 'best'); },
    /* r: { score, best, isNew, dist (m along the run), vert (m of vertical drop), wave } */
    over(r) {
      $('final').textContent = fmt(r.score);
      $('record').textContent = r.isNew ? 'New best' : 'Best ' + fmt(r.best);
      $('record').className = r.isNew ? 'gold' : '';
      $('dist').textContent = fmt(r.dist) + ' m run, ' + fmt(r.vert) + ' m vertical';
      best = r.best; Hud.setBest(best);
      Hud.setScore(r.score);
      Hud.setMode('dead');
    },
    fail() { $('fail').hidden = false; $('title').hidden = true; $('hud').hidden = true; },
  };
  FL.Hud = Hud;
})(window);
