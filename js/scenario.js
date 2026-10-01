// Scenario generation and the round state machine. No DOM in here so it can be
// unit-tested under Node.

import { add, scale, dot, dist, len, perpLeft, norm, fromHeading, headingOf, angleDiff, distToSegment } from './vec.js';
import { mulberry32, randRange, smoothstep, GustField, localWind } from './physics.js';

// The visible field is a rectangle centred on the pilot. Its shorter side
// always shows FIELD_SHORT_HALF metres either way; a wider screen shows more
// ground along the longer side.
export const FIELD_SHORT_HALF = 70;
export const DEFAULT_FIELD = { halfW: FIELD_SHORT_HALF, halfH: FIELD_SHORT_HALF };

export const WIND_CLASSES = {
  slow: { min: 1.5, max: 3.0, label: 'Slow' },
  moderate: { min: 3.0, max: 5.0, label: 'Moderate' },
};

// Thermal strength: peak inflow at the core edge (m/s) and core radius (m).
// Inflow decays as (R/r)^1.1 outside the core, so a stronger, wider thermal
// pulls air in from much further out: for a mid-range thermal of each class,
// inflow is still about 0.27, 0.5 and 1 m/s 50 m from the centre. A strong thermal upwind of a
// streamer often out-pulls a light wind and turns the streamer round.
export const THERMAL_CLASSES = {
  weak: { strength: [1.2, 2.0], radius: [8, 12], label: 'Weak' },
  medium: { strength: [1.6, 3.0], radius: [9, 16], label: 'Medium' },
  strong: { strength: [3.0, 4.5], radius: [12, 18], label: 'Strong' },
};

// Easy mode: the track passes within EASY_PASS metres of a streamer (or
// between the two poles) and the thermal forms between EASY_LEAD.min and
// EASY_LEAD.max metres upwind of the streamers, so you see the whole
// lull → limp → surge as it goes by.
export const EASY_PASS = 12;
export const EASY_LEAD = { min: 50, max: 70 };

// A thermal never forms within this many metres of the pilot or any
// streamer: popping up right beside a streamer gives an instant, obvious
// shift. From further out its inflow builds gradually as it drifts closer.
export const MIN_SPAWN_DIST = 50;

// How many readable tracks to draw (uniformly 1..PICK_MAX) before taking the
// one with the weakest signal. Readable tracks cluster close to a streamer,
// so taking the weakest of a few spreads passes out toward the limit of what
// can still be read, while some rounds still pass close by.
export const PICK_MAX = 3;

// Streamer layouts, in wind-aligned coordinates relative to the pilot.
// Every layout includes the pilot's own streamer (id 'P'): it stands for the
// wind the pilot feels, and the pilot is always there. It sits a little
// upwind and to the right, so it blows past rather than across the figure.
//   poles: plus two poles upwind, one each side: the classic third-vector setup.
//   ring:  plus RING.count poles evenly round the pilot at RING.radius, half
//          a step off dead upwind, so (for five) there's a pair upwind, a
//          pair just behind crosswind and one dead downwind.
//   pilot: the pilot's streamer alone.
export const LAYOUTS = ['poles', 'ring', 'pilot'];
export const POLE_UPWIND = 28;
export const POLE_SPREAD = 18;
export const RING = { count: 5, radius: 30 };
export const PILOT_STREAMER = { upwind: 3, right: 4 };

// Along-wind gust RMS as a fraction of wind speed.
export const DEFAULT_GUSTINESS = 0.06;

// The thermal may form this far beyond the upwind edge and drift in.
export const ENTRY_MARGIN = 15;

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

