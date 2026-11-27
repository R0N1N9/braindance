import { describe, expect, it } from 'vitest';
import { addSensor, BdError, emptyManifest, pack, unpack, type Recording } from '../src/format/bd';
import { envelope, indexAt, quatAt, turnRate, valueAt } from '../src/format/samples';

function sample(): Recording {
  const rec: Recording = { manifest: emptyManifest('Test', 4), media: new Map(), samples: new Map() };
  rec.manifest.media.push({
    id: 'video', kind: 'video', file: 'video.webm', mime: 'video/webm',
    projection: 'flat', fov: 65, hasAudio: true, offset: 0.12,
  });
  rec.media.set('video.webm', new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'video/webm' }));
  addSensor(rec, 'heartrate', ['bpm'], 'bpm', { t: [0, 1, 2], v: [60, 80, 100] });
  rec.manifest.markers.push({ id: 'a', t: 1.5, label: 'Door opens', layer: 'sound', dir: [0, 0, -1] });
  return rec;
}

describe('.bd container', () => {
  it('survives a pack and unpack', async () => {
    const before = sample();
    const after = await unpack(await pack(before));
    expect(after.manifest).toEqual(before.manifest);
    expect(after.samples.get('heartrate.json')).toEqual({ t: [0, 1, 2], v: [60, 80, 100] });
    const bytes = new Uint8Array(await after.media.get('video.webm')!.arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(after.media.get('video.webm')!.type).toBe('video/webm');
  });

  it('rejects files that are not recordings', async () => {
    await expect(unpack(new Blob(['hello']))).rejects.toBeInstanceOf(BdError);
  });

  it('rejects a recording with a missing video file', async () => {
    const rec = sample();
    rec.media.clear();
    await expect(pack(rec)).rejects.toThrow(/missing/);
  });

  it('rejects sensor tracks whose values do not match their times', async () => {
    const rec = sample();
    rec.samples.get('heartrate.json')!.v.pop();
    await expect(pack(rec)).rejects.toThrow(/different number/);
  });

  it('skips empty sensor tracks', () => {
    const rec = sample();
    addSensor(rec, 'pose', ['x', 'y', 'z', 'w'], 'quaternion', { t: [], v: [] });
    expect(rec.manifest.sensors.map((s) => s.kind)).toEqual(['heartrate']);
  });
});

describe('sampling', () => {
  const hr = { t: [0, 1, 2], v: [60, 80, 100] };

  it('finds the sample at or before a time', () => {
    expect(indexAt(hr.t, -1)).toBe(-1);
    expect(indexAt(hr.t, 0)).toBe(0);
    expect(indexAt(hr.t, 1.9)).toBe(1);
    expect(indexAt(hr.t, 9)).toBe(2);
  });

  it('interpolates and holds the ends', () => {
    expect(valueAt(hr, 1, 0, 0.5)).toBe(70);
    expect(valueAt(hr, 1, 0, -3)).toBe(60);
    expect(valueAt(hr, 1, 0, 30)).toBe(100);
    expect(valueAt({ t: [], v: [] }, 1, 0, 1)).toBeUndefined();
  });

  it('interpolates orientation along the shorter arc', () => {
    const h = Math.SQRT1_2;
    // Identity, then 90 degrees about Y written with the opposite sign.
    const pose = { t: [0, 1], v: [0, 0, 0, 1, 0, -h, 0, -h] };
    const q = quatAt(pose, 0.5)!;
    expect(q[1]).toBeCloseTo(Math.sin(Math.PI / 8), 5);
    expect(q[3]).toBeCloseTo(Math.cos(Math.PI / 8), 5);
    expect(quatAt(pose, 5)).toEqual([0, -h, 0, -h]);
  });

  it('measures how fast the head turns', () => {
    const h = Math.SQRT1_2;
    const rate = turnRate({ t: [0, 0.5], v: [0, 0, 0, 1, 0, h, 0, h] });
    expect(rate.v[0]).toBeCloseTo(180, 3);
  });

  it('reduces a track to bucket maxima', () => {
    expect([...envelope({ t: [0, 0.4, 1.6], v: [1, 3, 2] }, 2, 2)]).toEqual([3, 2]);
  });
});
