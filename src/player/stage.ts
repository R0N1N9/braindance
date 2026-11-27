// The 3D view of a recording. The video is drawn either on a frame that sits
// where the recorder was looking (flat video) or on a sphere around the viewer
// (360 video), through a shader that renders the chosen layer.

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  VideoTexture,
  WebGLRenderer,
  DoubleSide,
  Euler,
  LinearFilter,
  NoColorSpace,
} from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { sensor, type Layer, type Marker, type MediaTrack, type Recording, type Samples } from '../format/bd';
import { quatAt } from '../format/samples';

const LAYER_INDEX: Record<Layer, number> = { sight: 0, sound: 1, heat: 2 };

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D heatMap;
  uniform bool hasHeat;
  uniform int layer;
  uniform vec2 texel;
  uniform float loudness;
  varying vec2 vUv;

  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  // Dark violet through ember to pale yellow, like a thermal camera's palette.
  vec3 ember(float t) {
    vec3 a = vec3(0.05, 0.02, 0.12);
    vec3 b = vec3(0.48, 0.09, 0.42);
    vec3 c = vec3(0.94, 0.42, 0.18);
    vec3 d = vec3(1.0, 0.95, 0.72);
    if (t < 0.33) return mix(a, b, t / 0.33);
    if (t < 0.66) return mix(b, c, (t - 0.33) / 0.33);
    return mix(c, d, (t - 0.66) / 0.34);
  }

  void main() {
    vec3 c = texture2D(map, vUv).rgb;
    if (layer == 1) {
      // Sound: the picture recedes to outlines that brighten with loudness.
      float gx = luma(texture2D(map, vUv + vec2(texel.x, 0.0)).rgb) - luma(texture2D(map, vUv - vec2(texel.x, 0.0)).rgb);
      float gy = luma(texture2D(map, vUv + vec2(0.0, texel.y)).rgb) - luma(texture2D(map, vUv - vec2(0.0, texel.y)).rgb);
      float edge = clamp(length(vec2(gx, gy)) * 6.0, 0.0, 1.0);
      vec3 teal = vec3(0.31, 0.76, 0.69);
      c = vec3(luma(c)) * 0.22 + teal * edge * (0.45 + loudness * 1.6);
    } else if (layer == 2) {
      c = hasHeat ? texture2D(heatMap, vUv).rgb : ember(smoothstep(0.08, 0.95, luma(c)));
    }
    gl_FragColor = vec4(c, 1.0);
  }
