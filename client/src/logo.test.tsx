// The top bar and the login card show the official NamRA mark with "| Voting"; the text wordmark is gone.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Wordmark } from './icons';

afterEach(cleanup);

describe('Wordmark', () => {
  it('shows the logo image with the alt text NamRA, at 32px, followed by Voting', () => {
    const { container } = render(<Wordmark />);
    const img = screen.getByRole('img', { name: 'NamRA' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toMatch(/namra-logo.*\.jpg$/);
    expect(img.getAttribute('height')).toBe('32'); expect(img.getAttribute('width')).toBe('32');
    expect(container.textContent).toBe('Voting');                    // the old text "NamRA" is not drawn next to it
    expect(container.querySelector('.wordmark-logo')).not.toBeNull(); // the backing that keeps a non-white logo visible on navy
  });
  it('the login-card variant uses the same file', () => {
    render(<Wordmark dark />);
    expect(screen.getByRole('img', { name: 'NamRA' }).getAttribute('src')).toMatch(/namra-logo.*\.jpg$/);
  });
});
