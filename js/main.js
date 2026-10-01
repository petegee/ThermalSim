import {
  createScenario,
  Round,
  randomSeed,
  WIND_CLASSES,
  THERMAL_CLASSES,
  FIELD_SHORT_HALF,
  DEFAULT_GUSTINESS,
} from './scenario.js';
import { Streamer } from './physics.js';
import { Renderer } from './render.js';
import { FlowParticles } from './flow.js';
import { compassPoint } from './vec.js';

const $ = (id) => document.getElementById(id);

// ---- Persistence (best-effort; the app works without it) ---------------------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

// Bump when a default changes enough that old saved values should be
// dropped. v2: gustiness default 10% → 6% after the turbulence retune.
const SETTINGS_VERSION = 2;
const savedSettings = store.get('tvt.settings', {});
if (savedSettings.v !== SETTINGS_VERSION) delete savedSettings.gustiness;
const settings = {
  mode: 'poles',
  windClass: 'random',
  thermalClass: 'medium',
  easy: false,
  gustiness: Math.round(DEFAULT_GUSTINESS * 100),
  speed: 1,
  ...savedSettings,
  v: SETTINGS_VERSION,
  assists: { baseline: true, third: false, project: false, rings: true, ...(savedSettings.assists || {}) },
};
const saveSettings = () => store.set('tvt.settings', settings);

const emptyStats = () => ({ rounds: 0, points: 0, distSum: 0, distN: 0, best: null });
let stats = { ...emptyStats(), ...store.get('tvt.stats', {}) };

// ---- State -------------------------------------------------------------------

const canvas = $('field');
const wrap = $('canvasWrap');
const renderer = new Renderer(canvas);

let round;
let streamers = [];
let particles = null;
let paused = false;
let hover = null;
let lastPhase = 'watching';
let recorded = false;
let roundNo = 0;
let sessionScore = 0;

const INSTRUCTIONS = {
  poles:
    'Watch both streamers. When the air shifts, work out the third vector and <strong>click the field where you think the thermal is</strong>.',
  ring:
    'Six streamers surround you. Each one’s shift points toward the lift: upwind ones lull as it approaches, downwind ones surge once it has passed. <strong>Click where you think the thermal is</strong>.',
  pilot:
    'Watch the streamer beside you. Its shift points toward the lift, and how big and how fast it changes tells you how far away. <strong>Click where you think the thermal is</strong>.',
};

// The field's shorter side always shows FIELD_SHORT_HALF metres each way;
// the longer side shows proportionally more.
function currentField() {
  const short = Math.min(renderer.w, renderer.h);
  return {
    halfW: Math.round((FIELD_SHORT_HALF * renderer.w) / short),
    halfH: Math.round((FIELD_SHORT_HALF * renderer.h) / short),
  };
}

function newRound(seed = randomSeed(), opts = null) {
  const scenarioOpts = opts ?? {
    windClass: settings.windClass,
    thermalClass: settings.thermalClass,
    gustiness: settings.gustiness / 100,
    layout: settings.mode,
    easy: settings.easy,
    field: currentField(),
  };
  const scn = createScenario(seed, scenarioOpts);
  round = new Round(scn);
  round.opts = scenarioOpts;
  streamers = scn.poles.map((p) => {
    const s = new Streamer(p.pos, round.wind(p.pos));
    s.id = p.id;
    return s;
  });
  particles = null;
  lastPhase = 'watching';
  hadThermal = false;
  recorded = false;
  roundNo++;

  $('roundNo').textContent = roundNo;
  $('instructions').innerHTML = INSTRUCTIONS[scn.layout];
  $('seedLabel').textContent = `#${seed.toString(16).toUpperCase().padStart(8, '0')}`;
  clearTimeout(toastTimer);
  $('toast').hidden = true;
  $('summary').hidden = true;
  $('windChip').hidden = true;
  $('btnReveal').disabled = false;
  wrap.classList.remove('locked');
  setPaused(false);
  updateStatus();
}

// ---- Simulation loop -----------------------------------------------------------

const FIXED = 1 / 60;
let last = performance.now();

function frame(now) {
  const realDt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!paused) {
    const dt = realDt * settings.speed;
    const steps = Math.max(1, Math.ceil(dt / FIXED));
    const h = dt / steps;
    const windAt = (p) => round.wind(p);
    for (let i = 0; i < steps; i++) {
      round.step(h);
      for (const s of streamers) s.update(h, round.wind(s.pole));
      if (particles) particles.update(h, windAt);
    }
  }

  syncPhase();
  renderer.draw({ round, streamers, assists: settings.assists, particles, hover });
  $('timer').textContent = formatClock(round.endT ?? round.t);
  requestAnimationFrame(frame);
}

