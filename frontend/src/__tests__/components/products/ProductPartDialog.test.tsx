/**
 * The part dialog (WS-13 E10 C01–C07, F14): one form for a new part and an edit,
 * written in ONE request — its aliases with it and, on creation, its variant
 * binding (A05). Nothing is written before «Save part»; a refusal stays in the
 * dialog and nothing of it is half-saved.
 *
 * It carries what the inline editors did (Review Focus 1): aliases, «Not
 * counted» only at zero (a count takes the mark off in the same request), the
 * variant binding, the purchased part's price / address / remarks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import type { Product, ProductPart } from '../../../api/client';
import { ProductPartDialog } from '../../../components/products/ProductPartDialog';

function part(over: Partial<ProductPart> & Pick<ProductPart, 'id' | 'name'>): ProductPart {
  return {
    kind: 'printed',
    name_key: `${over.name.toLowerCase()}.stl`,
    qty_per_unit: 1,
    aliases: [`${over.name.toLowerCase()}.stl`],
    auto: false,
    unit_price: null,
    sourcing_url: null,
    remarks: null,
    sort_order: over.id,
    ignored: false,
    stock_balance: 0,
    variant_option_id: null,
    ...over,
  };
}

const body = part({ id: 1, name: 'Body', aliases: ['body.stl', 'body_v2'] });
const cube = part({ id: 3, name: 'Cube', qty_per_unit: 0, ignored: true });
const magnet = part({
  id: 4,
  name: 'Magnet',
  kind: 'purchased',
  name_key: 'purchased:magnet',
  aliases: [],
  qty_per_unit: 4,
  unit_price: 0.5,
  sourcing_url: 'https://shop.example/m',
  remarks: 'N52',
});

const product = {
  id: 7,
  code: 'PR-0007',
  name: 'Flask',
  parts: [body, cube, magnet],
  variant_groups: [
    {
      id: 1,
      name: 'Lid type',
      position: 0,
      default_option_id: 10,
      lines_count: 0,
      stock_count: 0,
      parts_count: 0,
      options: [
        { id: 10, name: 'Glass', position: 0, lines_count: 0, parts_count: 0, stock_count: 0 },
        { id: 11, name: 'Cork', position: 1, lines_count: 0, parts_count: 0, stock_count: 0 },
      ],
    },
  ],
} as unknown as Product;

const noop = () => {};
const save = () => screen.getByRole('button', { name: /^(save part|saving…)$/i });

describe('ProductPartDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getSettings').mockResolvedValue({ currency: 'EUR' } as never);
  });

  describe('the frame (C01)', () => {
    it('a new part: its title, «code · product», «Save part», the cursor in the name', async () => {
      render(<ProductPartDialog product={product} onClose={noop} />);
      const dialog = screen.getByRole('dialog', { name: 'New part' });
      expect(dialog).toHaveAccessibleDescription('PR-0007 · Flask');
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(save()).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
    });

    it('an edit: «Edit part» and the part’s values', () => {
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      expect(screen.getByRole('dialog', { name: 'Edit part' })).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toHaveValue('Body');
      expect(screen.getByLabelText('Per unit')).toHaveValue(1);
    });
  });

  describe('the fields and the kind (C02, C03)', () => {
    it('the kind switches the blocks: a printed part’s aliases and mark, a purchased one’s price, address, remarks', async () => {
      render(<ProductPartDialog product={product} onClose={noop} />);
      expect(screen.getByLabelText('Also known as')).toBeInTheDocument();
      expect(screen.getByLabelText('Not counted')).toBeInTheDocument();
      expect(screen.queryByLabelText(/^Unit price/)).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'purchased' } });
      expect(screen.queryByLabelText('Also known as')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Not counted')).not.toBeInTheDocument();
      expect(await screen.findByLabelText('Unit price, €')).toBeInTheDocument();
      expect(screen.getByLabelText('Where to buy')).toBeInTheDocument();
      expect(screen.getByLabelText('Remarks')).toBeInTheDocument();
    });

    it('an edit shows the kind as text: it does not change after creation', () => {
      render(<ProductPartDialog product={product} part={magnet} onClose={noop} />);
      const kind = screen.getByLabelText('Kind');
      expect(kind).toHaveValue('Purchased');
      expect(kind).toHaveAttribute('readonly');
      expect(kind).toHaveAccessibleDescription('The kind does not change — create a new part');
    });

    it('a purchased name is bounded by its prefixed key, a printed one by its column', () => {
      render(<ProductPartDialog product={product} onClose={noop} />);
      expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', '512');
      fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'purchased' } });
      expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', '502');
    });
  });

  describe('per unit and «Not counted» (C04)', () => {
    it('«Not counted» only at zero, and says why when shut', () => {
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      const mark = screen.getByLabelText('Not counted');
      expect(mark).toBeDisabled();
      expect(mark).toHaveAccessibleDescription('Only for a part with 0 per unit.');
      expect(screen.getByLabelText('Per unit')).toHaveAccessibleDescription('0 — out of the kit');
      fireEvent.change(screen.getByLabelText('Per unit'), { target: { value: '0' } });
      expect(screen.getByLabelText('Not counted')).toBeEnabled();
    });

    it('a count typed on a marked part takes the mark off in the same request', async () => {
      const update = vi.spyOn(api, 'updateProductPart').mockResolvedValue(cube as never);
      render(<ProductPartDialog product={product} part={cube} onClose={noop} />);
      expect(screen.getByLabelText('Not counted')).toBeChecked();
      fireEvent.change(screen.getByLabelText('Per unit'), { target: { value: '2' } });
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, 3, { qty_per_unit: 2, ignored: false }));
    });

    it('a fraction or a negative count is said in the dialog and nothing is sent', async () => {
      const update = vi.spyOn(api, 'updateProductPart');
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      fireEvent.change(screen.getByLabelText('Per unit'), { target: { value: '1.5' } });
      fireEvent.click(save());
      expect(await screen.findByRole('alert')).toHaveTextContent('Per unit is a whole number from 0.');
      expect(update).not.toHaveBeenCalled();
    });

    it('the server refusing the mark is said in the slot, the focus on «Save part»', async () => {
      vi.spyOn(api, 'updateProductPart').mockRejectedValue(new ApiError('This part holds stock', 409));
      render(<ProductPartDialog product={product} part={part({ id: 9, name: 'Spare', qty_per_unit: 0 })} onClose={noop} />);
      fireEvent.click(screen.getByLabelText('Not counted'));
      fireEvent.click(save());
      expect(await screen.findByRole('alert')).toHaveTextContent('This part holds stock');
      await waitFor(() => expect(save()).toHaveFocus());
    });
  });

  describe('the variant (C05)', () => {
    it('«Always» or «Group: Option»; a change goes in the same PATCH', async () => {
      const update = vi.spyOn(api, 'updateProductPart').mockResolvedValue(body as never);
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      const variant = screen.getByLabelText('Variant');
      expect(within(variant).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Always (no variant)',
        'Lid type: Glass',
        'Lid type: Cork',
      ]);
      expect(variant).toHaveAccessibleDescription('The part is taken only when an order chooses this option');
      fireEvent.change(variant, { target: { value: '11' } });
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, 1, { variant_option_id: 11 }));
    });

    it('a busy product is said in the slot, and the same press may be sent again', async () => {
      const update = vi
        .spyOn(api, 'updateProductPart')
        .mockRejectedValueOnce(new ApiError('The product is being changed by another request', 409, 'product_busy'))
        .mockResolvedValueOnce(body as never);
      const onClose = vi.fn();
      render(<ProductPartDialog product={product} part={body} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('Variant'), { target: { value: '10' } });
      fireEvent.click(save());
      expect(await screen.findByRole('alert')).toHaveTextContent('The product is being changed by another request');
      fireEvent.click(save());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(update).toHaveBeenCalledTimes(2);
    });

    it('a bound option the product lost is named so and blocks the save', () => {
      render(<ProductPartDialog product={product} part={{ ...body, variant_option_id: 99 }} onClose={noop} />);
      expect(screen.getByLabelText('Variant')).toHaveValue('99');
      expect(screen.getByRole('option', { name: '#99 (no longer exists)' })).toBeInTheDocument();
      expect(screen.getByLabelText('Variant')).toHaveAccessibleDescription(
        'This option no longer exists — choose another one.',
      );
      expect(save()).toBeDisabled();
    });
  });

  describe('aliases (C06)', () => {
    it('its own key is a chip without «×»; the others can be removed', () => {
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      const tokens = screen.getByTestId('part-alias-tokens');
      expect(within(tokens).getByText('body.stl')).toBeInTheDocument();
      expect(within(tokens).queryByRole('button', { name: 'Remove body.stl' })).not.toBeInTheDocument();
      expect(within(tokens).getByRole('button', { name: 'Remove body_v2' })).toBeInTheDocument();
      expect(screen.getByLabelText('Also known as')).toHaveAccessibleDescription(
        'Object names on a plate by which a file finds this part',
      );
    });

    it('Enter and a comma add a token as the server stores it — and send nothing', () => {
      const update = vi.spyOn(api, 'updateProductPart');
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      const input = screen.getByLabelText('Also known as');
      fireEvent.change(input, { target: { value: '  Body_V3 ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.change(input, { target: { value: 'lid.STL' } });
      fireEvent.keyDown(input, { key: ',' });
      const tokens = screen.getByTestId('part-alias-tokens');
      expect(within(tokens).getByText('body_v3')).toBeInTheDocument();
      expect(within(tokens).getByText('lid.stl')).toBeInTheDocument();
      expect(input).toHaveValue('');
      expect(update).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('a pasted comma list becomes a token per name', () => {
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      const input = screen.getByLabelText('Also known as');
      fireEvent.change(input, { target: { value: 'Lid.STL, cap_v2 ,, lid.stl' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      const items = within(screen.getByTestId('part-alias-tokens')).getAllByRole('listitem').map((li) => li.textContent);
      expect(items.some((t) => t?.includes(','))).toBe(false);
      expect(within(screen.getByTestId('part-alias-tokens')).getByText('lid.stl')).toBeInTheDocument();
      expect(within(screen.getByTestId('part-alias-tokens')).getByText('cap_v2')).toBeInTheDocument();
      expect(input).toHaveValue('');
    });

    it('a blank or a name already in the list is not added, and says so', () => {
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      const input = screen.getByLabelText('Also known as');
      fireEvent.change(input, { target: { value: 'BODY.STL' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByText('This name is already in the list.')).toBeInTheDocument();
      expect(within(screen.getByTestId('part-alias-tokens')).getAllByText('body.stl')).toHaveLength(1);
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(within(screen.getByTestId('part-alias-tokens')).getAllByRole('listitem')).toHaveLength(2);
    });

    it('Escape in the field empties it and leaves the dialog open', () => {
      const onClose = vi.fn();
      render(<ProductPartDialog product={product} part={body} onClose={onClose} />);
      const input = screen.getByLabelText('Also known as');
      fireEvent.change(input, { target: { value: 'half' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(input).toHaveValue('');
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('the list is sent whole with the part: removing one leaves the own key', async () => {
      const update = vi.spyOn(api, 'updateProductPart').mockResolvedValue(body as never);
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      fireEvent.click(screen.getByRole('button', { name: 'Remove body_v2' }));
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, 1, { aliases: [] }));
    });

    it('text left in the field becomes a token at «Save part», not lost', async () => {
      const update = vi.spyOn(api, 'updateProductPart').mockResolvedValue(body as never);
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      fireEvent.change(screen.getByLabelText('Also known as'), { target: { value: 'Body_V3' } });
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, 1, { aliases: ['body_v2', 'body_v3'] }));
    });

    it('a duplicate left in the field blocks the save with its hint', () => {
      const update = vi.spyOn(api, 'updateProductPart');
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      fireEvent.change(screen.getByLabelText('Also known as'), { target: { value: 'body_v2' } });
      fireEvent.click(save());
      expect(screen.getByText('This name is already in the list.')).toBeInTheDocument();
      expect(screen.getByLabelText('Also known as')).toHaveFocus();
      expect(update).not.toHaveBeenCalled();
    });

    it('a key another part owns refuses the whole save, in the slot', async () => {
      vi.spyOn(api, 'updateProductPart').mockRejectedValue(new ApiError("'cube.stl' already belongs to part 'Cube'", 409));
      render(<ProductPartDialog product={product} part={body} onClose={noop} />);
      const input = screen.getByLabelText('Also known as');
      fireEvent.change(input, { target: { value: 'cube.stl' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Body Mk II' } });
      fireEvent.click(save());
      expect(await screen.findByRole('alert')).toHaveTextContent("'cube.stl' already belongs to part 'Cube'");
      // What was typed stays.
      expect(screen.getByLabelText('Name')).toHaveValue('Body Mk II');
      expect(within(screen.getByTestId('part-alias-tokens')).getByText('cube.stl')).toBeInTheDocument();
    });
  });

  describe('one request (C07)', () => {
    it('a new printed part: kind, name, count, mark, aliases and binding in one POST', async () => {
      const create = vi.spyOn(api, 'createProductPart').mockResolvedValue(body as never);
      render(<ProductPartDialog product={product} onClose={noop} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Tail A ' } });
      fireEvent.change(screen.getByLabelText('Variant'), { target: { value: '10' } });
      const input = screen.getByLabelText('Also known as');
      fireEvent.change(input, { target: { value: 'tail_a_v2' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.click(save());
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create).toHaveBeenCalledWith(7, {
        kind: 'printed',
        name: 'Tail A',
        qty_per_unit: 1,
        ignored: false,
        aliases: ['tail_a_v2'],
        variant_option_id: 10,
      });
    });

    it('a new purchased part: its price, address and remarks; a blank price is none', async () => {
      const create = vi.spyOn(api, 'createProductPart').mockResolvedValue(magnet as never);
      render(<ProductPartDialog product={product} onClose={noop} />);
      fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'purchased' } });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nut' } });
      fireEvent.change(screen.getByLabelText('Per unit'), { target: { value: '4' } });
      fireEvent.change(screen.getByLabelText('Where to buy'), { target: { value: 'https://shop.example/n' } });
      fireEvent.change(screen.getByLabelText('Remarks'), { target: { value: 'M3' } });
      fireEvent.click(save());
      await waitFor(() =>
        expect(create).toHaveBeenCalledWith(7, {
          kind: 'purchased',
          name: 'Nut',
          qty_per_unit: 4,
          variant_option_id: null,
          unit_price: null,
          sourcing_url: 'https://shop.example/n',
          remarks: 'M3',
        }),
      );
    });

    it('an edit of a purchased part sends only what moved; a cleared price goes as none', async () => {
      const update = vi.spyOn(api, 'updateProductPart').mockResolvedValue(magnet as never);
      render(<ProductPartDialog product={product} part={magnet} onClose={noop} />);
      fireEvent.change(await screen.findByLabelText('Unit price, €'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('Remarks'), { target: { value: 'N42' } });
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, 4, { unit_price: null, remarks: 'N42' }));
    });

    it('a negative price is said in the dialog', async () => {
      render(<ProductPartDialog product={product} part={magnet} onClose={noop} />);
      fireEvent.change(await screen.findByLabelText('Unit price, €'), { target: { value: '-1' } });
      fireEvent.click(save());
      expect(await screen.findByRole('alert')).toHaveTextContent('The price cannot be negative.');
    });

    it('an empty name is said in the dialog and nothing is sent', async () => {
      const create = vi.spyOn(api, 'createProductPart');
      render(<ProductPartDialog product={product} onClose={noop} />);
      fireEvent.click(save());
      expect(await screen.findByRole('alert')).toHaveTextContent('Enter the part’s name.');
      expect(screen.getByLabelText('Name')).toHaveFocus();
      expect(create).not.toHaveBeenCalled();
      // Typing what was asked for takes the sentence away (final review M5).
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Hinge' } });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('nothing changed: closes without a request; «Cancel» sends nothing', () => {
      const update = vi.spyOn(api, 'updateProductPart');
      const onClose = vi.fn();
      render(<ProductPartDialog product={product} part={body} onClose={onClose} />);
      fireEvent.click(save());
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(2);
      expect(update).not.toHaveBeenCalled();
    });

    it('a success closes, says «Part saved» and makes the product stale', async () => {
      vi.spyOn(api, 'updateProductPart').mockResolvedValue(body as never);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(['product', 7], { seeded: true });
      client.setQueryData(['projects', {}], { seeded: true });
      const onClose = vi.fn();
      render(
        <QueryClientProvider client={client}>
          <ProductPartDialog product={product} part={body} onClose={onClose} />
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Body 2' } });
      fireEvent.click(save());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(client.getQueryState(['product', 7])?.isInvalidated).toBe(true);
      // A part's count, binding or existence moves the kits of saved order lines (K22).
      expect(client.getQueryState(['projects', {}])?.isInvalidated).toBe(true);
      expect(await screen.findByText('Part saved')).toBeInTheDocument();
    });

    it('under a request nothing closes it and nothing sends twice — decided in the same frame', async () => {
      const create = vi.spyOn(api, 'createProductPart').mockReturnValue(new Promise(() => {}) as never);
      const onClose = vi.fn();
      render(<ProductPartDialog product={product} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Hinge' } });
      const submit = save();
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      const x = screen.getByRole('button', { name: 'Close' });
      act(() => {
        submit.click();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        cancel.click();
        x.click();
        submit.click();
      });
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
