import { describe, it, expect } from 'vitest';
import { activeChildId, type NavChild } from '../../../components/sidebar/navChildren';

const children: NavChild[] = [
  { id: 'orders', to: '/projects', labelKey: 'x', match: /^\/projects(\/|$)/ },
  { id: 'products', to: '/products', labelKey: 'x', match: /^\/products(\/|$)/ },
];

describe('activeChildId', () => {
  it('lights the child on its list and on its detail pages', () => {
    expect(activeChildId(children, '/projects')).toBe('orders');
    expect(activeChildId(children, '/projects/12')).toBe('orders');
    expect(activeChildId(children, '/products/5')).toBe('products');
  });
  it('lights nothing outside the section, nor on a look-alike path', () => {
    expect(activeChildId(children, '/queue')).toBeNull();
    expect(activeChildId(children, '/projectsx')).toBeNull();
  });
});
