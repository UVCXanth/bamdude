/**
 * Every place that renders HTML it did not write goes through DOMPurify, and each keeps
 * the markup it supports while dropping what runs (issue #93, spec D3).
 *
 * The four surfaces: a MakerWorld summary (DOMPurify's default config), the archive's
 * and the library file's model card (one shared allowlist each), and an order's notes
 * for a reader. The same hostile document goes into each; the test reads the element
 * that holds the sanitized HTML, so a sanitizer that is skipped, or a config that
 * starts dropping lists, links or pictures, fails here whatever the version.
 *
 * None of the October 2026 DOMPurify advisories applies to these calls — they need
 * SAFE_FOR_TEMPLATES with a DOM-returning mode, IN_PLACE with a hook, or the XHTML
 * parser — so this is a regression net for the upgrade, not a proof of an exploit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { api } from '../../api/client';
import type { Order } from '../../api/client';
import { ModelCardModal } from '../../components/ModelCardModal';
import { OrderNotes } from '../../components/projects/OrderNotes';
import { MakerworldPage } from '../../pages/MakerworldPage';

const HOSTILE = [
  '<p>Kept <strong>bold</strong> <em>slanted</em> <u>under</u></p>',
  '<ul><li>first item</li></ul><ol><li>second item</li></ol>',
  '<p><a href="https://example.com/guide" target="_blank" rel="noopener">guide link</a></p>',
  '<p><img src="https://example.com/pic.png"></p>',
  '<script>window.__sanitizerProbe = "script"</script>',
  '<img src="missing.png" onerror="window.__sanitizerProbe = \'onerror\'">',
  '<p><a href="javascript:window.__sanitizerProbe=\'href\'">bad link</a></p>',
  '<iframe src="https://evil.example/frame"></iframe>',
  '<p onclick="window.__sanitizerProbe=\'click\'">clickable</p>',
].join('');

declare global {
  interface Window {
    __sanitizerProbe?: string;
  }
}

/** The element whose innerHTML is the sanitized document. */
async function holder(): Promise<HTMLElement> {
  const kept = await screen.findByText(/^Kept/);
  const element = kept.closest('p')?.parentElement;
  expect(element).toBeTruthy();
  return element as HTMLElement;
}

function expectSanitized(root: HTMLElement, { keepsTarget }: { keepsTarget: boolean }) {
  // What runs is gone.
  expect(root.querySelector('script, iframe')).toBeNull();
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.startsWith('on'), `${element.tagName} keeps ${attribute}`).toBe(false);
    }
  }
  for (const link of root.querySelectorAll('a')) {
    expect(link.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
  }
  expect(root.textContent).toContain('bad link');

  // What the surface supports is kept.
  expect(root.querySelector('strong')).toHaveTextContent('bold');
  expect(root.querySelector('em')).toHaveTextContent('slanted');
  expect(root.querySelector('u')).toHaveTextContent('under');
  expect(root.querySelector('ul > li')).toHaveTextContent('first item');
  expect(root.querySelector('ol > li')).toHaveTextContent('second item');
  const guide = root.querySelector('a[href="https://example.com/guide"]');
  expect(guide).toHaveTextContent('guide link');
  if (keepsTarget) expect(guide).toHaveAttribute('target', '_blank');
  expect(root.querySelector('img[src="https://example.com/pic.png"]')).not.toBeNull();

  // Nothing fired, not even on a click.
  fireEvent.click(screen.getByText('clickable'));
  expect(window.__sanitizerProbe).toBeUndefined();
}

const card = {
  title: 'Desk lamp',
  description: HOSTILE,
  designer: 'Ada',
  designer_user_id: null,
  license: null,
  copyright: null,
  creation_date: null,
  modification_date: null,
  origin: null,
  profile_title: null,
  profile_description: null,
  profile_cover: null,
  profile_user_id: null,
  profile_user_name: null,
  design_model_id: null,
  design_profile_id: null,
  design_region: null,
};

describe('sanitized markup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete window.__sanitizerProbe;
  });
  afterEach(() => {
    delete window.__sanitizerProbe;
  });

  it.each([
    ['description', { description: HOSTILE }],
    ['profile description', { description: null, profile_title: '0.20 Standard', profile_description: HOSTILE }],
  ])("an archive's model card keeps its markup and drops what runs — %s", async (_field, fields) => {
    vi.spyOn(api, 'getArchiveProjectPage').mockResolvedValue({
      ...card,
      ...fields,
      model_pictures: [],
      profile_pictures: [],
      thumbnails: [],
    } as never);
    render(<ModelCardModal source={{ kind: 'archive', id: 12 }} onClose={() => {}} />);

    expectSanitized(await holder(), { keepsTarget: true });
  });

  it.each([
    ['description', { description: HOSTILE }],
    ['profile description', { description: null, profile_title: '0.20 Standard', profile_description: HOSTILE }],
  ])("a library file's model card keeps its markup and drops what runs — %s", async (_field, fields) => {
    vi.spyOn(api, 'getLibraryFileCard').mockResolvedValue({
      ...card,
      ...fields,
      auxiliaries: { pictures: [], bom_docs: [] },
      error: null,
    } as never);
    render(<ModelCardModal source={{ kind: 'file', id: 3 }} onClose={() => {}} />);

    expectSanitized(await holder(), { keepsTarget: true });
  });

  it('an order’s notes, for a reader, keep their markup and drop what runs', async () => {
    render(<OrderNotes order={{ id: 1, notes: HOSTILE } as unknown as Order} canEdit={false} />);

    expectSanitized(await holder(), { keepsTarget: false });
  });

  it('a MakerWorld summary keeps its markup and drops what runs', async () => {
    server.use(
      http.get('/api/v1/makerworld/status', () =>
        HttpResponse.json({ has_cloud_token: true, can_download: true, sign_in_expired: false }),
      ),
      http.get('/api/v1/library/folders', () => HttpResponse.json([])),
      http.post('/api/v1/makerworld/resolve', () =>
        HttpResponse.json({
          model_id: 1400373,
          profile_id: null,
          design: { title: 'Desk lamp', summary: HOSTILE },
          instances: [],
          already_imported_library_ids: [],
          already_imported_by_profile_id: {},
        }),
      ),
    );
    render(<MakerworldPage />);

    fireEvent.change(screen.getByPlaceholderText(/paste any MakerWorld link/), {
      target: { value: 'https://makerworld.com/en/models/1400373' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve/ }));

    expectSanitized(await holder(), { keepsTarget: false });
  });
});
