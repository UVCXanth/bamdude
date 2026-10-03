/**
 * The category directory (WS-13 E10 H01–H05, F19a): a row per category with its count,
 * an explicit rename in the row (Enter or «Save»; «Cancel» or Escape undoes the row
 * only), a delete confirmed with the number of products it leaves uncategorized. Each
 * action writes at once by its own button — the one exception to «nothing is written
 * before the primary button» (H05). A read that failed is never «No categories yet».
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import { CategoryManagerDialog } from '../../../components/products/CategoryManagerDialog';

const categories = [
  { id: 3, name: 'Hooks', products_count: 2 },
  { id: 4, name: 'Vases', products_count: 1 },
];

const noop = () => {};
const rowOf = (name: string) => screen.getByTestId(`category-row-${name}`);

describe('CategoryManagerDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProductCategories').mockResolvedValue(categories);
  });

  describe('the frame and the reading states (H01)', () => {
    it('«Categories»: a row per category with its count, «Rename», «Delete»; a row to add', async () => {
      render(<CategoryManagerDialog onClose={noop} />);
      const dialog = screen.getByRole('dialog', { name: 'Categories' });
      await within(dialog).findByText('Hooks');
      expect(within(rowOf('Hooks')).getByText('2 products')).toBeInTheDocument();
      expect(within(rowOf('Vases')).getByText('1 product')).toBeInTheDocument();
      expect(within(rowOf('Hooks')).getByRole('button', { name: 'Rename Hooks' })).toBeInTheDocument();
      expect(within(rowOf('Hooks')).getByRole('button', { name: 'Delete Hooks' })).toBeInTheDocument();
      expect(within(dialog).getByLabelText('New category')).toBeInTheDocument();
    });

    it('a failed read says so with a retry — never «No categories yet»', async () => {
      const read = vi
        .spyOn(api, 'getProductCategories')
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce(categories);
      render(<CategoryManagerDialog onClose={noop} />);
      const failed = await screen.findByRole('alert');
      expect(failed).toHaveTextContent('Could not read the categories');
      expect(screen.queryByText('No categories yet')).not.toBeInTheDocument();
      fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('Hooks')).toBeInTheDocument();
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('a truly empty directory says so', async () => {
      vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
      render(<CategoryManagerDialog onClose={noop} />);
      expect(await screen.findByText('No categories yet')).toBeInTheDocument();
    });
  });

  describe('the rename (H02)', () => {
    it('is explicit: the row’s field, Enter saves — the id is kept', async () => {
      const rename = vi.spyOn(api, 'renameProductCategory').mockResolvedValue({ ...categories[0], name: 'Hooks 2' });
      render(<CategoryManagerDialog onClose={noop} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Hooks' }));
      const field = within(rowOf('Hooks')).getByLabelText('Category name');
      expect(field).toHaveFocus();
      fireEvent.change(field, { target: { value: 'Hooks 2' } });
      fireEvent.submit(field);
      await waitFor(() => expect(rename).toHaveBeenCalledWith(3, 'Hooks 2'));
    });

    it('«Cancel» undoes the row only; Escape in the field too, and the next Escape closes the manager', async () => {
      const rename = vi.spyOn(api, 'renameProductCategory');
      const onClose = vi.fn();
      render(<CategoryManagerDialog onClose={onClose} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Hooks' }));
      fireEvent.change(within(rowOf('Hooks')).getByLabelText('Category name'), { target: { value: 'X' } });
      fireEvent.click(within(rowOf('Hooks')).getByRole('button', { name: 'Cancel' }));
      expect(within(rowOf('Hooks')).queryByLabelText('Category name')).not.toBeInTheDocument();
      expect(within(rowOf('Hooks')).getByText('Hooks')).toBeInTheDocument();

      fireEvent.click(within(rowOf('Hooks')).getByRole('button', { name: 'Rename Hooks' }));
      const field = within(rowOf('Hooks')).getByLabelText('Category name');
      fireEvent.keyDown(field, { key: 'Escape' });
      expect(within(rowOf('Hooks')).queryByLabelText('Category name')).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(rename).not.toHaveBeenCalled();
    });

    it('a taken name is said under the row, what was typed stays', async () => {
      vi.spyOn(api, 'renameProductCategory').mockRejectedValue(new ApiError('A category with this name already exists', 409));
      render(<CategoryManagerDialog onClose={noop} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Hooks' }));
      const field = within(rowOf('Hooks')).getByLabelText('Category name');
      fireEvent.change(field, { target: { value: 'Vases' } });
      fireEvent.click(within(rowOf('Hooks')).getByRole('button', { name: 'Save' }));
      expect(await within(rowOf('Hooks')).findByText('A category with this name already exists')).toBeInTheDocument();
      expect(within(rowOf('Hooks')).getByLabelText('Category name')).toHaveValue('Vases');
    });

    it('a rename on its way: one request, the row waits', async () => {
      const rename = vi.spyOn(api, 'renameProductCategory').mockReturnValue(new Promise(() => {}) as never);
      render(<CategoryManagerDialog onClose={noop} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Hooks' }));
      fireEvent.change(within(rowOf('Hooks')).getByLabelText('Category name'), { target: { value: 'Hooks 2' } });
      const save = within(rowOf('Hooks')).getByRole('button', { name: 'Save' });
      act(() => {
        save.click();
        save.click();
      });
      await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
      expect(within(rowOf('Hooks')).getByRole('button', { name: /^Save/ })).toBeDisabled();
    });
  });

  describe('the delete (H03)', () => {
    it('asks naming the category and how many products lose it, then tells the page', async () => {
      const del = vi.spyOn(api, 'deleteProductCategory').mockResolvedValue({ message: 'ok', uncategorized: 2 });
      const onDeleted = vi.fn();
      render(<CategoryManagerDialog onClose={noop} onDeleted={onDeleted} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Delete Hooks' }));
      const confirm = await screen.findByRole('dialog', { name: 'Delete the category “Hooks”?' });
      expect(confirm).toHaveTextContent('2 products will be left without a category');
      expect(del).not.toHaveBeenCalled();
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(del).toHaveBeenCalledWith(3));
      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(3));
    });

    it('says «product» for one', async () => {
      render(<CategoryManagerDialog onClose={noop} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Delete Vases' }));
      expect(await screen.findByText('1 product will be left without a category')).toBeInTheDocument();
    });
  });

  describe('adding, and what goes stale (H04)', () => {
    it('adds a category; a taken name is said under the add row, never a toast', async () => {
      const create = vi
        .spyOn(api, 'createProductCategory')
        .mockRejectedValueOnce(new ApiError('A category with this name already exists', 409))
        .mockResolvedValueOnce({ id: 5, name: 'Lamps', products_count: 0 });
      render(<CategoryManagerDialog onClose={noop} />);
      const field = await screen.findByLabelText('New category');
      fireEvent.change(field, { target: { value: 'Hooks' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(await screen.findByText('A category with this name already exists')).toBeInTheDocument();
      expect(screen.getAllByText('A category with this name already exists')).toHaveLength(1);
      fireEvent.change(field, { target: { value: 'Lamps' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(create).toHaveBeenLastCalledWith('Lamps'));
      await waitFor(() => expect(field).toHaveValue(''));
    });

    it('a change marks the catalog and an open product stale', async () => {
      vi.spyOn(api, 'renameProductCategory').mockResolvedValue({ ...categories[0], name: 'Hooks 2' });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      for (const key of [['products'], ['product', 7], ['product-facets'], ['projects', 'nav-badges']]) {
        client.setQueryData(key, { seeded: true });
      }
      render(
        <QueryClientProvider client={client}>
          <CategoryManagerDialog onClose={noop} />
        </QueryClientProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Hooks' }));
      fireEvent.change(within(rowOf('Hooks')).getByLabelText('Category name'), { target: { value: 'Hooks 2' } });
      fireEvent.click(within(rowOf('Hooks')).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(client.getQueryState(['products'])?.isInvalidated).toBe(true));
      expect(client.getQueryState(['product', 7])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['product-facets'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['projects', 'nav-badges'])?.isInvalidated).toBe(true);
    });
  });
});