function makePoles(layout, upwind, left) {
  const { upwind: a, right } = PILOT_STREAMER;
  const pilot = { id: 'P', label: 'pilot streamer', pos: add(scale(upwind, a), scale(left, -right)) };
  if (layout === 'ring') {
    const ring = Array.from({ length: RING.count }, (_, i) => {
      // Angle from dead upwind, counter-clockwise (toward the pilot's left).
      const a = ((i + 0.5) / RING.count) * Math.PI * 2;
      const pos = add(scale(upwind, RING.radius * Math.cos(a)), scale(left, RING.radius * Math.sin(a)));
      // Name it by where it stands relative to the pilot facing into wind.
      const along = Math.cos(a) > 0.5 ? 'upwind' : Math.cos(a) < -0.5 ? 'downwind' : 'crosswind';
      const side = Math.abs(Math.sin(a)) < 0.2 ? '' : Math.sin(a) > 0 ? '-left' : '-right';
      return { id: String(i + 1), label: `${along}${side} streamer`, pos };
    });
    return [...ring, pilot];
  }
  if (layout === 'pilot') return [pilot];
  return [
    { id: 'L', label: 'left pole', pos: add(scale(upwind, POLE_UPWIND), scale(left, POLE_SPREAD)) },
    { id: 'R', label: 'right pole', pos: add(scale(upwind, POLE_UPWIND), scale(left, -POLE_SPREAD)) },
    pilot,
  ];
}

// Where the line o + s·u crosses the field: [sIn, sOut], or null if it misses.
export function fieldChord(o, u, field) {
  let lo = -Infinity;
  let hi = Infinity;
  for (const [oc, uc, h] of [
    [o.x, u.x, field.halfW],
    [o.y, u.y, field.halfH],
  ]) {
    if (Math.abs(uc) < 1e-9) {
      if (Math.abs(oc) > h) return null;
      continue;
    }
    const a = (-h - oc) / uc;
    const b = (h - oc) / uc;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  }
  return hi > lo ? [lo, hi] : null;
}

// Metres of drift the thermal should have left on the field once it forms.
export const minTrackOnField = (windSpeed) => Math.max(35, windSpeed * 15);

