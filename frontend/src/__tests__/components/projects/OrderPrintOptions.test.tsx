import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { api } from '../../../api/client';
import type { OrderPrintOptionsResponse } from '../../../api/client';
import { DEFAULT_PRINT_OPTIONS } from '../../../components/PrintModal/types';
import { OrderPrintOptions } from '../../../components/projects/OrderPrintOptions';
import { render } from '../../utils';

function fixture(): OrderPrintOptionsResponse {
  return {
    overrides: {},
    models: [
      { model: 'A1 Mini', custom: false, capabilities: {
        known: true, supported: { flow_cali: true, bed_levelling: true, nozzle_offset_cali: false, layer_inspect: false },
        auto: { bed_levelling: false, flow_cali: false, nozzle_offset_cali: false },
      }, inherited: { ...DEFAULT_PRINT_OPTIONS, nozzle_offset_cali: 'off' }, options: { ...DEFAULT_PRINT_OPTIONS, nozzle_offset_cali: 'off' } },
      { model: 'P1S', custom: false, capabilities: {
        known: true, supported: { flow_cali: false, bed_levelling: true, nozzle_offset_cali: false, layer_inspect: false },
        auto: { bed_levelling: false, flow_cali: false, nozzle_offset_cali: false },
      }, inherited: { ...DEFAULT_PRINT_OPTIONS, flow_cali: 'off', nozzle_offset_cali: 'off' }, options: { ...DEFAULT_PRINT_OPTIONS, flow_cali: 'off', nozzle_offset_cali: 'off' } },
      { model: 'H2D', custom: false, capabilities: {
        known: true, supported: { flow_cali: true, bed_levelling: true, nozzle_offset_cali: true, layer_inspect: false },
        auto: { bed_levelling: true, flow_cali: true, nozzle_offset_cali: true },
      }, inherited: { ...DEFAULT_PRINT_OPTIONS }, options: { ...DEFAULT_PRINT_OPTIONS } },
    ],
  };
}

async function open(canEdit = true, busy = false) {
  const blocked = vi.fn();
  render(<OrderPrintOptions orderId={1} canEdit={canEdit} busy={busy} onBlocked={blocked} />);
  fireEvent.click(screen.getByRole('button', { name: 'Print parameters for this order' }));
  await screen.findByRole('tab', { name: 'A1 Mini' });
  return blocked;
}

function custom() {
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use custom parameters for this order and model' }));
}

describe('OrderPrintOptions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getOrderPrintOptions').mockResolvedValue(fixture());
    vi.spyOn(api, 'setOrderPrintOptions').mockImplementation(async (_id, overrides) => ({ ...fixture(), overrides }));
  });

  it('keeps independent model choices, hides unsupported functions and limits auto mode', async () => {
    const blocked = await open();
    expect(screen.getByRole('button', { name: 'Save parameters' })).toBeDisabled();
    expect(api.setOrderPrintOptions).not.toHaveBeenCalled();
    custom();
    const a1 = screen.getByRole('tabpanel', { name: 'A1 Mini' });
    expect(within(a1).getByText('Flow Calibration')).toBeInTheDocument();
    expect(within(a1).queryByRole('button', { name: 'Auto' })).not.toBeInTheDocument();
    const flow = within(a1).getByText('Flow Calibration').parentElement!.parentElement!;
    fireEvent.click(within(flow).getByRole('button', { name: 'Off' }));
    fireEvent.click(screen.getByRole('tab', { name: 'P1S' }));
    custom();
    const p1s = screen.getByRole('tabpanel', { name: 'P1S' });
    expect(within(p1s).queryByText('Flow Calibration')).not.toBeInTheDocument();
    expect(within(p1s).queryByText('Nozzle Offset Calibration')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'H2D' }));
    custom();
    const h2 = screen.getByRole('tabpanel', { name: 'H2D' });
    const nozzle = within(h2).getByText('Nozzle Offset Calibration').parentElement!.parentElement!;
    fireEvent.click(within(nozzle).getByRole('button', { name: 'Auto' }));
    await waitFor(() => expect(blocked).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
    await waitFor(() => expect(api.setOrderPrintOptions).toHaveBeenCalledWith(1, expect.objectContaining({
      'A1 Mini': expect.objectContaining({ flow_cali: 'off' }),
      P1S: expect.objectContaining({ flow_cali: 'off' }),
      H2D: expect.objectContaining({ nozzle_offset_cali: 'auto' }),
    })));
    await waitFor(() => expect(blocked).toHaveBeenLastCalledWith(false));
  });

  it('cancel restores inheritance and clears the enqueue block without a write', async () => {
    const blocked = await open();
    custom();
    await waitFor(() => expect(blocked).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(blocked).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(api.setOrderPrintOptions).not.toHaveBeenCalled();
  });

  it('failed save keeps explicit choices and blocks enqueue until cancel/retry', async () => {
    vi.mocked(api.setOrderPrintOptions).mockRejectedValue(new Error('Synthetic refusal'));
    const blocked = await open();
    custom();
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic refusal');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(blocked).toHaveBeenLastCalledWith(true);
  });

  it.each([[false, false], [true, true]])('read-only or enqueue-in-flight cannot change choices (%s/%s)', async (canEdit, busy) => {
    await open(canEdit, busy);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(api.setOrderPrintOptions).not.toHaveBeenCalled();
  });

  it('persisted overrides survive reload and can be removed for just one model', async () => {
    const data = fixture();
    data.overrides = { 'A1 Mini': { ...data.models[0].inherited, flow_cali: 'off' }, H2D: data.models[2].inherited };
    vi.mocked(api.getOrderPrintOptions).mockResolvedValue(data);
    await open();
    expect(screen.getByRole('checkbox')).toBeChecked();
    custom();
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
    await waitFor(() => expect(api.setOrderPrintOptions).toHaveBeenCalledWith(1, { H2D: data.models[2].inherited }));
  });
});
