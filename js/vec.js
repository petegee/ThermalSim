// Small 2D vector helpers. World frame: metres, x = east, y = north,
// origin at the pilot. Headings are compass degrees (0 = north, clockwise).

export const vec = (x = 0, y = 0) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function norm(a) {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

// Rotate 90° counter-clockwise: the "left" of a direction when viewed from above.
export const perpLeft = (a) => ({ x: -a.y, y: a.x });

// Unit vector pointing toward a compass heading.
export function fromHeading(deg, mag = 1) {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r) * mag, y: Math.cos(r) * mag };
}

// Compass heading a vector points toward.
export function headingOf(a) {
  return ((Math.atan2(a.x, a.y) * 180) / Math.PI + 360) % 360;
}

// Signed smallest difference b - a in degrees, in (-180, 180].
export function angleDiff(a, b) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compassPoint = (deg) => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
