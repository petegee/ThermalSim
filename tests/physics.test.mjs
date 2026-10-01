import test from 'node:test';
import assert from 'node:assert/strict';

import { sub, len, norm, dot, dist, headingOf, angleDiff } from '../js/vec.js';
import { thermalInflow, inflowProfile, streamerTipOffset, localWind } from '../js/physics.js';
import {
  createScenario,
  Round,
  FIELD_HALF,
  WIND_CLASSES,
  scoreGuess,
  estimatedCrossingTime,
} from '../js/scenario.js';

const thermalAt = (x, y, strength = 2.5, radius = 12) => ({
  pos: { x, y },
  radius,
  strength,
  strengthNow: strength,
});

test('inflow points at the thermal from every direction', () => {
  const th = thermalAt(10, -5);
  for (let deg = 0; deg < 360; deg += 15) {
    const r = (deg * Math.PI) / 180;
    for (const d of [4, 12, 30, 60]) {
      const p = { x: 10 + Math.cos(r) * d, y: -5 + Math.sin(r) * d };
      const v = thermalInflow(th, p);
      const toward = norm(sub(th.pos, p));
      assert.ok(dot(norm(v), toward) > 0.9999, `deg=${deg} d=${d}`);
    }
  }
});

test('inflow peaks at the core edge and decays outside', () => {
  assert.equal(inflowProfile(12, 12), 1);
  assert.ok(inflowProfile(6, 12) < 1);
  assert.ok(inflowProfile(24, 12) < inflowProfile(18, 12));
  assert.ok(inflowProfile(60, 12) < 0.2);
});

test('third vector (C − B) equals the inflow and points at the thermal when air is smooth', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const scn = createScenario(seed, { gustiness: 0 });
    scn.thermal = thermalAt(scn.thermalSpec.spawnPos.x, scn.thermalSpec.spawnPos.y);
    for (const pole of scn.poles) {
      const felt = localWind(scn, pole.pos, 3);
      const B = streamerTipOffset(scn.wind);
      const C = streamerTipOffset(felt);
      const third = sub(C, B);
      const toThermal = norm(sub(scn.thermal.pos, pole.pos));
      assert.ok(dot(norm(third), toThermal) > 0.999, `seed ${seed} pole ${pole.id}`);
    }
  }
});

test('wind lulls when the thermal is upwind of a pole, strengthens when downwind', () => {
  const scn = createScenario(7, { gustiness: 0 });
  const pole = scn.poles[0].pos;
  const up = { x: pole.x + scn.upwind.x * 25, y: pole.y + scn.upwind.y * 25 };
  const down = { x: pole.x - scn.upwind.x * 25, y: pole.y - scn.upwind.y * 25 };
  const ambient = len(scn.wind);
  scn.thermal = thermalAt(up.x, up.y);
  assert.ok(len(localWind(scn, pole, 0)) < ambient);
  scn.thermal = thermalAt(down.x, down.y);
  assert.ok(len(localWind(scn, pole, 0)) > ambient);
});

test('scenarios: wind is never calm or too strong, poles are upwind, thermal spawns on-field', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const scn = createScenario(seed);
    const s = len(scn.wind);
    assert.ok(s >= WIND_CLASSES.slow.min && s <= WIND_CLASSES.moderate.max);
    // wind blows toward (windFrom + 180)
    assert.ok(Math.abs(angleDiff(headingOf(scn.wind), (scn.windFrom + 180) % 360)) < 1e-6);
    for (const pole of scn.poles) assert.ok(dot(pole.pos, scn.upwind) > 15, 'pole upwind');
    // left pole is on the pilot's left when facing upwind
    const L = scn.poles.find((p) => p.id === 'L').pos;
    assert.ok(dot(L, scn.left) > 0);
    const sp = scn.thermalSpec.spawnPos;
    assert.ok(Math.abs(sp.x) <= FIELD_HALF && Math.abs(sp.y) <= FIELD_HALF);
    assert.ok(dot(sp, scn.upwind) > 0, 'thermal starts upwind of the pilot');
    // Thermal stays on screen for a usable time, but does leave.
    const tCross = estimatedCrossingTime(scn);
    assert.ok(tCross > 12 && tCross < 200, `seed ${seed} crossing ${tCross}`);
  }
});

test('same seed reproduces the same scenario', () => {
  const a = createScenario(1234);
  const b = createScenario(1234);
  assert.deepEqual(a.thermalSpec, b.thermalSpec);
  assert.deepEqual(a.wind, b.wind);
  assert.deepEqual(a.gusts.sample({ x: 3, y: 4 }, 10, a.wind), b.gusts.sample({ x: 3, y: 4 }, 10, b.wind));
});

test('round: thermal forms, drifts downwind, scores a mark, and ends off-field', () => {
  const scn = createScenario(99, { gustiness: 0.1 });
  const round = new Round(scn);
  const dt = 1 / 60;
  while (!round.thermal) round.step(dt);
  const start = { ...round.thermal.pos };
  for (let i = 0; i < 120; i++) round.step(dt);
  const moved = sub(round.thermal.pos, start);
  assert.ok(Math.abs(len(moved) - scn.windSpeed * 2) < 0.1, 'drifts at wind speed');
  assert.ok(dot(norm(moved), norm(scn.wind)) > 0.999, 'drifts downwind');

  const g = round.mark({ ...round.thermal.pos });
  assert.equal(g.points, 100);
  assert.equal(round.phase, 'revealed');
  assert.equal(round.mark({ x: 0, y: 0 }), null, 'only one mark per round');

  let guard = 0;
  while (round.phase !== 'over' && guard++ < 60 * 600) round.step(dt);
  assert.equal(round.phase, 'over');
});

test('marking before the thermal forms scores zero', () => {
  const round = new Round(createScenario(5));
  round.step(0.5);
  const g = round.mark({ x: 0, y: 20 });
  assert.equal(g.early, true);
  assert.equal(g.points, 0);
});

test('score falls off with distance', () => {
  assert.equal(scoreGuess(0), 100);
  assert.ok(scoreGuess(5) > 85);
  assert.ok(scoreGuess(12) < 70 && scoreGuess(12) > 50);
  assert.ok(scoreGuess(40) < 3);
});

test('gusts are modest relative to ambient', () => {
  const scn = createScenario(3, { gustiness: 0.12 });
  let sum = 0;
  let n = 0;
  for (let t = 0; t < 200; t += 0.5) {
    const g = scn.gusts.sample({ x: 0, y: 20 }, t, scn.wind);
    sum += g.x * g.x + g.y * g.y;
    n++;
  }
  const rms = Math.sqrt(sum / n);
  assert.ok(rms < scn.windSpeed * 0.3, `rms ${rms}`);
  assert.ok(dist({ x: 0, y: 0 }, { x: 0, y: 0 }) === 0);
});
