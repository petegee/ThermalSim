# Third Vector Trainer

A browser-based simulator for practising Joe Wurts' **third vector** method of finding thermals from ground wind signs.

You stand in the middle of a flat field. The shorter side of the screen shows 70 m each way, and a wider screen shows more ground along the longer side. Each scenario sets an average wind that's either slow or moderate, never calm. After a quiet spell an invisible thermal forms somewhere on or just upwind of the field and drifts downwind. Its inflow pulls on the air, and the streamers show it. Click where you think the thermal is. You're scored on how close you were, and then the thermal is revealed with the full set of vectors around it while it drifts off the field.

There are two modes:

- **Two upwind poles**: a streamer on each of two poles upwind of you. Their two third vectors cross near the thermal.
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
3. Click the field where you think the thermal is. Clicking before it has formed scores zero, because you were reading a gust.
4. The reveal shows the thermal, its track, the average wind, and Joe's vector triangle at points all the way round it: blue average wind + yellow inflow = white felt wind.

Keys: **Space** pauses, **N** starts a new scenario, **R** reveals.

Training aids (all toggleable):

- Baseline streamer (B)
- Third-vector arrows (B→C)
- Projected third vectors (with two poles, where the two lines cross is the thermal)
- Range rings

Conditions for the next scenario: wind class (random / slow / moderate) and gustiness (0–30 %). Switching mode starts a new scenario straight away.

## The model

Everything is plain vector addition (`js/physics.js`):

```
felt wind = ambient wind + gusts + thermal inflow
```

- **Ambient wind**: slow is 1.5–3 m/s, moderate is 3–5 m/s, from any direction. The thermal drifts at the ambient wind velocity.
- **Thermal track**: any line across the field parallel to the wind. The crosswind offset is spread evenly over the whole field, so it can pass far to one side of you. The thermal forms anywhere along that line, from up to 15 m beyond the upwind edge (it then drifts in) to far enough up the field that at least `max(35 m, 15 s × wind speed)` of track is left. So it can form downwind of you too.
- **Thermal inflow**: horizontal flow toward the thermal centre. It rises linearly inside the core radius R (9–16 m) to a peak of 1.6–3 m/s at the core edge, then decays as `(R/r)^1.1` outside, a little faster than the 1/r that continuity gives. Strength ramps up over 5–9 s as the thermal forms.
- **Gusts**: a few travelling sine waves frozen into the air mass and carried downwind, with an RMS of about 10 % of wind speed by default. Their periods are short compared with a passing thermal, so a sustained shift stands out from turbulence, as the training notes describe.
- **Streamers**: the visible length grows linearly with wind speed, the way a real streamer lifts from hanging to flying. The tip is therefore literally the wind vector drawn from the pole, so C − B equals the inflow plus gusts. The streamer response is slightly smoothed, with a 0.35 s time constant.

At the default gustiness, a headless check across 300 scenarios gives a median error of ~7–10° between the third vector and the true bearing when the thermal is within 35 m of a pole. It rises to ~30° beyond 50 m, where the signal gets lost in the gusts.

Scoring: `100 · exp(−d² / 2·12²)` for miss distance d in metres. Ratings are based on whether you'd have been in the core, in the lift, or on its edge.

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
