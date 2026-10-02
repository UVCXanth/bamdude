/**
 * The form that adds a part (WS-13 E9 D05). It lives in the «Add part» dialog now: after a
 * part lands it empties and keeps the focus in the name for the next one; a refusal goes
 * to whoever asked for it (`onError` — the dialog's error slot), else to a toast, and
 * what was typed stays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import { AddPartRow } from '../../../components/products/AddPartRow';

describe('AddPartRow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('adds a printed part, then empties and keeps the focus in the name', async () => {
    const create = vi.spyOn(api, 'createProductPart').mockResolvedValue({} as never);
    render(<AddPartRow productId={7} canEdit />);
    fireEvent.change(screen.getByLabelText('Part'), { target: { value: ' Hinge ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(7, {
        kind: 'printed',
        name: 'Hinge',
        qty_per_unit: 1,
        unit_price: null,
        sourcing_url: null,
        remarks: null,
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Part')).toHaveValue(''));
    expect(screen.getByLabelText('Part')).toHaveFocus();
  });

  it('without `onError` a refusal is a toast, and what was typed stays', async () => {
    vi.spyOn(api, 'createProductPart').mockRejectedValue(new ApiError('That name belongs to another part', 409));
    render(<AddPartRow productId={7} canEdit />);
    fireEvent.change(screen.getByLabelText('Part'), { target: { value: 'Lid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('That name belongs to another part')).toBeInTheDocument();
    expect(screen.getByLabelText('Part')).toHaveValue('Lid');
  });

  it('with `onError` the refusal goes there — no toast — and the next attempt clears it', async () => {
    const onError = vi.fn();
    const create = vi
      .spyOn(api, 'createProductPart')
      .mockRejectedValueOnce(new ApiError('That name belongs to another part', 409))
      .mockResolvedValueOnce({} as never);
    render(<AddPartRow productId={7} canEdit onError={onError} />);
    fireEvent.change(screen.getByLabelText('Part'), { target: { value: 'Lid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('That name belongs to another part'));
    expect(screen.queryByText('That name belongs to another part')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Part')).toHaveValue('Lid');
    fireEvent.change(screen.getByLabelText('Part'), { target: { value: 'Lid 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it('a purchased part carries its price, address and remarks', async () => {
    const create = vi.spyOn(api, 'createProductPart').mockResolvedValue({} as never);
    render(<AddPartRow productId={7} canEdit />);
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'purchased' } });
    fireEvent.change(screen.getByLabelText('Part'), { target: { value: 'Magnet' } });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Where to buy'), { target: { value: ' https://shop.example/m ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(7, expect.objectContaining({ kind: 'purchased', unit_price: 0.5, sourcing_url: 'https://shop.example/m' })),
    );
  });

  it('renders nothing for somebody who may not change the product', () => {
    const { container } = render(<AddPartRow productId={7} canEdit={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
