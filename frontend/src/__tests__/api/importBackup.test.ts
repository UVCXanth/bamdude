/**
 * A refused restore says why (spec §4.3, plan A6): the raw-fetch restore call reads a 409's detail — the
 * {error, message} the preview quiesce answers and the plain sentence of the part-render gate alike — instead of
 * a toast with no text, and the previews' refusal has a sentence of its own.
 */

import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { api } from '../../api/client';
import { restoreFailureText } from '../../utils/restoreFailure';
import { server } from '../mocks/server';

const file = new File(['PK'], 'backup.zip');
const t = (key: string) => `t:${key}`;

describe('importBackup', () => {
  it('reads the previews quiesce refusal as a code and a message', async () => {
    server.use(
      http.post('/api/v1/settings/restore', () =>
        HttpResponse.json({ detail: { error: 'preview_quiesce_unproven', message: 'server sentence' } }, { status: 409 }),
      ),
    );
    const result = await api.importBackup(file);
    expect(result).toEqual({ success: false, message: 'server sentence', code: 'preview_quiesce_unproven' });
    expect(restoreFailureText(result, t)).toBe('t:backup.previewQuiesceUnproven');
  });

  it('reads a plain-sentence refusal', async () => {
    server.use(
      http.post('/api/v1/settings/restore', () =>
        HttpResponse.json({ detail: 'The part thumbnail worker could not prove its last attempt ended.' }, { status: 409 }),
      ),
    );
    const result = await api.importBackup(file);
    expect(result.success).toBe(false);
    expect(restoreFailureText(result, t)).toBe('The part thumbnail worker could not prove its last attempt ended.');
  });

  it('falls back to the generic sentence when a refusal carries no text', async () => {
    server.use(http.post('/api/v1/settings/restore', () => HttpResponse.json({}, { status: 500 })));
    const result = await api.importBackup(file);
    expect(restoreFailureText(result, t)).toBe('t:backup.failedToRestore');
  });

  it('passes a success through unchanged', async () => {
    server.use(http.post('/api/v1/settings/restore', () => HttpResponse.json({ success: true, message: 'restored' })));
    expect(await api.importBackup(file)).toEqual({ success: true, message: 'restored' });
  });
});
