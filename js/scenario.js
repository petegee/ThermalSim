// Scenario generation and the round state machine. No DOM in here so it can be
// unit-tested under Node.

import { add, scale, dist, perpLeft, norm, fromHeading } from './vec.js';
import { mulberry32, randRange, smoothstep, GustField, localWind } from './physics.js';

export const FIELD_HALF = 70; // metres visible in every direction from the pilot

export const WIND_CLASSES = {
  slow: { min: 1.5, max: 3.0, label: 'Slow' },
  moderate: { min: 3.0, max: 5.0, label: 'Moderate' },
};

// Pole layout relative to the pilot, in wind-aligned coordinates.
export const POLE_UPWIND = 28;
export const POLE_SPREAD = 18;

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

// opts: { windClass: 'random' | 'slow' | 'moderate', gustiness: 0..0.35 }
export function createScenario(seed, opts = {}) {
  const rng = mulberry32(seed);
  const windPref = opts.windClass ?? 'random';
  const windClass = windPref === 'random' ? (rng() < 0.5 ? 'slow' : 'moderate') : windPref;
  const { min, max } = WIND_CLASSES[windClass];
  const windSpeed = randRange(rng, min, max);
  const windFrom = rng() * 360; // meteorological: direction the wind comes FROM
  const wind = fromHeading((windFrom + 180) % 360, windSpeed);

  const upwind = norm(scale(wind, -1));
  const left = perpLeft(upwind); // pilot's left when facing into wind
  const poles = [
    { id: 'L', label: 'Left pole', pos: add(scale(upwind, POLE_UPWIND), scale(left, POLE_SPREAD)) },
    { id: 'R', label: 'Right pole', pos: add(scale(upwind, POLE_UPWIND), scale(left, -POLE_SPREAD)) },
  ];

  // Thermal: forms somewhere upwind of the pilot, inside the visible field,
  // after a quiet spell so the player can learn the baseline wind first.
  let spawnPos;
  for (let i = 0; i < 200; i++) {
    const a = randRange(rng, 18, 62); // metres upwind of the pilot
    const c = randRange(rng, -42, 42); // metres across the wind
    const p = add(scale(upwind, a), scale(left, c));
    const nearPole = Math.min(...poles.map((pl) => dist(pl.pos, p)));
    if (Math.abs(p.x) <= FIELD_HALF - 8 && Math.abs(p.y) <= FIELD_HALF - 8 && nearPole > 8) {
      spawnPos = p;
      break;
    }
  }
  spawnPos ??= scale(upwind, 40);

  const thermalSpec = {
    spawnTime: randRange(rng, 5, 14),
    spawnPos,
    radius: randRange(rng, 9, 16), // core radius, m
    strength: randRange(rng, 1.6, 3.0), // peak inflow at the core edge, m/s
    rampTime: randRange(rng, 5, 9), // seconds to build to full strength
  };

  const gustiness = opts.gustiness ?? 0.1;
  const gusts = new GustField(rng, gustiness);

  return {
    seed,
    windClass,
    windSpeed,
    windFrom,
    wind,
    upwind,
    left,
    poles,
    thermalSpec,
    gusts,
    gustiness,
    thermal: null,
  };
}

// Is a circle of radius r at p completely outside the visible field?
export function offField(p, r = 0) {
  return Math.abs(p.x) > FIELD_HALF + r || Math.abs(p.y) > FIELD_HALF + r;
}

// ---- Scoring -----------------------------------------------------------------

export const SCORE_SIGMA = 12;

export function scoreGuess(distance) {
  return Math.round(100 * Math.exp(-(distance * distance) / (2 * SCORE_SIGMA * SCORE_SIGMA)));
}

export function rateGuess(distance, radius) {
  if (distance <= radius * 0.5) return { tier: 'core', text: 'Dead centre: you’re in the core' };
  if (distance <= radius) return { tier: 'lift', text: 'In the lift' };
  if (distance <= radius * 2) return { tier: 'edge', text: 'On the edge: you’d feel it' };
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
    this.guess = null; // { pos, t, thermalPos, distance, points, rating, early }
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
      th.pos = add(th.pos, scale(this.scn.wind, dt));
      th.strengthNow = th.strength * smoothstep(0, spec.rampTime, this.t - th.bornAt);
      this.trailClock += dt;
      if (this.trailClock >= 0.25) {
        this.trailClock = 0;
        this.trail.push({ ...th.pos });
      }
      if (this.phase !== 'over' && offField(th.pos, th.radius * 0.6)) {
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
      const d = dist(pos, th.pos);
      this.guess = {
        pos,
        t: this.t,
        early: false,
        thermalPos: { ...th.pos },
        distance: d,
        points: scoreGuess(d),
        rating: rateGuess(d, th.radius),
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

// Rough time for a thermal to cross from its spawn point off the field.
export function estimatedCrossingTime(scn) {
  const { spawnPos, radius } = scn.thermalSpec;
  const u = norm(scn.wind);
  let t = 0;
  let p = { ...spawnPos };
  const step = 0.5;
  while (!offField(p, radius * 0.6) && t < 600) {
    p = add(p, scale(u, scn.windSpeed * step));
    t += step;
  }
  return t;
}
