/**
 * The product form (WS-13 E10 B01–B08, F13): the Workshop dialog frame, the
 * mockup's field order, «More» for the two fields the mockup does not draw,
 * readiness on both create and edit, every refusal in the dialog's own slot,
 * no closing under a request and the new product opened at once.
 *
 * The draft session (J): the base is the first full product, a background
 * refresh never reseeds what was typed, the PATCH is the difference from that
 * base, and a chosen category that disappeared is not quietly swapped.
 */

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent, waitFor, within, render as renderBare } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Product, ProductListItem } from '../../../api/client';
import { ProductCardDialog } from '../../../components/products/ProductCardDialog';
import { ToastProvider } from '../../../contexts/ToastContext';

const product = {
  id: 7,
  code: 'PR-0007',
  name: 'Flask',
  is_active: true,
  sku: 'FLK-1',
  version: null,
  category: { id: 3, name: 'Hooks' },
  status: 'draft',
  has_cover: false,
  cover_image_filename: null,
  parts_count: 2,
  plates_count: 1,
  lines_count: 0,
  description: 'A flask',
  notes: null,
  designer: 'Ada',
  license: null,
  source_url: null,
  design_id: null,
  attachments: [],
  parts: [],
  library_file_ids: [],
  library_folder_ids: [],
  units_printed_total: 0,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
} as unknown as Product;

const noop = () => {};

function primary(name: RegExp = /^(save|create) product$/i) {
  return screen.getByRole('button', { name });
}

