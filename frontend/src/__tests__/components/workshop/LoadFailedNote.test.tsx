import { describe, it, expect } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { render } from '../../utils';
import { LoadFailedNote } from '../../../components/workshop/LoadFailedNote';

describe('LoadFailedNote', () => {
  it('says the retry is under way until it answers, and asks once', async () => {
    let answer!: () => void;
    let asked = 0;
    render(
      <LoadFailedNote
        message="Could not load"
        onRetry={() => {
          asked += 1;
          return new Promise<void>((r) => { answer = r; });
        }}
      />,
    );
    const note = screen.getByRole('alert');
    const button = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(button);
    expect(note).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveTextContent('Loading...');
    fireEvent.click(button);
    expect(asked).toBe(1);
    await act(async () => answer());
    expect(note).not.toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Retry');
  });

  it('a retry that returns nothing leaves the note as it was', () => {
    render(<LoadFailedNote message="Could not load" onRetry={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('alert')).not.toHaveAttribute('aria-busy', 'true');
  });
});