// opts: {
//   windClass: 'random' | 'slow' | 'moderate',
//   thermalClass: 'random' | 'weak' | 'medium' | 'strong',
//   gustiness: 0..0.35,
//   layout: 'poles' | 'ring' | 'pilot',
//   easy: boolean,
//   field: { halfW, halfH } in metres,
// }
export function createScenario(seed, opts = {}) {
  const rng = mulberry32(seed);
  const windPref = opts.windClass ?? 'random';
  const windClass = windPref === 'random' ? (rng() < 0.5 ? 'slow' : 'moderate') : windPref;
  const { min, max } = WIND_CLASSES[windClass];
  const windSpeed = randRange(rng, min, max);
  const windFrom = rng() * 360; // meteorological: direction the wind comes FROM
  const wind = fromHeading((windFrom + 180) % 360, windSpeed);

  const layout = LAYOUTS.includes(opts.layout) ? opts.layout : 'poles';
  const field = opts.field ?? DEFAULT_FIELD;
  const down = norm(wind);
  const upwind = scale(down, -1);
  const left = perpLeft(upwind); // pilot's left when facing into wind
  const poles = makePoles(layout, upwind, left);

  // Thermal track: any line across the field parallel to the wind. Normally
  // the crosswind offset is spread evenly over the whole field and the
  // thermal forms anywhere along the line, from just beyond the upwind edge
  // to far enough up the field that it stays on screen for a while. In easy
  // mode the line passes close to a streamer and starts upwind of them.
  const easy = !!opts.easy;
  const crossExtent = Math.abs(left.x) * field.halfW + Math.abs(left.y) * field.halfH;
  const poleCross = poles.map((pl) => dot(pl.pos, left));
  const crossRange = easy
    ? [Math.min(...poleCross) - EASY_PASS, Math.max(...poleCross) + EASY_PASS]
    : [-crossExtent, crossExtent];
  const streamersAt = Math.min(...poles.map((pl) => dot(pl.pos, down))); // most upwind
  const minTrack = minTrackOnField(windSpeed);

  const thermalPref = opts.thermalClass ?? 'medium';
  const thermalClass =
    thermalPref === 'random' ? ['weak', 'medium', 'strong'][Math.floor(rng() * 3)] : thermalPref;
  const tc = THERMAL_CLASSES[thermalClass];
  const thermalSpec = {
    spawnTime: randRange(rng, 5, 14),
    spawnPos: null,
    radius: randRange(rng, ...tc.radius), // core radius, m
    strength: randRange(rng, ...tc.strength), // peak inflow at the core edge, m/s
    rampTime: randRange(rng, 5, 9), // seconds to build to full strength
    signal: null,
  };

  // Only accept a track that gives a readable signal: at some point while
  // the thermal is on the field, at least one streamer must swing by
  // MIN_SIGNAL.angle and change speed by MIN_SIGNAL.speed. Outside easy mode,
  // collect `pick` readable tracks and keep the weakest (see PICK_MAX). If no
  // candidate manages it, keep the one that came closest.
  const pick = easy ? 1 : 1 + Math.floor(rng() * PICK_MAX);
  const spawnClear = [{ x: 0, y: 0 }, ...poles.map((pl) => pl.pos)];
  let best = null;
  let chosen = null;
  let readable = 0;
  for (let i = 0; i < 400; i++) {
    const o = scale(left, randRange(rng, crossRange[0], crossRange[1]));
    const chord = fieldChord(o, down, field);
    if (!chord || chord[1] - chord[0] < minTrack) continue; // clips a corner
    const [lo, hi] = easy
      ? [Math.max(chord[0] - ENTRY_MARGIN, streamersAt - EASY_LEAD.max), streamersAt - EASY_LEAD.min]
      : [chord[0] - ENTRY_MARGIN, chord[1] - minTrack];
    if (hi < lo) continue;
    const p = add(o, scale(down, randRange(rng, lo, hi)));
    if (Math.min(...spawnClear.map((q) => dist(q, p))) < MIN_SPAWN_DIST) continue;
    const signal = thermalSignal({ wind, poles, field }, { ...thermalSpec, spawnPos: p });
    if (!best || signal.score > best.signal.score) best = { p, signal };
    if (signal.score < SIGNAL_MARGIN) continue;
    if (!chosen || signal.score < chosen.signal.score) chosen = { p, signal };
    if (++readable >= pick) break;
  }
  chosen ??= best;
  thermalSpec.spawnPos = chosen ? chosen.p : scale(upwind, FIELD_SHORT_HALF + ENTRY_MARGIN);
  thermalSpec.signal = chosen ? chosen.signal : null;

  const gustiness = opts.gustiness ?? DEFAULT_GUSTINESS;
  const gusts = new GustField(rng, gustiness);

  return {
    seed,
    windClass,
    thermalClass,
    easy,
    windSpeed,
    windFrom,
    wind,
    upwind,
    left,
    layout,
    field,
    poles,
    thermalSpec,
    gusts,
    gustiness,
    thermal: null,
  };
}

// ---- Signal check -------------------------------------------------------------
//
// The thermal has to make itself felt: somewhere along its track, while it is
// on the field, at least one streamer must turn by MIN_SIGNAL.angle degrees
// away from the ambient wind direction and change speed by MIN_SIGNAL.speed
// (a fraction of ambient). The two don't have to peak at the same moment.
// With default gusts (along-wind RMS 6 %, direction RMS ~2.5°) both are well
// clear of the turbulence.
export const MIN_SIGNAL = { angle: 15, speed: 0.2 };
// The generator asks for this much more than MIN_SIGNAL, so the round, which
// samples at its own frame times, always clears the thresholds comfortably.
const SIGNAL_MARGIN = 1.1;

// Below this felt speed (m/s) a streamer is limp, so its angle means nothing.
const LIMP_MS = 0.3;

