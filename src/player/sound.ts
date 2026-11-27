// Audio for the editor: loudness of the recording, a waveform for the
// timeline, and the pulse played back as a heartbeat.

export class Sound {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private buffer: Uint8Array<ArrayBuffer>;
  private beatPhase = 0;
  private lastTime: number | null = null;

  constructor(video: HTMLVideoElement) {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buffer = new Uint8Array(this.analyser.fftSize);
    const source = this.ctx.createMediaElementSource(video);
    source.connect(this.analyser);
    source.connect(this.ctx.destination);
  }

  /** Browsers keep audio suspended until the user interacts with the page. */
  wake(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Current loudness of the recording, 0 to 1. */
  loudness(): number {
    this.analyser.getByteTimeDomainData(this.buffer);
    let sum = 0;
    for (const b of this.buffer) {
      const s = (b - 128) / 128;
      sum += s * s;
    }
    return Math.min(1, Math.sqrt(sum / this.buffer.length) * 3);
  }

  /**
   * Advance the heartbeat to recording time `t` at `bpm`.
   * Returns true on the frames where a beat lands.
   */
  heartbeat(t: number, bpm: number | undefined, audible: boolean): boolean {
    const last = this.lastTime;
    this.lastTime = t;
    if (last == null || bpm == null) return false;
    const dt = t - last;
    // Scrubbing or pausing: do not beat.
    if (dt <= 0 || dt > 0.25) return false;
    this.beatPhase += (dt * bpm) / 60;
    if (this.beatPhase < 1) return false;
    this.beatPhase %= 1;
    if (audible) {
      this.thump(0, 62, 0.5);
      this.thump(0.14, 48, 0.32);
    }
    return true;
  }

  private thump(delay: number, hz: number, level: number): void {
    const at = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.setValueAtTime(hz * 1.6, at);
    osc.frequency.exponentialRampToValueAtTime(hz, at + 0.08);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.16);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(at);
    osc.stop(at + 0.18);
  }

  /** Peak level per bucket across the whole file, or null if it has no readable audio. */
  async waveform(blob: Blob, buckets: number): Promise<Float32Array | null> {
    try {
      const audio = await this.ctx.decodeAudioData(await blob.arrayBuffer());
      const data = audio.getChannelData(0);
      const out = new Float32Array(buckets);
      const per = data.length / buckets;
      for (let b = 0; b < buckets; b++) {
        let peak = 0;
        const end = Math.min(data.length, Math.floor((b + 1) * per));
        for (let i = Math.floor(b * per); i < end; i += 8) peak = Math.max(peak, Math.abs(data[i]));
        out[b] = peak;
      }
      return out;
    } catch {
      return null;
    }
  }

  dispose(): void {
    void this.ctx.close();
  }
}
