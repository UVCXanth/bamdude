import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setAuthToken } from '../../api/client';

let click: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  setAuthToken('recording-reader');
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:recording'),
    revokeObjectURL: vi.fn(),
  }));
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  setAuthToken(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MQTT recording download', () => {
  it('sends the bearer token and downloads the raw file without navigating away', async () => {
    const blob = new Blob(['synthetic MQTT recording'], { type: 'text/plain' });
    const fetch = vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }));
    vi.stubGlobal('fetch', fetch);
    await api.downloadMQTTRecording(7);
    expect(fetch).toHaveBeenCalledWith('/api/v1/printers/7/mqtt-recording/download', {
      headers: { Authorization: 'Bearer recording-reader' },
    });
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    const link = click.mock.instances[0] as HTMLAnchorElement;
    expect(link.download).toBe('mqtt-printer-7.log');
    expect(link.href).toBe('blob:recording');
    expect(link.isConnected).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recording');
  });

  it('refreshes an expired session and retries once with the new token', async () => {
    let attempts = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) return {
        ok: true, status: 200, json: async () => ({ access_token: 'refreshed-reader' }),
      };
      return ++attempts === 1
        ? { ok: false, status: 401, json: async () => ({ detail: 'Expired' }) }
        : { ok: true, status: 200, blob: async () => new Blob(['fixture']) };
    });
    vi.stubGlobal('fetch', fetch);
    await api.downloadMQTTRecording(7);
    expect(attempts).toBe(2);
    expect(fetch).toHaveBeenLastCalledWith('/api/v1/printers/7/mqtt-recording/download', {
      headers: { Authorization: 'Bearer refreshed-reader' },
    });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 500])('surfaces a %i refusal without downloading error JSON', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: async () => ({ detail: 'Recording unavailable' }) })));
    await expect(api.downloadMQTTRecording(7)).rejects.toThrow('Recording unavailable');
    expect(click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('cleans up the temporary URL even if browser download fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['fixture']) })));
    click.mockImplementation(() => { throw new Error('Download refused'); });
    await expect(api.downloadMQTTRecording(7)).rejects.toThrow('Download refused');
    expect(document.querySelector('a[download="mqtt-printer-7.log"]')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recording');
  });
});
