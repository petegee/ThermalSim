# CLAUDE.md: Third Vector Trainer (ThermalSim)

Browser trainer for RC sailplane pilots learning **Joe Wurts' "third vector" method** of finding thermals from ground wind signs. It's a top-down field with the pilot at the centre and streamers on poles. An invisible thermal forms and drifts downwind, its inflow shifts the streamers, and the player clicks where they think it is. They're scored on distance, then the thermal is revealed with its vectors while it drifts off the field.

- Live: https://thermalsim.fly.dev. Repo: https://github.com/petegee/ThermalSim (public). **Every push to `main` deploys to production.**
- Plain ES modules, Canvas 2D, no build step, no runtime or dev dependencies. Node ≥ 22 for tests.
- `README.md` is the user-facing description, including model numbers. Keep it in step with any behaviour change.

## Domain in one minute

- **B**: where a streamer's tip would sit in the *ambient* (average) wind. **C**: where it actually is. **B→C is the third vector**: felt wind − ambient wind = thermal inflow, which points at the thermal.
- Thermal **upwind** of a streamer: inflow opposes the wind, giving a **lull**, or a **reversal** if the inflow beats the wind (strong thermal, light wind). **Overhead**: the streamer goes **limp**. **Downwind** (already passed): a **surge**.
- A big or fast-changing shift means close. A small, slow one means weak or far. Two or more streamers' third vectors cross at the thermal.
- Sources (PDFs live in `docs/`, which is **gitignored**; they're third-party, so never commit them): Joe Wurts' *Soaring Training Program* slides 25–27 (Joe's diagram: blue average wind + yellow inflow = green "what you feel"), and Marcus Stent's *Thermal Training Notes* (2016), which covers the B/C/A streamer diagrams, lull vs surge, and rapid change = close.
- **Joe Wurts has reviewed the app.** His feedback drove: smaller turbulence (it used to swamp the signal), streamers upwind *and* downwind (ring mode), and a guaranteed minimum signal per thermal. Treat that feedback as requirements.

## Commands

```bash
npm test                    # node --test tests/*.test.mjs, 27 tests, ~1 s
python3 serve.py 8000       # dev server with Cache-Control: no-store (plain http.server caches ES modules → stale code)
node tools/accuracy.mjs 300 # third-vector accuracy by distance, per layout; rerun after any model change
```

Browser preview: `.claude/launch.json` defines `thermal-sim` (serve.py on port 8765). Add `?seed=<hex>` to replay a scenario.

## Files and layering

`vec.js` ← `physics.js` ← `scenario.js` ← `render.js` / `flow.js` ← `main.js`. **`physics.js`, `scenario.js` and `vec.js` must stay DOM-free**, because the Node tests import them.

| File | Responsibility |
| --- | --- |
| `js/vec.js` | 2D vector helpers, compass headings (`fromHeading`, `headingOf`, `compassPoint`) |
| `js/physics.js` | Seeded RNG (`mulberry32`), thermal inflow, calm-under-core, `GustField`, `localWind`, streamer length model, `Streamer` (smoothed display state) |
| `js/scenario.js` | All tunable constants, layouts, `createScenario`, `thermalSignal` (readability check), `Round` state machine, scoring |
| `js/render.js` | `Renderer`: grass (pre-rendered offscreen), streamers, pilot, thermal, vector triangles, HUD-on-canvas (compass, scale bar, wind key) |
| `js/flow.js` | Tracer particles riding the local wind, shown only after the reveal |
| `js/main.js` | Game loop, input, DOM HUD/panel wiring, settings and stats in localStorage, canvas layout |
| `index.html`, `css/style.css` | UI. Dark panel, green field. Desktop: field fills the left, panel (with title and score) scrolls on the right. ≤ 900 px: stacked. |
| `tests/physics.test.mjs` | Physics invariants, scenario rules, round lifecycle, and the gameplay-quality guarantees below |
| `tools/accuracy.mjs` | Headless accuracy measurement (not part of the test suite) |
| `Dockerfile`, `nginx.conf`, `fly.toml`, `.github/workflows/build-and-test.yml` | Deploy (see below) |

## Conventions

- **World frame**: metres, `x` = east, `y` = north, origin = pilot. Screen y is flipped in `Renderer.toScreen`.
- **Headings** are compass degrees (0 = N, clockwise). `scn.windFrom` is meteorological (where the wind comes *from*); `scn.wind` is the velocity vector (where the air goes).
- `scn.upwind` is a unit vector into the wind (the way the pilot faces). `scn.left` = `perpLeft(upwind)` is the pilot's left. Layouts and spawn logic use these wind-aligned axes.
- **Field** `{ halfW, halfH }`: the short screen side always shows `FIELD_SHORT_HALF` = 70 m each way, and the long side more (aspect clamped to 1.8). It's computed from the canvas when a round starts (`currentField()` in main.js) and stored in the scenario. So **a seed reproduces exactly only on a screen with the same aspect**.
- Comments explain *why*. Match the existing density and voice. Constants live at the top of the module that owns them, with a comment giving their physical meaning.

## The model (all vector addition)

```
felt = (ambient + gusts) × (1 − calm) + inflow          // physics.localWind(scn, p, t, thermal)
```

`localWind(scn, p, null, th)` leaves out gusts. The signal check and the reveal's triangles use that.

| Piece | Where | Behaviour | Why |
| --- | --- | --- | --- |
| Inflow | `thermalInflow`, `inflowProfile` | Toward the centre. Rises linearly to peak S at core radius R, then `(R/r)^1.1` (`INFLOW_DECAY`) | Roughly mass continuity (1/r), slightly more local |
| Calm patch | `thermalCalm`, `CALM_RADIUS` = 0.8 | Gaussian, width 0.8R. Cancels ambient + gusts: ~20 % at R, < 3 % beyond 1.5R | User asked for the streamer to go **limp overhead**. Without it the ambient wind showed at full strength under the core. |
| Gusts | `GustField` | 7 travelling sine modes frozen in the air and advected with the wind. Wavelengths `GUST_WAVELENGTH` 4–30 m, ω ±0.8. Along-wind RMS = gustiness × wind speed, crosswind × `GUST_CROSS` 0.7 | Joe: turbulence swamped the signal. Slow 10–70 m swirls looked like thermals. Small quick ones read as flutter. **Don't add slow, large-scale wander back.** |
| Streamer length | `streamerLength`, `STREAMER_*` | Linear (2.4 m per m/s, exaggerated for visibility) from `STREAMER_LIFT_MS` 1.5 m/s up. Below that ∝ v² (droops), limp near 0 | Linear in the operating range means the tip *is* the wind vector, so **B→C points exactly at the thermal**. 1.5 m/s is the slowest ambient wind, so ambient is always linear. |
| Streamer display | `Streamer.update` | Low-pass, τ = 0.35 s. Flutter phase speeds up with wind | Visual only. Tip math uses the smoothed `v`. |
| Thermal drift | `Round.step` | `pos = spawnPos + wind × age`, strength ramps (smoothstep) over `rampTime` 5–9 s | Position from age, so it sits exactly at `spawnPos` when it forms. (An off-by-one-step bug once made rounds disagree with the generator.) |

Classes, in `scenario.js`:
- `WIND_CLASSES`: slow 1.5–3, moderate 3–5 m/s. Never calm, never so strong it crosses too fast.
- `THERMAL_CLASSES`: weak S 1.2–2.0 / R 8–12; medium 1.6–3.0 / 9–16 (default); strong 3.0–4.5 / 12–18. Stronger thermals reach further: about 0.27, 0.5 and 1 m/s of inflow at 50 m.
- `DEFAULT_GUSTINESS` 0.06, with a UI slider from 0 to 30 %.

## Scenario generation: `createScenario(seed, opts)`

`opts`: `windClass`, `thermalClass` (each may be `'random'`), `gustiness` (fraction), `layout` (`'poles' | 'ring' | 'pilot'`), `easy`, `field`.

Layouts (`makePoles`) each give `{ id, label, pos }`. `label` is lower-case and used in the summary sentence "… on the {label}".
- `poles`: two poles 28 m upwind, ±18 m, ids `L`/`R`, the only layout with on-canvas id labels.
- `ring`: `RING` = 6 poles at 30 m, starting 30° off upwind, so there's a pair upwind, a pair crosswind and a pair downwind. Labelled by position, e.g. "upwind-left streamer".
- `pilot`: one streamer 3 m upwind and 4 m to the pilot's **right**, so it blows past rather than over the pilot figure. Physics is evaluated where it's drawn.

Spawn pipeline. **RNG call order defines every seed**: reordering, or adding draws before the end, changes all scenarios. That's acceptable, but deliberate.
1. Wind class (if random) → speed → `windFrom`.
2. Thermal class (if random) → `spawnTime` (5–14 s quiet spell first) → radius → strength → `rampTime`.
3. `pick` (normal mode only): how many readable tracks to collect, 1..`PICK_MAX` 3.
4. Candidate loop (≤ 400 tries). Pick a crosswind offset: uniform over the whole field normally; in **easy** mode, within `EASY_PASS` 12 m of a streamer, or between the poles. `fieldChord` finds where that wind-parallel line crosses the field. Reject corner clips shorter than `minTrackOnField` = max(35 m, 15 s × wind). Pick the start along the line: normally from up to `ENTRY_MARGIN` 15 m beyond the upwind edge (it drifts in) to where enough track remains, so it **can form downwind of the pilot**; in easy mode 50–70 m (`EASY_LEAD`) upwind of the most-upwind streamer. Reject anything within `MIN_SPAWN_DIST` 50 m of the pilot or any streamer (user: thermals mustn't pop up right beside a streamer).
5. **Readability check** (Joe's requirement): `thermalSignal` drifts the candidate without gusts while it's on the field. It needs some streamer to reach both ≥ `MIN_SIGNAL.angle` 15° from the ambient direction *and* ≥ `MIN_SIGNAL.speed` 20 % speed change (not necessarily at the same moment; angle is ignored while the streamer is limp, < 0.3 m/s). Collect `pick` candidates with score ≥ `SIGNAL_MARGIN` 1.1 and keep the **weakest** of them (readable tracks cluster near streamers; this spreads passes toward the readable limit, user asked for more variation). If none qualify, the best one is kept. The result is stored in `thermalSpec.signal` and shown in the round summary.
6. `GustField` (draws last).

Trade-off to keep in mind: the readability rule means **weak thermals pass close to streamers** (medium: median ~13 m), while strong ones still roam (~70 % pass > 40 m from the pilot). With upwind-only layouts, thermals forming behind the pilot rarely qualify; the ring catches them, but the 50 m spawn clearance limits that to wide fields (~3–5 %). The user originally asked for "thermals crossing any part of the field", and Joe's rule overrides that where they conflict.

## Round lifecycle (`Round` in scenario.js)

- Phases: `watching` → (`mark(pos)` or `reveal()`) → `revealed` → `over`. Also `watching` → `over` if the thermal leaves unmarked.
- It's `over` once the thermal has **entered** the field and then left by more than 0.6R (`th.entered` handles thermals that form beyond the edge). `endT` freezes the HUD timer, but time keeps running so streamers stay alive.
- `mark` before the thermal forms gives an `early` guess with 0 points. Guess fields: `pos, t, early, thermalPos, distance, points, rating, bearingError, flyThrough, readTime`, or `gaveUp`.
- Score (`assessGuess`): the max of `100·exp(−d²/2·12²)` (`SCORE_SIGMA`) and direction credit (user request: reward the right vector with the wrong range). Direction is judged from the pilot: bearing error gives up to `DIRECTION_POINTS` 35 (σ 10°), and if the pilot→mark segment passes within R of the thermal ("fly through it on the way") `FLY_THROUGH_POINTS` 50. Only when the thermal is ≥ 2R from the pilot and the mark ≥ 10 m out. Judged against the thermal's position at mark time (no drift during the flight). `rateGuess` tiers: core / lift / edge (relative to R), then through / line, then near / miss.

## UI and main.js

- Loop: real dt (capped at 50 ms) × speed (½/1/2/4×), split into fixed 1/60 s substeps. `syncPhase()` turns phase changes into DOM updates: `onRevealed` (particles, wind chip, toast, stats), `onOver` (summary card). `hadThermal` refreshes status and toast when the thermal forms after an early mark.
- Renderer: `resize(w, h)` in CSS px; `fit(field)` sets pixels-per-metre and repaints the grass when size or field changes (called each `draw`). Draw order: grass → range rings → (if revealed: trail, particles, thermal, vector triangles) → pole shadows → per streamer: projection ray (aid, pre-reveal only), ribbon, B baseline, B→C arrow, pole → pilot → guess (after the reveal: flight line from the pilot, line to the thermal) → hover → compass, scale bar, ambient key.
- Colours (`COLORS`): ambient = blue, felt = white, third vector = yellow (Joe's convention, but felt is white not green, because green is invisible on grass), streamer = orange, guess = pink.
- Training aids (`settings.assists`): `baseline` (B, default on), `third` (B→C), `project` (rays to the field edge), `rings` (every 25 m). After the reveal, B and B→C are always shown.
- Settings (localStorage `tvt.settings`): `mode, windClass, thermalClass, easy, gustiness` (integer %), `speed, assists, v`. **Bump `SETTINGS_VERSION`** and drop the affected keys when changing a default that saved values would otherwise override (v2 reset gustiness 10 → 6). Stats: `tvt.stats`. All storage access goes through try/catch (`store`).
- Changing the mode starts a new round immediately. The other conditions apply to the next scenario. Keys: Space pause, N new, R reveal.
- CSS gotchas: `[hidden] { display: none !important }` is required because overlay classes set `display`. The desktop grid needs `min-height: 0` on the stage and panel for the panel to scroll, but the stacked (≤ 900 px) layout must *not* constrain heights, or the canvas overlaps the panel.

## Guarantees the tests enforce (don't silently weaken them)

- Inflow points at the thermal. Outside 1.5R, with the felt wind ≥ lift speed, B→C points at it (cos > 0.995).
- Limp overhead. Lull → limp → surge on a pass. Reversal when inflow beats the wind, and strong thermals in slow wind reverse the streamer in > 50 % of easy-mode runs.
- Streamer droops below 1.5 m/s and is continuous and linear above.
- Default gusts: ≥ 88 % of readings within 50 m and ≥ 75 % at 50–70 m are within 30° of the thermal.
- Every generated thermal (all layouts × classes × winds) shows ≥ 15° and ≥ 20 % in real round playback.
- Spawn ≥ 50 m from the pilot and every streamer. Layout geometry, easy-mode lead and pass distance, strength ordering, track rules (on field, enough track left, drifts in), seed determinism, round lifecycle and scoring (including direction and fly-through credit).

If a model change legitimately moves a threshold, update the test, `README.md` and this file together, and say why in the commit.

## Verifying changes

1. `npm test`.
2. For model changes, run `node tools/accuracy.mjs 300` (compare before and after) and update the README accuracy table.
3. Visual check: start the `thermal-sim` preview. To force a situation, find a seed with a Node one-liner that loops `createScenario(seed, opts)` and `new Round(scn)`, steps it, and records what you need (e.g. the time the thermal passes over a pole). Use the canvas's actual field (`halfW = 70·w/min(w,h)` …). Then set `localStorage['tvt.settings']` (include `v: 2`) and load `/?seed=<8-hex>`. **Remove `tvt.settings` and `tvt.stats` afterwards** so you don't leave test settings in the user's browser.
4. Check the console for errors, and check both desktop and 375 px mobile widths.

## Deploy and accounts

- Fly.io app `thermalsim` (org `personal`, region `syd`, nginx static, scales to zero) under peteg@hotmail.co.nz. `flyctl` and `fly` are installed at `~/.fly/bin`.
- The GitHub Actions workflow runs `npm test` on pushes and PRs to `main`. Pushes also run `flyctl deploy --remote-only` using the repo secret `FLY_IO_DEPLOY_TOKEN` (a deploy token scoped to `thermalsim`).
- The `gh` CLI has several accounts. This repo needs **`petegee`** (`gh auth switch -h github.com -u petegee`); the user's work account is `peterglassey-mwnz`. Git credentials go through `gh auth git-credential`, so the active account is the one that pushes.
- nginx serves `Cache-Control: no-cache` (ETag revalidation) because asset names aren't hashed.
- **Only commit or push when the user asks.** They review locally first. Pushing to `main` = deploying to production. Commit messages: a summary line plus bullets of the behaviour changes, with the Co-Authored-By trailer.

## Extension recipes

- **New streamer layout**: add it to `LAYOUTS` and `makePoles` (wind-aligned positions; lower-case positional `label`), a `modeSeg` button in `index.html`, an `INSTRUCTIONS` entry in `main.js`, a geometry test, and include it in the layout loops in tests and `tools/accuracy.mjs`. Spawning, easy mode, the readability check and rendering all work from `scn.poles` generically.
- **New scenario condition**: an `opts` field in `createScenario` (append RNG draws carefully, see above), a default in `settings`, a control in the Conditions card (`bindSegmented` or a toggle), pass it through in `newRound`, and show it in the summary if the player should see it.
- **New training aid**: a key in `settings.assists`, a toggle in the Training aids card (the `[id, key]` list in main.js), and a draw call gated on it in `Renderer.draw` (decide whether it's shown before the reveal).
- **Physics tuning**: change constants in `physics.js` or `scenario.js`, run the tests and the accuracy tool, then update the README tables (model, strength classes, accuracy).
- **Ideas raised but not built**: a sandbox mode (drag a visible thermal around); sink on the thermal's upwind side (Stent's notes); a felt-wind indicator at the pilot.
