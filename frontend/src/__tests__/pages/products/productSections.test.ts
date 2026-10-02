/**
 * The product page's five tabs in the address (WS-13 E9 C03): `?tab=` names one; the
 * standard one (`composition`) is never written; an unknown value reads as the standard
 * and is not rewritten by reading.
 */
import { describe, expect, it } from 'vitest';
import { parseProductSection, PRODUCT_SECTIONS, sectionParam } from '../../../pages/products/productSections';

describe('productSections', () => {
  it('lists the mockup’s five tabs in order', () => {
    expect(PRODUCT_SECTIONS).toEqual(['composition', 'plates', 'stock', 'docs', 'orders']);
  });

  it('reads a known tab, and anything else as the composition', () => {
    expect(parseProductSection('orders')).toBe('orders');
    expect(parseProductSection('docs')).toBe('docs');
    expect(parseProductSection(null)).toBe('composition');
    expect(parseProductSection('')).toBe('composition');
    expect(parseProductSection('nonsense')).toBe('composition');
  });

  it('writes nothing for the composition', () => {
    expect(sectionParam('composition')).toBe('');
    expect(sectionParam('stock')).toBe('stock');
  });
});
