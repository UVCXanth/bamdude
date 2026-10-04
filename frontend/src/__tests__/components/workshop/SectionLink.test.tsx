/**
 * `SectionLink` (WS-13 E13 O19): a link into a Workshop section for whoever may read it, its
 * text for anyone else — never a link the section's route answers with a silent bounce to «/».
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import type { Permission } from '../../../api/client';
import { SectionLink } from '../../../components/workshop/SectionLink';
import { sectionReadOf } from '../../../utils/sectionRead';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), hasPermission: (p: Permission) => auth.granted.has(p) }),
  };
});

describe('sectionReadOf', () => {
  it('names the read each section’s route asks', () => {
    expect(sectionReadOf('/projects/5')).toEqual(['orders:read']);
    expect(sectionReadOf('/products/1#files')).toEqual(['products:read']);
    expect(sectionReadOf('/customers/2')).toEqual(['customers:read']);
    expect(sectionReadOf('/stock?tab=notes')).toEqual(['stock:read']);
    expect(sectionReadOf('/stock/7')).toEqual(['stock:read']);
    // The document opens for any of the three reads (O25).
    expect(sectionReadOf('/stock/dispatch-notes/9')).toEqual(['stock:read', 'orders:read', 'customers:read']);
    expect(sectionReadOf('/archives')).toBeNull();
  });
});

describe('SectionLink', () => {
  it('is a link for the section’s reader', () => {
    auth.granted = new Set(['products:read']);
    render(<SectionLink to="/products/1" className="x">Lamp</SectionLink>);
    expect(screen.getByRole('link', { name: 'Lamp' })).toHaveAttribute('href', '/products/1');
  });

  it('is its text for anyone else', () => {
    auth.granted = new Set(['stock:read']);
    render(<SectionLink to="/products/1" className="x">Lamp</SectionLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Lamp')).toBeInTheDocument();
  });

  it('opens a dispatch note for any of its three reads', () => {
    auth.granted = new Set(['customers:read']);
    render(<SectionLink to="/stock/dispatch-notes/9">DN-0009</SectionLink>);
    expect(screen.getByRole('link', { name: 'DN-0009' })).toBeInTheDocument();
  });
});
