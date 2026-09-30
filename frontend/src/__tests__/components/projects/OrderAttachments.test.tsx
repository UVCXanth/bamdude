/**
 * Busy is a property of the ROW, not of the list.
 *
 * One `busy` flag covered every attachment: downloading a large spec disabled
 * the download button of all ten rows, and the section read as broken when one
 * slow request was in flight. The delete button had the same shape through
 * `remove.isPending` — one mutation shared by every row cannot say which row
 * asked.
 *
 * WS-13 E4 G04: a row says the file's type, size and upload time; a picture can be
 * viewed from the authorised fetch the download uses, and its blob URL is let go on
 * close, on replacement and on unmount — an answer that arrives after the viewer was
 * closed opens nothing (R09). Deleting asks first; several files upload one by one,
 * a refused one named in its own toast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Order } from '../../../api/client';
import { OrderAttachments } from '../../../components/projects/OrderAttachments';
import { formatDateTime } from '../../../utils/date';

const UPLOADED = '2026-09-01T10:30:00Z';
const order = {
  id: 1,
  attachments: [
    { filename: 'a.pdf', original_name: 'Spec.pdf', size: 1024, uploaded_at: UPLOADED },
    { filename: 'b.pdf', original_name: 'Quote.pdf', size: 2048, uploaded_at: UPLOADED },
  ],
} as unknown as Order;
const pictures = {
  id: 1,
  attachments: [
    { filename: 'p.png', original_name: 'Parcel.png', size: 4096, uploaded_at: UPLOADED },
    { filename: 'q.jpg', original_name: 'Box.jpg', size: 4096, uploaded_at: UPLOADED },
    { filename: 'a.pdf', original_name: 'Spec.pdf', size: 1024, uploaded_at: UPLOADED },
  ],
} as unknown as Order;

describe('OrderAttachments', () => {
  let urls: string[];
  let revoked: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProjectAttachmentUrl').mockImplementation((_id, name) => `/api/v1/projects/1/attachments/${name}`);
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

  it('only the row being downloaded goes quiet', async () => {
    let finish: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );

    render(<OrderAttachments order={order} canEdit />);

    fireEvent.click(screen.getByTestId('attachment-download-a.pdf'));

    await waitFor(() => expect(screen.getByTestId('attachment-download-a.pdf')).toBeDisabled());
    expect(screen.getByTestId('attachment-download-b.pdf')).toBeEnabled();

    finish({ ok: false, status: 500 } as Response);
    await waitFor(() => expect(screen.getByTestId('attachment-download-a.pdf')).toBeEnabled());
  });

  it('asks before deleting, and only the row being deleted goes quiet', async () => {
    let finish: () => void = () => {};
    const del = vi.spyOn(api, 'deleteProjectAttachment').mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }) as never,
    );

    render(<OrderAttachments order={order} canEdit />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete attachment «Quote.pdf»' }));
    const ask = await screen.findByRole('dialog', { name: 'Delete the attachment «Quote.pdf»?' });
    expect(ask).toHaveTextContent('The file will be deleted from the order for good.');
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(1, 'b.pdf'));
    await waitFor(() => expect(screen.getByTestId('attachment-delete-b.pdf')).toBeDisabled());
    expect(screen.getByTestId('attachment-delete-a.pdf')).toBeEnabled();

    finish();
    await waitFor(() => expect(screen.getByTestId('attachment-delete-b.pdf')).toBeEnabled());
  });

  it('says each file’s type, size and upload time, and lets only pictures be viewed', () => {
    render(<OrderAttachments order={pictures} canEdit />);
    const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
    expect(within(row('Spec.pdf')).getByText('PDF')).toBeInTheDocument();
    expect(within(row('Parcel.png')).getByText('PNG')).toBeInTheDocument();
    expect(row('Spec.pdf')).toHaveTextContent(`1.0 KB · ${formatDateTime(UPLOADED)}`);
    expect(within(row('Parcel.png')).getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(within(row('Spec.pdf')).queryByRole('button', { name: 'View' })).not.toBeInTheDocument();
    expect(within(row('Spec.pdf')).getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('gives a reader download and view, and no delete', () => {
    render(<OrderAttachments order={pictures} canEdit={false} />);
    expect(screen.queryByRole('button', { name: /Delete attachment/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upload/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'View' })).toHaveLength(2);
  });

  it('views a picture from the authorised fetch, and lets its URL go on close', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    render(<OrderAttachments order={pictures} canEdit />);

    fireEvent.click(within(screen.getByText('Parcel.png').closest('li') as HTMLElement).getByRole('button', { name: 'View' }));
    const viewer = await screen.findByRole('dialog', { name: 'Parcel.png' });
    await waitFor(() => expect(within(viewer).getByRole('img')).toHaveAttribute('src', 'blob:test/1'));
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects/1/attachments/p.png', expect.anything());

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Parcel.png' })).not.toBeInTheDocument());
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('refreshes the session once on a 401 and then shows the picture (final review M10)', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/auth/refresh')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'fresh' }) } as unknown as Response;
      }
      return calls.filter((u) => u.endsWith('/p.png')).length === 1
        ? ({ ok: false, status: 401, json: async () => ({ detail: 'Token has expired' }) } as unknown as Response)
        : ({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<OrderAttachments order={pictures} canEdit />);

    fireEvent.click(within(screen.getByText('Parcel.png').closest('li') as HTMLElement).getByRole('button', { name: 'View' }));
    const viewer = await screen.findByRole('dialog', { name: 'Parcel.png' });
    await waitFor(() => expect(within(viewer).getByRole('img')).toHaveAttribute('src', 'blob:test/1'));
    expect(calls.filter((u) => u.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/p.png'))).toHaveLength(2);
  });

  it('says the server’s sentence when a download is refused, not «HTTP 403» (final review M10)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ detail: 'You may not read this order' }) }) as unknown as Response),
    );
    render(<OrderAttachments order={order} canEdit />);
    fireEvent.click(screen.getByTestId('attachment-download-a.pdf'));
    expect(await screen.findByText('You may not read this order')).toBeInTheDocument();
    expect(screen.queryByText('HTTP 403')).not.toBeInTheDocument();
  });

  it('lets the previous URL go when another picture replaces it, and the last one on unmount', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) }) as unknown as Response));
    const { unmount } = render(<OrderAttachments order={pictures} canEdit />);
    const viewButton = (name: string) =>
      within(screen.getByText(name).closest('li') as HTMLElement).getByRole('button', { name: 'View' });

    fireEvent.click(viewButton('Parcel.png'));
    await waitFor(() => expect(urls).toEqual(['blob:test/1']));
    // Another picture replaces the one on screen (the list is inert under the viewer
    // for a person; the code path is what is pinned here).
    fireEvent.click(viewButton('Box.jpg'));
    await waitFor(() => expect(urls).toEqual(['blob:test/1', 'blob:test/2']));
    expect(revoked).toEqual(['blob:test/1']);

    unmount();
    expect(revoked).toEqual(['blob:test/1', 'blob:test/2']);
  });

  it('does not reopen a viewer closed before its picture arrived', async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    render(<OrderAttachments order={pictures} canEdit />);

    fireEvent.click(within(screen.getByText('Parcel.png').closest('li') as HTMLElement).getByRole('button', { name: 'View' }));
    const viewer = await screen.findByRole('dialog', { name: 'Parcel.png' });
    expect(within(viewer).getByText('Loading...')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await act(async () => {
      answer({ ok: true, blob: async () => new Blob(['x']) } as unknown as Response);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Whatever was made of the late answer is let go at once.
    expect(urls.every((u) => revoked.includes(u))).toBe(true);
  });

  it('says a picture could not be opened, with a retry, inside the viewer', async () => {
    // The attachment's own URL fails once; anything else the page reads (settings)
    // is not what this test is about.
    let failures = 1;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/attachments/') && failures-- > 0) return { ok: false, status: 500 } as Response;
      return { ok: true, blob: async () => new Blob(['x']) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<OrderAttachments order={pictures} canEdit />);

    fireEvent.click(within(screen.getByText('Parcel.png').closest('li') as HTMLElement).getByRole('button', { name: 'View' }));
    const viewer = await screen.findByRole('dialog', { name: 'Parcel.png' });
    expect(await within(viewer).findByText('Could not open the picture')).toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(viewer).getByRole('img')).toHaveAttribute('src', 'blob:test/1'));
  });

  it('uploads several files one after another, and a refused one does not stop the rest', async () => {
    const order0 = { id: 1, attachments: [] } as unknown as Order;
    const calls: string[] = [];
    let release: () => void = () => {};
    const upload = vi.spyOn(api, 'uploadProjectAttachment').mockImplementation(async (_id, file: File) => {
      calls.push(`start ${file.name}`);
      if (file.name === 'one.pdf') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        calls.push('end one.pdf');
        throw new Error('File too large');
      }
      calls.push(`end ${file.name}`);
      return {} as never;
    });
    render(<OrderAttachments order={order0} canEdit />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toHaveAttribute('multiple');
    const files = [new File(['1'], 'one.pdf'), new File(['2'], 'two.pdf')];
    fireEvent.change(input, { target: { files } });

    expect(await screen.findByRole('button', { name: 'Uploading 1 of 2…' })).toBeDisabled();
    expect(calls).toEqual(['start one.pdf']);
    await act(async () => release());
    await waitFor(() => expect(calls).toEqual(['start one.pdf', 'end one.pdf', 'start two.pdf', 'end two.pdf']));
    expect(await screen.findByText('one.pdf: File too large')).toBeInTheDocument();
    expect(upload).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload…' })).toBeEnabled());
  });

  it('says there are no attachments yet', () => {
    render(<OrderAttachments order={{ id: 1, attachments: [] } as unknown as Order} canEdit />);
    expect(screen.getByText('No attachments yet.')).toBeInTheDocument();
  });
});
