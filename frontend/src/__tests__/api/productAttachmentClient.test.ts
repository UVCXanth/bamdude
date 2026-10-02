/**
 * A product document's bytes (WS-13 E9 G02, R07): the same authorised blob fetch an order's
 * attachments use — the session refreshed once after a 401, a refusal in the server's own
 * words — on the existing route, no new one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, fetchAuthorizedBlob } from '../../api/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getProductAttachment', () => {
  it('reads the product’s attachment route, refreshing the session once on a 401', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/auth/refresh')) {
          return { ok: true, status: 200, json: async () => ({ access_token: 'fresh' }) } as unknown as Response;
        }
        return calls.filter((u) => u.includes('/attachments/')).length === 1
          ? ({ ok: false, status: 401, json: async () => ({ detail: 'Token has expired' }) } as unknown as Response)
          : ({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response);
      }),
    );
    const blob = await api.getProductAttachment(7, 'a b.pdf');
    expect(blob).toBeInstanceOf(Blob);
    expect(calls.filter((u) => u === '/api/v1/products/7/attachments/a%20b.pdf')).toHaveLength(2);
    expect(calls.filter((u) => u.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('a refusal is the server’s sentence with its status, never «HTTP 403»', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ detail: 'You may not read this product' }) }) as unknown as Response),
    );
    const error = await api.getProductAttachment(7, 'a.pdf').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('You may not read this product');
    expect((error as ApiError).status).toBe(403);
  });

  it('is the one authorised blob fetch — an order attachment goes the same way', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        return { ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response;
      }),
    );
    await fetchAuthorizedBlob('/api/v1/anything');
    await api.getProjectAttachment(3, 'q.pdf');
    expect(seen).toEqual(['/api/v1/anything', '/api/v1/projects/3/attachments/q.pdf']);
  });
});
