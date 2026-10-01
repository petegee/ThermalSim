// Short-lived tracer particles that ride the local wind, used once the thermal
// is revealed to show the air converging on it.

import { FIELD_HALF } from './scenario.js';

export class FlowParticles {
  constructor(count = 380) {
    this.items = [];
    for (let i = 0; i < count; i++) {
      const p = this.spawn({});
      p.age = Math.random() * p.life; // stagger so they don't all blink together
      this.items.push(p);
    }
  }

  spawn(p) {
    const span = FIELD_HALF + 4;
    p.pos = { x: (Math.random() * 2 - 1) * span, y: (Math.random() * 2 - 1) * span };
    p.vel = { x: 0, y: 0 };
    p.age = 0;
    p.life = 1.8 + Math.random() * 2.2;
    return p;
  }

  update(dt, windAt) {
    for (const p of this.items) {
      p.vel = windAt(p.pos);
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.age += dt;
      if (p.age > p.life || Math.abs(p.pos.x) > FIELD_HALF + 6 || Math.abs(p.pos.y) > FIELD_HALF + 6) this.spawn(p);
    }
  }
}
