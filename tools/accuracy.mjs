// Headless check of how readable the third vector is: plays many rounds
// (with gusts) and reports the median angle between each streamer's B→C
// vector and the true bearing to the thermal, bucketed by distance. Also
// reports how limp streamers get with the thermal overhead.
//
// Use it before and after any change to the wind/streamer/gust model, and
// keep the README's accuracy table in step with it.
//
//   node tools/accuracy.mjs [seeds=300] [gustiness=default] [thermalClass=medium]

import { createScenario, Round } from '../js/scenario.js';
import { Streamer, streamerTipOffset } from '../js/physics.js';
import { sub, norm, dot, dist, len } from '../js/vec.js';

const seeds = Number(process.argv[2] ?? 300);
const gustArg = process.argv[3];
const thermalClass = process.argv[4] ?? 'medium';
const field = { halfW: 97, halfH: 70 }; // a typical laptop-landscape field

const median = (a) => {
  if (!a.length) return '-';
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)].toFixed(0);
};

for (const layout of ['poles', 'ring', 'pilot']) {
  const buckets = { '<1.5R': [], '1.5R-35m': [], '35-50m': [], '50m+': [] };
  const overhead = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const opts = { layout, field, thermalClass };
    if (gustArg !== undefined && gustArg !== 'default') opts.gustiness = Number(gustArg);
    const scn = createScenario(seed, opts);
    const round = new Round(scn);
    const streamers = scn.poles.map((p) => new Streamer(p.pos, round.wind(p.pos)));
    const dt = 1 / 30;
    let k = 0;
    while (round.phase !== 'over' && round.t < 400) {
      round.step(dt);
      for (const s of streamers) s.update(dt, round.wind(s.pole));
      const th = round.thermal;
      if (!th || th.strengthNow < 0.9 * th.strength || k++ % 15) continue;
      for (const s of streamers) {
        const d = dist(th.pos, s.pole);
        if (d < 0.3 * th.radius) overhead.push(len(streamerTipOffset(s.v)));
        const third = sub(streamerTipOffset(s.v), streamerTipOffset(scn.wind));
        const cos = Math.max(-1, Math.min(1, dot(norm(third), norm(sub(th.pos, s.pole)))));
        const err = (Math.acos(cos) * 180) / Math.PI;
        const b = d < 1.5 * th.radius ? '<1.5R' : d < 35 ? '1.5R-35m' : d < 50 ? '35-50m' : '50m+';
        buckets[b].push(err);
      }
    }
  }
  const cols = Object.entries(buckets).map(([b, a]) => `${b} ${median(a)}° (n=${a.length})`);
  console.log(`${layout.padEnd(6)} median error: ${cols.join(' | ')} | overhead streamer ${median(overhead.map((x) => x * 10)) / 10 || '-'} m`);
}
