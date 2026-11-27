import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import './style.css';

import { newId, pack, sensor, unpack, type Layer, type Marker, type Projection, type Recording } from './format/bd';
import { envelope, turnRate, valueAt } from './format/samples';
import { Sound } from './player/sound';
import { Stage } from './player/stage';
import { clock, Timeline } from './player/timeline';
import { recordDemo } from './recorder/demo';
import { CaptureSession, extensionFor, importVideo } from './recorder/recorder';
import { HeartRateSensor } from './recorder/sensors';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const views = { home: $('home'), capture: $('capture'), editor: $('editor') };
function show(view: keyof typeof views): void {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
}

function say(el: HTMLElement, text: string, problem = false): void {
  el.textContent = text;
  el.classList.toggle('problem', problem);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Waveforms need the whole file decoded in memory, so skip them for big files. */
const WAVEFORM_LIMIT = 150 * 1024 * 1024;

// ---------------------------------------------------------------- Home

const homeStatus = $('home-status');
const openFile = $<HTMLInputElement>('open-file');
const importFile = $<HTMLInputElement>('import-file');
const importDialog = $<HTMLDialogElement>('import-dialog');

$('go-open').addEventListener('click', () => openFile.click());
openFile.addEventListener('change', async () => {
  const file = openFile.files?.[0];
  openFile.value = '';
  if (!file) return;
  say(homeStatus, `Opening ${file.name}…`);
  try {
    openEditor(await unpack(file));
    say(homeStatus, '');
  } catch (e) {
    say(homeStatus, message(e), true);
  }
});

$('go-import').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => {
  const file = importFile.files?.[0];
  if (!file) return;
  $('import-name').textContent = file.name;
  importDialog.showModal();
});
async function finishImport(projection: Projection): Promise<void> {
  const file = importFile.files?.[0];
  importDialog.close();
  importFile.value = '';
  if (!file) return;
  try {
    openEditor(await importVideo(file, projection));
    say(homeStatus, '');
  } catch (e) {
    say(homeStatus, message(e), true);
  }
}
$('import-flat').addEventListener('click', () => void finishImport('flat'));
$('import-360').addEventListener('click', () => void finishImport('equirect'));
$('import-cancel').addEventListener('click', () => {
  importDialog.close();
  importFile.value = '';
});

const demoButton = $<HTMLButtonElement>('go-demo');
demoButton.addEventListener('click', async () => {
  demoButton.disabled = true;
  try {
    const rec = await recordDemo((k) => say(homeStatus, `Making the demo recording… ${Math.round(k * 100)}%`));
    say(homeStatus, '');
    openEditor(rec);
  } catch (e) {
    say(homeStatus, `The demo could not be made: ${message(e)}`, true);
  } finally {
    demoButton.disabled = false;
  }
});

// ---------------------------------------------------------------- Capture

const preview = $<HTMLVideoElement>('preview');
const recToggle = $<HTMLButtonElement>('rec-toggle');
const recTime = $('rec-time');
const captureStatus = $('capture-status');
const connectPulse = $<HTMLButtonElement>('connect-pulse');
let session: CaptureSession | null = null;
let captureTimer = 0;

$('go-record').addEventListener('click', async () => {
  show('capture');
  say(captureStatus, '');
  recToggle.disabled = true;
  recToggle.textContent = 'Start recording';
  recTime.textContent = '0:00';
  $('sense-motion').textContent = 'Starts with the recording';
  $('sense-pulse').textContent = HeartRateSensor.supported
    ? 'No sensor connected'
    : 'This browser cannot connect to Bluetooth sensors. Chrome on Android or a computer can.';
  connectPulse.hidden = !HeartRateSensor.supported;

  if (!navigator.mediaDevices?.getUserMedia) {
    say(captureStatus, 'Recording needs a secure connection. Open this page over https, or on localhost.', true);
    return;
  }
  session = new CaptureSession();
  try {
    const stream = await session.openCamera();
    preview.srcObject = stream;
    const video = stream.getVideoTracks()[0]?.getSettings();
    $('sense-sight').textContent = video ? `${video.width} × ${video.height}` : 'No camera found';
    $('sense-sound').textContent = stream.getAudioTracks().length ? 'Microphone on' : 'No microphone found';
    recToggle.disabled = false;
  } catch {
    say(
      captureStatus,
      'The camera or microphone is blocked. Allow both for this site in the browser settings, then come back.',
      true,
    );
  }
  captureTimer = window.setInterval(updateCapture, 250);
});

