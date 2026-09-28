import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../utils';
import { DispatchNoteCreated } from '../../../components/stock/DispatchNoteCreated';

const navigate = vi.fn();
vi.mock('react-router', async (orig) => ({ ...(await orig<typeof import('react-router')>()), useNavigate: () => navigate }));

describe('DispatchNoteCreated', () => {
  it('names the note and opens it', () => {
    const onClose = vi.fn();
    render(<DispatchNoteCreated id={42} code="DN-0042" onClose={onClose} />);
    expect(screen.getByText('Dispatch note DN-0042 is made')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/stock/dispatch-notes/42');
  });

  it('a manual issue is not said to be on an order card (final review M7)', () => {
    render(<DispatchNoteCreated id={42} code="DN-0042" fromOrder={false} onClose={() => {}} />);
    expect(screen.queryByText(/order's card/)).not.toBeInTheDocument();
    expect(screen.getByText(/customer's page/)).toBeInTheDocument();
  });

  it('closes without opening', () => {
    const onClose = vi.fn();
    navigate.mockClear();
    render(<DispatchNoteCreated id={42} code="DN-0042" onClose={onClose} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(onClose).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