// Drift the thermal (without gusts) from where it forms until it leaves the
// field, and report the biggest change it makes to each streamer. Returns the
// streamer that best meets both thresholds: { angle, speed, pole, score },
// where score ≥ 1 means both are met.
export function thermalSignal({ wind, poles, field }, spec, dt = 0.5) {
  const W = len(wind);
  const th = { pos: { ...spec.spawnPos }, radius: spec.radius, strength: spec.strength, strengthNow: 0 };
  const peak = poles.map(() => ({ angle: 0, speed: 0 }));
  let entered = false;
  for (let t = 0; t < 600; t += dt) {
    th.pos = add(spec.spawnPos, scale(wind, t));
    th.strengthNow = spec.strength * smoothstep(0, spec.rampTime, t);
    const off = offField(th.pos, 0, field);
    if (off && entered) break;
    if (off) continue;
    entered = true;
    poles.forEach((pole, i) => {
      const felt = localWind({ wind }, pole.pos, null, th);
      const s = len(felt);
      peak[i].speed = Math.max(peak[i].speed, Math.abs(s - W) / W);
      if (s > LIMP_MS) {
        const cos = dot(felt, wind) / (s * W);
        peak[i].angle = Math.max(peak[i].angle, (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
      }
    });
  }
  let best = { angle: 0, speed: 0, pole: null, score: 0 };
  peak.forEach((pk, i) => {
    const score = Math.min(pk.angle / MIN_SIGNAL.angle, pk.speed / MIN_SIGNAL.speed);
    if (score > best.score) best = { ...pk, pole: poles[i].id, score };
  });
  return best;
}

// Is a circle of radius r at p completely outside the field?
export function offField(p, r = 0, field = DEFAULT_FIELD) {
  return Math.abs(p.x) > field.halfW + r || Math.abs(p.y) > field.halfH + r;
}

// ---- Scoring -----------------------------------------------------------------

export const SCORE_SIGMA = 12;

export function scoreGuess(distance) {
  return Math.round(100 * Math.exp(-(distance * distance) / (2 * SCORE_SIGMA * SCORE_SIGMA)));
}

// Partial credit for reading the direction right but misjudging the range.
// The pilot launches from the centre and flies toward their mark, so:
//   - a bearing (from the pilot) within a few degrees of the thermal's earns
//     up to DIRECTION_POINTS, falling off with DIRECTION_SIGMA degrees;
//   - if that flight line passes through the lift (within the core radius)
//     on the way to the mark, they'd have found it anyway: FLY_THROUGH_POINTS.
// Bearings mean nothing when the thermal or the mark is right by the pilot,
// so neither applies when the thermal is within DIRECTION_MIN_CORES core
// radii of the pilot or the mark within DIRECTION_MIN_MARK metres.
export const DIRECTION_POINTS = 35;
export const DIRECTION_SIGMA = 10;
export const FLY_THROUGH_POINTS = 50;
export const DIRECTION_MIN_CORES = 2;
export const DIRECTION_MIN_MARK = 10;

const PILOT = { x: 0, y: 0 };

// Score a mark against the thermal's position at the moment of marking.
// Points are the best of the distance score and the direction credits.
export function assessGuess(pos, thermalPos, radius) {
  const distance = dist(pos, thermalPos);
  const byDistance = scoreGuess(distance);
  let bearingError = null;
  let flyThrough = false;
  let byDirection = 0;
  if (len(thermalPos) >= DIRECTION_MIN_CORES * radius && len(pos) >= DIRECTION_MIN_MARK) {
    bearingError = Math.abs(angleDiff(headingOf(thermalPos), headingOf(pos)));
    byDirection = Math.round(DIRECTION_POINTS * Math.exp(-(bearingError ** 2) / (2 * DIRECTION_SIGMA ** 2)));
    flyThrough = distToSegment(thermalPos, PILOT, pos) <= radius;
  }
  const points = Math.max(byDistance, byDirection, flyThrough ? FLY_THROUGH_POINTS : 0);
  return { distance, points, bearingError, flyThrough, rating: rateGuess(distance, radius, { bearingError, flyThrough }) };
}

export function rateGuess(distance, radius, { bearingError = null, flyThrough = false } = {}) {
  if (distance <= radius * 0.5) return { tier: 'core', text: 'Dead centre: you’re in the core' };
  if (distance <= radius) return { tier: 'lift', text: 'In the lift' };
  if (distance <= radius * 2) return { tier: 'edge', text: 'On the edge: you’d feel it' };
  if (flyThrough) return { tier: 'through', text: 'Right line: you’d fly through it on the way' };
  if (bearingError != null && bearingError <= DIRECTION_SIGMA) {
    return { tier: 'line', text: 'Right direction, wrong distance' };
  }
  if (distance <= 35) return { tier: 'near', text: 'Close, but you’d fly past it' };
  return { tier: 'miss', text: 'Missed it' };
}

// ---- Round state machine -------------------------------------------------------
//
//   watching  → the player studies the streamers (thermal may or may not exist yet)
//   revealed  → thermal and vectors shown; it keeps drifting
//   over      → thermal has left the field

export class Round {
  constructor(scn) {
    this.scn = scn;
    this.t = 0;
    this.phase = 'watching';
    this.guess = null; // { pos, t, thermalPos, distance, points, rating, bearingError, flyThrough, early }
    this.trail = [];
    this.trailClock = 0;
    this.endReason = null;
  }

  get thermal() {
    return this.scn.thermal;
  }

  // Time keeps running after the round is over so gusts and streamers stay alive.
  step(dt) {
    this.t += dt;
    const spec = this.scn.thermalSpec;

    if (!this.scn.thermal && this.t >= spec.spawnTime) {
      this.scn.thermal = {
        pos: { ...spec.spawnPos },
        radius: spec.radius,
        strength: spec.strength,
        strengthNow: 0,
        bornAt: this.t,
      };
      this.trail.push({ ...spec.spawnPos });
    }

    const th = this.scn.thermal;
    if (th) {
      // Position follows from age, so it's at spawnPos the moment it forms
      // (matching the generator's signal check).
      const age = this.t - th.bornAt;
      th.pos = add(spec.spawnPos, scale(this.scn.wind, age));
      th.strengthNow = th.strength * smoothstep(0, spec.rampTime, age);
      this.trailClock += dt;
      if (this.trailClock >= 0.25) {
        this.trailClock = 0;
        this.trail.push({ ...th.pos });
      }
      // A thermal can form just beyond the upwind edge, so it has only left
      // once it has been on the field and drifted off again.
      const off = offField(th.pos, th.radius * 0.6, this.scn.field);
      if (!off) th.entered = true;
      if (this.phase !== 'over' && th.entered && off) {
        this.endReason = this.guess ? 'drifted' : 'unmarked';
        this.endT = this.t;
        this.phase = 'over';
      }
    }
  }

  // Record the player's mark. Returns the guess record.
  mark(pos) {
    if (this.guess || this.phase !== 'watching') return null;
    const th = this.scn.thermal;
    if (!th) {
      this.guess = { pos, t: this.t, early: true, points: 0, distance: null, thermalPos: null };
    } else {
      this.guess = {
        pos,
        t: this.t,
        early: false,
        thermalPos: { ...th.pos },
        ...assessGuess(pos, th.pos, th.radius),
        readTime: this.t - th.bornAt,
      };
    }
    this.phase = 'revealed';
    return this.guess;
  }

  // Give up and show the thermal without scoring.
  reveal() {
    if (this.phase !== 'watching') return;
    this.guess = this.guess ?? { gaveUp: true, points: 0, t: this.t };
    this.phase = 'revealed';
  }

  wind(p) {
    return localWind(this.scn, p, this.t);
  }

  ambientAt(p) {
    return add(this.scn.wind, this.scn.gusts.sample(p, this.t, this.scn.wind));
  }
}

// Time for the thermal to drift from where it forms until it leaves the field.
export function estimatedCrossingTime(scn) {
  const { spawnPos, radius } = scn.thermalSpec;
  const u = norm(scn.wind);
  let t = 0;
  let p = { ...spawnPos };
  let entered = false;
  const step = 0.5;
  while (t < 600) {
    const off = offField(p, radius * 0.6, scn.field);
    if (!off) entered = true;
    if (entered && off) break;
    p = add(p, scale(u, scn.windSpeed * step));
    t += step;
  }
  return t;
}
