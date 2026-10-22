import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type FarmStartupState } from '../../api/client';
import { FarmStartupBanner } from '../../components/FarmStartupBanner';

const held: FarmStartupState = {
  state: 'held', boot_id: 'boot', hold_id: 'hold', reason: 'unclean_shutdown', since: null,
  ready: true, can_resume: true,
};

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><FarmStartupBanner /></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getFarmStartup').mockResolvedValue({ ...held });
  vi.spyOn(api, 'resumeFarmStartup').mockResolvedValue({ ...held, state: 'running', hold_id: null });
});

describe('Farm startup hold', () => {
  it('asks for restart instead of offering resume after restore', async () => {
    vi.mocked(api.getFarmStartup).mockResolvedValue({ ...held, state: 'restart_required', can_resume: false });
    renderBanner();
    expect(await screen.findByText(/Data restore requires a BamDude restart/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('requires a confirmation and sends the identities the operator saw', async () => {
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByRole('button', { name: 'Allow new starts' }));
    expect(api.resumeFarmStartup).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(/already recovered by printer firmware/);
    await user.click(screen.getAllByRole('button', { name: 'Allow new starts' }).at(-1)!);
    await waitFor(() => expect(api.resumeFarmStartup).toHaveBeenCalledWith('boot', 'hold'));
  });

  it('does not hide the hold optimistically from the resume response', async () => {
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByRole('button', { name: 'Allow new starts' }));
    await user.click(screen.getAllByRole('button', { name: 'Allow new starts' }).at(-1)!);
    await waitFor(() => expect(api.getFarmStartup).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status')).toHaveTextContent('New automatic starts are paused');
  });

  it('read-only callers see the reason without a resume button', async () => {
    vi.mocked(api.getFarmStartup).mockResolvedValue({ ...held, can_resume: false });
    renderBanner();
    expect(await screen.findByText('New automatic starts are paused')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('canceling the dialogue leaves the hold unchanged', async () => {
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByRole('button', { name: 'Allow new starts' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.resumeFarmStartup).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a stale or failed release stays visible and rereads the state', async () => {
    vi.mocked(api.resumeFarmStartup).mockRejectedValue(new Error('stale'));
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByRole('button', { name: 'Allow new starts' }));
    await user.click(screen.getAllByRole('button', { name: 'Allow new starts' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent('The pause could not be released');
    expect(screen.getByRole('status')).toHaveTextContent('New automatic starts are paused');
  });
});
