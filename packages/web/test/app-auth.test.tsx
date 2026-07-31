import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whoAmI } from '../src/api.js';
import { useAppAuth } from '../src/controllers/use-app-auth.js';

vi.mock('../src/api.js', () => ({
  whoAmI: vi.fn(),
}));

const mockedWhoAmI = vi.mocked(whoAmI);

describe('useAppAuth', () => {
  beforeEach(() => {
    mockedWhoAmI.mockReset();
  });

  it('holds the app at login when the HTTP session is absent', async () => {
    mockedWhoAmI.mockResolvedValue(null);

    const { result } = renderHook(() => useAppAuth());

    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('login'));
  });

  it('admits an existing login and can resume after a successful login', async () => {
    mockedWhoAmI.mockResolvedValue({ user: 'admin' });
    const existing = renderHook(() => useAppAuth());

    await waitFor(() => expect(existing.result.current.status).toBe('authenticated'));
    existing.unmount();

    mockedWhoAmI.mockResolvedValue(null);
    const fresh = renderHook(() => useAppAuth());
    await waitFor(() => expect(fresh.result.current.status).toBe('login'));

    act(() => fresh.result.current.onLoginOk());
    expect(fresh.result.current.status).toBe('authenticated');
  });
});
