/**
 * A figure the server masks — another domain's, without its read (WS-13 E13 O12) — arrives as
 * null and is shown as «—», never as a 0 that reads as «none».
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { ProductStock } from '../../components/products/productRow/ProductStock';
import { ProductStockFact } from '../../components/products/detail/ProductStockFact';

describe('masked figures', () => {
  it('a product row without the stock read says «—», not 0 finished', () => {
    render(
      <ProductStock product={{ finished_available: null, finished_positions: null, finished_below_min: null, kits_available: null }} />,
    );
    expect(screen.getByTestId('product-stock')).toHaveTextContent(/^—$/);
  });

  it('a product page without the stock read says «—» for its shelf', () => {
    render(
      <ProductStockFact
        product={{ id: 1, finished_available: null, finished_positions: null, finished_below_min: null, kits_available: null }}
      />,
    );
    expect(screen.getByTestId('product-stock-fact')).toHaveTextContent(/^—$/);
  });

  it('with the stock read the figures are the server’s, a zero included', () => {
    render(<ProductStock product={{ finished_available: 0, finished_positions: 0, finished_below_min: 0, kits_available: 2 }} />);
    expect(screen.getByTestId('product-stock')).toHaveTextContent('0');
  });
});
