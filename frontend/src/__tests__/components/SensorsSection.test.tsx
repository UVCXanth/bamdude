import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../utils';
import { SensorsSection } from '../../components/zigbee/SensorsSection';
import { api } from '../../api/client';
import type { ZigbeeSensor, ZigbeeStatus } from '../../api/client';

const UP: ZigbeeStatus = { state: 'up', reason: null, coordinator: null, network: null, radio_changed: null };
const DOWN: ZigbeeStatus = { state: 'error', reason: 'no dongle', coordinator: null, network: null, radio_changed: null };

function sensor(over: Partial<ZigbeeSensor> = {}): ZigbeeSensor {
  return {
    id: 1,
    name: 'Майстерня',
    location: null,
    printer_id: null,
    printer_name: null,
    ieee: 'aa:bb',
    nwk: 1,
    manufacturer: 'SONOFF',
    model: 'SNZB-02DR2',
    power: 'battery',
    quirk_applied: true,
    unreachable: false,
    present: true,
    measurements: {},
    ...over,
  };
}

function stub(status: ZigbeeStatus, sensors: ZigbeeSensor[]) {
  vi.spyOn(api, 'getZigbeeStatus').mockResolvedValue(status);
  vi.spyOn(api, 'getZigbeeSensors').mockResolvedValue({ sensors });
  vi.spyOn(api, 'getZigbeeDevices').mockResolvedValue({ devices: [] });
  vi.spyOn(api, 'getPrinterLocations').mockResolvedValue({ locations: [] });
  vi.spyOn(api, 'getHASensors').mockResolvedValue([]);
  vi.spyOn(api, 'getLocationHASensors').mockResolvedValue([]);
  vi.spyOn(api, 'getHASensorManagementReadings').mockResolvedValue({ configured: false, readings: [] });
  vi.spyOn(api, 'getLocationHASensorManagementReadings').mockResolvedValue({ configured: false, readings: [] });
  vi.spyOn(api, 'getPrinters').mockResolvedValue([]);
  vi.spyOn(api, 'getLocations').mockResolvedValue([]);
}