let hadThermal = false;
function syncPhase() {
  if (!!round.thermal !== hadThermal) {
    hadThermal = !!round.thermal;
    updateStatus();
    // The thermal just formed after an early mark or reveal: refresh the message.
    if (hadThermal && round.phase === 'revealed') showToast(resultSummary());
  }
  if (round.phase === lastPhase) return;
  if (lastPhase === 'watching') onRevealed();
  if (round.phase === 'over') onOver();
  lastPhase = round.phase;
  updateStatus();
}

// ---- Round events ---------------------------------------------------------------

function onRevealed() {
  particles = new FlowParticles(round.scn.field);
  wrap.classList.add('locked');
  $('btnReveal').disabled = true;

  const scn = round.scn;
  $('windChip').innerHTML =
    `Average wind <b>${scn.windSpeed.toFixed(1)} m/s</b><br>` +
    `from ${compassPoint(scn.windFrom)} (${Math.round(scn.windFrom)}°) · ${WIND_CLASSES[scn.windClass].label.toLowerCase()}`;
  $('windChip').hidden = false;

  showToast(resultSummary());
  recordResult();
}

function onOver() {
  const r = resultSummary();
  const scn = round.scn;
  const spec = scn.thermalSpec;
  $('sumEyebrow').textContent = `Round ${roundNo} · ${r.points} pts${scn.easy ? ' · easy mode' : ''}`;
  $('sumTitle').textContent = r.title;

  const rows = [
    ['Score', `${r.points} / 100`],
    ['Miss distance', round.guess?.distance != null ? `${round.guess.distance.toFixed(1)} m` : '–'],
    ['Read time', round.guess?.readTime != null ? `${round.guess.readTime.toFixed(1)} s after it formed` : '–'],
    ['Average wind', `${scn.windSpeed.toFixed(1)} m/s from ${compassPoint(scn.windFrom)}`],
    ['Thermal', `${THERMAL_CLASSES[scn.thermalClass].label}, ${spec.strength.toFixed(1)} m/s peak inflow`],
    ['Core size', `${Math.round(spec.radius * 2)} m across`],
  ];
  const sig = spec.signal;
  if (sig?.pole) {
    const pole = scn.poles.find((p) => p.id === sig.pole);
    rows.push([
      'Biggest shift',
      `${Math.round(sig.angle)}° and ${Math.round(sig.speed * 100)}% on the ${pole.label}`,
    ]);
  }
  $('sumGrid').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('toast').hidden = true;
  $('summary').hidden = false;
  $('sumNext').focus({ preventScroll: true });
}

function resultSummary() {
  const g = round.guess;
  if (!g) {
    return {
      points: 0,
      title: 'It got away',
      detail: 'The thermal drifted off the field before you marked it. Its track is shown dotted.',
    };
  }
  if (g.gaveUp) {
    return {
      points: 0,
      title: round.thermal ? 'Revealed' : 'No thermal yet',
      detail: round.thermal ? 'No score this round. Study how the vectors line up.' : 'It will appear here when it forms.',
    };
  }
  if (g.early) {
    return {
      points: 0,
      title: 'Too early',
      detail: round.thermal
        ? 'That was just a gust. Here’s the thermal that formed afterwards.'
        : 'No thermal had formed yet, so that was just a gust. Watch for it to form.',
    };
  }
  return {
    points: g.points,
    title: g.rating.text,
    detail: `${g.distance.toFixed(1)} m from the centre · read ${g.readTime.toFixed(1)} s after it formed`,
  };
}

