/**
 * Tests for SystemHealthPanel — the shared log-health result renderer used by
 * the System page and the bug reporter.
 *
 * Covers the three states (clean / log unavailable / findings) and that a
 * finding renders its localized name, cause, fix, category badge, and a wiki
 * deep-link built from the signature's anchor.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import { SystemHealthPanel } from '../../components/SystemHealthPanel';
import type { SystemHealthResult } from '../../api/client';

function renderPanel(result: SystemHealthResult) {
  render(
    <I18nextProvider i18n={i18n}>
      <SystemHealthPanel result={result} />
    </I18nextProvider>,
  );
}

const BASE: SystemHealthResult = {
  findings: [],
  scanned_entries: 1200,
  log_available: true,
  summary: { total: 0, layer8: 0, environment: 0, bug: 0 },
};

describe('SystemHealthPanel', () => {
  it('shows a healthy message when there are no findings', () => {
    renderPanel(BASE);
    expect(screen.getByText(/No known issues found/i)).toBeInTheDocument();
  });

  it('shows a notice when file logging is unavailable', () => {
    renderPanel({ ...BASE, log_available: false });
    expect(screen.getByText(/File logging is disabled/i)).toBeInTheDocument();
  });

  it('renders a finding with localized name, cause, fix, badge, and wiki link', () => {
    renderPanel({
      ...BASE,
      log_available: true,
      findings: [
        {
          signature_id: 'ftp-auth-rejected',
          severity: 'error',
          category: 'layer8',
          wiki_anchor: 'wrong-access-code',
          count: 4,
          first_seen: '2026-05-22 09:00:00,000',
          last_seen: '2026-05-22 10:00:00,000',
          sample: 'FTP connection permission error to [IP]',
        },
      ],
      summary: { total: 1, layer8: 1, environment: 0, bug: 0 },
    });

    expect(screen.getByText('Printer rejected the access code')).toBeInTheDocument();
    expect(screen.getByText(/refused the file-transfer login/i)).toBeInTheDocument();
    expect(screen.getByText(/Re-copy the access code/i)).toBeInTheDocument();
    expect(screen.getByText('You can fix this')).toBeInTheDocument();
    expect(screen.getByText('FTP connection permission error to [IP]')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /How to fix/i });
    expect(link).toHaveAttribute(
      'href',
      'https://docs.bamdude.top/reference/troubleshooting/#wrong-access-code',
    );
  });
});

describe('SystemHealthPanel print-state mention', () => {
  function renderWith(result: SystemHealthResult) {
    render(<I18nextProvider i18n={i18n}><SystemHealthPanel result={result} showPrintState /></I18nextProvider>);
  }
  const coverage = { cycle_complete: true, truncated: false, checked: 3 };

  it('mentions print-state problems once, with a link to the diagnostics and no repair', () => {
    renderWith({ ...BASE, print_state: {
      by_code: { terminal_runtime_context: 1, dispatch_no_progress: 1 }, error: null, checked_at: '2026-10-01T12:00:00Z',
      printers: [{ printer_id: 7, codes: ['dispatch_no_progress', 'terminal_runtime_context'] }], coverage,
    } });
    expect(screen.getByText(/2 print-state problems on 1 printer/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open print state diagnostics' })).toHaveAttribute('href', '#print-state');
    expect(screen.queryByRole('button', { name: /Release/ })).not.toBeInTheDocument();
  });

  it('never calls an incomplete or failed check healthy', () => {
    renderWith({ ...BASE, print_state: { by_code: {}, error: null, checked_at: null, printers: [],
      coverage: { cycle_complete: false, truncated: true, checked: 0 } } });
    expect(screen.getByText(/has not finished checking every printer/)).toBeInTheDocument();
  });

  it('says when stall records were dropped, even with no problem listed', () => {
    renderWith({ ...BASE, print_state: { by_code: {}, error: null, checked_at: null, printers: [], coverage,
      stall_tracking: { since_seconds: 600, evicted: 5 } } });
    expect(screen.getByText(/5 stall records were dropped/)).toBeInTheDocument();
  });

  it('counts no observation as a problem', () => {
    renderWith({ ...BASE, print_state: { by_code: {}, observations: { runtime_phase_lingering: 1 }, error: null,
      checked_at: null, printers: [], coverage } });
    expect(screen.queryByText(/print-state problem/i)).not.toBeInTheDocument();
  });

  it('says when the check is unavailable', () => {
    renderWith({ ...BASE, print_state: { by_code: {}, error: 'unavailable', checked_at: null, printers: [],
      coverage: { cycle_complete: false, truncated: true, checked: 0 } } });
    expect(screen.getByText(/print-state check is unavailable/i)).toBeInTheDocument();
  });

  it('stays silent without the read rights', () => {
    render(<I18nextProvider i18n={i18n}><SystemHealthPanel result={{ ...BASE, print_state: null }} showPrintState /></I18nextProvider>);
    expect(screen.queryByText(/print-state/i)).not.toBeInTheDocument();
  });

  it('stays silent in the bug reporter, which has no diagnostics to link to', () => {
    render(<I18nextProvider i18n={i18n}><SystemHealthPanel result={{ ...BASE, print_state: {
      by_code: { terminal_runtime_context: 1 }, error: null, checked_at: null, printers: [{ printer_id: 7, codes: ['terminal_runtime_context'] }],
      coverage,
    } }} /></I18nextProvider>);
    expect(screen.queryByText(/print-state problem/i)).not.toBeInTheDocument();
  });
});
