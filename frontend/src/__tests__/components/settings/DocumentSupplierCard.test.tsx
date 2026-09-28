import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../utils';
import { DocumentSupplierCard } from '../../../components/settings/DocumentSupplierCard';

describe('DocumentSupplierCard', () => {
  it('edits the five details', () => {
    const onChange = vi.fn();
    const values = { name: 'Workshop', address: '', phone: '', code: '', iban: '' };
    render(<DocumentSupplierCard values={values} onChange={onChange} />);
    expect(screen.getByLabelText('Name')).toHaveValue('Workshop');
    fireEvent.change(screen.getByLabelText('IBAN'), { target: { value: 'UA00' } });
    expect(onChange).toHaveBeenCalledWith('document_supplier_iban', 'UA00');
    expect(screen.getByText(/Copied into every new dispatch note/)).toBeInTheDocument();
  });
});
