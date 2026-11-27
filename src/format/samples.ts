// Reading sensor tracks at an arbitrary time.

import type { Samples } from './bd';

/** Index of the last sample at or before t, or -1 if t is before the first. */
export function indexAt(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || t < times[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Linear interpolation of one channel. Holds the end values outside the range. */
export function valueAt(s: Samples, stride: number, channel: number, t: number): number | undefined {
  const n = s.t.length;
  if (n === 0) return undefined;
  const i = indexAt(s.t, t);
  if (i < 0) return s.v[channel];
  if (i >= n - 1) return s.v[(n - 1) * stride + channel];
  const span = s.t[i + 1] - s.t[i];
  const k = span > 0 ? (t - s.t[i]) / span : 0;
  const a = s.v[i * stride + channel];
  const b = s.v[(i + 1) * stride + channel];
  return a + (b - a) * k;
}

export type Quat = [number, number, number, number];

/** Orientation at time t from a pose track (x, y, z, w per sample). */
export function quatAt(s: Samples, t: number): Quat | undefined {
  const n = s.t.length;
  if (n === 0) return undefined;
  const i = Math.max(0, indexAt(s.t, t));
  const j = Math.min(n - 1, i + 1);
  const a = s.v.slice(i * 4, i * 4 + 4) as Quat;
  if (i === j || t <= s.t[i]) return a;
  const b = s.v.slice(j * 4, j * 4 + 4) as Quat;
  const span = s.t[j] - s.t[i];
  const k = span > 0 ? Math.min(1, (t - s.t[i]) / span) : 0;
  // Normalised lerp along the shorter arc; samples are close enough together.
  const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q: Quat = [0, 0, 0, 0];
  let len = 0;
  for (let c = 0; c < 4; c++) {
    q[c] = a[c] + (sign * b[c] - a[c]) * k;
    len += q[c] * q[c];
  }
  len = Math.sqrt(len) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** How fast the head was turning, in degrees per second, one value per pose sample. */
export function turnRate(pose: Samples): Samples {
  const out: Samples = { t: [], v: [] };
  for (let i = 1; i < pose.t.length; i++) {
    const dt = pose.t[i] - pose.t[i - 1];
    if (dt <= 0) continue;
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += pose.v[(i - 1) * 4 + c] * pose.v[i * 4 + c];
    const angle = 2 * Math.acos(Math.min(1, Math.abs(dot)));
    out.t.push(pose.t[i]);
    out.v.push((angle * 180) / Math.PI / dt);
  }
  return out;
}

/** Reduce a single-channel track to `buckets` maxima across [0, duration]. */
export function envelope(s: Samples, duration: number, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  for (let i = 0; i < s.t.length; i++) {
    const b = Math.min(buckets - 1, Math.max(0, Math.floor((s.t[i] / duration) * buckets)));
    if (s.v[i] > out[b]) out[b] = s.v[i];
  }
  return out;
}