let toastTimer = 0;
function showToast(r) {
  const t = $('toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 9000);
  t.innerHTML = `<div class="pts">${r.points}<small>pts</small></div><div class="msg"><strong>${r.title}</strong><span>${r.detail}</span></div>`;
  t.hidden = false;
  // Restart the entry animation.
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
}

function recordResult() {
  if (recorded) return;
  recorded = true;
  const g = round.guess;
  const pts = g?.points ?? 0;
  sessionScore += pts;
  $('totalScore').textContent = sessionScore;

  stats.rounds++;
  stats.points += pts;
  if (g?.distance != null) {
    stats.distSum += g.distance;
    stats.distN++;
  }
  stats.best = Math.max(stats.best ?? 0, pts);
  store.set('tvt.stats', stats);
  renderStats();
}

function renderStats() {
  $('recRounds').textContent = stats.rounds;
  $('recAvg').textContent = stats.rounds ? Math.round(stats.points / stats.rounds) : '–';
  $('recDist').textContent = stats.distN ? `${(stats.distSum / stats.distN).toFixed(1)} m` : '–';
  $('recBest').textContent = stats.best ?? '–';
}

function updateStatus() {
  const dot = $('statusDot');
  dot.className = 'dot';
  let text;
  if (paused) {
    dot.classList.add('paused');
    text = 'Paused';
  } else if (round.phase === 'watching') {
    text = 'Watching the air<span class="wide-only">: click where the lift is</span>';
  } else if (round.phase === 'revealed') {
    dot.classList.add('revealed');
    text = round.thermal ? 'Thermal revealed<span class="wide-only">. Watch it drift</span>' : 'Waiting for the thermal…';
  } else {
    dot.classList.add('revealed');
    text = 'Thermal has left the field';
  }
  $('statusText').innerHTML = text;
}

// ---- Controls --------------------------------------------------------------------

function setPaused(p) {
  paused = p;
  $('pausedBadge').hidden = !p;
  $('pauseIcon').setAttribute('d', p ? 'M8 5v14l11-7z' : 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z');
  $('btnPause').setAttribute('aria-label', p ? 'Resume' : 'Pause');
  if (round) updateStatus();
}

function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (e) => {
  if (round.phase !== 'watching') return;
  if (paused) setPaused(false);
  const p = canvasPoint(e);
  round.mark(renderer.toWorld(p.x, p.y));
});

canvas.addEventListener('pointermove', (e) => {
  hover = e.pointerType === 'mouse' ? canvasPoint(e) : null;
});
canvas.addEventListener('pointerleave', () => (hover = null));

$('btnNew').addEventListener('click', () => newRound());
$('sumNext').addEventListener('click', () => newRound());
$('sumRetry').addEventListener('click', () => newRound(round.scn.seed, round.opts));
$('btnReveal').addEventListener('click', () => round.reveal());
$('btnPause').addEventListener('click', () => setPaused(!paused));
$('toast').addEventListener('click', () => ($('toast').hidden = true));

function bindSegmented(id, key, parse = (v) => v, onChange = null) {
  const seg = $(id);
  const buttons = [...seg.querySelectorAll('button')];
  const sync = () => buttons.forEach((b) => b.setAttribute('aria-checked', String(parse(b.dataset.v) === settings[key])));
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      const changed = settings[key] !== parse(b.dataset.v);
      settings[key] = parse(b.dataset.v);
      saveSettings();
      sync();
      if (changed && onChange) onChange();
    }),
  );
  sync();
}
bindSegmented('speedSeg', 'speed', Number);
bindSegmented('windSeg', 'windClass');
bindSegmented('strengthSeg', 'thermalClass');

const easyBox = $('easyMode');
easyBox.checked = !!settings.easy;
easyBox.addEventListener('change', () => {
  settings.easy = easyBox.checked;
  saveSettings();
});
// Switching layout starts a fresh scenario straight away.
bindSegmented('modeSeg', 'mode', String, () => newRound());

for (const [id, key] of [
  ['aidBaseline', 'baseline'],
  ['aidThird', 'third'],
  ['aidProject', 'project'],
  ['aidRings', 'rings'],
]) {
  const el = $(id);
  el.checked = !!settings.assists[key];
  el.addEventListener('change', () => {
    settings.assists[key] = el.checked;
    saveSettings();
  });
}

const gusty = $('gusty');
gusty.value = settings.gustiness;
$('gustyOut').textContent = `${settings.gustiness}%`;
gusty.addEventListener('input', () => {
  settings.gustiness = Number(gusty.value);
  $('gustyOut').textContent = `${settings.gustiness}%`;
  saveSettings();
});

$('btnResetStats').addEventListener('click', () => {
  stats = emptyStats();
  store.set('tvt.stats', stats);
  renderStats();
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  const inControl = tag === 'INPUT' || tag === 'BUTTON' || tag === 'SUMMARY';
  if (e.code === 'Space' && !inControl) {
    e.preventDefault();
    setPaused(!paused);
  } else if (e.key === 'n' || e.key === 'N') {
    newRound();
  } else if (e.key === 'r' || e.key === 'R') {
    round.reveal();
  }
});

// ---- Layout -------------------------------------------------------------------------

// On desktop the field fills the stage; stacked on a phone it's sized from the
// width. Either way it's kept from getting too long and thin.
const MAX_ASPECT = 1.8;

function layout() {
  const stage = wrap.parentElement;
  const stacked = window.matchMedia('(max-width: 900px)').matches;
  let w = stage.clientWidth;
  let h = stacked ? Math.max(w * 0.75, Math.min(window.innerHeight * 0.72, w * 1.3)) : stage.clientHeight;
  if (w / h > MAX_ASPECT) w = h * MAX_ASPECT;
  if (h / w > MAX_ASPECT) h = w * MAX_ASPECT;
  w = Math.max(260, Math.floor(w));
  h = Math.max(260, Math.floor(h));
  if (w !== renderer.w || h !== renderer.h) renderer.resize(w, h);
}

new ResizeObserver(layout).observe(wrap.parentElement);
window.addEventListener('resize', layout);

function formatClock(t) {
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- Boot ------------------------------------------------------------------------------

const urlSeed = new URLSearchParams(location.search).get('seed');
const parsedSeed = urlSeed ? parseInt(urlSeed, 16) : NaN;
layout();
renderStats();
newRound(Number.isFinite(parsedSeed) ? parsedSeed >>> 0 : randomSeed());
requestAnimationFrame((t) => {
  last = t;
  requestAnimationFrame(frame);
});
