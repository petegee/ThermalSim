import test from 'node:test';
import assert from 'node:assert/strict';

import { sub, len, norm, dot, dist, headingOf, angleDiff, fromHeading } from '../js/vec.js';
import {
  thermalInflow,
  inflowProfile,
  streamerTipOffset,
  streamerLength,
  localWind,
  Streamer,
  STREAMER_LIFT_MS,
} from '../js/physics.js';
import {
  createScenario,
  Round,
  WIND_CLASSES,
  ENTRY_MARGIN,
  PILOT_STREAMER,
  scoreGuess,
  assessGuess,
  DIRECTION_POINTS,
  FLY_THROUGH_POINTS,
  estimatedCrossingTime,
  fieldChord,
  minTrackOnField,
  THERMAL_CLASSES,
  EASY_PASS,
  EASY_LEAD,
  MIN_SPAWN_DIST,
  RING,
  DEFAULT_GUSTINESS,
  MIN_SIGNAL,
  offField,
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

test('outside the core, the third vector (C − B) points at the thermal when air is smooth', () => {
  let checked = 0;
  for (let seed = 1; seed <= 160; seed++) {
    const scn = createScenario(seed, { gustiness: 0, layout: ['poles', 'ring', 'pilot'][seed % 3] });
    scn.thermal = thermalAt(scn.thermalSpec.spawnPos.x, scn.thermalSpec.spawnPos.y);
    for (const pole of scn.poles) {
      const felt = localWind(scn, pole.pos, 3);
      // Inside 1.5 core radii the calm patch matters; below lift speed the
      // streamer droops non-linearly. Both are covered by their own tests.
      if (dist(pole.pos, scn.thermal.pos) < 1.5 * scn.thermal.radius || len(felt) < STREAMER_LIFT_MS) continue;
      const third = sub(streamerTipOffset(felt), streamerTipOffset(scn.wind));
      const toThermal = norm(sub(scn.thermal.pos, pole.pos));
      assert.ok(dot(norm(third), toThermal) > 0.995, `seed ${seed} pole ${pole.id}`);
      checked++;
    }
  }
  assert.ok(checked > 300, `only ${checked} cases checked`);
});

test('streamer droops in light air: short below lift speed, linear above', () => {
  assert.equal(streamerLength(0), 0);
  assert.ok(streamerLength(0.5) < 0.15 * streamerLength(STREAMER_LIFT_MS), 'nearly limp at 0.5 m/s');
  assert.ok(Math.abs(streamerLength(STREAMER_LIFT_MS - 1e-9) - streamerLength(STREAMER_LIFT_MS)) < 1e-6, 'continuous');
  assert.ok(Math.abs(streamerLength(4) / streamerLength(2) - 2) < 1e-9, 'linear above lift speed');
});

test('the streamer goes limp with the thermal directly overhead', () => {
  const scn = createScenario(11, { gustiness: 0.1 });
  const pole = scn.poles[0].pos;
  scn.thermal = thermalAt(pole.x, pole.y, 2.5, 12);
  for (let t = 0; t < 30; t += 1.7) {
    const felt = localWind(scn, pole, t);
    assert.ok(len(felt) < 0.05, `felt ${len(felt)} m/s at t=${t}`);
    assert.ok(len(streamerTipOffset(felt)) < 0.01, 'limp');
  }
});

test('a thermal drifting over a pole: lull, limp overhead, then a surge', () => {
  for (const seed of [3, 8, 21]) {
    const scn = createScenario(seed, { gustiness: 0, layout: 'pilot' });
    const pole = scn.poles[0].pos;
    const ambient = len(scn.wind);
    const R = 12;
    const at = (along) => {
      const c = { x: pole.x + scn.upwind.x * along, y: pole.y + scn.upwind.y * along };
      scn.thermal = thermalAt(c.x, c.y, 2.5, R);
      return len(localWind(scn, pole, 0));
    };
    assert.ok(at(1.5 * R) < ambient * 0.7, `seed ${seed}: lull as it approaches`);
    assert.ok(at(0) < 0.05, `seed ${seed}: limp overhead`);
    assert.ok(at(-1.5 * R) > ambient * 1.3, `seed ${seed}: surge once it has passed`);
  }
});

test('inflow stronger than the wind, thermal directly upwind: the streamer turns round', () => {
  const scn = createScenario(4, { gustiness: 0, windClass: 'slow', layout: 'pilot' });
  const pole = scn.poles[0].pos;
  const R = 15;
  const S = len(scn.wind) + 1.5; // inflow comfortably beats the wind
  // Strongest just outside the core edge, where the inflow peaks.
  for (const r of [R, 1.1 * R, 1.2 * R]) {
    const c = { x: pole.x + scn.upwind.x * r, y: pole.y + scn.upwind.y * r };
    scn.thermal = thermalAt(c.x, c.y, S, R);
    const felt = localWind(scn, pole, 0);
    assert.ok(dot(felt, scn.upwind) > 0, `r=${r}: blowing upwind, toward the thermal`);
    assert.ok(len(streamerTipOffset(felt)) > 1, `r=${r}: lifted enough to see`);
  }
});

test('strong thermals out in a light wind often turn the streamer round as they approach', () => {
  let reversed = 0;
  const N = 40;
  for (let seed = 1; seed <= N; seed++) {
    const scn = createScenario(seed, { windClass: 'slow', thermalClass: 'strong', layout: 'pilot', easy: true });
    const round = new Round(scn);
    const s = new Streamer(scn.poles[0].pos, round.wind(scn.poles[0].pos));
    let seen = false;
    while (round.phase !== 'over' && round.t < 300 && !seen) {
      round.step(1 / 30);
      s.update(1 / 30, round.wind(s.pole));
      const tip = streamerTipOffset(s.v);
      seen = dot(tip, scn.upwind) > 1.5; // visibly pointing upwind
    }
    if (seen) reversed++;
  }
  assert.ok(reversed / N > 0.5, `only ${reversed}/${N} reversed`);
});

test('thermal strength classes: stronger thermals pull harder and from further out', () => {
  const counts = { weak: 0, medium: 0, strong: 0 };
  for (let seed = 1; seed <= 300; seed++) {
    for (const cls of ['weak', 'medium', 'strong']) {
      const { radius, strength } = createScenario(seed, { thermalClass: cls }).thermalSpec;
      const tc = THERMAL_CLASSES[cls];
      assert.ok(radius >= tc.radius[0] && radius <= tc.radius[1]);
      assert.ok(strength >= tc.strength[0] && strength <= tc.strength[1]);
    }
    counts[createScenario(seed, { thermalClass: 'random' }).thermalClass]++;
  }
  assert.ok(Object.values(counts).every((n) => n > 60), `random picks all three: ${JSON.stringify(counts)}`);
  const mid = ([a, b]) => (a + b) / 2;
  const at50 = (cls) => {
    const tc = THERMAL_CLASSES[cls];
    return len(thermalInflow(thermalAt(50, 0, mid(tc.strength), mid(tc.radius)), { x: 0, y: 0 }));
  };
  assert.ok(at50('strong') > 1.6 * at50('medium') && at50('medium') > 1.6 * at50('weak'), 'reach grows with strength');
  assert.ok(at50('strong') > 0.9, 'a strong thermal is still pulling ~1 m/s at 50 m');
});

test('easy mode: the thermal forms upwind of the streamers and passes close by', () => {
  for (const layout of ['poles', 'ring', 'pilot']) {
    for (const field of FIELDS) {
      for (let seed = 1; seed <= 200; seed++) {
        const scn = createScenario(seed, { field, layout, easy: true });
        const sp = scn.thermalSpec.spawnPos;
        const cross = scn.poles.map((p) => dot(p.pos, scn.left));
        const c = dot(sp, scn.left);
        const closest = Math.min(...cross.map((pc) => Math.abs(pc - c)));
        const between = c >= Math.min(...cross) && c <= Math.max(...cross);
        assert.ok(closest <= EASY_PASS + 1e-6 || between, `${layout} seed ${seed}: passes ${closest.toFixed(1)} m away`);
        const lead = Math.min(...scn.poles.map((p) => dot(sub(sp, p.pos), scn.upwind)));
        assert.ok(lead >= EASY_LEAD.min - 1e-6 && lead <= EASY_LEAD.max + 1e-6, `${layout} seed ${seed}: lead ${lead}`);
        assert.ok(estimatedCrossingTime(scn) > 15);
      }
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
    assert.ok(len(p) > 4 && len(p) < 8, 'beside the pilot, not on top of them');
  }
});

test('ring mode: six streamers evenly round the pilot, upwind and downwind', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const scn = createScenario(seed, { layout: 'ring' });
    assert.equal(scn.poles.length, RING.count);
    for (const p of scn.poles) assert.ok(Math.abs(len(p.pos) - RING.radius) < 1e-9);
    const along = scn.poles.map((p) => dot(p.pos, scn.upwind) / RING.radius);
    assert.equal(along.filter((a) => a > 0.5).length, 2, 'two upwind');
    assert.equal(along.filter((a) => Math.abs(a) < 0.1).length, 2, 'two crosswind');
    assert.equal(along.filter((a) => a < -0.5).length, 2, 'two downwind');
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

// Weak thermals have to pass close to a streamer to be readable (see the
// signal test), but a strong one can be read from well across the field. The
// ring has streamers downwind too, so thermals can also form behind you,
// though only on wider fields: they must form MIN_SPAWN_DIST from the pilot
// and every streamer and still have enough track left.
test('strong thermal tracks spread across the whole field, not just past the pilot', () => {
  let formsBehind = 0;
  for (const field of FIELDS) {
    const offsets = [];
    let formsDownwind = 0;
    let driftsIn = 0;
    const N = 600;
    for (let seed = 1; seed <= N; seed++) {
      const scn = createScenario(seed, { field, thermalClass: 'strong', layout: 'ring' });
      const sp = scn.thermalSpec.spawnPos;
      offsets.push(dot(sp, scn.left)); // closest approach to the pilot (signed)
      if (dot(sp, scn.upwind) < 0) formsDownwind++;
      if (Math.abs(sp.x) > field.halfW || Math.abs(sp.y) > field.halfH) driftsIn++;
    }
    const far = offsets.filter((c) => Math.abs(c) > 40).length / N;
    const short = Math.min(field.halfW, field.halfH);
    assert.ok(far > 0.3, `only ${(far * 100).toFixed(0)}% of tracks pass > 40 m from the pilot`);
    assert.ok(Math.max(...offsets) > short * 0.7 && Math.min(...offsets) < -short * 0.7, 'tracks reach both sides');
    assert.ok(driftsIn / N > 0.03, 'some thermals drift in from beyond the upwind edge');
    formsBehind += formsDownwind / N / FIELDS.length;
  }
  assert.ok(formsBehind > 0.015, 'some thermals form downwind of the pilot');
});

test('thermals never form within MIN_SPAWN_DIST of the pilot or a streamer', () => {
  for (const layout of ['poles', 'ring', 'pilot']) {
    for (const field of FIELDS) {
      for (const easy of [false, true]) {
        for (let seed = 1; seed <= 150; seed++) {
          const scn = createScenario(seed, { field, layout, easy, thermalClass: 'random' });
          const sp = scn.thermalSpec.spawnPos;
          for (const q of [{ x: 0, y: 0 }, ...scn.poles.map((p) => p.pos)]) {
            assert.ok(dist(q, sp) >= MIN_SPAWN_DIST - 1e-6, `${layout} seed ${seed}: forms ${dist(q, sp).toFixed(1)} m away`);
          }
        }
      }
    }
  }
});

test('every thermal visibly shifts a streamer’s angle and speed while it is on the field', () => {
  let rounds = 0;
  let short = 0;
  for (const layout of ['poles', 'ring', 'pilot']) {
    for (const thermalClass of ['weak', 'medium', 'strong']) {
      for (const windClass of ['slow', 'moderate']) {
        for (let seed = 1; seed <= 12; seed++) {
          // Play the round without gusts and watch the raw wind at each streamer.
          const scn = createScenario(seed, { layout, thermalClass, windClass, gustiness: 0 });
          const W = len(scn.wind);
          const round = new Round(scn);
          const peak = scn.poles.map(() => ({ angle: 0, speed: 0 }));
          while (round.phase !== 'over' && round.t < 600) {
            round.step(0.25);
            const th = round.thermal;
            if (!th || offField(th.pos, 0, scn.field)) continue;
            scn.poles.forEach((p, i) => {
              const f = round.wind(p.pos);
              peak[i].speed = Math.max(peak[i].speed, Math.abs(len(f) - W) / W);
              if (len(f) > 0.3) {
                const a = (Math.acos(Math.min(1, dot(f, scn.wind) / (len(f) * W))) * 180) / Math.PI;
                peak[i].angle = Math.max(peak[i].angle, a);
              }
            });
          }
          rounds++;
          // 2% slack: the round steps more coarsely than the generator's check.
          const ok = peak.some((pk) => pk.angle >= MIN_SIGNAL.angle * 0.98 && pk.speed >= MIN_SIGNAL.speed * 0.98);
          if (!ok) short++;
          assert.ok(scn.thermalSpec.signal.score >= 1, `${layout}/${thermalClass}/${windClass} seed ${seed}: generator`);
        }
      }
    }
  }
  assert.equal(short, 0, `${short}/${rounds} rounds never showed a ${MIN_SIGNAL.angle}° and ${MIN_SIGNAL.speed * 100}% shift`);
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

test('partial credit for the right direction, more if you would fly through the lift', () => {
  const th = { x: 0, y: 50 }; // 50 m north of the pilot
  const R = 12;
  const short = assessGuess({ x: 0, y: 20 }, th, R); // right bearing, stops short
  assert.equal(short.points, DIRECTION_POINTS);
  assert.equal(short.flyThrough, false);
  assert.equal(short.rating.tier, 'line');
  const beyond = assessGuess({ x: 3, y: 90 }, th, R); // overshoots, but the line crosses the core
  assert.equal(beyond.flyThrough, true);
  assert.equal(beyond.points, FLY_THROUGH_POINTS);
  assert.equal(beyond.rating.tier, 'through');
  assert.ok(FLY_THROUGH_POINTS > DIRECTION_POINTS);
  const offLine = assessGuess(fromHeading(40, 50), th, R); // 40° off at the right range
  assert.ok(offLine.points < 10 && !offLine.flyThrough);
  assert.equal(assessGuess(th, th, R).points, 100, 'a direct hit is still 100');
  assert.ok(assessGuess({ x: 5, y: 45 }, th, R).points > FLY_THROUGH_POINTS, 'close hits beat the line credit');
  // Bearings mean nothing when the thermal is beside the pilot.
  const nearPilot = assessGuess({ x: 0, y: 60 }, { x: 0, y: 10 }, R);
  assert.equal(nearPilot.bearingError, null);
  assert.equal(nearPilot.points, scoreGuess(50));
});

test('gusts shift both speed and direction, crosswind a bit less than along-wind', () => {
  const scn = createScenario(3, { gustiness: 0.1 });
  let along = 0;
  let cross = 0;
  let n = 0;
  for (let t = 0; t < 400; t += 0.37) {
    const g = scn.gusts.sample({ x: 5, y: 20 }, t, scn.wind);
    along += dot(g, scn.upwind) ** 2;
    cross += dot(g, scn.left) ** 2;
    n++;
  }
  const ratio = Math.sqrt(cross / along);
  assert.ok(ratio > 0.45 && ratio < 1, `crosswind/along-wind RMS ${ratio.toFixed(2)}`);
});

test('at default gustiness the third vector mostly survives the turbulence, even 50–70 m out', () => {
  const near = [];
  const far = [];
  for (let seed = 1; seed <= 50; seed++) {
    const scn = createScenario(seed, { layout: 'poles', field: { halfW: 97, halfH: 70 } });
    assert.equal(scn.gustiness, DEFAULT_GUSTINESS);
    const round = new Round(scn);
    const st = scn.poles.map((p) => new Streamer(p.pos, round.wind(p.pos)));
    const dt = 1 / 20;
    let k = 0;
    while (round.phase !== 'over' && round.t < 300) {
      round.step(dt);
      for (const s of st) s.update(dt, round.wind(s.pole));
      const th = round.thermal;
      if (!th || th.strengthNow < 0.9 * th.strength || k++ % 10) continue;
      for (const s of st) {
        const d = dist(th.pos, s.pole);
        if (d < 1.5 * th.radius || d > 70) continue;
        const third = sub(streamerTipOffset(s.v), streamerTipOffset(scn.wind));
        const ok = dot(norm(third), norm(sub(th.pos, s.pole))) > Math.cos(Math.PI / 6);
        (d < 50 ? near : far).push(ok);
      }
    }
  }
  const share = (a) => a.filter(Boolean).length / a.length;
  assert.ok(share(near) > 0.88, `within 50 m: ${(share(near) * 100).toFixed(0)}% within 30°`);
  assert.ok(share(far) > 0.75, `50–70 m: ${(share(far) * 100).toFixed(0)}% within 30°`);
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
