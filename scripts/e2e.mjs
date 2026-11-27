// End-to-end check in headless Chromium with a fake camera:
// demo -> play -> layers -> marker -> save -> reopen -> record.
// Run `npm run build` first. Screenshots land in e2e-out/.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { unzipSync, strFromU8 } from 'fflate';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire('/usr/lib/node_modules/')('playwright'));
}

const OUT = 'e2e-out';
const PORT = 4173;
mkdirSync(OUT, { recursive: true });

// Run vite directly (not through npx) so that killing it frees the port.
const server = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'pipe',
});
await new Promise((ok, fail) => {
  server.stdout.on('data', (d) => String(d).includes('Local') && ok());
  server.on('exit', () => fail(new Error(`The preview server did not start. Is port ${PORT} in use, or is dist/ missing?`)));
});

const failures = [];
const check = (name, pass, detail = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures.push(name);
};

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, acceptDownloads: true });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const time = async () => {
  const [m, s] = (await page.textContent('#r-time')).split(':');
  return Number(m) * 60 + Number(s);
};
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

try {
  await page.goto(`http://localhost:${PORT}/`);
  await shot('1-home');

  await page.click('#go-demo');
  await page.waitForSelector('#editor:not([hidden])', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  check('demo opens in the editor', (await page.inputValue('#title')) === 'Demo: the door');
  check('pulse and head lanes are present', (await page.locator('.lane-label').count()) === 5);
  await shot('2-editor-sight');

  await page.click('#play');
  await page.waitForTimeout(5200);
  const played = await time();
  check('playback advances', played > 3.5, `t=${played}`);
  check('pulse reads the recorded rate', Number(await page.textContent('#r-pulse')) > 90, await page.textContent('#r-pulse'));
  await shot('3-playing-after-door');
  await page.click('#play');

  await page.locator('.strata-canvas').click({ position: { x: 20, y: 40 } });
  await page.waitForTimeout(600);
  const early = await time();
  check('scrubbing seeks backwards', early < 1, `t=${early}`);
  const box = await page.locator('.strata-canvas').boundingBox();
  await page.locator('.strata-canvas').click({ position: { x: box.width * 0.7, y: 40 } });
  await page.waitForTimeout(600);
  const late = await time();
  check('scrubbing seeks forwards', late > 4.5 && late < 6.5, `t=${late}`);

  await page.keyboard.press('2');
  await page.waitForTimeout(300);
  check('sound layer selected', (await page.getAttribute('.lane-sound', 'aria-pressed')) === 'true');
  await shot('4-layer-sound');
  await page.keyboard.press('3');
  await page.waitForTimeout(300);
  await shot('5-layer-heat');

  await page.keyboard.press('1');
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const view = await page.locator('#viewport').boundingBox();
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  await page.mouse.down();
  await page.mouse.move(view.x + view.width / 2 + 180, view.y + view.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await shot('6-look-around');

  await page.keyboard.press('m');
  await page.keyboard.type('Someone in the doorway');
  check('marker added', (await page.locator('#marker-list li').count()) === 2);

  await page.fill('#title', 'Door test');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
  const saved = `${OUT}/${download.suggestedFilename()}`;
  await download.saveAs(saved);
  const files = unzipSync(new Uint8Array(readFileSync(saved)));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  check('saved file is named after the title', download.suggestedFilename() === 'Door-test.bd');
  check('saved manifest keeps both markers', manifest.markers.length === 2 && manifest.markers.some((m) => m.label === 'Someone in the doorway'));
  check('saved file holds video and sensors', !!files['video.webm']?.length && !!files['pose.json'] && !!files['heartrate.json'],
    Object.keys(files).join(' '));

  await page.click('#close');
  await page.setInputFiles('#open-file', saved);
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(1000);
  check('saved file reopens', (await page.inputValue('#title')) === 'Door test' && (await page.locator('#marker-list li').count()) === 2);
  await page.click('#close');

  await page.setInputFiles('#open-file', { name: 'junk.bd', mimeType: 'application/zip', buffer: Buffer.from('not a recording') });
  await page.waitForTimeout(300);
  check('a bad file is refused with a reason', (await page.textContent('#home-status')).includes('not a braindance recording'));

  await page.click('#go-record');
  await page.waitForSelector('#rec-toggle:not([disabled])', { timeout: 10_000 });
  await shot('7-capture');
  await page.click('#rec-toggle');
  await page.waitForTimeout(3200);
  await page.click('#rec-toggle');
  await page.waitForSelector('#editor:not([hidden])', { timeout: 10_000 });
  await page.waitForTimeout(1200);
  await page.click('#play');
  await page.waitForTimeout(1500);
  const recorded = await time();
  check('a camera recording plays back', recorded > 0.8, `t=${recorded}`);
  await shot('8-recorded');
  await page.click('#close');

  await page.setViewportSize({ width: 390, height: 800 });
  await shot('9-home-phone');
  check('no console errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failures.push(String(e));
  console.log('FAIL', e);
  await shot('failure');
} finally {
  await browser.close();
  server.kill();
}
process.exit(failures.length ? 1 : 0);
