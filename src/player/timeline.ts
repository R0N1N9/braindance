// The timeline: one lane per recorded sense, stacked like strata. The first
// three lanes are also the layer switch; choosing one changes how the
// recording is drawn in the view above.

import type { Layer, Marker, Samples } from '../format/bd';

const RULER = 22;
const LANE = 34;

interface LaneSpec {
  key: Layer | 'pulse' | 'motion';
  name: string;
  note?: string;
}

export interface TimelineOptions {
  duration: number;
  markers: () => Marker[];
  pulse?: Samples;
  motion?: Float32Array;
  onSeek: (t: number) => void;
  onLayer: (layer: Layer) => void;
}

export class Timeline {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private lanes: LaneSpec[];
  private buttons = new Map<Layer, HTMLButtonElement>();
  private heatNote = document.createElement('small');
  private layer: Layer = 'sight';
  private wave: { peaks: Float32Array; start: number; length: number } | null = null;
  private colors: Record<string, string> = {};
  private width = 0;
  private lastT = 0;
  private resizer: ResizeObserver;

  constructor(
    private root: HTMLElement,
    private opts: TimelineOptions,
  ) {
    this.lanes = [
      { key: 'sight', name: 'Sight' },
      { key: 'sound', name: 'Sound' },
      { key: 'heat', name: 'Heat' },
    ];
    if (opts.pulse) this.lanes.push({ key: 'pulse', name: 'Pulse' });
    if (opts.motion) this.lanes.push({ key: 'motion', name: 'Head movement' });

    root.replaceChildren();
    root.classList.add('strata');
    const labels = document.createElement('div');
    labels.className = 'strata-labels';
    labels.style.paddingTop = `${RULER}px`;
    for (const lane of this.lanes) {
      const isLayer = lane.key === 'sight' || lane.key === 'sound' || lane.key === 'heat';
      const el = document.createElement(isLayer ? 'button' : 'div');
      el.className = `lane-label lane-${lane.key}`;
      el.style.height = `${LANE}px`;
      const name = document.createElement('span');
      name.textContent = lane.name;
      el.append(name);
      if (lane.key === 'heat') el.append(this.heatNote);
      if (isLayer) {
        const layer = lane.key as Layer;
        (el as HTMLButtonElement).type = 'button';
        el.title = `Show the ${lane.name.toLowerCase()} layer`;
        el.addEventListener('click', () => opts.onLayer(layer));
        this.buttons.set(layer, el as HTMLButtonElement);
      }
      labels.append(el);
    }
    this.canvas.className = 'strata-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'slider');
    this.canvas.setAttribute('aria-label', 'Position in the recording');
    this.canvas.setAttribute('aria-valuemin', '0');
    this.canvas.setAttribute('aria-valuemax', opts.duration.toFixed(1));
    this.canvas.style.height = `${RULER + this.lanes.length * LANE}px`;
    root.append(labels, this.canvas);

    const css = getComputedStyle(document.documentElement);
    for (const name of ['ink', 'panel', 'line', 'bone', 'dim', 'sound', 'heat', 'pulse']) {
      this.colors[name] = css.getPropertyValue(`--${name}`).trim();
    }
    this.colors.sight = this.colors.bone;
    this.colors.motion = this.colors.dim;

    let scrubbing = false;
    const seekTo = (e: PointerEvent) => {
      const box = this.canvas.getBoundingClientRect();
      const k = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
      opts.onSeek(k * opts.duration);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      this.canvas.setPointerCapture(e.pointerId);
      seekTo(e);
    });
    this.canvas.addEventListener('pointermove', (e) => scrubbing && seekTo(e));
    this.canvas.addEventListener('pointerup', () => (scrubbing = false));
    this.canvas.addEventListener('pointercancel', () => (scrubbing = false));

    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(this.canvas);
    this.setLayer('sight');
  }

  setLayer(layer: Layer): void {
    this.layer = layer;
    for (const [key, button] of this.buttons) button.setAttribute('aria-pressed', String(key === layer));
    this.draw(this.lastT);
  }

  setHeatNote(text: string): void {
    this.heatNote.textContent = text;
  }

  /** `start` and `length` place the audio file on the timeline, in seconds. */
  setWaveform(peaks: Float32Array, start: number, length: number): void {
    this.wave = { peaks, start, length };
    this.draw(this.lastT);
  }

  dispose(): void {
    this.resizer.disconnect();
    this.root.replaceChildren();
  }

  private resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.width = this.canvas.clientWidth;
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round((RULER + this.lanes.length * LANE) * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw(this.lastT);
  }

  draw(t: number): void {
    this.lastT = t;
    const { ctx, width: w, colors } = this;
    if (!w) return;
    const d = this.opts.duration;
    const h = RULER + this.lanes.length * LANE;
    const x = (time: number) => (time / d) * w;
    ctx.clearRect(0, 0, w, h);

    // Ruler: a tick each second or so, labelled every few.
    const step = [0.5, 1, 2, 5, 10, 30, 60, 300, 600].find((s) => (s / d) * w >= 56) ?? 600;
    ctx.fillStyle = colors.dim;
    ctx.font = '11px "Instrument Sans Variable", sans-serif';
    ctx.textBaseline = 'middle';
    for (let s = 0; s <= d; s += step) {
      ctx.fillRect(Math.round(x(s)), RULER - 5, 1, 5);
      if (x(s) < w - 30) ctx.fillText(clock(s, step < 1), x(s) + 4, RULER / 2 - 1);
    }

    this.lanes.forEach((lane, i) => {
      const top = RULER + i * LANE;
      const color = colors[lane.key];
      const active = lane.key === this.layer;
      ctx.globalAlpha = active ? 0.2 : 0.06;
      ctx.fillStyle = color;
      ctx.fillRect(0, top + 1, w, LANE - 2);
      ctx.globalAlpha = active ? 1 : 0.6;

      if (lane.key === 'sound' && this.wave) {
        const { peaks, start, length } = this.wave;
        const mid = top + LANE / 2;
        const bar = Math.max(1, (x(length) / peaks.length) * 0.8);
        for (let b = 0; b < peaks.length; b++) {
          const amp = Math.max(1, peaks[b] * (LANE - 8));
          ctx.fillRect(x(start + (b / peaks.length) * length), mid - amp / 2, bar, amp);
        }
      }
      if (lane.key === 'pulse' && this.opts.pulse) {
        const p = this.opts.pulse;
        const lo = Math.min(...p.v) - 4;
        const hi = Math.max(...p.v) + 4;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        p.t.forEach((time, k) => {
          const y = top + LANE - 5 - ((p.v[k] - lo) / (hi - lo)) * (LANE - 10);
          if (k === 0) ctx.moveTo(x(time), y);
          else ctx.lineTo(x(time), y);
        });
        ctx.stroke();
      }
      if (lane.key === 'motion' && this.opts.motion) {
        const m = this.opts.motion;
        const peak = Math.max(1, ...m);
        const bar = w / m.length;
        for (let b = 0; b < m.length; b++) {
          const amp = (m[b] / peak) * (LANE - 8);
          ctx.fillRect(b * bar, top + LANE - 4 - amp, Math.max(1, bar - 1), amp);
        }
      }
      ctx.globalAlpha = 1;

      // Markers sit in the lane of the layer they were placed on.
      for (const marker of this.opts.markers()) {
        if (marker.layer !== lane.key) continue;
        const mx = x(marker.t);
        ctx.fillStyle = colors.ink;
        ctx.beginPath();
        ctx.arc(mx, top + LANE / 2, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });

    const px = Math.round(x(Math.min(t, d)));
    ctx.fillStyle = colors.bone;
    ctx.fillRect(Math.min(w - 2, px), 0, 2, h);
    this.canvas.setAttribute('aria-valuenow', t.toFixed(1));
    this.canvas.setAttribute('aria-valuetext', clock(t));
  }
}

export function clock(seconds: number, tenths = false): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const base = `${m}:${String(whole).padStart(2, '0')}`;
  return tenths ? `${base}.${Math.floor((rest - whole) * 10)}` : base;
}
