// Umoja branding: the page title, the tab icons (real PNGs, transparent, the right sizes) and the manifest, all addressed through the base path.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const png = (rel: string) => readFileSync(path.join(root, rel));
const size = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20), colourType: b[25] });

describe('page title and icons', () => {
  it('the title is "Umoja Voting"', () => { expect(html).toMatch(/<title>Umoja Voting<\/title>/); });
  it('every icon link goes through %BASE_URL%, so it works at "/" and under /voting-app/', () => {
    const hrefs = [...html.matchAll(/<link [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(4);
    for (const h of hrefs) expect(h.startsWith('%BASE_URL%'), h).toBe(true);
  });
  it.each([['favicon-16.png', 16], ['favicon-32.png', 32], ['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]] as const)('%s is a %ipx PNG', (f, n) => {
    const b = png(`public/icons/${f}`);
    expect(b.subarray(1, 4).toString()).toBe('PNG');
    expect(size(b)).toMatchObject({ w: n, h: n });
  });
  it('the tab and manifest icons keep an alpha channel with transparent corners (the iOS touch icon is the one opaque exception)', async () => {
    for (const f of ['favicon-32.png', 'icon-192.png', 'icon-512.png']) expect(size(png(`public/icons/${f}`)).colourType, f).toBe(6);   // RGBA
    const sharp = createRequire(path.join(root, '../server/package.json'))('sharp');   // the server's image library decodes the pixels
    for (const f of ['icon-192.png', 'icon-512.png']) {
      const { data, info } = await sharp(png(`public/icons/${f}`)).raw().toBuffer({ resolveWithObject: true });
      expect(data[3], `${f} top-left pixel alpha`).toBe(0);
      expect(data[(info.width * info.height - 1) * 4 + 3], `${f} bottom-right pixel alpha`).toBe(0);
    }
  });
  it('the manifest names the app and uses relative paths', () => {
    const m = JSON.parse(readFileSync(path.join(root, 'public/site.webmanifest'), 'utf8'));
    expect(m).toMatchObject({ name: 'Umoja Voting', start_url: './', scope: './', theme_color: '#002d4d' });
    for (const i of m.icons) expect(i.src.startsWith('/')).toBe(false);
  });
});
