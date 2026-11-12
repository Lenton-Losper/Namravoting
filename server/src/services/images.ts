import crypto from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { HttpError } from '../errors.js';
import { getStorage } from './storage.js';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** SEC-20: a small file can describe a huge image (a 25 megapixel PNG of one colour is a few kilobytes), so the size is read from the header first. */
export const MAX_PIXELS = 12_000_000;
export const MAX_SIDE = 8000;

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const FILE_RE = /^[0-9a-f]{32}\.jpg$/;
const bad = (msg: string) => new HttpError(400, msg, 'bad_image');

/** At most two images are decoded at the same time, so a burst of uploads cannot add up to a lot of memory. */
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

/**
 * Validates magic bytes (JPEG/PNG only), checks the pixel count from the header BEFORE any decoding, re-encodes to JPEG max
 * 800px (drops metadata), returns the stored filename.
 */
export async function savePhoto(buf: Buffer): Promise<string> {
  if (!isJpeg(buf) && !isPng(buf)) throw bad('Only JPEG or PNG images are allowed');
  const out = await slot(async () => {
    let meta: Metadata;
    try { meta = await sharp(buf, { limitInputPixels: false }).metadata(); }   // reads the header only
    catch { throw bad('Image could not be processed'); }
    const { width, height } = meta;
    if (!width || !height) throw bad('Image could not be processed');
    if ((meta.pages ?? 1) > 1) throw bad('Animated images are not allowed');
    if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
      throw bad(`Image is too large (${width}x${height}). The limit is ${MAX_PIXELS / 1_000_000} megapixels and ${MAX_SIDE} pixels on a side.`);
    }
    try {
      return await sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate()
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    } catch { throw bad('Image could not be processed'); }
  });
  const name = crypto.randomBytes(16).toString('hex') + '.jpg';
  await getStorage().put(name, out);
  return name;
}

export async function readPhoto(name: string): Promise<Buffer | null> {
  if (!FILE_RE.test(name)) return null;
  return getStorage().get(name);
}

export async function deletePhoto(name: string | null | undefined): Promise<void> {
  if (!name || !FILE_RE.test(name)) return;
  await getStorage().delete(name);
}