function updateCapture(): void {
  if (!session) return;
  if (session.recording) {
    recTime.textContent = clock(session.elapsed());
    $('sense-motion').textContent = session.orientation.live
      ? 'Tracking where the camera points'
      : 'This device is not reporting its orientation';
  }
  if (session.heart.bpm != null) {
    $('sense-pulse').textContent = `${session.heart.deviceName}: ${session.heart.bpm} bpm`;
  }
}

connectPulse.addEventListener('click', async () => {
  if (!session) return;
  try {
    await session.heart.open();
    connectPulse.hidden = true;
    $('sense-pulse').textContent = `${session.heart.deviceName}: waiting for the first beat`;
  } catch (e) {
    // Closing the browser's device picker is not a failure worth reporting.
    if ((e as DOMException).name !== 'NotFoundError') {
      $('sense-pulse').textContent = `Could not connect: ${message(e)}`;
    }
  }
});

recToggle.addEventListener('click', async () => {
  if (!session) return;
  if (!session.recording) {
    // Motion permission has to be asked for from a tap, so it happens here.
    await Promise.all([session.orientation.open(), session.motion.open()]);
    session.start();
    views.capture.classList.add('recording');
    recToggle.textContent = 'Stop and review';
    return;
  }
  recToggle.disabled = true;
  const when = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  try {
    const rec = await session.stop(`Recording, ${when}`);
    closeCapture();
    openEditor(rec);
    say($('editor-status'), 'Not saved yet. Save the recording to keep it.');
  } catch (e) {
    say(captureStatus, `The recording could not be finished: ${message(e)}`, true);
    recToggle.disabled = false;
  }
});

function closeCapture(): void {
  clearInterval(captureTimer);
  session?.close();
  session = null;
  preview.srcObject = null;
  views.capture.classList.remove('recording');
}

$('capture-close').addEventListener('click', () => {
  closeCapture();
  show('home');

// Offline use and installing to a home screen. Left off in development so a
// stale copy never hides an edit.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('sw.js').catch(() => {});
}
});

// ---------------------------------------------------------------- Editor

interface Editor {
  rec: Recording;
  stage: Stage;
  sound: Sound;
  timeline: Timeline;
  layer: Layer;
}
let editor: Editor | null = null;

const titleInput = $<HTMLInputElement>('title');
const playButton = $<HTMLButtonElement>('play');
const followButton = $<HTMLButtonElement>('follow');
const pulseButton = $<HTMLButtonElement>('pulse-sound');
const markerList = $('marker-list');
const editorStatus = $('editor-status');
const beatDot = $('beat');
const heatFile = $<HTMLInputElement>('heat-file');

