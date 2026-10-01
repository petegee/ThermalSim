# Third Vector Trainer

A browser-based simulator for practising Joe Wurts' **third vector** method of finding thermals from ground wind signs.

You stand in the middle of a flat field. The shorter side of the screen shows 70 m each way, and a wider screen shows more ground along the longer side. Each scenario sets an average wind that's either slow or moderate, never calm. After a quiet spell an invisible thermal forms somewhere on or just upwind of the field and drifts downwind. Its inflow pulls on the air, and the streamers show it. Click where you think the thermal is. You're scored on how close you were, and then the thermal is revealed with the full set of vectors around it while it drifts off the field.

There are three modes:

- **Two poles**: a streamer on each of two poles upwind of you. Their two third vectors cross near the thermal.
- **Ring of six**: six streamers 30 m out, evenly round you: a pair upwind, a pair crosswind and a pair downwind. The upwind ones lull as a thermal approaches, and the downwind ones surge after it has passed. All six third vectors converge on it.
- **Pilot streamer**: a single streamer just beside you (a little upwind and to your right, so it doesn't draw over the pilot). It gives you a direction only, so you judge distance from the size of the shift and how fast it changes.

## Running it

It's a static site with no build step. ES modules need to be served over HTTP, not opened as `file://`:

```bash
python3 serve.py 8000      # then open http://localhost:8000
```

Any static file server works. `serve.py` just turns off caching so edits show up on reload.

Add `?seed=<hex>` to the URL to replay a specific scenario. The current seed is shown in the Round card. The field size comes from the screen's shape, so a seed replays exactly only on a screen with the same aspect ratio.

## How to play

1. Watch the streamers settle in the average wind. With **Baseline streamer (B)** turned on, a dashed line shows where each streamer would lie in the average wind.
2. When a thermal forms, its inflow moves each streamer tip from **B** to **C**. The vector **B→C** is the third vector, and it points at the thermal.
   - Wind **drops**: the lift is upwind of the pole, coming toward you.
   - Wind **picks up**: the lift has passed and is now downwind.
   - A **big or fast** change means the thermal is close. A **small or slow** one means it's weak or far away.
3. Click the field where you think the thermal is. Getting the direction right earns partial credit even if the distance is off, and more if you'd fly through it on the way. Clicking before it has formed scores zero, because you were reading a gust.
4. The reveal shows the thermal, its track, the average wind, and Joe's vector triangle at points all the way round it: blue average wind + yellow inflow = white felt wind.

Keys: **Space** pauses, **N** starts a new scenario, **R** reveals.

Training aids (all toggleable):

- Baseline streamer (B)
- Third-vector arrows (B→C)
- Projected third vectors (with two poles, where the two lines cross is the thermal)
- Range rings

Conditions for the next scenario:

- **Wind**: random / slow / moderate.
- **Thermal strength**: random / weak / medium / strong.
- **Gustiness**: 0–30 % (default 6 %).
- **Easy mode**: the thermal forms 50–70 m upwind of the streamers and its track passes within 12 m of one (or between the two poles), so you see the whole sequence as it goes by.

Switching mode starts a new scenario straight away.

## The model

Everything is plain vector addition (`js/physics.js`):

```
felt wind = (ambient wind + gusts) × (1 − calm) + thermal inflow
```

- **Ambient wind**: slow is 1.5–3 m/s, moderate is 3–5 m/s, from any direction. The thermal drifts at the ambient wind velocity.
- **Thermal track**: any line across the field parallel to the wind (in easy mode, one that passes close to the streamers). The crosswind offset is spread evenly over the whole field, so it can pass far to one side of you. The thermal forms anywhere along that line, from up to 15 m beyond the upwind edge (it then drifts in) to far enough up the field that at least `max(35 m, 15 s × wind speed)` of track is left. It never forms within 50 m of you or any streamer, so it doesn't pop up right beside one: its inflow builds as it drifts in. On a wide screen it can occasionally form downwind of you too.
- **Readable signal**: a track is only accepted if, at some point while the thermal is on the field, at least one streamer turns at least 15° from the ambient wind direction and changes speed by at least 20 %. The two don't have to happen at the same moment. That's checked without gusts and with a 10 % margin, so every thermal makes itself felt above the default turbulence. In practice weak thermals have to pass close to a streamer, while strong ones can still cross far out. To spread passes out, the generator draws one to three readable tracks and keeps the one with the weakest signal, so some rounds pass close by and others near the limit of what can be read. With only upwind streamers (two poles, or the pilot streamer), thermals that form behind you and drift away rarely qualify; the ring's downwind streamers can see those. The round summary shows the biggest shift the thermal caused.
- **Thermal inflow**: horizontal flow toward the thermal centre. It rises linearly inside the core radius R to a peak S at the core edge, then decays as `(R/r)^1.1` outside, a little faster than the 1/r that continuity gives. Strength ramps up over 5–9 s as the thermal forms. Stronger thermals are both faster and wider, so they pull air in from much further out:

  | Class | Peak inflow S | Core radius R | Inflow 50 m out (typical) |
  | --- | --- | --- | --- |
  | Weak | 1.2–2.0 m/s | 8–12 m | ~0.3 m/s |
  | Medium | 1.6–3.0 m/s | 9–16 m | ~0.5 m/s |
  | Strong | 3.0–4.5 m/s | 12–18 m | ~1 m/s |

  When the thermal is upwind of a streamer and its inflow beats the ambient wind (in practice, strong thermals in a light wind), the felt wind reverses and the streamer turns round to point upwind at it.
- **Calm under the core**: right under a thermal the air is going up, not sideways, so the ambient wind fades out in a Gaussian patch of width 0.8 R around the centre. It's about 20 % at the core edge and under 3 % beyond 1.5 R, so further out the plain vector sum holds. A thermal drifting over a streamer therefore gives the sequence pilots describe: a lull or reversal as it approaches, the streamer going limp overhead, then a surge once it has passed.
- **Gusts**: a few travelling sine waves frozen into the air mass and carried downwind. They change both speed and direction. The along-wind RMS is 6 % of wind speed by default, and crosswind gusts are 70 % of that, as is typical near the ground. The swirls are small (4–30 m), so they pass a streamer in a second or few and read as flutter. Slower, larger-scale wander would look just like a passing thermal: an earlier version with 10–70 m swirls at 10 % often swamped the thermal signal. So a sustained shift stands out from turbulence, as the training notes describe.
- **Streamers**: a real streamer hangs limp in still air and lifts as the wind picks up. Drag goes with speed squared, so below 1.5 m/s the visible length falls off as v² and the streamer droops. From 1.5 m/s up, which covers every ambient wind in the scenarios, length is linear in speed. The tip is then literally the wind vector drawn from the pole, so C − B equals the inflow plus gusts. The streamer response is slightly smoothed, with a 0.35 s time constant.

At the default gustiness, a headless check across 300 medium-thermal scenarios per mode (on a 194 × 140 m field) gives these median errors between the third vector and the true bearing to the thermal:

| Distance from the streamer | Error |
| --- | --- |
| Inside 1.5 core radii | 13–14° |
| 1.5 R to 35 m | 5–6° |
| 35–50 m | 8–9° |
| Beyond 50 m | 12–15° |

Inside the core the streamer is mostly limp, and far away the signal starts to get lost in the gusts. A test keeps this honest: at default settings, at least 75 % of readings 50–70 m from a streamer must point within 30° of the thermal. With the thermal directly overhead, the median streamer length is under 1 m, against about 7 m in a 3 m/s breeze.

Scoring: `100 · exp(−d² / 2·12²)` for miss distance d in metres. If you read the direction right but misjudged the range, you get partial credit instead, whichever is higher. Picture launching from where you stand and flying straight at your mark. A bearing within a few degrees of the thermal's earns up to 35 points (falling off with a 10° spread), and if that line passes through the core on the way to your mark you'd have found it anyway, which earns 50. Bearings mean nothing when the thermal is right beside you, so this only applies when it's at least two core radii away and your mark at least 10 m out. Ratings are based on whether you'd have been in the core, in the lift or on its edge, on the right line, or in the right direction.

## Files

| Path | What it does |
| --- | --- |
| `index.html`, `css/style.css` | Page and UI |
| `js/main.js` | Game loop, input, HUD, settings/stats (localStorage) |
| `js/scenario.js` | Scenario generation, round state machine, scoring |
| `js/physics.js` | Wind field, thermal inflow, gusts, streamer model, seeded RNG |
| `js/render.js` | Canvas rendering of the field, streamers, pilot, vectors |
| `js/flow.js` | Tracer particles shown after the reveal |
| `js/vec.js` | 2D vector helpers |
| `tests/physics.test.mjs` | Node tests for the vector maths and scenario rules |

```bash
npm test     # node --test, no dependencies
```

## Deploy

It's hosted on Fly.io as a tiny nginx container (`Dockerfile`, `nginx.conf`, `fly.toml`). GitHub Actions (`.github/workflows/build-and-test.yml`) runs the tests on every push and pull request, and pushes to `main` also deploy. One-time setup:

1. `fly apps create thermalsim` (if the name is taken, pick another and update `app` in `fly.toml`).
2. Add a `FLY_IO_DEPLOY_TOKEN` secret to the GitHub repo. Get one from `fly tokens create deploy -a thermalsim`.

To deploy by hand instead: `fly deploy`.

## Sources

The source documents aren't included in this repository.

- Joe Wurts, *Soaring Training Program* (slides: "Clues to Finding Thermals", "The Third Vector")
- Marcus Stent, *Thermal Training Notes* (April 2016)
- Model Aviation, [Making a thermal plan](https://www.modelaviation.com/making-thermal-plan)
