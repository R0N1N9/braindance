// A capture session: camera and microphone into one video file, with the
// sensors sampled against the same clock.

import { addSensor, emptyManifest, type Projection, type Recording } from '../format/bd';
import { HeartRateSensor, MotionSensor, OrientationSensor } from './sensors';

const MIME_CHOICES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

export function pickMime(): string {
  return MIME_CHOICES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export function extensionFor(mime: string): string {
  return mime.includes('mp4') ? 'mp4' : 'webm';
}

/** Phone main cameras are close to this along the long edge; there is no way to ask. */
export const PHONE_FOV = 65;

export class CaptureSession {
  stream: MediaStream | null = null;
  orientation = new OrientationSensor();
  motion = new MotionSensor();
  heart = new HeartRateSensor();
  recording = false;

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private t0 = 0;
  private mediaOffset = 0;

  async openCamera(): Promise<MediaStream> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    return this.stream;
  }

  /** Seconds since recording began. */
  elapsed = (): number => (performance.now() - this.t0) / 1000;

  start(): void {
    if (!this.stream) throw new Error('Open the camera before recording.');
    const mime = pickMime();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    // The file's own clock starts when the encoder does, slightly after ours.
    this.recorder.onstart = () => (this.mediaOffset = this.elapsed());
    this.t0 = performance.now();
    this.orientation.begin(this.elapsed);
    this.motion.begin(this.elapsed);
    this.heart.begin(this.elapsed);
    this.recorder.start(1000);
    this.recording = true;
  }

  async stop(title: string): Promise<Recording> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('Nothing is being recorded.');
    const duration = this.elapsed();
    await new Promise<void>((done) => {
      recorder.onstop = () => done();
      recorder.stop();
    });
    this.recording = false;
    this.recorder = null;

    const mime = recorder.mimeType || 'video/webm';
    return assemble({
      title,
      duration,
      video: new Blob(this.chunks, { type: mime }),
      mime,
      projection: 'flat',
      fov: PHONE_FOV,
      offset: this.mediaOffset,
      hasAudio: this.stream!.getAudioTracks().length > 0,
      pose: this.orientation.end(),
      motion: this.motion.end(),
      heart: this.heart.end(),
    });
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.orientation.close();
    this.motion.close();
    this.heart.close();
  }
}

type Columns = { t: number[]; v: number[] };

export function assemble(parts: {
  title: string;
  duration: number;
  video: Blob;
  mime: string;
  projection: Projection;
  fov?: number;
  offset?: number;
  hasAudio: boolean;
  pose?: Columns;
  motion?: Columns;
  heart?: Columns;
}): Recording {
  const rec: Recording = {
    manifest: emptyManifest(parts.title, Math.round(parts.duration * 1000) / 1000),
    media: new Map(),
    samples: new Map(),
  };
  rec.manifest.device = navigator.userAgent;
  const file = `video.${extensionFor(parts.mime)}`;
  rec.manifest.media.push({
    id: 'video',
    kind: 'video',
    file,
    mime: parts.mime,
    projection: parts.projection,
    fov: parts.projection === 'flat' ? (parts.fov ?? PHONE_FOV) : undefined,
    hasAudio: parts.hasAudio,
    offset: Math.round((parts.offset ?? 0) * 1000) / 1000,
  });
  rec.media.set(file, parts.video);
  if (parts.pose) addSensor(rec, 'pose', ['x', 'y', 'z', 'w'], 'quaternion', parts.pose);
  if (parts.motion) addSensor(rec, 'motion', ['x', 'y', 'z'], 'm/s²', parts.motion);
  if (parts.heart) addSensor(rec, 'heartrate', ['bpm'], 'bpm', parts.heart);
  return rec;
}

/** Wrap a video file from another camera (a 360 camera, say) as a recording. */
export async function importVideo(file: File, projection: Projection): Promise<Recording> {
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  const url = URL.createObjectURL(file);
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      probe.onloadedmetadata = () => resolve(probe.duration);
      probe.onerror = () => reject(new Error(`This browser cannot play "${file.name}". Try an MP4 or WebM file.`));
      probe.src = url;
    });
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`"${file.name}" does not report how long it is, so it cannot be imported.`);
    }
    return assemble({
      title: file.name.replace(/\.[^.]+$/, ''),
      duration,
      video: file,
      mime: file.type || 'video/mp4',
      projection,
      hasAudio: true,
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
