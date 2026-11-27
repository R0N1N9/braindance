import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Cameras, motion sensors and Bluetooth only work on https (or localhost).
// `npm run dev:phone` serves over self-signed https so a phone or headset
// on the same network can open the recorder.
export default defineConfig({
  base: './',
  plugins: process.env.HTTPS ? [basicSsl()] : [],
});