function openEditor(rec: Recording): void {
  closeEditor();
  show('editor');
  say(editorStatus, '');
  titleInput.value = rec.manifest.title;

  const stage = new Stage($('viewport'), rec);
  const sound = new Sound(stage.video);
  const pulse = sensor(rec, 'heartrate');
  const pose = sensor(rec, 'pose');
  const turning = pose && turnRate(pose);
  const duration = rec.manifest.duration;

  const timeline = new Timeline($('timeline'), {
    duration,
    markers: () => rec.manifest.markers,
    pulse,
    motion: turning && envelope(turning, duration, 160),
    onSeek: (t) => stage.seek(t),
    onLayer: setLayer,
  });
  editor = { rec, stage, sound, timeline, layer: 'sight' };
  setLayer('sight');
  updateHeatNote();

  const main = rec.media.get(stage.track.file)!;
  if (stage.track.hasAudio && main.size < WAVEFORM_LIMIT) {
    void sound.waveform(main, 400).then((peaks) => {
      if (peaks && editor?.rec === rec) {
        timeline.setWaveform(peaks, stage.track.offset, duration - stage.track.offset);
      }
    });
  }

  $('r-pulse-row').hidden = !pulse;
  $('r-turn-row').hidden = !turning;
  pulseButton.hidden = !pulse;
  // Following only means something when there is a head track or a flat frame to hold still.
  followButton.hidden = stage.track.projection === 'equirect' && !pose;
  followButton.setAttribute('aria-pressed', String(stage.following));
  $<HTMLSelectElement>('speed').value = '1';

  const texts = new Map<HTMLElement, string>();
  const write = (el: HTMLElement, text: string) => {
    if (texts.get(el) === text) return;
    texts.set(el, text);
    el.textContent = text;
  };

  stage.onFrame = (t) => {
    stage.loudness = sound.loudness();
    const bpm = pulse && valueAt(pulse, 1, 0, t);
    const audible = pulseButton.getAttribute('aria-pressed') === 'true';
    if (sound.heartbeat(t, bpm, audible && stage.playing)) {
      beatDot.classList.remove('on');
      void beatDot.offsetWidth;
      beatDot.classList.add('on');
      if (audible) {
        navigator.vibrate?.(25);
        stage.pulseControllers(0.6);
      }
    }
    write($('r-time'), clock(t, true));
    if (bpm != null) write($('r-pulse'), String(Math.round(bpm)));
    if (turning) write($('r-turn'), String(Math.round(valueAt(turning, 1, 0, t) ?? 0)));
    write(playButton, stage.playing ? 'Pause' : 'Play');
    timeline.draw(t);
  };
  stage.onXrSelect = togglePlay;
  stage.video.addEventListener('error', () => {
    say(editorStatus, 'This browser cannot play the video in this recording.', true);
  });
  renderMarkers();
}

function closeEditor(): void {
  if (!editor) return;
  editor.stage.dispose();
  editor.sound.dispose();
  editor.timeline.dispose();
  editor = null;
}

function setLayer(layer: Layer): void {
  if (!editor) return;
  editor.layer = layer;
  editor.stage.layer = layer;
  editor.timeline.setLayer(layer);
  const tag = $('view-tag');
  tag.textContent = `Braindance · ${layer}`;
  tag.style.setProperty('--c', `var(--${layer})`);
  // A short tear in the picture when the layer changes.
  const viewport = $('viewport');
  viewport.classList.remove('glitch');
  void viewport.offsetWidth;
  viewport.classList.add('glitch');
}

function updateHeatNote(): void {
  if (!editor) return;
  editor.timeline.setHeatNote(editor.stage.hasHeatTrack ? 'Thermal camera' : 'Estimated from brightness');
}

function togglePlay(): void {
  if (!editor) return;
  editor.sound.wake();
  if (editor.stage.playing) editor.stage.pause();
  else void editor.stage.play().catch((e) => say(editorStatus, `Playback did not start: ${message(e)}`, true));
}

function toggleFollow(): void {
  if (!editor || followButton.hidden) return;
  editor.stage.setFollowing(!editor.stage.following);
  followButton.setAttribute('aria-pressed', String(editor.stage.following));
  say(editorStatus, editor.stage.following ? '' : 'Drag the view to look around. Scroll to zoom.');
}

function addMarker(): void {
  if (!editor) return;
  const marker: Marker = {
    id: newId(),
    t: Math.round(editor.stage.time * 100) / 100,
    label: '',
    layer: editor.layer,
    dir: editor.stage.viewDirection(),
  };
  const list = editor.rec.manifest.markers;
  list.push(marker);
  list.sort((a, b) => a.t - b.t);
  renderMarkers();
  markerList.querySelector<HTMLInputElement>(`[data-id="${marker.id}"] input`)?.focus();
}

