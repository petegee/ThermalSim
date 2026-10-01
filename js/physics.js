// Wind-field model.
//
// Local wind anywhere on the field is plain vector addition, as in Joe Wurts'
// third-vector diagram:
//
//     felt wind  =  ambient wind  +  gusts  +  thermal inflow
//
// The thermal inflow at a point always points at the thermal centre, so the
// difference between what a streamer shows (C) and where it would sit in the
// ambient wind (B), the "third vector", points at the thermal.
//
// One refinement: right under the core the air is going up, not sideways, so
// the ambient wind (and its gusts) fades out there and a streamer goes limp
// as the thermal passes overhead. Outside the core this is negligible.

import { add, scale, sub, len, norm, dist } from './vec.js';

// Deterministic PRNG so a scenario can be replayed from its seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randRange = (rng, lo, hi) => lo + (hi - lo) * rng();

export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Radial inflow profile, normalised so the peak (at the core edge r = R) is 1.
// Inside the core it rises linearly from zero (the air there is going up, not
// sideways); outside it decays with distance, slightly faster than the 1/r
// that mass continuity alone would give, so the effect stays local-ish.
export const INFLOW_DECAY = 1.1;
export function inflowProfile(r, R) {
  if (r <= 0) return 0;
  return r < R ? r / R : Math.pow(R / r, INFLOW_DECAY);
}

// Horizontal inflow toward a thermal at point p (m/s). Zero before the
// thermal forms; ramps up smoothly while it builds.
export function thermalInflow(thermal, p) {
  if (!thermal || thermal.strengthNow <= 0) return { x: 0, y: 0 };
  const toCentre = sub(thermal.pos, p);
  const r = len(toCentre);
  if (r < 1e-6) return { x: 0, y: 0 };
  return scale(norm(toCentre), thermal.strengthNow * inflowProfile(r, thermal.radius));
}

// How much of the ambient wind is cancelled at p, 0..1: a calm patch under the
// core, Gaussian with width CALM_RADIUS × core radius, growing as the thermal
// builds. At the core edge it's ~20%, and beyond 1.5 R it's under 3%.
export const CALM_RADIUS = 0.8;
export function thermalCalm(thermal, p) {
  if (!thermal || thermal.strengthNow <= 0) return 0;
  const r = dist(thermal.pos, p) / (CALM_RADIUS * thermal.radius);
  return (thermal.strengthNow / thermal.strength) * Math.exp(-r * r);
}

// Gusts: a handful of travelling sine waves frozen into the air mass and
// carried along with the ambient wind, so both poles feel related (but not
// identical) gusts. Amplitude scales with wind speed; `intensity` is the
// fraction of ambient speed (RMS per component).
export class GustField {
  constructor(rng, intensity) {
    this.intensity = intensity;
    this.modes = [];
    const n = 7;
    for (let i = 0; i < n; i++) {
      const wavelength = randRange(rng, 10, 70);
      const ang = rng() * Math.PI * 2;
      const k = (2 * Math.PI) / wavelength;
      this.modes.push({
        kx: Math.cos(ang) * k,
        ky: Math.sin(ang) * k,
        omega: randRange(rng, -0.4, 0.4),
        px: rng() * Math.PI * 2,
        py: rng() * Math.PI * 2,
        // Along-wind fluctuations are usually a bit bigger than cross-wind.
        ax: randRange(rng, 0.4, 1),
        ay: randRange(rng, 0.4, 1),
      });
    }
    // Normalise so each component has unit RMS before scaling by intensity.
    const sx = Math.sqrt(this.modes.reduce((s, m) => s + (m.ax * m.ax) / 2, 0));
    const sy = Math.sqrt(this.modes.reduce((s, m) => s + (m.ay * m.ay) / 2, 0));
    for (const m of this.modes) {
      m.ax /= sx;
      m.ay /= sy;
    }
  }

  // Returns gust vector (m/s) at world point p, time t, for ambient wind W.
  sample(p, t, W) {
    if (this.intensity <= 0) return { x: 0, y: 0 };
    const speed = len(W);
    // Advect the pattern downwind with the air.
    const qx = p.x - W.x * t;
    const qy = p.y - W.y * t;
    let along = 0;
    let cross = 0;
    for (const m of this.modes) {
      const phase = m.kx * qx + m.ky * qy + m.omega * t;
      along += m.ax * Math.sin(phase + m.px);
      cross += m.ay * Math.sin(phase + m.py);
    }
    const u = norm(W);
    const amp = this.intensity * speed;
    // Rotate (along, cross) into world frame.
    return {
      x: (u.x * along - u.y * cross) * amp,
      y: (u.y * along + u.x * cross) * amp,
    };
  }
}

// The total wind at a point. Pass t = null to leave out the gusts.
export function localWind(scn, p, t, thermal = scn.thermal) {
  const ambient = t == null ? scn.wind : add(scn.wind, scn.gusts.sample(p, t, scn.wind));
  return add(scale(ambient, 1 - thermalCalm(thermal, p)), thermalInflow(thermal, p));
}

// ---- Streamer model --------------------------------------------------------
//
// A real streamer hangs down in still air and lifts toward horizontal as the
// wind picks up, so from above its visible length grows with wind speed.
// Drag goes with speed squared, so in light air it barely lifts: below
// STREAMER_LIFT_MS the length falls off as v², and the streamer hangs limp
// near zero. Above that (every ambient wind the scenarios use) length is
// linear in speed, so the streamer tip is literally the wind vector drawn
// from the pole, which is what makes the B→C third vector point at the thermal.

export const STREAMER_M_PER_MS = 3.4; // metres of (stylised, exaggerated) streamer per m/s
export const STREAMER_LIFT_MS = 1.5;
export const STREAMER_MAX_MS = 10;

// Visible streamer length (m) for a wind speed (m/s).
export function streamerLength(s) {
  const eff = s < STREAMER_LIFT_MS ? (s * s) / STREAMER_LIFT_MS : Math.min(s, STREAMER_MAX_MS);
  return eff * STREAMER_M_PER_MS;
}

export function streamerTipOffset(windVec) {
  const s = len(windVec);
  return s < 1e-9 ? { x: 0, y: 0 } : scale(windVec, streamerLength(s) / s);
}

export class Streamer {
  constructor(pole, initialWind) {
    this.pole = pole;
    this.v = { ...initialWind }; // smoothed wind the streamer is showing
    this.phase = Math.random() * 10;
    this.wander = Math.random() * 10;
  }

  // Streamers respond quickly but not instantly.
  update(dt, wind, tau = 0.35) {
    const a = 1 - Math.exp(-dt / tau);
    this.v.x += (wind.x - this.v.x) * a;
    this.v.y += (wind.y - this.v.y) * a;
    const s = len(this.v);
    this.phase += dt * (5 + 2.6 * s);
    this.wander += dt * 0.7;
  }

  get tip() {
    return add(this.pole, streamerTipOffset(this.v));
  }
}
