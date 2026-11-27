# Braindance

Record a moment from your own point of view, then replay it and take it apart.

A recording holds video and sound, which way the camera was facing, and your
heart rate. The editor replays it with a timeline that has one lane per sense,
and three ways to look at the picture: sight, sound and heat.

This is the first working slice. It does not write feelings into anyone's
head; see [docs/DESIGN.md](docs/DESIGN.md) for what is real, what is
approximated, the file format and the roadmap.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open the address it prints and choose **Try the demo recording**. No hardware
is needed for that.

To record from a phone, or to open the page in a headset, the page must be
served over https. On the same network:

```bash
npm run dev:phone
```

Open the `https://…` network address on the device and accept the certificate
warning (the certificate is self-signed).

## Install it as an app

A production build (`npm run build`, then serve `dist/` from any static https
host) can be installed from the browser's menu: **Install app** in Chrome or
Edge, **Add to Home Screen** on a phone. Once opened it also works offline.
Recordings stay on the device; nothing is uploaded.

## Look

The interface uses the scanner-HUD skin from the NetWatch console: the same
palette, Rajdhani type and cut-corner panels, with one colour per sense.

## What to use each device for

| Device | Use |
| --- | --- |
| Phone | **Record with this device**: camera, microphone and orientation |
| Bluetooth heart-rate strap or watch | **Connect a heart-rate sensor** on the recording screen (Chrome on Android or desktop; not iOS) |
| 360 camera | Export an equirectangular video, then **Import a video** and choose 360 |
| Thermal camera | Record alongside, then **Add a thermal video** in the editor |
| VR headset | Open a recording in the headset's browser and enter VR. The trigger plays and pauses |

## Editor keys

| Key | Action |
| --- | --- |
| Space | Play or pause |
| ← → | Back or forward 1 s (5 s with Shift) |
| , . | Back or forward one frame |
| 1 2 3 | Sight, sound, heat |
| F | Follow the head, or look around freely |
| W A S D | Turn the view while looking around |
| M | Mark this moment |

## Checks

```bash
npm test
```

```bash
npm run build && npm run e2e
```

The second runs the whole flow in headless Chromium with a fake camera and
writes screenshots to `e2e-out/`. It expects Playwright to be installed
globally.
