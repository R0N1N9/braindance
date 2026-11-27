# Design

## Goal

Record a moment from one person's point of view with as many senses as cheap
hardware allows, then let anyone replay it and take it apart layer by layer.

The fictional version writes sensation and emotion straight into the viewer's
brain. Nothing safe and non-invasive does that, so this project does not try.
What it can do:

| Part of the idea | Status here |
| --- | --- |
| First-person sight and sound | Recorded and replayed |
| Sight, sound and heat layers with a scrub timeline | Built; heat is estimated from brightness until a thermal video is added |
| The recorder's body state: pulse, head movement | Recorded and replayed (pulse as sound and vibration) |
| Leaving the body to look around the scene | Partly: the frame is pinned where it was filmed and you can look away from it. Real free movement needs 3D reconstruction (phase 3) |
| Feeling what the recorder felt | Evoked only, through heartbeat, haptics and sound. Not transferred |

## Parts

```
 phone / 360 camera / sensors          browser or headset
┌───────────────────────────┐        ┌──────────────────────────────┐
│ Recorder                  │  .bd   │ Player and editor            │
│  camera + mic  -> video   │ ─────> │  Stage     3D view, layers   │
│  motion        -> pose    │  file  │  Timeline  lanes, scrubbing  │
│  Bluetooth     -> pulse   │        │  Sound     loudness, pulse   │
└───────────────────────────┘        └──────────────────────────────┘
```

- `src/format/` reads, writes and validates `.bd` files, and samples sensor
  tracks at a time. No browser or 3D dependencies, so it is unit tested.
- `src/recorder/` captures. `sensors.ts` holds one class per sensor;
  `recorder.ts` runs a session and builds a recording; `demo.ts` makes a
  synthetic one through the same encoder.
- `src/player/` replays. `stage.ts` is the three.js view and the playback
  clock, `timeline.ts` draws the lanes, `sound.ts` handles audio.
- `src/main.ts` wires the three screens together.

Everything is a static web page, so one build runs on a phone, a computer and
a headset browser, and nothing is uploaded anywhere.

## The .bd file

A zip, stored without compression, holding `manifest.json` and one file per
track. All times are seconds from the start of the recording.

```jsonc
{
  "format": "braindance",
  "version": 1,
  "id": "k3j9x0a1mf2",
  "title": "Recording, 27 Nov 2026, 14:05",
  "createdAt": "2026-11-27T14:05:11.000Z",
  "duration": 42.318,
  "device": "…",
  "media": [
    {
      "id": "video", "kind": "video",       // or "thermal"
      "file": "video.webm", "mime": "video/webm;codecs=vp9,opus",
      "projection": "flat",                 // or "equirect" for 360 video
      "fov": 65,                            // flat only: degrees along the long edge
      "hasAudio": true,
      "offset": 0.084                       // timeline time of the file's own time 0
    }
  ],
  "sensors": [
    { "id": "pose", "kind": "pose", "file": "pose.json",
      "channels": ["x", "y", "z", "w"], "unit": "quaternion" },
    { "id": "heartrate", "kind": "heartrate", "file": "heartrate.json",
      "channels": ["bpm"], "unit": "bpm" }
  ],
  "markers": [
    { "id": "…", "t": 4.8, "label": "Door opens", "layer": "sound", "dir": [0.56, 0, -0.83] }
  ]
}
```

A sensor file is two columns: `{ "t": [...], "v": [...] }`, with
`channels.length` values in `v` for each time in `t`. Times must not go
backwards.

Conventions:

- **Pose** is the direction the camera faces as a world-space quaternion,
  y up, looking down −z at identity (the three.js convention).
- **Markers** carry the layer they were placed on and the direction the viewer
  was facing, so they can be drawn in the scene as well as on the timeline.
- A reader must refuse a `version` higher than it knows. New sensor kinds can
  be added without a version bump; readers ignore kinds they do not know.

## Decisions worth knowing

- **The video element is the clock.** Sensors are sampled at
  `video.currentTime + offset`, so they cannot drift from the picture.
- **Sync is by wall clock.** Sensors are stamped with the page's clock, and
  the video's start is taken from the encoder's start event. Expect tens of
  milliseconds of error; a clap or flash would be needed to do better.
- **Flat video is pinned in space.** The frame is placed where the pose track
  says the camera pointed. Following the head keeps the frame centred; looking
  around freely shows it moving through the room as the recorder turned.
- **In a headset the frame stays still while following.** Swinging the world
  around a viewer who is not turning makes people sick.
- **Estimated heat is labelled as estimated.** Brightness is not temperature,
  and the timeline says so until a thermal video is attached.

## Known limits

- A recording is held in memory to save or open it. Short clips are fine;
  a long 360 video will run out of memory. Needs a streaming reader and writer.
- Videos made by the browser's recorder have no seek index, so scrubbing lands
  on the nearest keyframe and can lag.
- A thermal video is assumed to start with the main video and cover the same
  view. There is no alignment tool yet.
- A 360 camera's own orientation data is not read, so imported 360 video has
  no head track.
- Tested only in headless desktop Chromium with a fake camera. Real phones,
  Bluetooth sensors, Safari and the headset mode have not been tried.

## Roadmap

1. **Field test.** Host the build on https, then try a phone, a headset, a
   heart-rate strap and a 360 camera, and fix what breaks.
2. **Better capture.** Head-mounted phone or camera; read orientation from 360
   camera files; align thermal video in time and view; skin conductance and
   EEG as extra sensor kinds; streaming save for long recordings.
3. **Out of body.** Reconstruct the scene from the video (Gaussian splatting,
   run offline on a GPU), store it as another track, and let the editor's
   camera move through it.
4. **Feel.** Spatial audio, haptic vest and controller patterns driven by the
   sensor tracks, a warm or cool wearable driven by the heat layer.
5. **Analysis.** Automatic markers at pulse spikes, loud sounds and fast head
   turns; speech transcripts; object detection as its own layer.
