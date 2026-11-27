// The .bd container: a zip holding manifest.json plus one file per track.
// Every track shares one timeline, in seconds from the start of the recording.
// See docs/DESIGN.md for the full spec.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export const FORMAT = 'braindance';
export const VERSION = 1;

export type Layer = 'sight' | 'sound' | 'heat';
export type Projection = 'flat' | 'equirect';

/** A video file. `video` is the main view; `thermal` is a heat camera. */
export interface MediaTrack {
  id: string;
  kind: 'video' | 'thermal';
  file: string;
  mime: string;
  projection: Projection;
  /** Field of view along the long edge of a flat frame, in degrees. */
  fov?: number;
  hasAudio: boolean;
  /** Timeline time at which this file's own time 0 falls. */
  offset: number;
}

/** A sensor stream stored as columns: times, then `channels.length` values per time. */
export interface SampleTrack {
  id: string;
  kind: 'pose' | 'motion' | 'heartrate';
  file: string;
  channels: string[];
  unit: string;
}

export interface Marker {
  id: string;
  t: number;
  label: string;
  layer: Layer;
  /** Unit vector in world space the viewer was facing when the marker was placed. */
  dir?: [number, number, number];
}

export interface Manifest {
  format: typeof FORMAT;
  version: number;
  id: string;
  title: string;
  createdAt: string;
  duration: number;
  device?: string;
  media: MediaTrack[];
  sensors: SampleTrack[];
  markers: Marker[];
}

export interface Samples {
  t: number[];
  v: number[];
}

export interface Recording {
  manifest: Manifest;
  media: Map<string, Blob>;
  samples: Map<string, Samples>;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function emptyManifest(title: string, duration: number): Manifest {
  return {
    format: FORMAT,
    version: VERSION,
    id: newId(),
    title,
    createdAt: new Date().toISOString(),
    duration,
    media: [],
    sensors: [],
    markers: [],
  };
}

export class BdError extends Error {}

/** Throws BdError describing the first problem found. */
export function validate(rec: Recording): void {
  const m = rec.manifest;
  if (!m || m.format !== FORMAT) throw new BdError('This file is not a braindance recording.');
  if (m.version > VERSION) {
    throw new BdError(`This recording uses format version ${m.version}; this app reads up to ${VERSION}.`);
  }
  if (!(m.duration > 0)) throw new BdError('The recording has no duration.');
  if (!Array.isArray(m.media) || !Array.isArray(m.sensors) || !Array.isArray(m.markers)) {
    throw new BdError('The manifest is missing its track lists.');
  }
  if (!m.media.some((t) => t.kind === 'video')) throw new BdError('The recording has no video track.');
  for (const t of m.media) {
    if (!rec.media.has(t.file)) throw new BdError(`The video file "${t.file}" is missing from the recording.`);
  }
  for (const t of m.sensors) {
    const s = rec.samples.get(t.file);
    if (!s) throw new BdError(`The sensor file "${t.file}" is missing from the recording.`);
    if (s.v.length !== s.t.length * t.channels.length) {
      throw new BdError(`The sensor track "${t.id}" has a different number of values than times.`);
    }
    for (let i = 1; i < s.t.length; i++) {
      if (s.t[i] < s.t[i - 1]) throw new BdError(`The sensor track "${t.id}" has times out of order.`);
    }
  }
}

export async function pack(rec: Recording): Promise<Blob> {
  validate(rec);
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(rec.manifest, null, 2)),
  };
  for (const t of rec.manifest.sensors) {
    files[t.file] = strToU8(JSON.stringify(rec.samples.get(t.file)));
  }
  for (const t of rec.manifest.media) {
    files[t.file] = new Uint8Array(await rec.media.get(t.file)!.arrayBuffer());
  }
  // Video is already compressed, so store everything without deflating.
  const zipped = zipSync(files, { level: 0 });
  return new Blob([zipped as BlobPart], { type: 'application/x-braindance' });
}

export async function unpack(file: Blob): Promise<Recording> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new BdError('This file is not a braindance recording.');
  }
  if (!files['manifest.json']) throw new BdError('This file is not a braindance recording.');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(files['manifest.json']));
  } catch {
    throw new BdError('The recording manifest cannot be read.');
  }
  const rec: Recording = { manifest, media: new Map(), samples: new Map() };
  for (const t of manifest.media ?? []) {
    const data = files[t.file];
    if (data) rec.media.set(t.file, new Blob([data as BlobPart], { type: t.mime }));
  }
  for (const t of manifest.sensors ?? []) {
    const data = files[t.file];
    if (data) rec.samples.set(t.file, JSON.parse(strFromU8(data)));
  }
  validate(rec);
  return rec;
}

export function sensor(rec: Recording, kind: SampleTrack['kind']): Samples | undefined {
  const t = rec.manifest.sensors.find((s) => s.kind === kind);
  return t && rec.samples.get(t.file);
}

export function addSensor(
  rec: Recording,
  kind: SampleTrack['kind'],
  channels: string[],
  unit: string,
  samples: Samples,
): void {
  if (samples.t.length === 0) return;
  const file = `${kind}.json`;
  rec.manifest.sensors.push({ id: kind, kind, file, channels, unit });
  rec.samples.set(file, samples);
}