describe('SensorsSection', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists what has been added', async () => {
    stub(UP, [sensor()]);

    render(<SensorsSection adoptDevice={null} onAdoptHandled={() => {}} />);

    expect(await screen.findByText('Майстерня')).toBeInTheDocument();
  });

  it('groups one HA entity across printer and storage without mixing their readings', async () => {
    stub(UP, []);
    vi.mocked(api.getHASensors).mockResolvedValue([{ id: 1, printer_id: 3, name: 'Room probe',
      entity_id: 'sensor.room_temperature', kind: 'numeric', device_class: 'temperature', unit: '°C',
      show_on_printer_card: false }] as never);
    vi.mocked(api.getLocationHASensors).mockResolvedValue([{ id: 1, location_id: 5, name: 'Drybox probe',
      entity_id: 'sensor.room_temperature', kind: 'numeric', device_class: 'temperature', unit: '°C',
      show_on_card: true }] as never);
    vi.mocked(api.getHASensorManagementReadings).mockResolvedValue({ configured: true, readings: [{
      id: 1, printer_id: 3, name: 'Room probe', entity_id: 'sensor.room_temperature',
      kind: 'numeric', device_class: 'temperature', unit: '°C', state: '23.1', value: 23.1,
      reachable: true, fresh: true, alerting: false, block_print: false,
      show_on_printer_card: false, last_changed: null, last_checked: null, observed_at: null,
    }] });
    vi.mocked(api.getLocationHASensorManagementReadings).mockResolvedValue({ configured: true, readings: [{
      id: 1, location_id: 5, name: 'Drybox probe', entity_id: 'sensor.room_temperature',
      kind: 'numeric', device_class: 'temperature', unit: '°C', state: '19.2', value: 19.2,
      reachable: true, fresh: true, alerting: false, alert_state: null, alert_above: null,
      alert_below: null, show_on_card: true, last_changed: null, last_checked: null, observed_at: null,
    }] });
    render(<SensorsSection adoptDevice={null} onAdoptHandled={() => {}} />);
    expect(await screen.findByText('sensor.room_temperature')).toBeInTheDocument();
    expect(screen.getAllByText('sensor.room_temperature')).toHaveLength(1);
    await userEvent.click(screen.getByText(/2 places using this entity/));
    expect(screen.getByText('23.1 °C')).toBeInTheDocument();
    expect(screen.getByText('19.2 °C')).toBeInTheDocument();
    expect(screen.getByText('Hidden on card')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by place' }), 'storage');
    expect(screen.getByText('19.2 °C')).toBeInTheDocument();
    expect(screen.queryByText('23.1 °C')).not.toBeInTheDocument();
  });

  it('says nothing is added yet rather than looking broken', async () => {
    stub(UP, []);

    render(<SensorsSection adoptDevice={null} onAdoptHandled={() => {}} />);

    expect(await screen.findByText(/No sensors added yet/i)).toBeInTheDocument();
  });

  it('explains a downed radio once, above the list, not on every card', async () => {
    stub(DOWN, [sensor({ present: false }), sensor({ id: 2, name: 'Склад', present: false })]);

    render(<SensorsSection adoptDevice={null} onAdoptHandled={() => {}} />);

    // The cards arrive on their own query, which settles after the status one
    // the banner reads -- so wait for a card, not for the banner.
    expect(await screen.findByText('Майстерня')).toBeInTheDocument();
    expect(screen.getByText('Склад')).toBeInTheDocument();
    expect(screen.getByText(/radio is down/i)).toBeInTheDocument();
  });

  it('can add Home Assistant sensors while the Zigbee radio is down', async () => {
    stub(DOWN, []);
    vi.mocked(api.getHASensorManagementReadings).mockResolvedValue({ configured: true, readings: [] });
    vi.mocked(api.getLocationHASensorManagementReadings).mockResolvedValue({ configured: true, readings: [] });
    render(<SensorsSection adoptDevice={null} onAdoptHandled={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /Add sensor/i }));
    expect(screen.getByRole('button', { name: 'Zigbee' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Home Assistant' }));
    expect(screen.getByRole('button', { name: 'Printer' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Spool storage' })).toBeEnabled();
  });

  it('keeps Zigbee controls usable when a Home Assistant readings request fails', async () => {
    stub(UP, [sensor()]);
    vi.mocked(api.getHASensorManagementReadings).mockRejectedValue(new Error('HA batch unavailable'));
    render(<SensorsSection adoptDevice={null} onAdoptHandled={() => {}} />);
    expect(await screen.findByText('Майстерня')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    expect(screen.getByRole('combobox', { name: 'Filter by source' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add sensor/i })).toBeEnabled();
  });

  it('the unbind confirmation names the boundary it does not cross', async () => {
    // Unbinding is not removing from the network. The confirmation is the only
    // place a person learns the difference.
    stub(UP, [sensor()]);

    render(<SensorsSection adoptDevice={null} onAdoptHandled={() => {}} />);
    await screen.findByText('Майстерня');
    await userEvent.click(screen.getByLabelText(/delete/i));

    expect(await screen.findByText(/stays on the Zigbee network/i)).toBeInTheDocument();
    expect(screen.getByText(/separate action/i)).toBeInTheDocument();
  });

  it('opens the reporting settings for a sensor', async () => {
    stub(UP, [sensor()]);
    vi.spyOn(api, 'getDeviceSettings').mockResolvedValue({
      ieee: 'aa:bb',
      kind: 'sensor',
      name: 'SONOFF',
      adopted: true,
      editable: { temperature: ['max_interval'] },
      units: { temperature: '°C' },
      desired: { temperature: { min_interval: 30, max_interval: 900, reportable_change: 0.1 } },
      applied: {
        temperature: {
          state: 'ok',
          verification: 'verified',
          values: { min_interval: 30, max_interval: 900, reportable_change: 0.1 },
          actual: null,
          at: null,
          describes_desired: true,
        },
      },
      poll_seconds: 30,
      poll_supported: false,
      stale_after_seconds: 21600,
    });

    render(<SensorsSection adoptDevice={null} onAdoptHandled={() => {}} />);
    await screen.findByText('Майстерня');
    await userEvent.click(screen.getByLabelText(/Reporting settings/i));

    expect(await screen.findByRole('button', { name: /farm defaults/i })).toBeInTheDocument();
  });
});
