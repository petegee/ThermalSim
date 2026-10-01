// Canvas renderer: stylised top-down flying field.

import { add, sub, scale, len, norm, lerp } from './vec.js';
import { localWind, streamerTipOffset, mulberry32 } from './physics.js';

export const COLORS = {
  ambient: '#5cc8ff', // average wind (blue, as in Joe's diagram)
  felt: '#ffffff', // what you feel
  third: '#ffd23f', // third vector / thermal inflow (yellow)
  streamer: '#ff5a1f',
  streamerEdge: '#a8320a',
  guess: '#ff4fa3',
  thermal: '255, 150, 50',
};

const SHADOW = { x: 3, y: 3.5 }; // sun from the north-west
const VECTOR_M_PER_MS = 2.6; // reveal-mode arrow scale, metres per m/s

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.grass = document.createElement('canvas');
    this.w = 0;
    this.h = 0;
    this.ppm = 1;
    this.fitKey = '';
  }

  // Canvas size in CSS pixels.
  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.fitKey = '';
  }

  // Scale so the scenario's field fills the canvas (pilot at the centre).
  fit(field) {
    const key = `${this.w}x${this.h}:${field.halfW}x${field.halfH}`;
    if (key === this.fitKey) return;
    this.fitKey = key;
    this.field = field;
    this.ppm = Math.min(this.w / (2 * field.halfW), this.h / (2 * field.halfH));
    this.paintGrass();
  }

  toScreen(p) {
    return { x: this.w / 2 + p.x * this.ppm, y: this.h / 2 - p.y * this.ppm };
  }

  toWorld(sx, sy) {
    return { x: (sx - this.w / 2) / this.ppm, y: -(sy - this.h / 2) / this.ppm };
  }

  // World-space vector → screen-space vector (no translation).
  vToScreen(v) {
    return { x: v.x * this.ppm, y: -v.y * this.ppm };
  }

  // ---- Background ------------------------------------------------------------

  paintGrass() {
    const g = this.grass;
    g.width = this.canvas.width;
    g.height = this.canvas.height;
    const c = g.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const W = this.w;
    const H = this.h;
    const ppm = this.ppm;

    c.fillStyle = '#5c9e45';
    c.fillRect(0, 0, W, H);

    // Mowing stripes, 8 m wide, running north–south.
    const stripe = 8 * ppm;
    for (let i = 0, x = (W / 2) % stripe - stripe; x < W; i++, x += stripe) {
      c.fillStyle = i % 2 ? '#64a84c' : '#5a9b43';
      c.fillRect(x, 0, stripe, H);
    }

    // Grass texture: thousands of tiny blades, seeded so it never shimmers.
    const rng = mulberry32(42);
    const blades = Math.round((W * H) / 90);
    for (let i = 0; i < blades; i++) {
      const x = rng() * W;
      const y = rng() * H;
      const shade = rng();
      c.strokeStyle =
        shade < 0.5 ? 'rgba(40, 90, 30, 0.22)' : shade < 0.85 ? 'rgba(140, 200, 100, 0.16)' : 'rgba(30, 70, 25, 0.3)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + (rng() - 0.5) * 2.5, y - 1.5 - rng() * 2.5);
      c.stroke();
    }

    // A few clumps of clover/daisies for character.
    const clumps = Math.round((W * H) / 24000);
    for (let i = 0; i < clumps; i++) {
      const x = rng() * W;
      const y = rng() * H;
      const n = 3 + Math.floor(rng() * 6);
      for (let j = 0; j < n; j++) {
        c.fillStyle = rng() < 0.7 ? 'rgba(255, 255, 240, 0.55)' : 'rgba(255, 220, 90, 0.55)';
        c.beginPath();
        c.arc(x + (rng() - 0.5) * 14, y + (rng() - 0.5) * 14, 0.9 + rng() * 0.8, 0, Math.PI * 2);
        c.fill();
      }
    }

    // Worn patch where the pilots stand.
    const wear = c.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 7 * ppm);
    wear.addColorStop(0, 'rgba(170, 160, 90, 0.35)');
    wear.addColorStop(1, 'rgba(170, 160, 90, 0)');
    c.fillStyle = wear;
    c.fillRect(0, 0, W, H);

    // Soft vignette.
    const R = Math.hypot(W, H) / 2;
    const vig = c.createRadialGradient(W / 2, H / 2, R * 0.5, W / 2, H / 2, R * 1.05);
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(0, 20, 0, 0.32)');
    c.fillStyle = vig;
    c.fillRect(0, 0, W, H);
  }

  // ---- Frame -----------------------------------------------------------------

  draw(state) {
    const { ctx } = this;
    const { round, streamers, assists, particles, hover } = state;
    const scn = round.scn;
    const revealed = round.phase !== 'watching';
    const th = scn.thermal;

    this.fit(scn.field);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.grass, 0, 0, this.w, this.h);

    if (assists.rings) this.drawRangeRings();

    if (revealed) {
      this.drawTrail(round.trail, th);
      if (particles) this.drawParticles(particles);
      if (th) this.drawThermal(th);
      if (th && th.strengthNow > 0.05) this.drawVectorField(scn, th);
    }

    const showB = assists.baseline || revealed;
    const showThird = assists.third || revealed;
    for (const s of streamers) {
      this.drawPoleShadow(s);
    }
    for (const s of streamers) {
      if (assists.project && !revealed) this.drawProjection(s, scn);
      this.drawStreamer(s);
      if (showB) this.drawBaseline(s, scn);
      if (showThird) this.drawThirdVector(s, scn, revealed);
      this.drawPole(s, streamers.length > 1);
    }

    this.drawPilot(scn.upwind);

    if (round.guess && round.guess.pos) this.drawGuess(round.guess, revealed);
    if (hover && round.phase === 'watching') this.drawHover(hover);

    this.drawCompass();
    this.drawScaleBar();
    if (revealed) this.drawAmbientKey(scn);
  }

  // ---- Elements --------------------------------------------------------------

  drawRangeRings() {
    const { ctx } = this;
    const c = this.toScreen({ x: 0, y: 0 });
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    const reach = Math.max(this.field.halfW, this.field.halfH) - 8;
    for (const r of [25, 50, 75, 100].filter((r) => r <= reach)) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * this.ppm, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${r} m`, c.x + r * this.ppm * 0.71 + 3, c.y - r * this.ppm * 0.71 - 3);
    }
    ctx.restore();
  }

  drawPoleShadow(s) {
    const { ctx } = this;
    const p = this.toScreen(s.pole);
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 30, 0, 0.28)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + SHADOW.x * 7, p.y + SHADOW.y * 7);
    ctx.stroke();
    ctx.restore();
  }

  streamerPath(s) {
    const p = this.toScreen(s.pole);
    const off = this.vToScreen(streamerTipOffset(s.v));
    const L = Math.max(len(off), 0.001);
    const d = { x: off.x / L, y: off.y / L };
    const n = { x: -d.y, y: d.x };
    const speed = len(s.v);
    const N = 16;
    const pts = [];
    // Light air: the streamer droops and wanders lazily; stronger air: tighter,
    // faster flutter. The sideways wiggle never exceeds a fraction of the
    // length, so a drooping streamer stays visibly short.
    const lazy = Math.max(0, 1.4 - speed);
    const maxAmp = 0.35 * L;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const amp = Math.pow(t, 1.3) * Math.min(1.2 + 0.07 * L + lazy * 3, maxAmp);
      const drift = Math.min(lazy * 2.5, maxAmp) * t;
      const wave = Math.sin(s.phase - t * 7.5) * amp + Math.sin(s.wander * 1.7 + t * 2.5) * drift;
      pts.push({ x: p.x + d.x * L * t + n.x * wave, y: p.y + d.y * L * t + n.y * wave });
    }
    return { pts, L };
  }

  drawStreamer(s) {
    const { ctx } = this;
    const { pts, L } = this.streamerPath(s);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (L < 4) {
      // Hanging limp down the pole: from above, just a bunched-up bit of
      // ribbon at the top, nudged a touch whichever way the air is drifting.
      const p = pts[0];
      const tip = pts[pts.length - 1];
      const cx = (p.x + tip.x) / 2 + 1;
      const cy = (p.y + tip.y) / 2 + 1;
      ctx.fillStyle = COLORS.streamerEdge;
      ctx.beginPath();
      ctx.arc(cx, cy, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.streamer;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    const path = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    };

    // Shadow on the grass (the streamer flies a couple of metres up).
    ctx.save();
    ctx.translate(SHADOW.x * 3.5, SHADOW.y * 3.5);
    ctx.strokeStyle = 'rgba(0, 30, 0, 0.22)';
    ctx.lineWidth = 4;
    path();
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = COLORS.streamerEdge;
    ctx.lineWidth = 5.5;
    path();
    ctx.stroke();
    ctx.strokeStyle = COLORS.streamer;
    ctx.lineWidth = 3.6;
    path();
    ctx.stroke();
    // Highlight stripe.
    ctx.strokeStyle = 'rgba(255, 210, 160, 0.55)';
    ctx.lineWidth = 1;
    path();
    ctx.stroke();
    ctx.restore();
  }

  drawPole(s, labelled) {
    const { ctx } = this;
    const p = this.toScreen(s.pole);
    ctx.save();
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d9d9d9';
    ctx.beginPath();
    ctx.arc(p.x - 1, p.y - 1, 1.6, 0, Math.PI * 2);
    ctx.fill();
    // Pole label sits on the side away from the streamer.
    const away = norm(scale(this.vToScreen(s.v), -1));
    const lx = p.x + (away.x || 0) * 14;
    const ly = p.y + (away.y || -1) * 14;
    if (labelled) this.pill(s.id, lx, ly, 'rgba(20, 30, 20, 0.7)', '#fff', 10);
    ctx.restore();
  }

  baselineTip(s, scn) {
    return this.toScreen(add(s.pole, streamerTipOffset(scn.wind)));
  }

  drawBaseline(s, scn) {
    const { ctx } = this;
    const p = this.toScreen(s.pole);
    const B = this.baselineTip(s, scn);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.arc(B.x, B.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    const d = norm(this.vToScreen(scn.wind));
    ctx.fillText('B', B.x + d.x * 8 - 3 + d.y * 8, B.y + d.y * 8 + 4 - d.x * 8);
    ctx.restore();
  }

  drawThirdVector(s, scn, emphatic) {
    const B = this.baselineTip(s, scn);
    const C = this.toScreen(s.tip);
    if (len(sub(C, B)) < 2.5) return;
    this.arrow(B, C, COLORS.third, emphatic ? 3 : 2.5, 8);
    const { ctx } = this;
    ctx.save();
    ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = COLORS.third;
    const d = norm(sub(C, B));
    ctx.fillText('C', C.x + d.x * 9 - 3, C.y + d.y * 9 + 4);
    ctx.restore();
  }

  drawProjection(s, scn) {
    const B = this.baselineTip(s, scn);
    const C = this.toScreen(s.tip);
    const v = sub(C, B);
    if (len(v) < 4) return;
    const d = norm(v);
    const end = add(B, scale(d, Math.hypot(this.w, this.h)));
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 210, 63, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(B.x, B.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.restore();
  }

  drawPilot(facing) {
    const { ctx } = this;
    const c = this.toScreen({ x: 0, y: 0 });
    const f = this.vToScreen(facing);
    const ang = Math.atan2(f.y, f.x);
    const u = Math.max(this.ppm * 0.7, 3.6);

    ctx.save();
    ctx.translate(c.x, c.y);

    // Shadow.
    ctx.fillStyle = 'rgba(0, 30, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(SHADOW.x * 2.2, SHADOW.y * 2.2, 3.6 * u, 3.6 * u, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(ang); // +x is now the direction the pilot faces (into wind)

    // Arms reaching to the transmitter.
    ctx.strokeStyle = '#2459b8';
    ctx.lineWidth = 1.3 * u;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0.3 * u, -2.4 * u);
    ctx.lineTo(2.1 * u, -1.4 * u);
    ctx.moveTo(0.3 * u, 2.4 * u);
    ctx.lineTo(2.1 * u, 1.4 * u);
    ctx.stroke();

    // Body / shoulders.
    ctx.fillStyle = '#2f6fe0';
    ctx.beginPath();
    ctx.ellipse(0, 0, 1.6 * u, 3 * u, 0, 0, Math.PI * 2);
    ctx.fill();

    // Transmitter with antenna.
    ctx.fillStyle = '#1d1d1f';
    roundRect(ctx, 1.9 * u, -1.7 * u, 1.5 * u, 3.4 * u, 0.4 * u);
    ctx.fill();
    ctx.strokeStyle = '#cfcfcf';
    ctx.lineWidth = Math.max(1, 0.25 * u);
    ctx.beginPath();
    ctx.moveTo(3.2 * u, -1.2 * u);
    ctx.lineTo(5.2 * u, -2.3 * u);
    ctx.stroke();

    // Head with cap (brim forward).
    ctx.fillStyle = '#d7263d';
    ctx.beginPath();
    ctx.ellipse(1.1 * u, 0, 0.9 * u, 1.1 * u, 0, -Math.PI / 2, Math.PI / 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 1.4 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.arc(-0.35 * u, -0.35 * u, 0.45 * u, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  drawThermal(th) {
    const { ctx } = this;
    const c = this.toScreen(th.pos);
    const R = th.radius * this.ppm;
    const k = th.strength > 0 ? th.strengthNow / th.strength : 0;
    ctx.save();
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R * 2.4);
    g.addColorStop(0, `rgba(${COLORS.thermal}, ${0.55 * k})`);
    g.addColorStop(0.42, `rgba(${COLORS.thermal}, ${0.32 * k})`);
    g.addColorStop(1, `rgba(${COLORS.thermal}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(255, 235, 200, ${0.85 * Math.max(k, 0.3)})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this.pill('THERMAL', c.x, c.y - R - 12, 'rgba(120, 50, 0, 0.75)', '#ffe6c7', 10);
  }

  drawTrail(trail, th) {
    if (trail.length < 2) return;
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 225, 180, 0.75)';
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 6]);
    ctx.lineCap = 'round';
    ctx.beginPath();
    const p0 = this.toScreen(trail[0]);
    ctx.moveTo(p0.x, p0.y);
    for (const p of trail) {
      const s = this.toScreen(p);
      ctx.lineTo(s.x, s.y);
    }
    if (th) {
      const s = this.toScreen(th.pos);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Birthplace marker.
    ctx.strokeStyle = 'rgba(255, 220, 170, 0.6)';
    ctx.beginPath();
    ctx.arc(p0.x, p0.y, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Joe's diagram, all the way round: blue ambient + yellow inflow = white felt wind.
  drawVectorField(scn, th) {
    const rings = [
      { r: th.radius * 1.6, n: 8, off: 0 },
      { r: th.radius * 3.0, n: 12, off: Math.PI / 12 },
    ];
    const k = VECTOR_M_PER_MS;
    for (const ring of rings) {
      for (let i = 0; i < ring.n; i++) {
        const a = ring.off + (i / ring.n) * Math.PI * 2;
        const O = add(th.pos, { x: Math.cos(a) * ring.r, y: Math.sin(a) * ring.r });
        if (Math.abs(O.x) > this.field.halfW + 4 || Math.abs(O.y) > this.field.halfH + 4) continue;
        // Felt wind without gusts; the yellow third vector is felt − ambient
        // (the inflow, plus the calm-under-the-core term close in).
        const F = localWind(scn, O, null, th);
        const Wtip = add(O, scale(scn.wind, k));
        const Ftip = add(O, scale(F, k));
        const o = this.toScreen(O);
        // Felt wind underneath and thinner, so the blue + yellow pair stays readable on top.
        this.arrow(o, this.toScreen(Ftip), COLORS.felt, 1.4, 6, 0.85);
        this.arrow(o, this.toScreen(Wtip), COLORS.ambient, 2.2, 6, 0.95);
        this.arrow(this.toScreen(Wtip), this.toScreen(Ftip), COLORS.third, 2.4, 6, 1);
      }
    }
  }

  drawParticles(particles) {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.4;
    for (const p of particles.items) {
      const life = p.age / p.life;
      const alpha = Math.sin(Math.PI * Math.min(1, life)) * 0.4;
      if (alpha <= 0.01) continue;
      const a = this.toScreen(p.pos);
      const b = this.toScreen(sub(p.pos, scale(p.vel, 0.45)));
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawGuess(guess, revealed) {
    const { ctx } = this;
    const g = this.toScreen(guess.pos);
    ctx.save();
    if (revealed && guess.thermalPos) {
      const t = this.toScreen(guess.thermalPos);
      ctx.strokeStyle = 'rgba(255, 79, 163, 0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(255, 235, 200, 0.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const m = lerp(g, t, 0.5);
      this.pill(`${guess.distance.toFixed(1)} m`, m.x, m.y - 12, 'rgba(120, 10, 60, 0.85)', '#fff', 11);
    }
    // Marker.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = COLORS.guess;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 8, 0, Math.PI * 2);
    ctx.moveTo(g.x - 13, g.y);
    ctx.lineTo(g.x - 4, g.y);
    ctx.moveTo(g.x + 4, g.y);
    ctx.lineTo(g.x + 13, g.y);
    ctx.moveTo(g.x, g.y - 13);
    ctx.lineTo(g.x, g.y - 4);
    ctx.moveTo(g.x, g.y + 4);
    ctx.lineTo(g.x, g.y + 13);
    ctx.stroke();
    ctx.restore();
  }

  drawHover(h) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawCompass() {
    const { ctx } = this;
    const x = 36;
    const y = 46;
    ctx.save();
    ctx.fillStyle = 'rgba(10, 25, 12, 0.55)';
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff5a4a';
    ctx.beginPath();
    ctx.moveTo(x, y - 15);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x - 5, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.moveTo(x, y + 15);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x - 5, y);
    ctx.closePath();
    ctx.fill();
    ctx.font = '800 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText('N', x, y - 24);
    ctx.restore();
  }

  drawScaleBar() {
    const { ctx } = this;
    const m = 20;
    const w = m * this.ppm;
    const x = 16;
    const y = this.h - 18;
    ctx.save();
    ctx.fillStyle = 'rgba(10, 25, 12, 0.55)';
    roundRect(ctx, x - 8, y - 20, w + 16, 30, 6);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y - 4);
    ctx.stroke();
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(`${m} m`, x + w / 2, y - 7);
    ctx.restore();
  }

  drawAmbientKey(scn) {
    // Big ambient-wind arrow in the top-right corner.
    const { ctx } = this;
    const cx = this.w - 46;
    const cy = 46;
    const d = norm(this.vToScreen(scn.wind));
    const L = 26;
    ctx.save();
    ctx.fillStyle = 'rgba(10, 25, 12, 0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, 33, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this.arrow({ x: cx - d.x * L * 0.6, y: cy - d.y * L * 0.6 }, { x: cx + d.x * L * 0.6, y: cy + d.y * L * 0.6 }, COLORS.ambient, 4, 10);
  }

  // ---- Primitives ------------------------------------------------------------

  arrow(a, b, color, width = 2, head = 7, alpha = 1) {
    const { ctx } = this;
    const v = sub(b, a);
    const L = len(v);
    if (L < 0.5) return;
    const d = { x: v.x / L, y: v.y / L };
    const h = Math.min(head, L * 0.55);
    const base = { x: b.x - d.x * h, y: b.y - d.y * h };
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    // Dark outline so arrows read on grass.
    for (const [col, w] of [
      ['rgba(0, 0, 0, 0.35)', width + 2],
      [color, width],
    ]) {
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(base.x, base.y);
      ctx.stroke();
      const spread = h * 0.55 + (w - width) * 0.6;
      ctx.beginPath();
      ctx.moveTo(b.x + d.x * (w - width) * 0.6, b.y + d.y * (w - width) * 0.6);
      ctx.lineTo(base.x - d.y * spread, base.y + d.x * spread);
      ctx.lineTo(base.x + d.y * spread, base.y - d.x * spread);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  pill(text, x, y, bg, fg, size = 10) {
    const { ctx } = this;
    ctx.save();
    ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 10;
    const h = size + 7;
    ctx.fillStyle = bg;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
