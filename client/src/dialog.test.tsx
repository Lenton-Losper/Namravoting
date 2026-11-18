// The shared Dialog (and the ballot's Sheet): a tall dialog keeps its title bar and buttons in view and scrolls only its body; the page behind
// is locked while it is open and restored after; focus stays inside; and it is built to fit a 375px phone.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Dialog, lockBodyScroll } from './ui';

afterEach(() => { cleanup(); document.body.removeAttribute('style'); });
const css = readFileSync(path.resolve(__dirname, 'styles.css'), 'utf8');
const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`).exec(css)?.[0] ?? '';

/** A dialog far taller than any screen: 80 fields. */
function Tall({ onCancel = () => undefined }: { onCancel?: () => void }) {
  return (
    <>
      <button>opener</button>
      <Dialog title="Edit a very long form" confirmLabel="Save it" onConfirm={() => undefined} onCancel={onCancel}>
        {Array.from({ length: 80 }, (_, i) => <label key={i}>Field {i}<input defaultValue={`value ${i}`} /></label>)}
      </Dialog>
    </>
  );
}

describe('the dialog layout (title bar and footer pinned, the body scrolls)', () => {
  it('is three parts: the title in a head, the content in a scrolling body, the buttons in a footer', () => {
    render(<Tall />);
    const dlg = screen.getByRole('dialog');
    expect([...dlg.children].map((c) => c.className)).toEqual(['sheet-head', 'sheet-body', 'row sheet-foot']);
    expect(dlg.querySelector('.sheet-head h2')?.textContent).toBe('Edit a very long form');
    expect(dlg.querySelector('.sheet-body')?.querySelectorAll('input')).toHaveLength(80);
    expect(dlg.querySelector('.sheet-foot')?.querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Save it' })).toBeTruthy();
  });

  it('the stylesheet: at most 90dvh (90vh as the fallback), a flex column, only the body scrolls, with a visible scrollbar; the whole screen on a phone', () => {
    const sheet = rule('.sheet');
    expect(sheet).toMatch(/max-height: 90vh; max-height: 90dvh/);
    expect(sheet).toMatch(/display: flex; flex-direction: column; overflow: hidden/);
    expect(rule('.sheet-head')).toMatch(/flex: none/);
    const body = rule('.sheet-body');
    expect(body).toMatch(/flex: 1 1 auto; min-height: 0; overflow-y: auto/);
    expect(body).toMatch(/overscroll-behavior: contain/);
    expect(body).toMatch(/scrollbar-width: auto/);
    expect(css).toMatch(/\.sheet-body::-webkit-scrollbar, \.ballot-sheet-body::-webkit-scrollbar \{ width: 12px/);
    expect(css).toMatch(/\.sheet \.row\.sheet-foot \{ flex: none;/);
    expect(css).toMatch(/@media \(max-width: 559px\) \{ \.sheet \{ max-height: 100vh; max-height: 100dvh; \} \}/);
    expect(rule('.sheet-wide')).not.toMatch(/overflow|max-height/);
  });

  it('the ballot sheet follows the same pattern', () => {
    expect(rule('.ballot-sheet')).toMatch(/max-height: 90vh; max-height: 90dvh; overflow: hidden; display: flex; flex-direction: column/);
    expect(rule('.ballot-sheet-body')).toMatch(/overflow-y: auto/);
    expect(rule('.ballot-sheet-foot')).toMatch(/flex: none/);
    expect(css).toMatch(/@media \(max-width: 559px\) \{ \.ballot-sheet \{ max-height: 100vh; max-height: 100dvh; \} \}/);
  });

  it('the body is reachable from the keyboard when it overflows (a labelled, focusable scrolling region)', () => {
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 5000 });
    try {
      render(<Tall />);
      const region = screen.getByRole('region', { name: 'Edit a very long form: scrollable content' });
      expect(region.getAttribute('tabindex')).toBe('0');
    } finally { if (orig) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', orig); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight; }
  });
});

describe('background scrolling', () => {
  it('is locked while a dialog is open and restored exactly when it closes', () => {
    document.body.style.overflow = 'scroll';
    const { unmount } = render(<Tall />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('is released only by the LAST of several open dialogs, and each release counts once', () => {
    const a = lockBodyScroll(), b = lockBodyScroll();
    expect(document.body.style.overflow).toBe('hidden');
    a(); a();
    expect(document.body.style.overflow).toBe('hidden');
    b();
    expect(document.body.style.overflow).toBe('');
  });

  it('is restored when the dialog is closed from inside', async () => {
    function Host() { const [open, setOpen] = useState(true); return open ? <Dialog title="T" confirmLabel="OK" onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)}><p>x</p></Dialog> : <p>closed</p>; }
    render(<Host />);
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('closed')).toBeTruthy();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('focus', () => {
  it('moves into the dialog, stays inside on Tab and Shift+Tab, and goes back to the opener on close', async () => {
    const user = userEvent.setup();
    function Host() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>open it</button>{open && <Dialog title="T" confirmLabel="Save" onConfirm={() => undefined} onCancel={() => setOpen(false)}><input aria-label="one" /><input aria-label="two" /></Dialog>}</>; }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'open it' });
    await user.click(opener);
    const dlg = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dlg);
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('one'));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(save);
    for (let i = 0; i < 12; i++) { await user.tab(); expect(dlg.contains(document.activeElement)).toBe(true); }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Tab from outside the dialog is pulled back in', () => {
    render(<Tall />);
    const dlg = screen.getByRole('dialog');
    screen.getByRole('button', { name: 'opener' }).focus();
    fireEvent.keyDown(dlg, { key: 'Tab' });
    expect(dlg.contains(document.activeElement)).toBe(true);
  });

  it('typing in a field does not pull focus back to the box (the handler is kept in a ref)', async () => {
    const user = userEvent.setup();
    render(<Tall onCancel={vi.fn()} />);
    const field = screen.getByLabelText('Field 3') as HTMLInputElement;
    await user.click(field); await user.type(field, 'abc');
    expect(document.activeElement).toBe(field); expect(field.value).toBe('value 3abc');
  });
});
