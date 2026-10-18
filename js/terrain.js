// The mountain: a flat meadow around the launch site that rises into ridged peaks.
// Pure functions, shared by the mesh, the forest, the route and the flight path.

export const HOME = { x: 0, z: 0 };
export const TARGET = { x: 76, z: -124 };
export const TREELINE = 23;

const smooth = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const hash = (x, z) => {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function noise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), w = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
}

// Ridged fractal noise: sharp crests, like real ridgelines
function ridged(x, z) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < 6; o++) {
    const n = 1 - Math.abs(noise(x, z) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    x = x * 2.03 + 17.1;
    z = z * 2.03 - 9.3;
  }
  return sum / norm;
}

function raw(x, z) {
  const fromHome = Math.hypot(x - HOME.x, z - HOME.z);
  const mountain = 70 * Math.pow(ridged(x * 0.0105 + 3.7, z * 0.0105 + 1.9), 1.5) * smooth(16, 125, fromHome);
  const meadow = 0.8 * noise(x * 0.07, z * 0.07) * smooth(5, 30, fromHome);
  return mountain + meadow;
}

const LEDGE = raw(TARGET.x, TARGET.z);

// The injured person lies on a small ledge cut into the slope.
export function height(x, z) {
  const k = smooth(11, 4.5, Math.hypot(x - TARGET.x, z - TARGET.z));
  return raw(x, z) * (1 - k) + LEDGE * k;
}

// Upward surface normal, from the height gradient
export function normal(x, z, out) {
  const e = 0.5;
  out.set(height(x - e, z) - height(x + e, z), 2 * e, height(x, z - e) - height(x, z + e));
  return out.normalize();
}

export const steepness = (x, z) => Math.hypot(height(x + 1, z) - height(x - 1, z), height(x, z + 1) - height(x, z - 1)) / 2;
