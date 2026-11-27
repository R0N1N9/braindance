// Sensor capture: head orientation, movement, and heart rate.
// Each sensor is opened once (which may ask for permission), then told when a
// recording begins and ends. Times are seconds on the recording's clock.

import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { Samples } from '../format/bd';

export type Clock = () => number;

abstract class Sensor {
  samples: Samples = { t: [], v: [] };
  protected clock: Clock | null = null;
  begin(clock: Clock): void {
    this.samples = { t: [], v: [] };
    this.clock = clock;
  }
  end(): Samples {
    this.clock = null;
    return this.samples;
  }
  protected push(...values: number[]): void {
    if (!this.clock) return;
    this.samples.t.push(round(this.clock()));
    for (const v of values) this.samples.v.push(v);
  }
}

const round = (n: number, places = 4) => {
  const k = 10 ** places;
  return Math.round(n * k) / k;
};

type PermissionEvent = { requestPermission?: () => Promise<'granted' | 'denied'> };

async function allowed(eventClass: unknown): Promise<boolean> {
  // iOS asks before giving a page any motion data; other browsers just send it.
  const ask = (eventClass as PermissionEvent | undefined)?.requestPermission;
  if (!ask) return true;
  try {
    return (await ask()) === 'granted';
  } catch {
    return false;
  }
}

/** Which way the device's back camera is pointing, as a world-space quaternion. */
export class OrientationSensor extends Sensor {
  live = false;
  private euler = new Euler();
  private q = new Quaternion();
  private backCamera = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
  private screen = new Quaternion();
  private zAxis = new Vector3(0, 0, 1);

  async open(): Promise<boolean> {
    if (!('DeviceOrientationEvent' in window)) return false;
    if (!(await allowed(window.DeviceOrientationEvent))) return false;
    window.addEventListener('deviceorientation', this.onEvent);
    return true;
  }

  close(): void {
    window.removeEventListener('deviceorientation', this.onEvent);
    this.live = false;
  }

  private onEvent = (e: DeviceOrientationEvent) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    this.live = true;
    const angle = MathUtils.degToRad(window.screen.orientation?.angle ?? 0);
    this.euler.set(
      MathUtils.degToRad(e.beta),
      MathUtils.degToRad(e.alpha),
      -MathUtils.degToRad(e.gamma),
      'YXZ',
    );
    this.q
      .setFromEuler(this.euler)
      .multiply(this.backCamera)
      .multiply(this.screen.setFromAxisAngle(this.zAxis, -angle));
    this.push(round(this.q.x, 5), round(this.q.y, 5), round(this.q.z, 5), round(this.q.w, 5));
  };
}

/** Acceleration with gravity removed where the device can do that, in m/s². */
export class MotionSensor extends Sensor {
  live = false;

  async open(): Promise<boolean> {
    if (!('DeviceMotionEvent' in window)) return false;
    if (!(await allowed(window.DeviceMotionEvent))) return false;
    window.addEventListener('devicemotion', this.onEvent);
    return true;
  }

  close(): void {
    window.removeEventListener('devicemotion', this.onEvent);
    this.live = false;
  }

  private onEvent = (e: DeviceMotionEvent) => {
    const a = e.acceleration?.x != null ? e.acceleration : null;
    if (!a) return;
    this.live = true;
    this.push(round(a.x ?? 0, 3), round(a.y ?? 0, 3), round(a.z ?? 0, 3));
  };
}

/** Parse a Bluetooth Heart Rate Measurement value into beats per minute. */
export function parseHeartRate(data: DataView): number {
  const sixteenBit = (data.getUint8(0) & 1) === 1;
  return sixteenBit ? data.getUint16(1, true) : data.getUint8(1);
}

/** A Bluetooth heart-rate strap or watch that broadcasts the standard service. */
export class HeartRateSensor extends Sensor {
  bpm: number | null = null;
  deviceName = '';
  onChange: (() => void) | null = null;
  private device: BluetoothDevice | null = null;

  static get supported(): boolean {
    return 'bluetooth' in navigator;
  }

  /** Must be called from a click or tap. Throws if the user cancels or pairing fails. */
  async open(): Promise<void> {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService('heart_rate');
    const characteristic = await service.getCharacteristic('heart_rate_measurement');
    characteristic.addEventListener('characteristicvaluechanged', () => {
      if (!characteristic.value) return;
      this.bpm = parseHeartRate(characteristic.value);
      this.push(this.bpm);
      this.onChange?.();
    });
    device.addEventListener('gattserverdisconnected', () => {
      this.bpm = null;
      this.onChange?.();
    });
    await characteristic.startNotifications();
    this.device = device;
    this.deviceName = device.name ?? 'Heart-rate sensor';
  }

  close(): void {
    this.device?.gatt?.disconnect();
    this.device = null;
    this.bpm = null;
  }
}
