/**
 * The upload dialog and STEP pictures (spec §4.1, plan A6): the thumbnail option is shown for STL, OBJ and STEP
 * (and a ZIP that may hold them), says STEP is made in the background, hands every receipt an answer carries to
 * the page's one polling owner — a single upload's and a ZIP's members' alike — and says why none was queued.
 * An older server's answer without the field changes nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FileUploadModal } from '../../components/FileUploadModal';

const EPOCH = 'e'.repeat(32);

function uploaded(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    filename: 'bracket.step',
    file_type: 'step',
    file_tags: ['step'],
    file_size: 13,
    thumbnail_path: null,
    duplicate_of: null,
    outcome: 'created',
    superseded_name: null,
    metadata: null,
    ...over,
  };
}

describe('FileUploadModal — STEP thumbnails', () => {
  const props = () => ({ folderId: null, onClose: vi.fn(), onUploadComplete: vi.fn(), onThumbnailJobs: vi.fn() });

  beforeEach(() => vi.clearAllMocks());

  it.each(['bracket.step', 'BRACKET.STP', 'mesh.obj'])('offers the thumbnail option for %s and says STEP is made in the background', async (name) => {
    render(<FileUploadModal {...props()} initialFiles={[new File(['x'], name)]} />);
    expect(await screen.findByText('Thumbnail generation')).toBeInTheDocument();
    expect(screen.getByText(/STEP thumbnails are made in the background/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Generate thumbnails for STL, OBJ and STEP models/i)).toBeChecked();
  });

  it('hands a single upload’s receipt to the polling owner', async () => {
    server.use(
      http.post('/api/v1/library/files', () =>
        HttpResponse.json(uploaded({ thumbnail_job: { jobs_epoch: EPOCH, receipt_id: 'r9', state: 'queued', error_code: null } })),
      ),
    );
    const p = props();
    render(<FileUploadModal {...p} initialFiles={[new File(['ISO-10303-21;'], 'bracket.step')]} />);
    await userEvent.click(await screen.findByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(p.onThumbnailJobs).toHaveBeenCalledWith(EPOCH, [{ receipt_id: 'r9', file_id: 9 }]));
  });

  it('says why no picture was queued', async () => {
    server.use(
      http.post('/api/v1/library/files', () =>
        HttpResponse.json(uploaded({ thumbnail_job: { jobs_epoch: EPOCH, receipt_id: null, state: null, error_code: 'cad_unavailable' } })),
      ),
    );
    const p = props();
    render(<FileUploadModal {...p} initialFiles={[new File(['ISO-10303-21;'], 'bracket.step')]} />);
    await userEvent.click(await screen.findByRole('button', { name: /Upload \(1\)/ }));
    expect(await screen.findByText(/STEP thumbnail not queued: .*install or repair it/i)).toBeInTheDocument();
    expect(p.onThumbnailJobs).not.toHaveBeenCalled();
  });

  it('hands every STEP member of a ZIP to the polling owner', async () => {
    server.use(
      http.post('/api/v1/library/files/extract-zip', () =>
        HttpResponse.json({
          extracted: 3,
          skipped_duplicates: 0,
          folders_created: 0,
          errors: [],
          files: [
            { filename: 'a.step', file_id: 11, folder_id: null, thumbnail_job: { jobs_epoch: EPOCH, receipt_id: 'ra', state: 'queued', error_code: null } },
            { filename: 'cube.stl', file_id: 12, folder_id: null, thumbnail_job: null },
            { filename: 'b.stp', file_id: 13, folder_id: null, thumbnail_job: { jobs_epoch: EPOCH, receipt_id: 'rb', state: 'queued', error_code: null } },
          ],
        }),
      ),
    );
    const p = props();
    render(<FileUploadModal {...p} initialFiles={[new File(['PK'], 'kit.zip')]} />);
    await userEvent.click(await screen.findByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() =>
      expect(p.onThumbnailJobs).toHaveBeenCalledWith(EPOCH, [
        { receipt_id: 'ra', file_id: 11 },
        { receipt_id: 'rb', file_id: 13 },
      ]),
    );
  });

  it('an older server’s answer without the field changes nothing', async () => {
    server.use(http.post('/api/v1/library/files', () => HttpResponse.json(uploaded())));
    const p = props();
    render(<FileUploadModal {...p} initialFiles={[new File(['ISO-10303-21;'], 'bracket.step')]} />);
    await userEvent.click(await screen.findByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(p.onUploadComplete).toHaveBeenCalled());
    expect(p.onThumbnailJobs).not.toHaveBeenCalled();
  });
});
