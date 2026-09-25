import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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

describe('NavParentItem · rail flyout', () => {
  beforeEach(() => localStorage.removeItem('sidebarNavOpen'));
  const icon = () => screen.getByRole('button', { name: 'Projects' });
  const flyout = () => screen.queryByTestId('nav-flyout-projects');

  it('opens on hover, portalled into body, and closes a moment after the pointer leaves', async () => {
    mountParent({ expanded: false });
    fireEvent.mouseEnter(icon());
    expect(flyout()).toBeInTheDocument();
    expect(flyout()!.parentElement).toBe(document.body);
    expect(within(flyout()!).getByRole('link', { name: 'Customers' })).toBeInTheDocument();
    fireEvent.mouseLeave(icon());
    await waitFor(() => expect(flyout()).not.toBeInTheDocument());
  });

  it('a click toggles it — for a touch screen', () => {
    mountParent({ expanded: false });
    fireEvent.click(icon());
    expect(flyout()).toBeInTheDocument();
    fireEvent.click(icon());
    expect(flyout()).not.toBeInTheDocument();
  });

  it('Enter opens it with the focus on the first child; Esc closes it and gives the focus back', () => {
    mountParent({ expanded: false });
    icon().focus();
    fireEvent.keyDown(icon(), { key: 'Enter' });
    expect(within(flyout()!).getByRole('link', { name: 'Orders' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(flyout()).not.toBeInTheDocument();
    expect(icon()).toHaveFocus();
  });

  it('a Tab past the icon does not open it', () => {
    mountParent({ expanded: false });
    fireEvent.focus(icon());
    expect(flyout()).not.toBeInTheDocument();
  });

  it('closes on choosing a child and on a click outside', () => {
    mountParent({ expanded: false });
    fireEvent.click(icon());
    fireEvent.click(within(flyout()!).getByRole('link', { name: 'Stock' }));
    expect(flyout()).not.toBeInTheDocument();
    fireEvent.click(icon());
    fireEvent.mouseDown(document.body);
    expect(flyout()).not.toBeInTheDocument();
  });

  it('leaves Escape alone while it is closed', () => {
    mountParent({ expanded: false });
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    window.removeEventListener('keydown', seen);
    expect(seen).toHaveBeenCalledTimes(1); // not stopped — the modal stack and page shortcuts still get it
  });

  it('lights the icon when inside the section and shows the dot for a count', () => {
    mountParent({ expanded: false, path: '/customers/3', badges: { activeOrders: 2 } });
    expect(icon()).toHaveClass('bg-bambu-green');
    expect(within(icon()).getByTestId('nav-dot-projects')).toBeInTheDocument();
  });
});
