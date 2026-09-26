import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { CategoryManagerDialog } from '../../../components/products/CategoryManagerDialog';

const categories = [
  { id: 3, name: 'Hooks', products_count: 2 },
  { id: 4, name: 'Vases', products_count: 1 },
];

describe('CategoryManagerDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProductCategories').mockResolvedValue(categories);
  });

  it('adds and renames a category', async () => {
    const create = vi.spyOn(api, 'createProductCategory').mockResolvedValue({ id: 5, name: 'New', products_count: 0 });
    const rename = vi.spyOn(api, 'renameProductCategory').mockResolvedValue({ ...categories[0], name: 'Hooks 2' });
    render(<CategoryManagerDialog onClose={() => {}} />);
    const hooks = await screen.findByDisplayValue('Hooks');
    fireEvent.change(hooks, { target: { value: 'Hooks 2' } });
    fireEvent.blur(hooks);
    await waitFor(() => expect(rename).toHaveBeenCalledWith(3, 'Hooks 2'));
    fireEvent.change(screen.getByLabelText('New category'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('New'));
  });

  it('asks before deleting and says how many products lose their category', async () => {
    const del = vi.spyOn(api, 'deleteProductCategory').mockResolvedValue({ message: 'ok', uncategorized: 2 });
    render(<CategoryManagerDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Hooks' }));
    expect(await screen.findByText('2 products will be left without a category')).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(3));
  });

  it('says «product» for one', async () => {
    render(<CategoryManagerDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Vases' }));
    expect(await screen.findByText('1 product will be left without a category')).toBeInTheDocument();
  });
});
