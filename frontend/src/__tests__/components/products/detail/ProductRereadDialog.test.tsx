/**
 * Re-reading a product's card from one of its files (WS-13 E9 B03, R02, R08). The list
 * is the linked 3MF containers the reader may see — sliced or not — off the same
 * `/files` the «Plates and files» tab reads; STL, STEP, raw G-code and files without
 * access are not offered. The request goes only on «Re-read»; a note that nothing could
 * be read keeps the dialog with the note as its error; a success closes it with the notes
 * in a toast. The notes are CODES — their English lives here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import type { ProductFileGroup, ProductFileGroups } from '../../../../api/client';
import { ProductRereadDialog } from '../../../../components/products/detail/ProductRereadDialog';

const product = { id: 7, code: 'PR-0007', name: 'Flask' };

function file(over: Partial<ProductFileGroup>): ProductFileGroup {
  return {
    library_file_id: 1,
    filename: 'flask.gcode.3mf',
    hidden: false,
    folder_id: 4,
    folder_name: 'Lighting',
    file_type: 'gcode',
    plan_eligible: true,
    printer_model: 'P1S',
    sliced_any: true,
    plates: [],
    is_3mf: true,
    in_linked_folder: false,
    ...over,
  };
}

const groups = (files: ProductFileGroup[]): ProductFileGroups => ({
  files,
  hidden_files: files.filter((f) => f.hidden).length,
  folders: [],
});

const MANY = groups([
  file({ library_file_id: 1, filename: 'flask.gcode.3mf' }),
  file({ library_file_id: 2, filename: 'flask-project.3mf', file_type: '3mf', sliced_any: false, printer_model: null }),
  file({ library_file_id: 3, filename: 'flask.gcode', is_3mf: false }),
  file({ library_file_id: 4, filename: 'flask.stl', file_type: 'stl', is_3mf: false, sliced_any: false }),
  file({ library_file_id: 5, filename: null, hidden: true, folder_id: null, folder_name: null }),
]);

// The page's own query client, reached from inside the tree the dialog renders in.
const probe = vi.hoisted(() => ({ client: null as QueryClient | null }));
function Probe() {
  const client = useQueryClient();
  useEffect(() => {
    probe.client = client;
  }, [client]);
  return null;
}

function mount(onClose = vi.fn()) {
  render(<ProductRereadDialog product={product} onClose={onClose} />);
  return onClose;
}

describe('ProductRereadDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('offers the 3MF containers the reader may see — sliced or not — and nothing is chosen of several', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    mount();
    const radios = await screen.findAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual([
      expect.stringContaining('flask.gcode.3mf'),
      expect.stringContaining('flask-project.3mf'),
    ]);
    expect(screen.getByText('not sliced')).toBeInTheDocument();
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeDisabled();
  });

  it('chooses the only file there is', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(groups([file({ library_file_id: 9 })]));
    mount();
    expect(await screen.findByRole('radio')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeEnabled();
  });

  it('says when there is no 3MF the reader may re-read from', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(
      groups([file({ is_3mf: false, filename: 'a.stl' }), file({ hidden: true, filename: null })]),
    );
    mount();
    expect(await screen.findByText('None of the linked files is a 3MF you can see.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeDisabled();
  });

  it('reads the list while it loads, and a failed read offers a retry', async () => {
    let fail = true;
    vi.spyOn(api, 'getProductFileGroups').mockImplementation(async () => {
      if (fail) throw new ApiError('boom', 500);
      return MANY;
    });
    mount();
    expect(screen.getByText('Loading files…')).toBeInTheDocument();
    const retry = await screen.findByRole('button', { name: /try again|retry/i });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findAllByRole('radio')).toHaveLength(2);
  });

  it('a chosen file that left the list is chosen no more, and says why', async () => {
    const spy = vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    render(
      <>
        <Probe />
        <ProductRereadDialog product={product} onClose={() => {}} />
      </>,
    );
    fireEvent.click((await screen.findAllByRole('radio'))[1]);
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeEnabled();
    spy.mockResolvedValue(groups([file({ library_file_id: 1 }), file({ library_file_id: 8, filename: 'other.3mf' })]));
    // Somebody unlinked it meanwhile: the list is read again.
    await act(async () => {
      await probe.client!.invalidateQueries({ queryKey: ['product-file-groups', 7] });
    });
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByText('This file is no longer linked — pick another.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeDisabled();
  });

  it('sends one request on «Re-read», closes and reports the notes', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    const reread = vi.spyOn(api, 'rereadProductCard').mockResolvedValue({
      product,
      notes: [{ code: 'filled_field', params: { field: 'designer' } }],
    } as never);
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const onClose = mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    const primary = screen.getByRole('button', { name: 'Re-read' });
    // Two clicks in one tick — React has not re-rendered the button disabled between them.
    act(() => {
      primary.click();
      primary.click();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(reread).toHaveBeenCalledTimes(1);
    expect(reread).toHaveBeenCalledWith(7, 1);
    expect(await screen.findByText(/filled in designer/i)).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['product'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('a note that nothing could be read keeps the dialog, with the note as its error', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    vi.spyOn(api, 'rereadProductCard').mockResolvedValue({
      product,
      notes: [{ code: 'unreadable', params: { error: 'bad zip' } }],
    } as never);
    const onClose = mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/bad zip/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Re-read' })).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a refusal stays in the dialog with the server’s sentence', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    vi.spyOn(api, 'rereadProductCard').mockRejectedValue(new ApiError('That file is not linked to this product', 404));
    const onClose = mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is not linked to this product');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cannot be closed while the request runs', async () => {
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(MANY);
    vi.spyOn(api, 'rereadProductCard').mockReturnValue(new Promise(() => {}));
    const onClose = mount();
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Re-read' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
