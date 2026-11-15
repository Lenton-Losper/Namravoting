// The receipt code (services/voting.ts newReceiptCode): its format, its randomness, and that NOTHING about a vote can reach it.
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newReceiptCode, RECEIPT_ALPHABET } from '../../src/services/voting.js';

const FORMAT = /^UV-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;   // the CHECK on vote_receipts.receipt_code
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('newReceiptCode', () => {
  it('has the UV-XXXX-XXXX format of the database constraint, with no look-alike characters', () => {
    expect(RECEIPT_ALPHABET).toHaveLength(32);
    expect(new Set(RECEIPT_ALPHABET).size).toBe(32);
    expect(RECEIPT_ALPHABET).not.toMatch(/[01IO]/);
    for (let i = 0; i < 500; i++) expect(newReceiptCode()).toMatch(FORMAT);
  });

  it('can produce every symbol of the alphabet, the last one (Z) included, each equally often', () => {
    const counts = new Map<string, number>();
    // feed every byte value 0..255 exactly once: each symbol must come up exactly 8 times (no bias, none unreachable)
    const bytes = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 0; i < bytes.length; i += 8) {
      vi.spyOn(crypto, 'randomBytes').mockReturnValueOnce(Buffer.from(bytes.slice(i, i + 8)) as never);
      for (const ch of newReceiptCode().replace(/^UV-/, '').replace('-', '')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect([...counts.keys()].sort().join('')).toBe([...RECEIPT_ALPHABET].sort().join(''));
    expect(new Set(counts.values())).toEqual(new Set([8]));
  });

  it('is a function of random bytes and nothing else: no argument, and the same bytes give the same code at any time', () => {
    expect(newReceiptCode.length).toBe(0);                        // it cannot be handed a candidate, a position, a voter or a time
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    vi.useFakeTimers();
    const codes: string[] = [];
    for (const when of ['2026-01-01T00:00:00Z', '2026-06-15T13:37:00Z', '2030-12-31T23:59:59Z']) {
      vi.setSystemTime(new Date(when));
      vi.spyOn(crypto, 'randomBytes').mockReturnValueOnce(Buffer.from(bytes) as never);
      codes.push(newReceiptCode());
    }
    expect(new Set(codes).size).toBe(1);                          // the clock never enters the code
  });

  it('does not repeat in practice', () => {
    const seen = new Set(Array.from({ length: 20000 }, () => newReceiptCode()));
    expect(seen.size).toBe(20000);
  });
});
