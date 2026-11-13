import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAMRA_LOGO_JPEG } from '../../src/services/logo.js';
import { buildPdf } from '../../src/services/resultsExport.js';

const asset = path.resolve(__dirname, '../../../client/src/assets/namra-logo.jpg');

describe('the NamRA logo', () => {
  it('the copy embedded for the PDF is byte for byte the supplied file', () => {
    expect(NAMRA_LOGO_JPEG.equals(fs.readFileSync(asset))).toBe(true);
    expect(NAMRA_LOGO_JPEG.subarray(0, 3).toString('hex')).toBe('ffd8ff');   // a JPEG
  });

  it('the PDF header embeds it as an image', async () => {
    const pdf = await buildPdf({
      title: 'T', description: '', status: 'closed', opensAt: 'a', closesAt: 'b', startedAt: 'c', closedAt: 'd', eligibility: 'All staff', eligibleCount: null,
      turnout: 0, turnoutPct: null, candidates: [], tie: false, tiedNames: [], leader: null, runoff: '', history: [],
      seal: { sealed: false, hash: null, sealedAt: 'n/a', verified: null }, generatedAt: 'g', generatedBy: 'me',
    }, { compress: false });
    const text = pdf.toString('latin1');
    expect(text).toContain('/Subtype /Image');
    expect(text).toContain('/Filter /DCTDecode');                              // the JPEG is embedded as is, not re-encoded
    expect(text).toContain(NAMRA_LOGO_JPEG.toString('latin1').slice(0, 64));   // and it is the same bytes
  });
});