/** The dialog the way a page opens it, so "the focus comes back" can be observed. */
function Openable({ onClose = noop }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open card
      </button>
      {open && (
        <ProductCardDialog
          product={product}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

describe('ProductCardDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([
      { id: 3, name: 'Hooks', products_count: 1 },
      { id: 4, name: 'Vases', products_count: 0 },
    ]);
  });

  describe('the frame (B01)', () => {
    it('a new product: its title, the mockup sentence, «Create product», the cursor in the name', async () => {
      render(<ProductCardDialog product={null} onClose={noop} />);
      const dialog = screen.getByRole('dialog', { name: 'New product' });
      expect(dialog).toHaveAccessibleDescription('Parts appear once you link a sliced file, or add them by hand');
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(primary(/^create product$/i)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
    });

    it('an edit: its title, «code · SKU» under it, «Save product»', () => {
      render(<ProductCardDialog product={product} onClose={noop} />);
      const dialog = screen.getByRole('dialog', { name: 'Edit product' });
      expect(dialog).toHaveAccessibleDescription('PR-0007 · FLK-1');
      expect(primary(/^save product$/i)).toBeInTheDocument();
    });

    it('a product without a SKU shows its code alone', () => {
      render(<ProductCardDialog product={{ ...product, sku: null } as Product} onClose={noop} />);
      expect(screen.getByRole('dialog')).toHaveAccessibleDescription('PR-0007');
    });

    it('is named by its heading and hands the focus back on Escape', async () => {
      render(<Openable />);
      const opener = screen.getByRole('button', { name: 'open card' });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });
  });

  describe('the fields (B02, B03)', () => {
    it('come in the mockup order, «More» last, each bounded by its column', () => {
      render(<ProductCardDialog product={product} onClose={noop} />);
      const dialog = screen.getByRole('dialog');
      const labels = Array.from(dialog.querySelectorAll('label')).map((l) => l.textContent);
      expect(labels.slice(0, 9)).toEqual([
        'Name',
        'SKU',
        'Version',
        'Category',
        'Readiness',
        'Description',
        'Designer',
        'Licence',
        'Source',
      ]);
      expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', '255');
      expect(screen.getByLabelText('SKU')).toHaveAttribute('maxLength', '64');
      expect(screen.getByLabelText('Version')).toHaveAttribute('maxLength', '64');
      expect(screen.getByLabelText('Designer')).toHaveAttribute('maxLength', '255');
      expect(screen.getByLabelText('Licence')).toHaveAttribute('maxLength', '255');
      expect(screen.getByLabelText('Source')).toHaveAttribute('maxLength', '2048');
      expect(screen.getByLabelText('Design ID')).toHaveAttribute('maxLength', '64');
    });

    it('«More» starts folded when both of its fields are empty, and unfolds on a press', () => {
      render(<ProductCardDialog product={product} onClose={noop} />);
      const more = screen.getByRole('button', { name: 'More' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      const region = document.getElementById(more.getAttribute('aria-controls') as string);
      expect(region).not.toBeVisible();
      fireEvent.click(more);
      expect(more).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByLabelText('Design ID')).toBeVisible();
      expect(screen.getByLabelText('Notes')).toBeVisible();
    });

    it('«More» starts open when a design ID or a note is there', () => {
      render(<ProductCardDialog product={{ ...product, notes: 'Print upright' } as Product} onClose={noop} />);
      expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByLabelText('Notes')).toHaveValue('Print upright');
    });

    it('folding «More» loses nothing, and what it holds is sent', async () => {
      const update = vi.spyOn(api, 'updateProduct').mockResolvedValue(product as never);
      render(<ProductCardDialog product={product} onClose={noop} />);
      const more = screen.getByRole('button', { name: 'More' });
      fireEvent.click(more);
      fireEvent.change(screen.getByLabelText('Design ID'), { target: { value: 'MW-42' } });
      fireEvent.click(more);
      fireEvent.click(more);
      expect(screen.getByLabelText('Design ID')).toHaveValue('MW-42');
      fireEvent.click(more);
      fireEvent.click(primary());
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, { design_id: 'MW-42' }));
    });
  });

  describe('readiness (B04)', () => {
    it('an edit offers «Ready to print» with parts and a plate', async () => {
      render(<ProductCardDialog product={product} onClose={noop} />);
      expect(await screen.findByRole('option', { name: 'Ready to print' })).toBeEnabled();
    });

    it('an edit without a plate keeps it shut and says why', () => {
      render(<ProductCardDialog product={{ ...product, plates_count: 0 } as Product} onClose={noop} />);
      expect(screen.getByRole('option', { name: 'Ready to print' })).toBeDisabled();
      expect(screen.getByLabelText('Readiness')).toHaveAccessibleDescription('Needs parts and a plate');
    });

    it('a new product shows the field with «Ready to print» shut, and never sends a status', async () => {
      const create = vi.spyOn(api, 'createProduct').mockResolvedValue(product as never);
      render(<ProductCardDialog product={null} onClose={noop} />);
      expect(screen.getByLabelText('Readiness')).toHaveValue('draft');
      expect(screen.getByRole('option', { name: 'Ready to print' })).toBeDisabled();
      expect(screen.getByLabelText('Readiness')).toHaveAccessibleDescription('Needs parts and a plate');
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lid' } });
      fireEvent.click(primary());
      await waitFor(() => expect(create).toHaveBeenCalled());
      expect(create.mock.calls[0][0]).not.toHaveProperty('status');
    });

    it('the server refusing «ready» is said in the dialog, the focus on «Save product»', async () => {
      vi.spyOn(api, 'updateProduct').mockRejectedValue(new Error('A product needs parts and a plate to be ready to print'));
      render(<ProductCardDialog product={product} onClose={noop} />);
      fireEvent.change(screen.getByLabelText('Readiness'), { target: { value: 'ready' } });
      fireEvent.click(primary());
      expect(await screen.findByRole('alert')).toHaveTextContent('A product needs parts and a plate to be ready to print');
      await waitFor(() => expect(primary()).toHaveFocus());
    });
  });

  describe('checks and what is sent (B05)', () => {
    it('an empty name is said in the dialog and nothing is sent', async () => {
      const create = vi.spyOn(api, 'createProduct');
      render(<ProductCardDialog product={null} onClose={noop} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
      fireEvent.click(primary());
      expect(await screen.findByRole('alert')).toHaveTextContent('Enter a name.');
      expect(screen.getByLabelText('Name')).toHaveFocus();
      expect(create).not.toHaveBeenCalled();
    });

    it('a SKU another product holds is the server sentence in the slot, never a toast', async () => {
      vi.spyOn(api, 'updateProduct').mockRejectedValue(new Error('Another product already has this SKU'));
      render(<ProductCardDialog product={product} onClose={noop} />);
      fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'LMP-1' } });
      fireEvent.click(primary());
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Another product already has this SKU');
      expect(screen.getAllByText('Another product already has this SKU')).toHaveLength(1);
      // What was typed stays where it was.
      expect(screen.getByLabelText('SKU')).toHaveValue('LMP-1');
    });

    it('an edit sends only what changed, a blank field as none', async () => {
      const update = vi.spyOn(api, 'updateProduct').mockResolvedValue(product as never);
      render(<ProductCardDialog product={product} onClose={noop} />);
      await screen.findByRole('option', { name: 'Vases' });
      fireEvent.change(screen.getByLabelText('SKU'), { target: { value: '  ' } });
      fireEvent.change(screen.getByLabelText('Category'), { target: { value: '4' } });
      fireEvent.change(screen.getByLabelText('Licence'), { target: { value: 'CC-BY' } });
      fireEvent.click(primary());
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, { sku: null, category_id: 4, license: 'CC-BY' }));
    });

    it('a create sends every field, the catalog ones only when given', async () => {
      const create = vi.spyOn(api, 'createProduct').mockResolvedValue(product as never);
      render(<ProductCardDialog product={null} onClose={noop} />);
      await screen.findByRole('option', { name: 'Hooks' });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lid' } });
      fireEvent.change(screen.getByLabelText('Designer'), { target: { value: 'Ada' } });
      fireEvent.change(screen.getByLabelText('Category'), { target: { value: '3' } });
      fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'makerworld.com/x' } });
      fireEvent.click(primary());
      await waitFor(() =>
        expect(create).toHaveBeenCalledWith({
          name: 'Lid',
          description: null,
          designer: 'Ada',
          license: null,
          source_url: 'makerworld.com/x',
          design_id: null,
          notes: null,
          category_id: 3,
        }),
      );
    });

    it('an edit with nothing changed closes without a request', () => {
      const update = vi.spyOn(api, 'updateProduct');
      const onClose = vi.fn();
      render(<ProductCardDialog product={product} onClose={onClose} />);
      fireEvent.click(primary());
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('after the save (B06)', () => {
    it('a new product opens at once, with the mockup toast', async () => {
      vi.spyOn(api, 'createProduct').mockResolvedValue({ ...product, id: 42 } as never);
      vi.spyOn(api, 'getProduct').mockResolvedValue({ ...product, id: 42 } as never);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const onClose = vi.fn();
      // Bare: the shared wrapper already holds a router, and this one must start at the catalog.
      renderBare(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/products']}>
            <ToastProvider>
              <Routes>
                <Route path="/products" element={<ProductCardDialog product={null} onClose={onClose} />} />
                <Route path="/products/:id" element={<p>product page</p>} />
              </Routes>
            </ToastProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lid' } });
      fireEvent.click(primary());
      expect(await screen.findByText('product page')).toBeInTheDocument();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Product created — link a file or add parts')).toBeInTheDocument();
    });

    it('an edit closes and says «Product updated»', async () => {
      vi.spyOn(api, 'updateProduct').mockResolvedValue(product as never);
      const onClose = vi.fn();
      render(<ProductCardDialog product={product} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beaker' } });
      fireEvent.click(primary());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('Product updated')).toBeInTheDocument();
    });

    it('a rename reaches the order views, not only the product keys', async () => {
      // `ProjectLineResponse.product_name` is denormalised: an order card and every
      // line of an order page keep the OLD name until their keys are invalidated.
      vi.spyOn(api, 'updateProduct').mockResolvedValue(product as never);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      for (const key of [['projects', {}], ['project', 1], ['customers'], ['products']]) {
        client.setQueryData(key, { seeded: true });
      }
      render(
        <QueryClientProvider client={client}>
          <ProductCardDialog product={product} onClose={noop} />
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beaker' } });
      fireEvent.click(primary());
      await waitFor(() => expect(client.getQueryState(['projects', {}])?.isInvalidated).toBe(true));
      expect(client.getQueryState(['project', 1])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['customers'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['products'])?.isInvalidated).toBe(true);
    });
  });

  describe('under a request (B07)', () => {
    it('Escape, X and «Cancel» do not close it — decided in the same tick as the press', async () => {
      const create = vi.spyOn(api, 'createProduct').mockReturnValue(new Promise(() => {}) as never);
      const onClose = vi.fn();
      render(<ProductCardDialog product={null} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lid' } });
      // One act = one frame: nothing re-renders between the press and the rest, so
      // `isPending` (and with it the disabled X and buttons) is not there yet — only
      // the form's own synchronous guard can refuse these.
      const submit = primary();
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
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('a refusal re-arms the button', async () => {
      const update = vi
        .spyOn(api, 'updateProduct')
        .mockRejectedValueOnce(new Error('Another product already has this SKU'))
        .mockResolvedValueOnce(product as never);
      const onClose = vi.fn();
      render(<ProductCardDialog product={product} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'LMP-1' } });
      fireEvent.click(primary());
      await screen.findByRole('alert');
      fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'LMP-2' } });
      fireEvent.click(primary());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(update).toHaveBeenCalledTimes(2);
    });
  });

  it('carries no gallery (B08)', () => {
    render(<ProductCardDialog product={product} onClose={noop} />);
    expect(screen.queryByTestId('product-gallery-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('product-gallery')).not.toBeInTheDocument();
  });

  describe('the draft session (J)', () => {
    const listRow = { ...product } as unknown as ProductListItem;
    delete (listRow as unknown as Record<string, unknown>).description;

    it('a catalog row reads the full product first — a reading state, never empty fields', async () => {
      let resolve: (p: Product) => void = noop;
      vi.spyOn(api, 'getProduct').mockReturnValue(new Promise<Product>((r) => (resolve = r)) as never);
      render(<ProductCardDialog product={listRow} onClose={noop} />);
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
      resolve(product);
      expect(await screen.findByLabelText('Name')).toHaveValue('Flask');
    });

    it('a failed read says so and retries', async () => {
      const read = vi.spyOn(api, 'getProduct').mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce(product);
      render(<ProductCardDialog product={listRow} onClose={noop} />);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not read the product.');
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByLabelText('Name')).toHaveValue('Flask');
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('a background refresh reseeds nothing, and the PATCH is the difference from the base', async () => {
      const update = vi.spyOn(api, 'updateProduct').mockResolvedValue(product as never);
      const { rerender } = render(<ProductCardDialog product={product} onClose={noop} />);
      fireEvent.change(screen.getByLabelText('Licence'), { target: { value: 'CC-BY' } });
      rerender(<ProductCardDialog product={{ ...product, name: 'Flask 2', license: 'MIT' } as Product} onClose={noop} />);
      expect(screen.getByLabelText('Licence')).toHaveValue('CC-BY');
      expect(screen.getByLabelText('Name')).toHaveValue('Flask');
      fireEvent.click(primary());
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, { license: 'CC-BY' }));
    });

    it('a chosen category that is gone is named so and blocks the save until another is chosen', async () => {
      const update = vi.spyOn(api, 'updateProduct').mockResolvedValue(product as never);
      render(<ProductCardDialog product={{ ...product, category: { id: 9, name: 'Old' } } as Product} onClose={noop} />);
      expect(await screen.findByRole('option', { name: 'Old (no longer exists)' })).toBeInTheDocument();
      expect(screen.getByLabelText('Category')).toHaveValue('9');
      expect(screen.getByLabelText('Category')).toHaveAccessibleDescription(
        'This category no longer exists — choose another one.',
      );
      expect(primary()).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } });
      expect(primary()).toBeEnabled();
      fireEvent.click(primary());
      await waitFor(() => expect(update).toHaveBeenCalledWith(7, { category_id: null }));
    });

    it('while the categories load, the chosen one is shown by its own name, not as «No category»', () => {
      vi.spyOn(api, 'getProductCategories').mockReturnValue(new Promise(() => {}) as never);
      render(<ProductCardDialog product={product} onClose={noop} />);
      expect(screen.getByLabelText('Category')).toHaveValue('3');
      expect(screen.getByRole('option', { name: 'Hooks' })).toBeInTheDocument();
    });
  });
});
