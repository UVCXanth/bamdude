import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError, type Archive, type PrintStateIssue, type PrintStatePreview } from '../../api/client';
import { PrintStateIssuesPanel } from '../../components/PrintStateIssuesPanel';
import { PrintStateRecoveryDialog } from '../../components/PrintStateRecoveryDialog';
import { RecoveryEndTime } from '../../components/RecoveryEndTime';

const access = vi.hoisted(() => ({ allowed: true }));
vi.mock('../../contexts/AuthContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../contexts/AuthContext')>(),
  useAuth: () => ({ hasAllPermissions: () => access.allowed }),
}));
const issue: PrintStateIssue = {
  printer_id: 7, printer_name: 'P1S farm', queue_id: 4, kind: 'item', target_id: 11, item_id: 11, archive_id: 19,
  code: 'terminal_archive_active_item', actions: ['align_terminal_item'], blocked_reasons: [],
  live_mode: 'inactive', observed_at: 10, started_at: '2026-10-01T10:00:00Z', completed_at: null,
};
const preview: PrintStatePreview = {
  preview_token: 'opaque-preview', action: 'align_terminal_item', archive_preserved: true, expires_in: 300,
  before: { queue: { status: 'printing', is_paused: false }, item: { status: 'printing' }, archive: {} },
  after: { queue: { status: 'paused', is_paused: true }, item: { status: 'completed' }, archive: {}, delete_item: false },
};
function panel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={queryClient}><PrintStateIssuesPanel /></QueryClientProvider>);
}
beforeEach(() => {
  vi.restoreAllMocks(); access.allowed = true;
  vi.spyOn(api, 'getPrintStateIssues').mockResolvedValue({ issues: [issue], next_cursor: null, truncated: false, checked_at: '2026-10-01T12:00:00Z' });
  vi.spyOn(api, 'previewPrintState').mockResolvedValue(preview);
  vi.spyOn(api, 'applyPrintState').mockResolvedValue({ id: 'audit', action: 'align_terminal_item', printer_id: 7, queue_id: 4, item_id: 11, archive_id: 19 });
  vi.spyOn(api, 'getPrintStateHistory').mockResolvedValue({ actions: [], next_cursor: null });
});

describe('Print-state diagnostics', () => {
  it('does not request or expose diagnostics without all read permissions', () => {
    access.allowed = false; panel();
    expect(screen.queryByText('Print state diagnostics')).not.toBeInTheDocument();
    expect(api.getPrintStateIssues).not.toHaveBeenCalled();
  });
  it('omits deletion entirely when the server has not proven it safe', async () => {
    panel(); await screen.findByText(/P1S farm/);
    expect(screen.getByRole('button', { name: 'Align item with archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove stale item/ })).not.toBeInTheDocument();
  });
  it('renders a request failure separately from an empty healthy page', async () => {
    vi.mocked(api.getPrintStateIssues).mockRejectedValue(new Error('offline'));
    panel(); expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/No inconsistencies/)).not.toBeInTheDocument();
  });
  it('uses explicit cursors even when a partial page contains no issues', async () => {
    vi.mocked(api.getPrintStateIssues).mockResolvedValueOnce({ issues: [], next_cursor: 'next', truncated: true, checked_at: '' });
    const user = userEvent.setup(); panel();
    await user.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(api.getPrintStateIssues).toHaveBeenLastCalledWith({ printer_id: undefined, cursor: 'next' }));
  });
  it('loads an addressed recovery history without granting mutation', async () => {
    vi.mocked(api.getPrintStateIssues).mockResolvedValue({ issues: [{ ...issue, actions: [] }], next_cursor: null, truncated: false, checked_at: '' });
    const user = userEvent.setup(); panel();
    await user.click(await screen.findByRole('button', { name: 'Recovery history' }));
    expect(await screen.findByText('No operator recovery actions for this printer.')).toBeInTheDocument();
    expect(api.getPrintStateHistory).toHaveBeenCalledWith(7, undefined);
    expect(api.applyPrintState).not.toHaveBeenCalled();
  });
});

describe('Addressed recovery confirmation', () => {
  it('requires completion confirmation before an estimate and a second confirmation of the delta', async () => {
    const user = userEvent.setup();
    render(<PrintStateRecoveryDialog issue={issue} action="fill_estimated_end_and_align" onClose={vi.fn()} onApplied={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I confirm that this archive/ }));
    await user.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByText(/queue will stay paused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply this change' })).toBeDisabled();
    expect(api.applyPrintState).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: /I reviewed this change/ }));
    await user.click(screen.getByRole('button', { name: 'Apply this change' }));
    expect(api.applyPrintState).toHaveBeenCalledWith(7, 'opaque-preview');
  });
  it('discards a conflicted preview and never reapplies changed data automatically', async () => {
    vi.mocked(api.applyPrintState).mockRejectedValueOnce(new ApiError('changed', 409));
    const user = userEvent.setup();
    render(<PrintStateRecoveryDialog issue={issue} action="align_terminal_item" onClose={vi.fn()} onApplied={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Preview change' }));
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed/ }));
    await user.click(screen.getByRole('button', { name: 'Apply this change' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Apply this change' })).not.toBeInTheDocument();
    expect(api.previewPrintState).toHaveBeenCalledTimes(1);
    expect(api.applyPrintState).toHaveBeenCalledTimes(1);
  });
  it('retries a lost response with the same token so the server can return its audit', async () => {
    vi.mocked(api.applyPrintState).mockRejectedValueOnce(new Error('response lost'));
    const user = userEvent.setup();
    render(<PrintStateRecoveryDialog issue={issue} action="align_terminal_item" onClose={vi.fn()} onApplied={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Preview change' }));
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed/ }));
    await user.click(screen.getByRole('button', { name: 'Apply this change' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Apply this change' }));
    expect(vi.mocked(api.applyPrintState).mock.calls).toEqual([[7, 'opaque-preview'], [7, 'opaque-preview']]);
    expect(api.previewPrintState).toHaveBeenCalledTimes(1);
  });
  it('labels estimated archive ends, leaving ordinary archive cards unchanged', () => {
    const archive = { completed_at: '2026-10-01T12:00:00Z' } as Archive;
    const { rerender } = render(<RecoveryEndTime archive={archive} />);
    expect(screen.queryByText(/Estimated end/)).not.toBeInTheDocument();
    rerender(<RecoveryEndTime archive={{ ...archive, end_time_source: 'slicer_estimate' }} />);
    expect(screen.getByText(/Estimated end: start/)).toBeInTheDocument();
  });
});
