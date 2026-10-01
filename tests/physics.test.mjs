import test from 'node:test';
import assert from 'node:assert/strict';

import { sub, len, norm, dot, dist, headingOf, angleDiff } from '../js/vec.js';
import { thermalInflow, inflowProfile, streamerTipOffset, localWind } from '../js/physics.js';
import {
  createScenario,
  Round,
  WIND_CLASSES,
  ENTRY_MARGIN,
  PILOT_STREAMER,
  scoreGuess,
  estimatedCrossingTime,
  fieldChord,
  minTrackOnField,
} from '../js/scenario.js';

const FIELDS = [
  { halfW: 70, halfH: 70 },
  { halfW: 97, halfH: 70 }, // laptop landscape
  { halfW: 70, halfH: 91 }, // phone portrait
];

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
  for (let seed = 1; seed <= 80; seed++) {
    const scn = createScenario(seed, { gustiness: 0, layout: seed % 2 ? 'poles' : 'pilot' });
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

test('scenarios: wind is never calm or too strong, and streamers sit where they should', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const scn = createScenario(seed, { layout: 'poles' });
    const s = len(scn.wind);
    assert.ok(s >= WIND_CLASSES.slow.min && s <= WIND_CLASSES.moderate.max);
    // wind blows toward (windFrom + 180)
    assert.ok(Math.abs(angleDiff(headingOf(scn.wind), (scn.windFrom + 180) % 360)) < 1e-6);
    assert.equal(scn.poles.length, 2);
    for (const pole of scn.poles) assert.ok(dot(pole.pos, scn.upwind) > 15, 'pole upwind');
    // left pole is on the pilot's left when facing upwind
    const L = scn.poles.find((p) => p.id === 'L').pos;
    assert.ok(dot(L, scn.left) > 0);
  }
});

test('pilot-streamer mode: one streamer just upwind and to the right of the pilot', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const scn = createScenario(seed, { layout: 'pilot' });
    assert.equal(scn.poles.length, 1);
    const p = scn.poles[0].pos;
    assert.ok(Math.abs(dot(p, scn.upwind) - PILOT_STREAMER.upwind) < 1e-9);
    assert.ok(Math.abs(dot(p, scn.left) + PILOT_STREAMER.right) < 1e-9, 'on the right');
    assert.ok(len(p) > 6 && len(p) < 10, 'beside the pilot, not on top of them');
  }
});

test('thermal tracks: form on (or just upwind of) the field with enough drift left to read', () => {
  for (const field of FIELDS) {
    for (let seed = 1; seed <= 400; seed++) {
      const scn = createScenario(seed, { field });
      const sp = scn.thermalSpec.spawnPos;
      const down = norm(scn.wind);
      const chord = fieldChord(sp, down, field);
      assert.ok(chord, `seed ${seed}: track crosses the field`);
      assert.ok(chord[0] <= ENTRY_MARGIN + 1e-6, `seed ${seed}: starts at most ${ENTRY_MARGIN} m upwind of the edge`);
      assert.ok(chord[1] >= minTrackOnField(scn.windSpeed) - 1e-6, `seed ${seed}: enough track left`);
      for (const pole of scn.poles) assert.ok(dist(pole.pos, sp) >= 8, 'not right on a pole');
      const tCross = estimatedCrossingTime(scn);
      assert.ok(tCross > 10 && tCross < 240, `seed ${seed} crossing ${tCross}`);
    }
  }
});

test('thermal tracks spread across the whole field, not just past the pilot', () => {
  for (const field of FIELDS) {
    const offsets = [];
    let formsDownwind = 0;
    let driftsIn = 0;
    const N = 600;
    for (let seed = 1; seed <= N; seed++) {
      const scn = createScenario(seed, { field });
      const sp = scn.thermalSpec.spawnPos;
      offsets.push(dot(sp, scn.left)); // closest approach to the pilot (signed)
      if (dot(sp, scn.upwind) < 0) formsDownwind++;
      if (Math.abs(sp.x) > field.halfW || Math.abs(sp.y) > field.halfH) driftsIn++;
    }
    const far = offsets.filter((c) => Math.abs(c) > 40).length / N;
    const short = Math.min(field.halfW, field.halfH);
    assert.ok(far > 0.35, `only ${(far * 100).toFixed(0)}% of tracks pass > 40 m from the pilot`);
    assert.ok(Math.max(...offsets) > short * 0.8 && Math.min(...offsets) < -short * 0.8, 'tracks reach both sides');
    assert.ok(formsDownwind / N > 0.1, 'some thermals form downwind of the pilot');
    assert.ok(driftsIn / N > 0.03, 'some thermals drift in from beyond the upwind edge');
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

test('a thermal that forms beyond the upwind edge drifts in before the round can end', () => {
  let tested = 0;
  for (let seed = 1; seed <= 400 && tested < 10; seed++) {
    const scn = createScenario(seed);
    const sp = scn.thermalSpec.spawnPos;
    if (Math.abs(sp.x) <= 70 && Math.abs(sp.y) <= 70) continue;
    tested++;
    const round = new Round(scn);
    while (!round.thermal) round.step(0.1);
    round.step(0.1);
    assert.equal(round.phase, 'watching', `seed ${seed}`);
    let guard = 0;
    while (round.phase !== 'over' && guard++ < 6000) round.step(0.1);
    assert.equal(round.phase, 'over');
    assert.ok(round.endT - round.thermal.bornAt > 8, 'spent a while on the field');
  }
  assert.ok(tested >= 5);
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
