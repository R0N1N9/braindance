// A synthetic recording, so the editor can be tried without any hardware.
// It films a made-up room through a camera that pans around, with a tone for
// sound and a heart rate that jumps when something appears. It goes through
// the same MediaRecorder path as a real capture.

import { Euler, MathUtils, Quaternion } from 'three';
import type { Recording, Samples } from '../format/bd';
import { assemble, pickMime } from './recorder';

const W = 640;
const H = 360;
const FOV = 70;
const DURATION = 8;
const EVENT_AT = 4.2;

/** Things in the room, by direction in degrees (left and up are positive). */
const ROOM = [
  { az: 38, el: 4, w: 16, h: 22, color: '#5d6f8a', label: 'window' },
  { az: 0, el: -6, w: 22, h: 10, color: '#7b6a58', label: 'desk' },
  { az: -34, el: 0, w: 12, h: 26, color: '#4f5b52', label: 'door' },
];

function headAt(t: number): { yaw: number; pitch: number } {
  // A slow look to the left, then a quick turn to the door when it opens.
  const calm = 30 * Math.sin((t / DURATION) * Math.PI * 1.1);
  const snap = MathUtils.smoothstep(t, EVENT_AT, EVENT_AT + 0.5);
  return { yaw: MathUtils.lerp(calm, -32, snap), pitch: 3 * Math.sin(t * 1.7) };
}

function draw(ctx: CanvasRenderingContext2D, t: number): void {
  const { yaw, pitch } = headAt(t);
  const ppd = W / FOV;
  const x = (az: number) => W / 2 - (az - yaw) * ppd;
  const y = (el: number) => H / 2 - (el - pitch) * ppd;

  ctx.fillStyle = '#2a2630';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#3a3138';
  ctx.fillRect(0, y(-14), W, H);

  for (const o of ROOM) {
    ctx.fillStyle = o.color;
    ctx.fillRect(x(o.az + o.w / 2), y(o.el + o.h / 2), o.w * ppd, o.h * ppd);
  }
  // A lamp on the desk: the hottest thing in the room.
  ctx.fillStyle = '#fff3c4';
  ctx.beginPath();
  ctx.arc(x(6), y(3), 2.2 * ppd, 0, Math.PI * 2);
  ctx.fill();

  if (t > EVENT_AT) {
    // The door opens and a warm figure stands in it.
    const open = MathUtils.smoothstep(t, EVENT_AT, EVENT_AT + 0.6);
    ctx.fillStyle = '#16131a';
    ctx.fillRect(x(-28), y(13), 12 * ppd * open, 26 * ppd);
    ctx.fillStyle = `rgba(236, 196, 160, ${open})`;
    ctx.beginPath();
    ctx.ellipse(x(-34), y(-2), 2.6 * ppd, 8 * ppd, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x(-34), y(8), 2 * ppd, 0, Math.PI * 2);
    ctx.fill();
  }
}

function poseSample(t: number, q: Quaternion, e: Euler): number[] {
  const { yaw, pitch } = headAt(t);
  q.setFromEuler(e.set(MathUtils.degToRad(pitch), MathUtils.degToRad(yaw), 0, 'YXZ'));
  return [q.x, q.y, q.z, q.w].map((n) => Math.round(n * 1e5) / 1e5);
}

export async function recordDemo(onProgress: (fraction: number) => void): Promise<Recording> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, 0);

  const audio = new AudioContext();
  const out = audio.createMediaStreamDestination();
  const hum = audio.createOscillator();
  const humGain = audio.createGain();
  hum.frequency.value = 110;
  humGain.gain.value = 0.08;
  hum.connect(humGain).connect(out);
  hum.start();

  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...out.stream.getAudioTracks()]);
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const pose: Samples = { t: [], v: [] };
  const heart: Samples = { t: [], v: [] };
  const q = new Quaternion();
  const e = new Euler();
  let offset = 0;
  let creaked = false;
  let lastBeat = -1;

  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  recorder.onstart = () => (offset = now());
  recorder.start(500);

  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      const t = now();
      if (t >= DURATION) {
        clearInterval(timer);
        done();
        return;
      }
      draw(ctx, t);
      pose.t.push(Math.round(t * 1e4) / 1e4);
      pose.v.push(...poseSample(t, q, e));
      if (t - lastBeat >= 0.5) {
        lastBeat = t;
        const startle = MathUtils.smoothstep(t, EVENT_AT, EVENT_AT + 1.2);
        heart.t.push(Math.round(t * 100) / 100);
        heart.v.push(Math.round(66 + 52 * startle + 2 * Math.sin(t * 3)));
      }
      if (!creaked && t >= EVENT_AT) {
        creaked = true;
        // The door: a short rising creak over the room hum.
        const creak = audio.createOscillator();
        const g = audio.createGain();
        creak.type = 'sawtooth';
        creak.frequency.setValueAtTime(240, audio.currentTime);
        creak.frequency.linearRampToValueAtTime(620, audio.currentTime + 0.7);
        g.gain.setValueAtTime(0.25, audio.currentTime);
        g.gain.linearRampToValueAtTime(0, audio.currentTime + 0.8);
        creak.connect(g).connect(out);
        creak.start();
        creak.stop(audio.currentTime + 0.8);
      }
      onProgress(t / DURATION);
    }, 1000 / 30);
  });

  const duration = now();
  await new Promise<void>((done) => {
    recorder.onstop = () => done();
    recorder.stop();
  });
  stream.getTracks().forEach((t) => t.stop());
  await audio.close();

  const rec = assemble({
    title: 'Demo: the door',
    duration,
    video: new Blob(chunks, { type: recorder.mimeType || 'video/webm' }),
    mime: recorder.mimeType || 'video/webm',
    projection: 'flat',
    fov: FOV,
    offset,
    hasAudio: true,
    pose,
    heart,
  });
  rec.manifest.device = 'Synthetic demo';
  rec.manifest.markers.push({
    id: 'demo-door',
    t: EVENT_AT + 0.6,
    label: 'Door opens',
    layer: 'sound',
    dir: [Math.sin(MathUtils.degToRad(34)), 0, -Math.cos(MathUtils.degToRad(34))],
  });
  return rec;
}