`;

const FRAME_DISTANCE = 10;
const FREE_FOV = 75;

export class Stage {
  readonly video = document.createElement('video');
  readonly heatVideo = document.createElement('video');
  layer: Layer = 'sight';
  /** True: the view turns with the recorder's head. False: look around freely. */
  following = true;
  loudness = 0;
  onFrame: ((t: number) => void) | null = null;
  onXrChange: ((presenting: boolean) => void) | null = null;
  onXrSelect: (() => void) | null = null;

  readonly hasPose: boolean;
  readonly track: MediaTrack;
  hasHeatTrack = false;

  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FREE_FOV, 1, 0.1, 200);
  private pivot = new Group();
  private screen: Mesh;
  private material: ShaderMaterial;
  private grid: LineSegments;
  private rings: Mesh[] = [];
  private pose: Samples | undefined;
  private duration: number;
  private yaw = 0;
  private pitch = 0;
  private freeFov = FREE_FOV;
  private urls: string[] = [];
  private vrButton: HTMLElement | null = null;
  private resizer: ResizeObserver;
  private q = new Quaternion();
  private look = new Quaternion();
  private euler = new Euler();

  constructor(
    private host: HTMLElement,
    private rec: Recording,
  ) {
    this.track = rec.manifest.media.find((t) => t.kind === 'video')!;
    this.pose = sensor(rec, 'pose');
    this.hasPose = !!this.pose;
    this.duration = rec.manifest.duration;
    this.following = this.track.projection === 'flat';

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x120e13);
    this.renderer.xr.enabled = true;
    host.appendChild(this.renderer.domElement);

    this.prepare(this.video, rec.media.get(this.track.file)!);
    const texture = new VideoTexture(this.video);
    texture.colorSpace = NoColorSpace;
    texture.minFilter = LinearFilter;
    const heatTexture = new VideoTexture(this.heatVideo);
    heatTexture.colorSpace = NoColorSpace;
    heatTexture.minFilter = LinearFilter;

    this.material = new ShaderMaterial({
      uniforms: {
        map: { value: texture },
        heatMap: { value: heatTexture },
        hasHeat: { value: false },
        layer: { value: 0 },
        texel: { value: new Vector2(1 / 640, 1 / 360) },
        loudness: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: DoubleSide,
    });

    if (this.track.projection === 'equirect') {
      const sphere = new SphereGeometry(40, 64, 32);
      sphere.scale(-1, 1, 1);
      this.screen = new Mesh(sphere, this.material);
      this.scene.add(this.screen);
    } else {
      this.screen = new Mesh(new PlaneGeometry(1, 1), this.material);
      this.screen.position.z = -FRAME_DISTANCE;
      this.pivot.add(this.screen);
      this.scene.add(this.pivot);
      this.sizeFrame(16, 9);
    }
    this.video.addEventListener('loadedmetadata', () => {
      const { videoWidth: w, videoHeight: h } = this.video;
      if (!w || !h) return;
      this.material.uniforms.texel.value.set(1 / w, 1 / h);
      if (this.track.projection === 'flat') this.sizeFrame(w, h);
    });

    this.grid = makeGrid();
    this.scene.add(this.grid);

    const heat = rec.manifest.media.find((t) => t.kind === 'thermal');
    if (heat) this.setHeatVideo(rec.media.get(heat.file)!);

    this.setupPointer();
    this.setupXr();
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---- playback clock: the main video is the master ----

  get time(): number {
    return Math.min(this.duration, this.video.currentTime + this.track.offset);
  }

  get playing(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  seek(t: number): void {
    const clamped = MathUtils.clamp(t, 0, this.duration);
    this.video.currentTime = Math.max(0, clamped - this.track.offset);
    this.syncHeat(true);
  }

  async play(): Promise<void> {
    if (this.time >= this.duration - 0.05) this.seek(0);
    await this.video.play();
    if (this.hasHeatTrack) void this.heatVideo.play().catch(() => {});
  }

  pause(): void {
    this.video.pause();
    this.heatVideo.pause();
  }

  set rate(r: number) {
    this.video.playbackRate = r;
    this.heatVideo.playbackRate = r;
  }

  setHeatVideo(blob: Blob): void {
    this.prepare(this.heatVideo, blob);
    this.heatVideo.muted = true;
    this.hasHeatTrack = true;
    this.material.uniforms.hasHeat.value = true;
    this.syncHeat(true);
  }

  /** Where the viewer is facing in world space. */
  viewDirection(): [number, number, number] {
    const v = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return [round(v.x), round(v.y), round(v.z)];
  }

  setFollowing(on: boolean): void {
    if (!on && this.following) {
      // Start the free view facing wherever the recording is facing now.
      const v = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.yaw = Math.atan2(-v.x, -v.z);
      this.pitch = Math.asin(MathUtils.clamp(v.y, -1, 1));
    }
    this.following = on;
    this.resize();
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    void this.renderer.xr.getSession()?.end();
    this.resizer.disconnect();
    this.pause();
    for (const v of [this.video, this.heatVideo]) {
      v.removeAttribute('src');
      v.load();
    }
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.vrButton?.remove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---- internals ----

  private prepare(video: HTMLVideoElement, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    this.urls.push(url);
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.src = url;
    // Files straight from MediaRecorder do not know their own length, which
    // stops the browser seeking in them. Jumping far past the end makes it find out.
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (Number.isFinite(video.duration)) return;
        const settle = () => {
          if (!Number.isFinite(video.duration)) return;
          video.removeEventListener('durationchange', settle);
          video.currentTime = 0;
        };
        video.addEventListener('durationchange', settle);
        video.currentTime = 1e7;
      },
      { once: true },
    );
  }

  private syncHeat(force = false): void {
    if (!this.hasHeatTrack) return;
    const want = this.video.currentTime;
    if (force || Math.abs(this.heatVideo.currentTime - want) > 0.15) this.heatVideo.currentTime = want;
  }

  private sizeFrame(w: number, h: number): void {
    const long = 2 * FRAME_DISTANCE * Math.tan(MathUtils.degToRad(this.track.fov ?? 65) / 2);
    const landscape = w >= h;
    this.screen.scale.set(landscape ? long : (long * w) / h, landscape ? (long * h) / w : long, 1);
    this.resize();
  }

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    if (this.following && this.track.projection === 'flat') {
      // Fit the whole frame in the viewport.
      const fitH = 2 * Math.atan(this.screen.scale.y / 2 / FRAME_DISTANCE);
      const fitW = 2 * Math.atan(this.screen.scale.x / 2 / FRAME_DISTANCE / this.camera.aspect);
      this.camera.fov = MathUtils.radToDeg(Math.max(fitH, fitW)) * 1.02;
    } else {
      this.camera.fov = this.freeFov;
    }
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const t = this.time;
    const presenting = this.renderer.xr.isPresenting;
    const q = this.pose && quatAt(this.pose, t);
    const flat = this.track.projection === 'flat';

    if (q) this.q.set(q[0], q[1], q[2], q[3]);
    else this.q.identity();

    // In a headset the frame stays put while following, so the world does not
    // swing around the wearer; looking around freely pins it to where it was filmed.
    if (flat) {
      if (presenting && this.following) this.pivot.quaternion.identity();
      else this.pivot.quaternion.copy(this.q);
    }

    if (!presenting) {
      this.look.setFromEuler(this.euler.set(this.pitch, this.yaw, 0, 'YXZ'));
      if (this.following && flat) this.camera.quaternion.copy(this.q);
      else if (this.following && q) this.camera.quaternion.copy(this.q).multiply(this.look);
      else this.camera.quaternion.copy(this.look);
    }

    this.grid.visible = flat && !this.following;
    this.material.uniforms.layer.value = LAYER_INDEX[this.layer];
    this.material.uniforms.loudness.value = this.loudness;
    this.syncHeat();
    this.placeRings(t);

    if (this.playing && t >= this.duration) this.pause();
    this.onFrame?.(t);
    this.renderer.render(this.scene, this.camera);
  }

  private placeRings(t: number): void {
    const near = this.rec.manifest.markers.filter((m) => m.dir && Math.abs(m.t - t) < 1.5);
    while (this.rings.length < near.length) {
      const ring = new Mesh(
        new RingGeometry(0.42, 0.5, 48),
        new MeshBasicMaterial({ color: 0xe9e2d6, transparent: true, side: DoubleSide, depthTest: false }),
      );
      ring.renderOrder = 2;
      this.rings.push(ring);
      this.scene.add(ring);
    }
    this.rings.forEach((ring, i) => {
      const m: Marker | undefined = near[i];
      ring.visible = !!m;
      if (!m) return;
      ring.position.set(m.dir![0], m.dir![1], m.dir![2]).multiplyScalar(FRAME_DISTANCE - 1);
      ring.lookAt(0, 0, 0);
      (ring.material as MeshBasicMaterial).opacity = 1 - Math.abs(m.t - t) / 1.5;
    });
  }

  private setupPointer(): void {
    const el = this.renderer.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const canLook = () => !this.following || this.track.projection === 'equirect';
    el.addEventListener('pointerdown', (e) => {
      if (!canLook()) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const perPixel = MathUtils.degToRad(this.camera.fov) / (this.host.clientHeight || 1);
      this.yaw += (e.clientX - lastX) * perPixel;
      this.pitch = MathUtils.clamp(this.pitch + (e.clientY - lastY) * perPixel, -1.5, 1.5);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const end = () => (dragging = false);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        if (!canLook()) return;
        e.preventDefault();
        this.freeFov = MathUtils.clamp(this.freeFov + e.deltaY * 0.05, 25, 100);
        this.resize();
      },
      { passive: false },
    );
  }

  /** Nudge the free view from the keyboard, in degrees. */
  turn(yawDeg: number, pitchDeg: number): void {
    if (this.following && this.track.projection === 'flat') return;
    this.yaw += MathUtils.degToRad(yawDeg);
    this.pitch = MathUtils.clamp(this.pitch + MathUtils.degToRad(pitchDeg), -1.5, 1.5);
  }

  private setupXr(): void {
    const xr = (navigator as Navigator & { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
    if (!xr) return;
    void xr
      .isSessionSupported('immersive-vr')
      .then((ok) => {
        if (!ok) return;
        this.vrButton = VRButton.createButton(this.renderer);
        this.vrButton.removeAttribute('style');
        this.vrButton.className = 'vr-button';
        this.host.appendChild(this.vrButton);
      })
      .catch(() => {});
    this.renderer.xr.addEventListener('sessionstart', () => this.onXrChange?.(true));
    this.renderer.xr.addEventListener('sessionend', () => {
      this.onXrChange?.(false);
      this.resize();
    });
    for (const i of [0, 1]) {
      this.renderer.xr.getController(i).addEventListener('selectstart', () => this.onXrSelect?.());
    }
  }

  /** A short buzz on any held controllers, for the pulse. */
  pulseControllers(strength: number): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    for (const source of session.inputSources) {
      const actuator = (source.gamepad as (Gamepad & { hapticActuators?: { pulse(v: number, ms: number): void }[] }) | undefined)
        ?.hapticActuators?.[0];
      actuator?.pulse(strength, 60);
    }
  }
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Faint lines of latitude and longitude, so a free view has a horizon. */
function makeGrid(): LineSegments {
  const r = 30;
  const points: number[] = [];
  const at = (lat: number, lon: number) => {
    const a = MathUtils.degToRad(lat);
    const o = MathUtils.degToRad(lon);
    points.push(r * Math.cos(a) * Math.sin(o), r * Math.sin(a), -r * Math.cos(a) * Math.cos(o));
  };
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = 0; lon < 360; lon += 5) {
      at(lat, lon);
      at(lat, lon + 5);
    }
  }
  for (let lon = 0; lon < 360; lon += 30) {
    for (let lat = -60; lat < 60; lat += 5) {
      at(lat, lon);
      at(lat + 5, lon);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  return new LineSegments(geometry, new LineBasicMaterial({ color: 0xe9e2d6, transparent: true, opacity: 0.1 }));
}
