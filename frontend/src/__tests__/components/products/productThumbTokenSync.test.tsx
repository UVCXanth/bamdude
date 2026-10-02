/**
 * The catalog's picture and the app's ONE media-token recovery (WS-13 E8-V01, Codex review):
 * `useStreamTokenSync` — mounted as a sibling of the pages, as `App` does — stamps a token on a
 * picture asked without it and refreshes the token when a picture fails with it, rewriting every
 * `<img>` still on the page. The thumb must leave its `<img>` there for that, swap in its
 * placeholder only for a failure nobody retried, and take it away again when a retry loads.
 * Every token here is a fake.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, setMediaToken } from '../../../api/client';
import { ProductThumb } from '../../../components/products/productRow/ProductThumb';
import { useStreamTokenSync } from '../../../hooks/useCameraStreamToken';

vi.mock('../../../contexts/AuthContext', async (original) => {
  const actual = await original<typeof import('../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => ({ user: { id: 42 }, hasPermission: () => false }) };
});

function Sync() {
  useStreamTokenSync();
  return null;
}

function Page({ id = 8 }: { id?: number }) {
  return (
    <>
      <Sync />
      <ProductThumb product={{ id, has_cover: true }} variant="table" />
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  setMediaToken(null);
});

describe('ProductThumb under the shared media-token recovery', () => {
  it('keeps a bare cover the shared handler is retrying with its first token', () => {
    vi.spyOn(api, 'getMediaToken').mockImplementation(() => new Promise(() => {}));
    render(<Page />);
    const img = screen.getByTestId('product-cover');
    expect(img.getAttribute('src')).not.toContain('token=');
    // The token is there now, but this request had gone out without it.
    setMediaToken('fake-first');
    fireEvent.error(img);
    expect(img.getAttribute('src')).toContain('token=fake-first');
    expect(screen.queryByTestId('product-cover-placeholder')).not.toBeInTheDocument();
    expect(img).toBeInTheDocument();
    expect(img).toBeVisible();
  });

  it('retries the cover with the refreshed token after the server dropped the old one, and shows it when it loads', async () => {
    let resolveFresh!: (value: { token: string }) => void;
    const mint = vi
      .spyOn(api, 'getMediaToken')
      .mockResolvedValueOnce({ token: 'fake-old' })
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFresh = resolve)));
    render(<Page />);
    await waitFor(() => expect(screen.getByTestId('product-cover').getAttribute('src')).toContain('fake-old'));
    fireEvent.error(screen.getByTestId('product-cover'));
    // An ordinary failure with the current token: the placeholder, while the token is asked again.
    expect(screen.getByTestId('product-cover-placeholder')).toBeInTheDocument();
    await waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
    await act(async () => resolveFresh({ token: 'fake-fresh' }));
    const img = screen.getByTestId('product-cover');
    await waitFor(() => expect(img.getAttribute('src')).toContain('fake-fresh'));
    fireEvent.load(img);
    expect(screen.queryByTestId('product-cover-placeholder')).not.toBeInTheDocument();
    expect(img).toBeVisible();
  });

  it('answers a failure nobody retries with the placeholder, and asks for nothing itself', async () => {
    // The server mints the same token again: the refresh changes nothing, nothing is retried.
    const mint = vi.spyOn(api, 'getMediaToken').mockResolvedValue({ token: 'fake-same' });
    render(<Page />);
    await waitFor(() => expect(screen.getByTestId('product-cover').getAttribute('src')).toContain('fake-same'));
    const img = screen.getByTestId('product-cover');
    const asked = img.getAttribute('src');
    fireEvent.error(img);
    fireEvent.error(img);
    expect(screen.getByTestId('product-cover-placeholder')).toBeInTheDocument();
    expect(img).not.toBeVisible();
    expect(img.getAttribute('src')).toBe(asked);
    // One refresh at most (the shared handler's own limit) — never a loop.
    await waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('gives another product its own picture, not the last one’s failure', async () => {
    vi.spyOn(api, 'getMediaToken').mockResolvedValue({ token: 'fake-same' });
    const { rerender } = render(<Page />);
    await waitFor(() => expect(screen.getByTestId('product-cover').getAttribute('src')).toContain('fake-same'));
    fireEvent.error(screen.getByTestId('product-cover'));
    expect(screen.getByTestId('product-cover-placeholder')).toBeInTheDocument();
    rerender(<Page id={9} />);
    expect(screen.queryByTestId('product-cover-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('product-cover')).toBeVisible();
  });
});
