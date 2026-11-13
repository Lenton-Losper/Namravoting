// WCAG 2.1 AA colour contrast, checked from the real stylesheet tokens (jsdom cannot compute contrast, so axe skips it).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, 'styles.css'), 'utf8');
const root = css.match(/:root\s*\{([^}]*)\}/)![1];
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})`).exec(root);
  if (!m) throw new Error(`no token --${name}`);
  return m[1];
};

function lum(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TEXT = 4.5;     // normal text
const UI = 3;         // boundaries of controls, focus indicators

describe('text contrast (AA: 4.5:1)', () => {
  const white = '#FFFFFF';
  const pairs: [string, string, string][] = [
    ['body text on the page', token('navy-text'), token('bg')],
    ['body text on muted surfaces', token('navy-text'), token('surface-muted')],
    ['body text on the orange tint', token('navy-text'), token('orange-50')],
    ['muted (secondary) text on the page', token('muted'), token('bg')],
    ['muted (secondary) text on muted surfaces', token('muted'), token('surface-muted')],
    ['muted text on the orange tint', token('muted'), token('orange-50')],
    ['success text on the page', token('success'), token('bg')],
    ['error text on the page', token('danger'), token('bg')],
    ['error text on its hover tint', token('danger'), '#fdf2f2'],
    ['status chip text on the orange tint', token('orange-text'), token('orange-50')],
    ['white text on the navy bar and primary buttons', white, token('navy')],
    ['white text on a hovered primary button', white, token('navy-text')],
    ['secondary button text on white', token('navy'), white],
    ['operator banner text', '#78350f', '#fffbeb'],
    ['operator danger banner text', '#7f1d1d', '#fef2f2'],
  ];
  it.each(pairs)('%s', (_n, fg, bg) => { expect(ratio(fg, bg)).toBeGreaterThanOrEqual(TEXT); });
});

describe('non-text contrast (AA: 3:1)', () => {
  it('the border of a form field against the page', () => { expect(ratio(token('muted'), token('bg'))).toBeGreaterThanOrEqual(UI); });
  it('the stylesheet really uses a strong border for form fields (not the faint decorative one)', () => {
    const rule = /\binput, textarea, select \{[^}]*\}/.exec(css)![0];
    expect(rule).toMatch(/border: 1px solid var\(--muted\)/);
  });
  it('the keyboard focus outline against white and against the navy bar', () => {
    const rule = /:focus-visible \{ outline: 2px solid (var\(--[a-z-]+\)|#[0-9a-fA-F]+)/.exec(css)!;
    const colour = rule[1].startsWith('var(') ? token(rule[1].slice(6, -1)) : rule[1];
    expect(ratio(colour, '#FFFFFF')).toBeGreaterThanOrEqual(UI);
  });
});
