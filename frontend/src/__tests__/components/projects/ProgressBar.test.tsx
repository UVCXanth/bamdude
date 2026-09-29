/**
 * The bar must vanish for a denominator of 0 — not leave a bare "0" behind.
 *
 * `0 && <jsx>` evaluates to 0 and React renders the NUMBER, so every guard on a
 * count that can legitimately be zero paints a stray zero where the block used
 * to be (#ProjectDetailPageProgress). The gate here is `max <= 0`, and the
 * detector below walks TEXT nodes because *ByText queries walk elements and
 * cannot see a bare "0" sitting among an element's other children.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';

import { render } from '../../utils';
import { strayZeroTextNodes } from '../../domHelpers';
import { ProgressBar } from '../../../components/projects/ProgressBar';

describe('ProgressBar', () => {
  it('renders nothing at all when the denominator is zero', () => {
    render(
      <div data-testid="host">
        <ProgressBar value={0} max={0} />
      </div>
    );
    expect(screen.getByTestId('host').children).toHaveLength(0);
    expect(strayZeroTextNodes()).toHaveLength(0);
  });

  it('captions a percentage of the server fraction on request, rounded down (WS-13 E3 E03)', () => {
    render(<ProgressBar value={9} max={10} progress={0.9999} caption="percent" label="Covered" testId="bar" />);
    // 99.99 % is not done: rounding up would call an unfinished order complete.
    expect(screen.getByText('99%')).toBeInTheDocument();
    expect(screen.queryByText('9 / 10')).toBeNull();
    expect(screen.getByText('Covered')).toBeInTheDocument();
  });

  it('does not lose a percent to floating point (0.29 × 100 = 28.999…)', () => {
    render(<ProgressBar value={29} max={100} progress={0.29} caption="percent" testId="bar" />);
    expect(screen.getByText('29%')).toBeInTheDocument();
  });

  it('never reads 100% while something is still left, whatever the rounded fraction says', () => {
    render(<ProgressBar value={19999} max={20000} progress={1} caption="percent" testId="bar" />);
    expect(screen.getByText('99%')).toBeInTheDocument();
  });

  it('shows 100% only once the server fraction reaches one', () => {
    render(<ProgressBar value={10} max={10} progress={1} caption="percent" testId="bar" />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('falls back to value / max for the percentage when there is no server fraction', () => {
    render(<ProgressBar value={2} max={3} caption="percent" testId="bar" />);
    expect(screen.getByText('66%')).toBeInTheDocument();
  });

  it('caps the fill at 100% and prints value / max', () => {
    render(<ProgressBar value={7} max={5} testId="bar" />);
    expect(screen.getByTestId('bar-fill').style.width).toBe('100%');
    expect(screen.getByText('7 / 5')).toBeInTheDocument();
  });
});
