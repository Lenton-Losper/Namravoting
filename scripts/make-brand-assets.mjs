// Generates the Umoja logo (a real PNG, margins trimmed) and the browser-tab icons from the supplied artwork.
//   node scripts/make-brand-assets.mjs
// Sources (supplied, WebP data despite the .png name): client/src/assets/umonja-logo.png, client/src/assets/Namra-icon.png.
// Outputs: client/src/assets/umoja-logo.png, client/public/icons/*.png, client/public/site.webmanifest.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const root = path.resolve(import.meta.dirname, '..');
const A = (p) => path.join(root, 'client/src/assets', p);
const P = (p) => path.join(root, 'client/public', p);
fs.mkdirSync(P('icons'), { recursive: true });

// 1. Logo: trim the white margin, keep a small even border, write a real PNG.
const logo = await sharp(A('umonja-logo.png')).trim({ background: '#ffffff', threshold: 12 }).extend({ top: 8, bottom: 8, left: 8, right: 8, background: '#ffffff' }).resize({ width: 400 }).png({ palette: true, quality: 90, compressionLevel: 9 }).toBuffer();
fs.writeFileSync(A('umoja-logo.png'), logo);
const m = await sharp(logo).metadata();
console.log(`logo ${m.width}x${m.height}`);

// 2. Icon: white background -> transparent (soft edge), trimmed, centred on a square canvas.
const src = await sharp(A('Namra-icon.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { data, info } = src;
for (let i = 0; i < data.length; i += 4) {
  const d = 255 - Math.min(data[i], data[i + 1], data[i + 2]);       // distance from white
  const a = d >= 40 ? 255 : Math.round((d / 40) * 255);
  if (a < 255 && a > 0) { for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round((data[i + c] - (255 - a)) * 255 / a))); }
  data[i + 3] = a;
}
const keyed = await sharp(data, { raw: info }).png().toBuffer();
const trimmed = await sharp(keyed).trim().toBuffer();
const make = async (size, name, bg) => {
  const pad = Math.round(size * 0.08);
  const inner = await sharp(trimmed).resize({ width: size - 2 * pad, height: size - 2 * pad, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  let img = sharp({ create: { width: size, height: size, channels: 4, background: bg ?? { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: inner, gravity: 'center' }]).png({ compressionLevel: 9 });
  fs.writeFileSync(P('icons/' + name), await img.toBuffer());
};
await make(16, 'favicon-16.png'); await make(32, 'favicon-32.png');
await make(192, 'icon-192.png'); await make(512, 'icon-512.png');
await make(180, 'apple-touch-icon.png', { r: 255, g: 255, b: 255, alpha: 1 });   // iOS paints transparency black, so this one alone is on white
fs.writeFileSync(P('site.webmanifest'), JSON.stringify({
  name: 'Umoja Voting', short_name: 'Umoja Voting', start_url: './', scope: './', display: 'standalone', background_color: '#ffffff', theme_color: '#002d4d',
  icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
}, null, 2) + '\n');
console.log('icons written');