function renderMarkers(): void {
  if (!editor) return;
  const { rec, stage } = editor;
  $('no-markers').hidden = rec.manifest.markers.length > 0;
  markerList.replaceChildren(
    ...rec.manifest.markers.map((marker) => {
      const li = document.createElement('li');
      li.dataset.id = marker.id;
      li.className = { sight: 't-sight', sound: 't-sound', heat: 't-heat' }[marker.layer];

      const jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = clock(marker.t, true);
      jump.title = 'Go to this moment';
      jump.addEventListener('click', () => {
        stage.seek(marker.t);
        setLayer(marker.layer);
      });

      const label = document.createElement('input');
      label.value = marker.label;
      label.placeholder = 'What happens here?';
      label.setAttribute('aria-label', `Marker at ${clock(marker.t, true)}`);
      label.addEventListener('input', () => (marker.label = label.value));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        rec.manifest.markers = rec.manifest.markers.filter((m) => m !== marker);
        renderMarkers();
      });

      li.append(jump, label, remove);
      return li;
    }),
  );
}

playButton.addEventListener('click', togglePlay);
followButton.addEventListener('click', toggleFollow);
pulseButton.addEventListener('click', () => {
  const on = pulseButton.getAttribute('aria-pressed') !== 'true';
  pulseButton.setAttribute('aria-pressed', String(on));
});
$('add-marker').addEventListener('click', addMarker);
$('speed').addEventListener('change', (e) => {
  if (editor) editor.stage.rate = Number((e.target as HTMLSelectElement).value);
});
titleInput.addEventListener('input', () => {
  if (editor) editor.rec.manifest.title = titleInput.value;
});

$('add-heat').addEventListener('click', () => heatFile.click());
heatFile.addEventListener('change', () => {
  const file = heatFile.files?.[0];
  heatFile.value = '';
  if (!file || !editor) return;
  const { rec, stage } = editor;
  const mime = file.type || 'video/mp4';
  const name = `thermal.${extensionFor(mime)}`;
  const old = rec.manifest.media.find((t) => t.kind === 'thermal');
  if (old) rec.media.delete(old.file);
  rec.manifest.media = rec.manifest.media.filter((t) => t.kind !== 'thermal');
  rec.manifest.media.push({
    id: 'thermal',
    kind: 'thermal',
    file: name,
    mime,
    projection: stage.track.projection,
    fov: stage.track.fov,
    hasAudio: false,
    offset: stage.track.offset,
  });
  rec.media.set(name, file);
  stage.setHeatVideo(file);
  updateHeatNote();
  setLayer('heat');
  say(editorStatus, 'Thermal video added. It is assumed to start at the same moment as the main video.');
});

$('save').addEventListener('click', async () => {
  if (!editor) return;
  const { rec } = editor;
  rec.manifest.title = titleInput.value.trim() || 'Untitled recording';
  say(editorStatus, 'Saving…');
  try {
    const blob = await pack(rec);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${rec.manifest.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'recording'}.bd`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    say(editorStatus, `Saved as ${link.download}`);
  } catch (e) {
    say(editorStatus, `The recording could not be saved: ${message(e)}`, true);
  }
});

$('close').addEventListener('click', () => {
  closeEditor();
  show('home');

// Offline use and installing to a home screen. Left off in development so a
// stale copy never hides an edit.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('sw.js').catch(() => {});
}
});

document.addEventListener('keydown', (e) => {
  if (!editor || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target.matches('input, select, textarea')) return;
  const { stage } = editor;
  const step = e.shiftKey ? 5 : 1;
  switch (e.key) {
    case ' ':
      if (target.matches('button')) return;
      togglePlay();
      break;
    case 'ArrowLeft': stage.seek(stage.time - step); break;
    case 'ArrowRight': stage.seek(stage.time + step); break;
    case ',': stage.seek(stage.time - 1 / 30); break;
    case '.': stage.seek(stage.time + 1 / 30); break;
    case '1': setLayer('sight'); break;
    case '2': setLayer('sound'); break;
    case '3': setLayer('heat'); break;
    case 'm': addMarker(); break;
    case 'f': toggleFollow(); break;
    case 'a': stage.turn(5, 0); break;
    case 'd': stage.turn(-5, 0); break;
    case 'w': stage.turn(0, 5); break;
    case 's': stage.turn(0, -5); break;
    default: return;
  }
  e.preventDefault();
});

show('home');

// Offline use and installing to a home screen. Left off in development so a
// stale copy never hides an edit.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('sw.js').catch(() => {});
}
