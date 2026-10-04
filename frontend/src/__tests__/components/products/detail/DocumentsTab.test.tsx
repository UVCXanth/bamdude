/**
 * The «Documents» tab of the product page (WS-13 E9 G01–G04, R07): three sections — bill
 * of materials, assembly guide, other — read off `product.attachments` (no request of its
 * own); a row per document with its type, size and source; upload, download, view (pictures
 * only) and delete. Downloads and pictures go through the authorised blob fetch — the
 * session refreshed before and after a 401, a refusal in the server's words — and a
 * picture's late answer opens nothing and lets its URL go.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useRef, type ReactElement } from 'react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import type { Permission, Product, ProductAttachment } from '../../../../api/client';
import { DocumentsTab } from '../../../../components/products/detail/DocumentsTab';

const auth = vi.hoisted(() => ({ granted: null as Set<string> | null }));
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return { ...real, hasPermission: (p: Permission) => auth.granted?.has(p) ?? real.hasPermission(p) };
    },
  };
});

function doc(over: Partial<ProductAttachment> & Pick<ProductAttachment, 'filename' | 'category'>): ProductAttachment {
  return {
    original_name: over.filename,
    size: 2048,
    sort_order: 0,
    source: 'manual',
    source_file_id: null,
    uploaded_at: null,
    ...over,
  };
}

const product = {
  id: 7,
  code: 'PR-0007',
  name: 'Flask',
  attachments: [
    doc({ filename: 'bom.xlsx', original_name: 'bill-of-materials.xlsx', category: 'bom_docs', size: 10240 }),
    doc({ filename: 'guide.pdf', original_name: 'assembly.pdf', category: 'assembly', source: '3mf' }),
    doc({ filename: 'step1.png', original_name: 'Step 1.png', category: 'assembly', sort_order: 1, source: 'import' }),
    doc({ filename: 'step2.jpg', original_name: 'Step 2.jpg', category: 'assembly', sort_order: 2 }),
    doc({ filename: 'cover.png', category: 'pictures' }),
  ],
} as unknown as Product;

function Host({ product: p = product }: { product?: Product }) {
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Flask
      </h1>
      <DocumentsTab product={p} headingRef={heading} />
    </>
  );
}

const section = (category: string) => screen.getByTestId(`attachment-section-${category}`);
const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('DocumentsTab', () => {
  let urls: string[];
  let revoked: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    auth.granted = new Set(['orders:read', 'products:read', 'customers:read', 'stock:read', 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust']);
    urls = [];
    revoked = [];
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:test/${++n}`;
      urls.push(url);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('G01 / G03 the sections', () => {
    it('three sections in order with the server’s types; a picture belongs to the gallery, not here', () => {
      render(<Host />);
      const titles = screen.getAllByTestId(/^attachment-section-/).map((s) => s.dataset.testid);
      expect(titles).toEqual(['attachment-section-bom_docs', 'attachment-section-assembly', 'attachment-section-other']);
      expect(screen.queryByText('cover.png')).not.toBeInTheDocument();
    });

    it('an empty section says so with what it takes', () => {
      render(<Host />);
      expect(within(section('other')).getByText('Nothing here yet · any allowed file')).toBeInTheDocument();
    });

    it('a tie on sort_order breaks on the filename, as the gallery’s does', () => {
      render(
        <Host
          product={
            {
              ...product,
              attachments: [
                doc({ filename: 'b.pdf', category: 'other' }),
                doc({ filename: 'a.pdf', category: 'other' }),
              ],
            } as unknown as Product
          }
        />,
      );
      const names = within(section('other'))
        .getAllByRole('listitem')
        .map((li) => li.querySelector('b')?.textContent);
      expect(names).toEqual(['a.pdf', 'b.pdf']);
    });

    it('rows in the gallery’s order', () => {
      render(<Host />);
      const names = within(section('assembly'))
        .getAllByRole('listitem')
        .map((li) => li.querySelector('b')?.textContent);
      expect(names).toEqual(['assembly.pdf', 'Step 1.png', 'Step 2.jpg']);
    });
  });

  describe('G02 the rows', () => {
    it('type, name, size and where it came from — nothing for a plain upload', () => {
      render(<Host />);
      expect(within(row('bill-of-materials.xlsx')).getByText('XLSX')).toBeInTheDocument();
      expect(within(row('bill-of-materials.xlsx')).getByText('10 KB')).toBeInTheDocument();
      expect(within(row('assembly.pdf')).getByText('2 KB · from 3MF')).toBeInTheDocument();
      expect(within(row('Step 1.png')).getByText('2 KB · import')).toBeInTheDocument();
      expect(within(row('Step 2.jpg')).getByText('2 KB')).toBeInTheDocument();
    });

    it('only pictures can be viewed', () => {
      render(<Host />);
      expect(within(row('Step 1.png')).getByRole('button', { name: 'View «Step 1.png»' })).toBeInTheDocument();
      expect(within(row('assembly.pdf')).queryByRole('button', { name: /view/i })).not.toBeInTheDocument();
    });

    it('downloads through the authorised fetch and lets its URL go', async () => {
      const get = vi.spyOn(api, 'getProductAttachment').mockResolvedValue(new Blob(['x']));
      render(<Host />);
      fireEvent.click(within(row('bill-of-materials.xlsx')).getByRole('button', { name: 'Download «bill-of-materials.xlsx»' }));
      await waitFor(() => expect(get).toHaveBeenCalledWith(7, 'bom.xlsx'));
      await waitFor(() => expect(revoked).toEqual(['blob:test/1']));
    });

    it('a refused download says the server’s sentence', async () => {
      vi.spyOn(api, 'getProductAttachment').mockRejectedValue(new ApiError('You may not read this product', 403));
      render(<Host />);
      fireEvent.click(within(row('bill-of-materials.xlsx')).getByRole('button', { name: 'Download «bill-of-materials.xlsx»' }));
      expect(await screen.findByText('You may not read this product')).toBeInTheDocument();
    });

    it('deleting asks with the name and what goes, then deletes once', async () => {
      const remove = vi.spyOn(api, 'deleteProductAttachment').mockResolvedValue([] as never);
      render(<Host />);
      fireEvent.click(within(row('assembly.pdf')).getByRole('button', { name: 'Delete «assembly.pdf»' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Delete «assembly.pdf»?')).toBeInTheDocument();
      expect(within(dialog).getByText(/the library’s file stays/i)).toBeInTheDocument();
      act(() => {
        within(dialog).getByRole('button', { name: 'Delete' }).click();
        within(dialog).getByRole('button', { name: 'Delete' }).click();
      });
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
      expect(remove).toHaveBeenCalledWith(7, 'guide.pdf');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    const without = (filename: string) =>
      ({ ...product, attachments: product.attachments!.filter((a) => a.filename !== filename) }) as Product;

    it('the deleted row leaves with the re-read and the heading takes the focus', async () => {
      vi.spyOn(api, 'deleteProductAttachment').mockResolvedValue([] as never);
      const { rerender } = render(<Host />);
      const opener = within(row('assembly.pdf')).getByRole('button', { name: 'Delete «assembly.pdf»' });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog');
      act(() => within(dialog).getByRole('button', { name: 'Delete' }).click());
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      rerender(<Host product={without('guide.pdf')} />);
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Flask' })).toHaveFocus());
    });

    it('a row the re-read takes before the confirmation closes: the heading still gets the focus', async () => {
      let rerender: (ui: ReactElement) => void = () => {};
      vi.spyOn(api, 'deleteProductAttachment').mockImplementation(async () => {
        rerender(<Host product={without('guide.pdf')} />);
        return [] as never;
      });
      ({ rerender } = render(<Host />));
      const opener = within(row('assembly.pdf')).getByRole('button', { name: 'Delete «assembly.pdf»' });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog');
      act(() => within(dialog).getByRole('button', { name: 'Delete' }).click());
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Flask' })).toHaveFocus());
    });
  });

  describe('G01 / G03 uploading', () => {
    it('into the section whose button was used; that section waits, the others do not', async () => {
      let settle: (v: unknown) => void = () => {};
      const upload = vi.spyOn(api, 'uploadProductAttachment').mockReturnValue(new Promise((resolve) => (settle = resolve)) as never);
      render(<Host />);
      const file = new File(['x'], 'bom.csv', { type: 'text/csv' });
      fireEvent.change(screen.getByTestId('attachment-input-bom_docs'), { target: { files: [file] } });
      await waitFor(() => expect(upload).toHaveBeenCalledWith(7, file, 'bom_docs'));
      expect(within(section('bom_docs')).getByRole('button', { name: 'Uploading…' })).toBeDisabled();
      expect(within(section('other')).getByRole('button', { name: 'Upload…' })).toBeEnabled();
      await act(async () => settle({}));
      await waitFor(() => expect(within(section('bom_docs')).getByRole('button', { name: 'Upload…' })).toBeEnabled());
    });

    it('two sections uploading at once: each waits for its own upload', async () => {
      const settle: Record<string, (v: unknown) => void> = {};
      vi.spyOn(api, 'uploadProductAttachment').mockImplementation(
        (_id, _file, category) => new Promise((resolve) => (settle[category as string] = resolve)) as never,
      );
      render(<Host />);
      fireEvent.change(screen.getByTestId('attachment-input-bom_docs'), { target: { files: [new File(['x'], 'bom.csv')] } });
      await waitFor(() => expect(settle.bom_docs).toBeDefined());
      fireEvent.change(screen.getByTestId('attachment-input-other'), { target: { files: [new File(['x'], 'notes.txt')] } });
      await waitFor(() => expect(settle.other).toBeDefined());
      expect(within(section('bom_docs')).getByRole('button', { name: 'Uploading…' })).toBeDisabled();
      expect(within(section('other')).getByRole('button', { name: 'Uploading…' })).toBeDisabled();
      await act(async () => settle.bom_docs({}));
      await waitFor(() => expect(within(section('bom_docs')).getByRole('button', { name: 'Upload…' })).toBeEnabled());
      expect(within(section('other')).getByRole('button', { name: 'Uploading…' })).toBeDisabled();
      await act(async () => settle.other({}));
      await waitFor(() => expect(within(section('other')).getByRole('button', { name: 'Upload…' })).toBeEnabled());
    });

    it('a refused upload stands in its section in the server’s words', async () => {
      vi.spyOn(api, 'uploadProductAttachment').mockRejectedValue(new ApiError('This category takes .xls, .xlsx, .pdf or .csv', 400));
      render(<Host />);
      fireEvent.change(screen.getByTestId('attachment-input-bom_docs'), {
        target: { files: [new File(['x'], 'a.exe')] },
      });
      expect(await within(section('bom_docs')).findByRole('alert')).toHaveTextContent('This category takes .xls, .xlsx, .pdf or .csv');
      expect(section('assembly')).toBeInTheDocument();
    });

    it('a reader can download and view, and nothing more', () => {
      auth.granted = new Set(['orders:read', 'products:read', 'customers:read', 'stock:read']);
      render(<Host />);
      expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
      expect(within(row('Step 1.png')).getByRole('button', { name: 'View «Step 1.png»' })).toBeInTheDocument();
    });
  });

  describe('R07 viewing a picture', () => {
    it('«…» while it reads, then the picture; closing lets its URL go', async () => {
      let answer: (b: Blob) => void = () => {};
      vi.spyOn(api, 'getProductAttachment').mockReturnValue(new Promise((resolve) => (answer = resolve)));
      render(<Host />);
      fireEvent.click(within(row('Step 1.png')).getByRole('button', { name: 'View «Step 1.png»' }));
      const viewer = await screen.findByRole('dialog', { name: 'Step 1.png' });
      expect(within(viewer).getByText('…')).toBeInTheDocument();
      await act(async () => answer(new Blob(['x'])));
      expect(within(viewer).getByRole('img')).toHaveAttribute('src', 'blob:test/1');
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(revoked).toEqual(['blob:test/1']);
    });

    it('a failure — of the request or of the picture itself — is a sentence and a retry', async () => {
      const get = vi.spyOn(api, 'getProductAttachment').mockRejectedValueOnce(new Error('boom')).mockResolvedValue(new Blob(['x']));
      render(<Host />);
      fireEvent.click(within(row('Step 1.png')).getByRole('button', { name: 'View «Step 1.png»' }));
      const viewer = await screen.findByRole('dialog', { name: 'Step 1.png' });
      expect(await within(viewer).findByText('Could not show it')).toBeInTheDocument();
      fireEvent.click(within(viewer).getByRole('button', { name: 'Retry' }));
      const img = await within(viewer).findByRole('img');
      expect(get).toHaveBeenCalledTimes(2);
      // The bytes came, the picture does not decode.
      fireEvent.error(img);
      expect(await within(viewer).findByText('Could not show it')).toBeInTheDocument();
    });

    it('A slow, B fast: B is shown, A’s late answer opens nothing and is let go', async () => {
      const answers = new Map<string, (b: Blob) => void>();
      vi.spyOn(api, 'getProductAttachment').mockImplementation(
        (_id, filename) => new Promise((resolve) => answers.set(filename, resolve)),
      );
      render(<Host />);
      fireEvent.click(within(row('Step 1.png')).getByRole('button', { name: 'View «Step 1.png»' }));
      await screen.findByRole('dialog', { name: 'Step 1.png' });
      // The list is inert under the viewer for a person; the code path is what is pinned.
      fireEvent.click(within(row('Step 2.jpg')).getByRole('button', { name: 'View «Step 2.jpg»' }));
      await act(async () => answers.get('step2.jpg')!(new Blob(['b'])));
      const viewer = await screen.findByRole('dialog', { name: 'Step 2.jpg' });
      expect(within(viewer).getByRole('img')).toHaveAttribute('src', 'blob:test/1');
      await act(async () => answers.get('step1.png')!(new Blob(['a'])));
      expect(screen.getByRole('dialog', { name: 'Step 2.jpg' })).toBeInTheDocument();
      expect(revoked).toEqual(['blob:test/2']);
    });

    it('a viewer closed before its picture arrived is not reopened', async () => {
      let answer: (b: Blob) => void = () => {};
      vi.spyOn(api, 'getProductAttachment').mockReturnValue(new Promise((resolve) => (answer = resolve)));
      render(<Host />);
      fireEvent.click(within(row('Step 1.png')).getByRole('button', { name: 'View «Step 1.png»' }));
      await screen.findByRole('dialog', { name: 'Step 1.png' });
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await act(async () => answer(new Blob(['x'])));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(urls.every((u) => revoked.includes(u))).toBe(true);
    });

    it('another product (the page remounts) lets a late answer go', async () => {
      let answer: (b: Blob) => void = () => {};
      vi.spyOn(api, 'getProductAttachment').mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const { unmount } = render(<Host />);
      fireEvent.click(within(row('Step 1.png')).getByRole('button', { name: 'View «Step 1.png»' }));
      await screen.findByRole('dialog', { name: 'Step 1.png' });
      unmount();
      await act(async () => answer(new Blob(['x'])));
      expect(urls.every((u) => revoked.includes(u))).toBe(true);
    });
  });
});
