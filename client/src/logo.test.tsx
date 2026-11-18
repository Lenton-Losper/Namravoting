// The top bar and the login card show the Umoja Social Club logo followed by "Voting".
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Wordmark } from './icons';

afterEach(cleanup);

describe('Wordmark', () => {
  it('shows the Umoja logo with its alt text, 34px high with its own proportions, followed by Voting', () => {
    const { container } = render(<Wordmark />);
    const img = screen.getByRole('img', { name: 'Umoja Social Club' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toMatch(/umoja-logo.*\.png$/);
    expect(img.getAttribute('height')).toBe('34'); expect(img.getAttribute('width')).toBe('91');   // 416 x 155 scaled to 34 high
    expect(container.textContent).toBe('Voting');
    expect(container.querySelector('.wordmark-logo')).not.toBeNull(); // the backing that keeps a non-white logo visible on navy
  });
  it('the login-card variant uses the same file', () => {
    render(<Wordmark dark />);
    expect(screen.getByRole('img', { name: 'Umoja Social Club' }).getAttribute('src')).toMatch(/umoja-logo.*\.png$/);
  });
});
