import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { api } from '../../api/client';
import { MQTTDebugModal } from '../../components/MQTTDebugModal';

afterEach(() => vi.restoreAllMocks());

function mount(size = 128) {
  vi.spyOn(api, 'getMQTTRecording').mockResolvedValue({ entries: [], recording: false, size_bytes: size });
  render(<MQTTDebugModal printerId={7} printerName="Synthetic Printer" onClose={vi.fn()} />);
}

describe('MQTT recording download button', () => {
  it('disables repeat downloads until the authenticated download finishes', async () => {
    let finish!: () => void;
    const download = vi.spyOn(api, 'downloadMQTTRecording').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    mount();
    const button = screen.getByRole('button', { name: /download/i });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(download).toHaveBeenCalledWith(7);
    expect(button).toBeDisabled();
    finish();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('shows a failed download and allows retry', async () => {
    vi.spyOn(api, 'downloadMQTTRecording').mockRejectedValue(new Error('Recording no longer exists'));
    mount();
    const button = screen.getByRole('button', { name: /download/i });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText('Recording no longer exists')).toBeVisible();
    expect(button).toBeEnabled();
  });

  it('does not offer downloading an empty recording', async () => {
    mount(0);
    expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
  });
});
