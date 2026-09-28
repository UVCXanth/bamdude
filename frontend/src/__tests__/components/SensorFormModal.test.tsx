import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../utils';
import { SensorFormModal } from '../../components/zigbee/SensorFormModal';
import { api } from '../../api/client';
import type { ZigbeeDevice, ZigbeeSensor } from '../../api/client';

function device(over: Partial<ZigbeeDevice> = {}): ZigbeeDevice {
  return {
    ieee: 'aa:bb:cc:dd:ee:ff:00:11',
    nwk: 1,
    manufacturer: 'SONOFF',
    model: 'SNZB-02DR2',
    kind: 'sensor',
    measurements: ['temperature', 'humidity'],
    name: 'SONOFF SNZB-02DR2',
    adopted: false,
    is_coordinator: false,
    is_plug: false,
    has_metering: false,
    has_electrical_measurement: false,
    ...over,
  };
}

function existing(over: Partial<ZigbeeSensor> = {}): ZigbeeSensor {
  return {
    id: 7,
    name: 'Майстерня',
    location: null,
    printer_id: null,
    printer_name: null,
    ieee: 'aa:bb',
    nwk: 1,
    manufacturer: null,
    model: null,
    power: 'battery',
    quirk_applied: null,
    unreachable: false,
    present: true,
    measurements: {},
    ...over,
  };
}

describe('SensorFormModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getPrinterLocations').mockResolvedValue({ locations: [] });
    vi.spyOn(api, 'getZigbeeSensors').mockResolvedValue({ sensors: [] });
    vi.spyOn(api, 'getPrinters').mockResolvedValue([
      { id: 3, name: 'X1C' },
      { id: 4, name: 'P1S' },
    ] as never);
  });

  it('offers only paired sensors nobody has added', async () => {
    vi.spyOn(api, 'getZigbeeDevices').mockResolvedValue({
      devices: [
        device(),
        device({ ieee: 'ff:ff', name: 'taken', adopted: true }),
        device({ ieee: '11:11', kind: 'plug', is_plug: true, name: 'a plug' }),
      ],
    });

    render(<SensorFormModal sensor={null} initialDevice={null} onClose={() => {}} />);

    expect(await screen.findByRole('option', { name: /SNZB-02DR2/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /taken/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /a plug/ })).not.toBeInTheDocument();
  });

  it('starts from the hardware name so the operator renames rather than types', async () => {
    vi.spyOn(api, 'getZigbeeDevices').mockResolvedValue({ devices: [device()] });

    render(<SensorFormModal sensor={null} initialDevice={device()} onClose={() => {}} />);

    expect(await screen.findByDisplayValue('SONOFF SNZB-02DR2')).toBeInTheDocument();
  });

  it('adopts with the device, the name and the place', async () => {
    vi.spyOn(api, 'getZigbeeDevices').mockResolvedValue({ devices: [device()] });
    const adopt = vi.spyOn(api, 'adoptZigbeeSensor').mockResolvedValue({ id: 1, name: 'Bench' });

    render(<SensorFormModal sensor={null} initialDevice={device()} onClose={() => {}} />);
    const name = await screen.findByDisplayValue('SONOFF SNZB-02DR2');
    await userEvent.clear(name);
    await userEvent.type(name, 'Bench');
    await userEvent.click(screen.getByRole('radio', { name: 'A printer' }));
    await userEvent.selectOptions(screen.getByLabelText('A printer'), '3');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(adopt).toHaveBeenCalledWith({
        zigbee_ieee: 'aa:bb:cc:dd:ee:ff:00:11',
        name: 'Bench',
        initial_binding: {
          printer_id: 3, printer_location_id: null, storage_location_id: null,
          display_name: null, visible: true, sort_order: 0, notify_enabled: false,
        },
      }),
    );
  });

  it('adds a second printer while retaining the existing room binding', async () => {
    const add = vi.spyOn(api, 'addZigbeeSensorBinding').mockResolvedValue({ id: 12 } as never);

    render(
      <SensorFormModal
        sensor={existing({ bindings: [{ id: 11, sensor_id: 7, printer_id: null, printer_name: null,
          printer_location_id: 9, location: { id: 9, name: 'Shop', parent_id: null, path: 'Shop' },
          storage_location_id: null, storage_location_name: null, display_name: null,
          visible: true, sort_order: 0, notify_enabled: true }] })}
        initialDevice={null}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText('Shop')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'P1S' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/choose a target/i), '4');
    await userEvent.click(screen.getByRole('button', { name: /add binding/i }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(7, expect.objectContaining({ printer_id: 4,
        printer_location_id: null, storage_location_id: null })),
    );
  });

  it('shows an existing printer binding as an independent target', async () => {
    render(
      <SensorFormModal sensor={existing({ bindings: [{ id: 15, sensor_id: 7, printer_id: 3,
        printer_name: 'X1C', printer_location_id: null, location: null, storage_location_id: null,
        storage_location_name: null, display_name: null, visible: true, sort_order: 0,
        notify_enabled: true }] })} initialDevice={null} onClose={() => {}} />,
    );

    expect(await screen.findByText('X1C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  it('removes only the selected binding', async () => {
    const remove = vi.spyOn(api, 'deleteZigbeeSensorBinding').mockResolvedValue({ deleted: 15 });

    render(
      <SensorFormModal sensor={existing({ bindings: [{ id: 15, sensor_id: 7, printer_id: 3,
        printer_name: 'X1C', printer_location_id: null, location: null, storage_location_id: null,
        storage_location_name: null, display_name: null, visible: true, sort_order: 0,
        notify_enabled: true }] })} initialDevice={null} onClose={() => {}} />,
    );

    await userEvent.click(await screen.findByRole('button', { name: /remove/i }));
    const confirmation = await screen.findByRole('dialog', { name: 'Remove' });
    expect(within(confirmation).getByText(/device-level alerts will resume/i)).toBeInTheDocument();
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(7, 15));
  });

  it('editing does not offer to change the device', async () => {
    // A sensor's device does not change: to move to another one you unbind and
    // adopt again.
    vi.spyOn(api, 'getZigbeeDevices').mockResolvedValue({ devices: [device()] });

    render(<SensorFormModal sensor={existing()} initialDevice={null} onClose={() => {}} />);

    expect(await screen.findByDisplayValue('Майстерня')).toBeInTheDocument();
    expect(screen.queryByLabelText(/device/i)).not.toBeInTheDocument();
  });
});
