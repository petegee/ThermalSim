// Short-lived tracer particles that ride the local wind, used once the thermal
// is revealed to show the air converging on it.

export class FlowParticles {
  constructor(field, density = 0.0095) {
    this.field = field;
    this.items = [];
    const count = Math.round(4 * field.halfW * field.halfH * density);
    for (let i = 0; i < count; i++) {
      const p = this.spawn({});
      p.age = Math.random() * p.life; // stagger so they don't all blink together
      this.items.push(p);
    }
  }

  spawn(p) {
    const { halfW, halfH } = this.field;
    p.pos = { x: (Math.random() * 2 - 1) * (halfW + 4), y: (Math.random() * 2 - 1) * (halfH + 4) };
    p.vel = { x: 0, y: 0 };
    p.age = 0;
    p.life = 1.8 + Math.random() * 2.2;
    return p;
  }

  update(dt, windAt) {
    const { halfW, halfH } = this.field;
    for (const p of this.items) {
      p.vel = windAt(p.pos);
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.age += dt;
      if (p.age > p.life || Math.abs(p.pos.x) > halfW + 6 || Math.abs(p.pos.y) > halfH + 6) this.spawn(p);
    }
  }
}
