/**
 * Which models a saved print profile may carry swap macros for is the swap-profile
 * catalog's answer, not a list of this panel's own: a model gains swap mode when
 * a profile names it (the A2L did), and a second list here would keep its
 * profiles stripped of their swap macros on every save.
 */

import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { PrintOptionsPreferencesPanel } from '../../../components/settings/PrintOptionsPreferencesPanel';
import type { PrintOptionsPreferenceAdminEntry, PrintOptionsPreferenceData } from '../../../api/client';

const options: PrintOptionsPreferenceData = {
  print_options: {
    bed_levelling: 'on',
    flow_cali: 'on',
    layer_inspect: false,
    timelapse: false,
    mesh_mode_fast_check: true,
    gcode_injection: false,
    nozzle_offset_cali: 'on',
    preheat_override: 'inherit',
    preheat_chamber_target_override: null,
  },
  swap_macros: { execute: true, events: ['swap_mode_start', 'swap_mode_change_table'] },
  event_macros: { deselected_ids: [] },
};

function entryFor(model: string): PrintOptionsPreferenceAdminEntry {
  return { user_id: 1, username: 'operator', printer_model: model, options, updated_at: '2026-09-30T10:00:00Z' };
}

function stub(model: string, saved: PrintOptionsPreferenceData[]) {
  server.use(
    http.get('/api/v1/print-option-preferences/admin/list', () => HttpResponse.json([entryFor(model)])),
    http.get('/api/v1/print-option-preferences/system', () => HttpResponse.json([])),
    http.get('/api/v1/users/slim', () => HttpResponse.json([{ id: 1, username: 'operator' }])),
    http.get('/api/v1/printers/', () => HttpResponse.json([])),
    http.get('/api/v1/macros/', () => HttpResponse.json([])),
    http.get('/api/v1/macros/swap-profiles', () =>
      HttpResponse.json([{ id: 'a2l_stl', label: 'STL Edition', description: null, models: ['A2L'] }]),
    ),
    http.put('/api/v1/print-option-preferences/admin/1/:model', async ({ request }) => {
      const body = (await request.json()) as PrintOptionsPreferenceData;
      saved.push(body);
      return HttpResponse.json({ printer_model: model, options: body, updated_at: '2026-09-30T10:01:00Z' });
    }),
  );
}

async function openEditor() {
  await userEvent.click(await screen.findByTitle('Edit'));
  await screen.findByRole('dialog');
}

describe('PrintOptionsPreferencesPanel — swap macros follow the swap-profile catalog', () => {
  it('offers and keeps swap macros for a model a profile lists', async () => {
    const saved: PrintOptionsPreferenceData[] = [];
    stub('A2L', saved);
    render(<PrintOptionsPreferencesPanel />);

    await openEditor();
    expect(await screen.findByText('Swap Macros')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].swap_macros).toEqual({ execute: true, events: ['swap_mode_start', 'swap_mode_change_table'] });
  });

  it('strips swap macros from a model no profile lists', async () => {
    const saved: PrintOptionsPreferenceData[] = [];
    stub('X1C', saved);
    render(<PrintOptionsPreferencesPanel />);

    await openEditor();
    // Save waits for the catalog: an unanswered one hides the controls too,
    // and judging the model before it answered would pass for the wrong reason.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(screen.queryByText('Swap Macros')).not.toBeInTheDocument();
    expect(saved[0].swap_macros).toEqual({ execute: false, events: [] });
  });
});
