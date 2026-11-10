import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { getConfig } from '../config.js';
import { HttpError } from '../errors.js';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const FILE_RE = /^[0-9a-f]{32}\.jpg$/;

/** Validates magic bytes (JPEG/PNG only), re-encodes to JPEG max 800px (drops metadata), returns the stored filename. */
export async function savePhoto(buf: Buffer): Promise<string> {
  if (!isJpeg(buf) && !isPng(buf)) throw new HttpError(400, 'Only JPEG or PNG images are allowed', 'bad_image');
  let out: Buffer;
  try {
    out = await sharp(buf, { limitInputPixels: 40_000_000 }).rotate()
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    throw new HttpError(400, 'Image could not be processed', 'bad_image');
  }
  const dir = getConfig().uploadDir;
  await fs.mkdir(dir, { recursive: true });
  const name = crypto.randomBytes(16).toString('hex') + '.jpg';
  await fs.writeFile(path.join(dir, name), out, { flag: 'wx' });
  return name;
}

export async function readPhoto(name: string): Promise<Buffer | null> {
  if (!FILE_RE.test(name)) return null;
  try { return await fs.readFile(path.join(getConfig().uploadDir, name)); } catch { return null; }
}

export async function deletePhoto(name: string | null | undefined): Promise<void> {
  if (!name || !FILE_RE.test(name)) return;
  try { await fs.unlink(path.join(getConfig().uploadDir, name)); } catch { /* already gone */ }
}
