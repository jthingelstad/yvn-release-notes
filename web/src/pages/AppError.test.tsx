// A page that throws shows the app's error page, not a blank screen.
import { cleanup, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from './AppError.tsx';

afterEach(cleanup);

describe('AppError', () => {
  it('stands in for a page that breaks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = createRootRoute({ component: Outlet });
    const broken = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => {
        throw new Error('broken');
      }
    });
    const router = createRouter({
      routeTree: root.addChildren([broken]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      defaultErrorComponent: AppError
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('heading', { name: 'Something went wrong.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'go to today' }).getAttribute('href')).toBe('/today/');
    vi.restoreAllMocks();
  });
});
