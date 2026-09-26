/**
 * The rack-position pick leaves the dialog on every path that prints
 * (upstream #1784, adapted).
 *
 * Upstream's direct print was a queue row, so the pick needed only the queue
 * payloads. Here a direct print goes straight to the dispatcher, so the pick has
 * to ride the reprint / library-print request as well — and a pick is made on
 * ONE printer's rack, so it must never be sent to another.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { PrintModal } from '../../components/PrintModal';
import type { PrintQueueItem } from '../../api/client';

const printers = [{ id: 1, name: 'H2C One', model: 'H2C', ip_address: '192.168.1.100', enabled: true, is_active: true }];

const group = (over = {}) => ({ on_rack: true, nozzle_diameter: '0.40', volume_type: 'High Flow', filament_color: '', ...over });

// Upstream's plate: groups 2/0/1 — groups 1 and 2 on the rack, group 0 fixed.
const filamentReqs = {
  filaments: [
    { slot_id: 1, type: 'PLA', color: '#DE4343', used_grams: 7, used_meters: 2, group_id: 2, group: group() },
    { slot_id: 2, type: 'PLA', color: '#F4EE2A', used_grams: 7, used_meters: 2, group_id: 0, group: group({ on_rack: false }) },
    { slot_id: 3, type: 'PLA', color: '#0078BF', used_grams: 9, used_meters: 3, group_id: 1, group: group() },
  ],
};

const rackSlot = (id: number) => ({
  id, nozzle_type: 'HH01', nozzle_diameter: '0.4', wear: null, stat: null, max_temp: 300,
  serial_number: '', filament_color: '', filament_id: '', filament_type: '',
});

const printerStatus = {
  id: 1,
  name: 'H2C One',
  connected: true,
  state: 'IDLE',
  ams: [
    {
      id: 0,
      tray: [
        { id: 0, tray_type: 'PLA', tray_color: 'DE4343', tray_info_idx: 'GFA00' },
        { id: 1, tray_type: 'PLA', tray_color: 'F4EE2A', tray_info_idx: 'GFA00' },
        { id: 2, tray_type: 'PLA', tray_color: '0078BF', tray_info_idx: 'GFA00' },
      ],
    },
  ],
  vt_tray: [],
  ams_extruder_map: {},
  nozzle_rack: [1, 2, 3, 4, 5, 6].map((p) => rackSlot(15 + p)).concat(rackSlot(1)),
};

describe('the rack pick on the wire', () => {
  let posted: Record<string, unknown> | undefined;
  let patched: Record<string, unknown> | undefined;
  let reprinted: Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    posted = undefined;
    patched = undefined;
    reprinted = undefined;
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json(printerStatus)),
      http.get('/api/v1/printers/:id/spool-assignments', () => HttpResponse.json([])),
      http.get('/api/v1/archives/:id/plates', () => HttpResponse.json({ is_multi_plate: false, plates: [] })),
      http.get('/api/v1/archives/:id/filament-requirements', () => HttpResponse.json(filamentReqs)),
      http.post('/api/v1/queue/', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 9, status: 'pending', created_item_ids: [9] });
      }),
      http.patch('/api/v1/queue/:id', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 7, status: 'pending' });
      }),
      http.post('/api/v1/archives/:id/reprint', async ({ request }) => {
        reprinted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ status: 'dispatched', dispatch_job_id: 1 });
      }),
    );
  });

  /** The rack pickers, in slot order: the red group's first, then the blue one's. */
  const pickers = async () => {
    const found = await screen.findAllByLabelText('Rack position');
    expect(found).toHaveLength(2);
    return found as HTMLSelectElement[];
  };

  it('a queued job carries the positions the operator picked', async () => {
    const user = userEvent.setup();
    render(<PrintModal mode="add-to-queue" archiveId={1} archiveName="Benchy" initialSelectedPrinterIds={[1]}
      onClose={vi.fn()} onSuccess={vi.fn()} />);

    const [red] = await pickers();
    await user.selectOptions(red, '4');
    await user.click(screen.getByRole('button', { name: /add to queue/i }));

    await waitFor(() => expect(posted).toBeDefined());
    // Every rack group is written back, not only the edited one.
    expect(posted!.nozzle_rack_choice).toEqual({ '1': 1, '2': 4 });
  });

  it('an untouched picker sends no pick, so the dispatcher assigns', async () => {
    const user = userEvent.setup();
    render(<PrintModal mode="add-to-queue" archiveId={1} archiveName="Benchy" initialSelectedPrinterIds={[1]}
      onClose={vi.fn()} onSuccess={vi.fn()} />);

    await pickers();
    await user.click(screen.getByRole('button', { name: /add to queue/i }));

    await waitFor(() => expect(posted).toBeDefined());
    expect(posted).not.toHaveProperty('nozzle_rack_choice');
  });

  it('a direct print carries the pick to the dispatcher', async () => {
    const user = userEvent.setup();
    render(<PrintModal mode="reprint" archiveId={1} archiveName="Benchy" initialSelectedPrinterIds={[1]}
      onClose={vi.fn()} onSuccess={vi.fn()} />);

    const [, blue] = await pickers();
    await user.selectOptions(blue, '5');
    const print = screen.getByRole('button', { name: /^print$/i });
    await waitFor(() => expect(print).toBeEnabled());
    await user.click(print);

    await waitFor(() => expect(reprinted).toBeDefined());
    expect(reprinted!.nozzle_rack_choice).toEqual({ '1': 5, '2': 2 });
  });

  it('an edited item shows its saved pick and keeps it', async () => {
    const user = userEvent.setup();
    const item = {
      id: 7, queue_id: 1, printer_id: 1, archive_id: 1, library_file_id: null, waiting_reason: null,
      origin: 'queue', nozzle_offset_cali: 'off', mesh_mode_fast_check: true, execute_swap_macros: false,
      swap_macro_events: null, selected_macro_ids: null, gcode_injection: false, preheat_override: 'inherit',
      preheat_chamber_target_override: null, position: 1, scheduled_time: null, auto_off_after: false,
      manual_start: false, require_previous_success: false, ams_mapping: [0, 1, 2], plate_id: null,
      bed_levelling: 'on', flow_cali: 'on', layer_inspect: false, timelapse: false, use_ams: true,
      status: 'pending', started_at: null, completed_at: null, error_message: null,
      created_at: '2024-01-01T00:00:00Z', archive_name: 'Benchy', archive_thumbnail: null,
      printer_name: 'H2C One', print_time_seconds: 3600,
      nozzle_rack_choice: { 2: 3, 1: 6 },
    } as unknown as PrintQueueItem;
    render(<PrintModal mode="edit-queue-item" archiveId={1} archiveName="Benchy" queueItem={item}
      onClose={vi.fn()} onSuccess={vi.fn()} />);

    // The mapping panel opens collapsed when editing.
    await user.click(await screen.findByRole('button', { name: /filament mapping/i }));
    const [red, blue] = await pickers();
    expect(red.value).toBe('3');
    expect(blue.value).toBe('6');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(patched).toBeDefined());
    expect(patched!.nozzle_rack_choice).toEqual({ '1': 6, '2': 3 });
  });
});
