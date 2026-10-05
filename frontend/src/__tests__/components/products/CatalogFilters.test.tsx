import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { render } from '../../utils';
import { CatalogFilters, type CatalogFilterValues } from '../../../components/products/CatalogFilters';
import { catalogStatus, catalogStock } from '../../../components/products/catalogUrl';
import { __resetColorCatalogForTests, setColorCatalog } from '../../../utils/colors';

const facets = { materials: ['PETG', 'PLA'], colors: ['#FF0000'], models: ['P1S', 'X1C'] };
const none: CatalogFilterValues = { material: '', color: '', model: '', status: '', stock: '', hidden: false, adhoc: false };

const optionsOf = (label: string) =>
  within(screen.getByLabelText(label)).getAllByRole('option').map((o) => o.textContent);

// WS-13 E8 C03 / C04 / C09: the mockup's row of filters, every value a URL key the page owns.
describe('CatalogFilters', () => {
  beforeEach(() => setColorCatalog({ ff0000: 'Red' }));
  afterEach(() => __resetColorCatalogForTests());

  it('C03 draws the mockup row: five named selects and two checkboxes', async () => {
    render(<CatalogFilters values={none} onChange={vi.fn()} facets={facets} facetsFailed={false} onRetryFacets={vi.fn()} />);
    // The stock and one-off filters wait for the signed-in user's reads (WS-13 E13 O12).
    await screen.findByLabelText('Stock');
    expect(optionsOf('Material')).toEqual(['All materials', 'PETG', 'PLA']);
    expect(optionsOf('Colour')).toEqual(['All colours', 'Red']);
    expect(optionsOf('Printer model')).toEqual(['Any printer', 'Sliced for P1S', 'Sliced for X1C', 'Not sliced']);
    expect(optionsOf('Readiness')).toEqual(['Any readiness', 'Ready to print', 'Draft']);
    expect(optionsOf('Stock')).toEqual(['Any stock', 'Finished in stock', 'Part kits in stock', 'Finished below minimum']);
    expect(screen.getByRole('checkbox', { name: 'hidden' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'one-off' })).not.toBeChecked();
  });

  it('C03 reports each choice by its URL key', async () => {
    const onChange = vi.fn();
    render(<CatalogFilters values={none} onChange={onChange} facets={facets} facetsFailed={false} onRetryFacets={vi.fn()} />);
    await screen.findByLabelText('Stock');
    fireEvent.change(screen.getByLabelText('Printer model'), { target: { value: 'none' } });
    expect(onChange).toHaveBeenLastCalledWith('model', 'none');
    fireEvent.change(screen.getByLabelText('Stock'), { target: { value: 'low' } });
    expect(onChange).toHaveBeenLastCalledWith('stock', 'low');
    fireEvent.change(screen.getByLabelText('Readiness'), { target: { value: 'ready' } });
    expect(onChange).toHaveBeenLastCalledWith('status', 'ready');
    fireEvent.click(screen.getByRole('checkbox', { name: 'hidden' }));
    expect(onChange).toHaveBeenLastCalledWith('hidden', true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'one-off' }));
    expect(onChange).toHaveBeenLastCalledWith('adhoc', true);
  });

  it('C04 a value from a link that no product carries stays chosen', () => {
    render(
      <CatalogFilters
        values={{ ...none, material: 'ABS', model: 'A1' }}
        onChange={vi.fn()}
        facets={facets}
        facetsFailed={false}
        onRetryFacets={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Material')).toHaveValue('ABS');
    expect(screen.getByLabelText('Printer model')).toHaveValue('A1');
    expect(optionsOf('Printer model')).toContain('Sliced for A1');
  });

  it('C04 closed sets: an unknown status or stock reads as «any», the old stock=1 as part kits', () => {
    expect(catalogStatus('ready')).toBe('ready');
    expect(catalogStatus('archived')).toBe('');
    expect(catalogStock('1')).toBe('kits');
    expect(catalogStock('low')).toBe('low');
    expect(catalogStock('below_min')).toBe('');
    expect(catalogStock('zzz')).toBe('');
  });

  it('C09 the facets failed: the selects stay usable with «All…», a note offers a retry', () => {
    const retry = vi.fn();
    render(
      <CatalogFilters values={{ ...none, color: '#00FF00' }} onChange={vi.fn()} facets={undefined} facetsFailed onRetryFacets={retry} />,
    );
    expect(screen.getByLabelText('Material')).toBeEnabled();
    expect(optionsOf('Material')).toEqual(['All materials']);
    // The chosen colour from the URL is still there to see and to clear.
    expect(screen.getByLabelText('Colour')).toHaveValue('#00FF00');
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('Could not load the filter values');
    fireEvent.click(within(note).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });

  it('C05 Reset is drawn only when the page hands one over', () => {
    const { unmount } = render(
      <CatalogFilters values={none} onChange={vi.fn()} facets={facets} facetsFailed={false} onRetryFacets={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    unmount();
    const reset = vi.fn();
    render(
      <CatalogFilters
        values={{ ...none, hidden: true }}
        onChange={vi.fn()}
        facets={facets}
        facetsFailed={false}
        onRetryFacets={vi.fn()}
        onReset={reset}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'hidden' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(reset).toHaveBeenCalled();
  });
});
