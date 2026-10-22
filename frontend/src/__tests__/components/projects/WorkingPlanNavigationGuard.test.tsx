import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { WorkingPlanNavigationGuard, WorkingPlanNavigationProvider } from '../../../components/projects/WorkingPlanNavigationGuard';

afterEach(() => vi.restoreAllMocks());

it('keeps the same workspace editor across tabs but protects changing the selected order', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const router = createMemoryRouter([{ path: '/projects', element: <WorkingPlanNavigationProvider>
    <WorkingPlanNavigationGuard dirty orderId={7} /><p>Editor</p>
  </WorkingPlanNavigationProvider> }], { initialEntries: ['/projects?view=workspace'] });
  const view = render(<RouterProvider router={router} />);
  await act(async () => { await router.navigate('/projects?view=workspace&order=7&section=prints'); });
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => { await router.navigate('/projects?view=workspace&order=8'); });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(router.state.location.search).toContain('order=7');
  await act(async () => { await router.navigate('/projects?view=workspace&order=7&q=other'); });
  expect(confirm).toHaveBeenCalledTimes(2);
  view.unmount(); router.dispose();
});

it('covers Back, programmatic navigation and a kept-mounted tab without saving on unmount', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const router = createMemoryRouter([
    { path: '/other', element: <p>Other page</p> },
    { path: '/plan', element: <><WorkingPlanNavigationGuard dirty /><p>Editor</p></> },
  ], { initialEntries: ['/other', '/plan'] });
  const view = render(<RouterProvider router={router} />);
  await act(async () => { await router.navigate(-1); });
  expect(screen.getByText('Editor')).toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(1);
  await act(async () => { await router.navigate('/plan?tab=prints'); });
  expect(confirm).toHaveBeenCalledTimes(1);
  await act(async () => { await router.navigate('/other'); });
  expect(screen.getByText('Editor')).toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(2);
  confirm.mockReturnValue(true);
  await act(async () => { await router.navigate('/other'); });
  await waitFor(() => expect(screen.getByText('Other page')).toBeInTheDocument());
  view.unmount(); router.dispose();
});

it('registers the same explicit decision for a non-route modal close and clears it on unmount', () => {
  const register = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const view = render(<WorkingPlanNavigationGuard dirty onLeaveGuard={register} />);
  const leave = register.mock.calls.at(-1)![0] as () => boolean;
  expect(leave()).toBe(false);
  confirm.mockReturnValue(true);
  expect(leave()).toBe(true);
  view.unmount();
  expect(register).toHaveBeenLastCalledWith(null);
});
