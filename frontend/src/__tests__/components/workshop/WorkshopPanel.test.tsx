/**
 * The Workshop panel (WS-13 E2 §E): the one Card with a heading, a body and a
 * footer — and, for a table, a flush body whose horizontal scroll is the
 * table's own, never the page's, with the footer outside it. Geometry is
 * measured in the browser; here only the composition a list leans on.
 */

import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils';
import { WorkshopPanel, WorkshopTableScroll } from '../../../components/workshop/WorkshopPanel';

describe('WorkshopPanel', () => {
  it('draws the heading, the body and the footer in that order, inside one frame', () => {
    render(
      <WorkshopPanel data-testid="panel" title="Lines" footer={<p>footer</p>}>
        <p>body</p>
      </WorkshopPanel>,
    );

    const panel = screen.getByTestId('panel');
    expect([...panel.children].map((part) => part.textContent)).toEqual(['Lines', 'body', 'footer']);
    expect(within(panel).getByRole('heading', { name: 'Lines' })).toBeInTheDocument();
  });

  it('names its heading at level 2 unless the page says the panel sits one level deeper (WS-13 E3 B06)', () => {
    render(
      <>
        <WorkshopPanel title="Forecast">
          <p>a</p>
        </WorkshopPanel>
        <WorkshopPanel title="Queue" headingLevel={3}>
          <p>b</p>
        </WorkshopPanel>
      </>,
    );

    expect(screen.getByRole('heading', { name: 'Forecast', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Queue', level: 3 })).toBeInTheDocument();
  });

  it('keeps a table in its own named, focusable scroll region and the footer outside it', () => {
    render(
      <WorkshopPanel data-testid="panel" flush footer={<nav>pages</nav>}>
        <WorkshopTableScroll label="Orders">
          <table>
            <tbody>
              <tr>
                <td>row</td>
              </tr>
            </tbody>
          </table>
        </WorkshopTableScroll>
      </WorkshopPanel>,
    );

    const region = screen.getByRole('region', { name: 'Orders' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table')).toBeInTheDocument();
    expect(within(region).queryByText('pages')).toBeNull();
    expect(within(screen.getByTestId('panel')).getByText('pages')).toBeInTheDocument();
  });
});
