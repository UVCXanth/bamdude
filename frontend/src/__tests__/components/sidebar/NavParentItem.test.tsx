import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { FolderKanban } from 'lucide-react';
import { render } from '../../utils';
import { NavParentItem } from '../../../components/sidebar/NavParentItem';
import type { NavChild } from '../../../components/sidebar/navChildren';

const children: NavChild[] = [
  { id: 'orders', to: '/projects', labelKey: 'projects.tabs.orders', match: /^\/projects(\/|$)/, badge: 'activeOrders' },
  { id: 'products', to: '/products', labelKey: 'projects.tabs.products', match: /^\/products(\/|$)/ },
  { id: 'customers', to: '/customers', labelKey: 'projects.tabs.customers', match: /^\/customers(\/|$)/ },
  { id: 'stock', to: '/stock', labelKey: 'projects.tabs.stock', match: /^\/stock(\/|$)/ },
];
const item = { id: 'projects', icon: FolderKanban, labelKey: 'nav.projects', children };

function mountParent(opts: { expanded?: boolean; badges?: Partial<Record<'activeOrders', number>>; path?: string } = {}) {
  window.history.pushState({}, '', opts.path ?? '/queue');
  return render(
    <ul>
      <NavParentItem item={item} expanded={opts.expanded ?? true} showGrip={false} badges={opts.badges ?? {}} liProps={{}} />
    </ul>,
  );
}

describe('NavParentItem · expanded', () => {
  beforeEach(() => localStorage.removeItem('sidebarNavOpen'));

  it('toggles its children and remembers the choice', () => {
    const first = mountParent();
    const toggle = screen.getByRole('button', { name: 'Projects' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Products' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Products' })).not.toBeInTheDocument();
    first.unmount();
    mountParent();
    expect(screen.getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('lights the child of a detail page and marks the parent as inside', () => {
    mountParent({ path: '/products/5' });
    expect(screen.getByRole('link', { name: 'Products' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Orders' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Projects' })).toHaveAttribute('data-inside', 'true');
  });

  it('with the children folded, an inside parent carries the accent and a badge shows as a dot', () => {
    localStorage.setItem('sidebarNavOpen', JSON.stringify({ projects: false }));
    mountParent({ path: '/stock', badges: { activeOrders: 4 } });
    const toggle = screen.getByRole('button', { name: 'Projects' });
    expect(toggle).toHaveClass('bg-bambu-green');
    expect(within(toggle).getByTestId('nav-dot-projects')).toBeInTheDocument();
  });

  it('shows the count beside its child, hides a zero', () => {
    const view = mountParent({ badges: { activeOrders: 3 } });
    expect(screen.getByTitle('Active orders')).toHaveTextContent('3');
    expect(screen.queryByTestId('nav-dot-projects')).not.toBeInTheDocument(); // children are visible — no dot
    view.unmount();
    mountParent({ badges: { activeOrders: 0 } });
    expect(screen.queryByTitle('Active orders')).not.toBeInTheDocument();
  });

  it('caps the badge at 99+', () => {
    mountParent({ badges: { activeOrders: 150 } });
    expect(screen.getByTitle('Active orders')).toHaveTextContent('99+');
  });
});
