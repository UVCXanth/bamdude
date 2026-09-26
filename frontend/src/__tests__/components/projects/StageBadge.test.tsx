import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { StageBadge } from '../../../components/projects/StageBadge';
import { ResponsibleName } from '../../../components/projects/ResponsibleName';
import { initialsOf } from '../../../utils/initials';

describe('StageBadge', () => {
  it('names the stage of an active or completed order, and the status of a cancelled one', () => {
    const { rerender } = render(<StageBadge stage="qc" status="active" />);
    expect(screen.getByText('Quality check')).toBeInTheDocument();
    rerender(<StageBadge stage="done" status="completed" />);
    expect(screen.getByText('Done')).toBeInTheDocument();
    rerender(<StageBadge stage={null} status="cancelled" />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });
});

describe('ResponsibleName', () => {
  it('draws initials beside the name, and a dash for nobody', () => {
    expect(initialsOf('olena.koval')).toBe('OK');
    expect(initialsOf('ira')).toBe('IR');
    expect(initialsOf('марко данилюк')).toBe('МД');
    const { rerender } = render(<ResponsibleName name="olena.koval" />);
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('olena.koval')).toBeInTheDocument();
    rerender(<ResponsibleName name={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
