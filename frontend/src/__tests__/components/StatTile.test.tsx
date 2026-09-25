import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { StatTile } from '../../components/StatTile';

describe('StatTile', () => {
  it('waits with «…» until the number arrives', () => {
    render(<StatTile testId="t" label="Printing" />);
    expect(screen.getByTestId('t')).toHaveTextContent('…');
  });
  it('shows «—» when the request failed with nothing to show', () => {
    render(<StatTile testId="t" label="Printing" failed />);
    expect(screen.getByTestId('t')).toHaveTextContent('—');
  });
  it('shows the number with its suffix and its explanation', () => {
    render(<StatTile testId="t" label="Printing" value={3} suffix={7} sub="prints now" />);
    expect(screen.getByTestId('t')).toHaveTextContent('3 / 7');
    expect(screen.getByText('prints now')).toBeInTheDocument();
  });
  it('draws its children instead of a number', () => {
    render(
      <StatTile testId="t" label="Covered">
        <span>bar</span>
      </StatTile>,
    );
    expect(screen.getByTestId('t')).not.toHaveTextContent('…');
    expect(screen.getByText('bar')).toBeInTheDocument();
  });
});
