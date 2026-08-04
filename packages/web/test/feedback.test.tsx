import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import {
  __resetFeedback,
  confirm,
  dismissToast,
  getSnapshot,
  toast,
} from '../src/feedback.js';
import { Toaster } from '../src/components/Toaster.js';
import { LocaleProvider } from '../src/i18n/index.js';

afterEach(() => {
  __resetFeedback();
  vi.useRealTimers();
});

function renderToaster() {
  return render(<LocaleProvider locale="en"><Toaster /></LocaleProvider>);
}

describe('feedback store', () => {
  it('toast() defaults kind to info and duration by kind', () => {
    const id = toast({ message: 'hi' });
    const rec = getSnapshot().toasts.find(t => t.id === id)!;
    expect(rec.kind).toBe('info');
    expect(rec.duration).toBe(4000);
    expect(toastDuration('error')).toBe(6000);
  });

  function toastDuration(kind: 'error') {
    const id = toast({ kind, message: 'x' });
    return getSnapshot().toasts.find(t => t.id === id)!.duration;
  }

  it('dismissToast removes by id', () => {
    const id = toast({ message: 'bye' });
    expect(getSnapshot().toasts).toHaveLength(1);
    dismissToast(id);
    expect(getSnapshot().toasts).toHaveLength(0);
  });

  it('confirm() resolves true/false via resolveConfirm', async () => {
    const p = confirm({ message: 'sure?' });
    expect(getSnapshot().confirms).toHaveLength(1);
    const { resolveConfirm } = await import('../src/feedback.js');
    resolveConfirm(getSnapshot().confirms[0]!.id, true);
    await expect(p).resolves.toBe(true);
    expect(getSnapshot().confirms).toHaveLength(0);
  });

  it('__resetFeedback resolves pending confirms as false', async () => {
    const p = confirm({ message: 'pending' });
    __resetFeedback();
    await expect(p).resolves.toBe(false);
  });
});

describe('<Toaster /> toasts', () => {
  it('renders a toast and auto-dismisses after its duration', () => {
    vi.useFakeTimers();
    renderToaster();
    act(() => { toast({ kind: 'success', message: 'Saved' }); });
    expect(screen.getByText('Saved')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('a sticky toast (duration 0) stays until manually dismissed', () => {
    vi.useFakeTimers();
    renderToaster();
    act(() => { toast({ kind: 'error', message: 'Boom', duration: 0 }); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Boom')).toBeTruthy();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(screen.queryByText('Boom')).toBeNull();
  });
});

describe('<Toaster /> confirm dialog', () => {
  it('resolves true when the confirm button is clicked', async () => {
    renderToaster();
    let result: boolean | undefined;
    act(() => { void confirm({ message: 'Delete it?', confirmLabel: 'Delete' }).then(r => { result = r; }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(result).toBe(true));
  });

  it('resolves false on Escape', async () => {
    renderToaster();
    let result: boolean | undefined;
    act(() => { void confirm({ message: 'Drop?' }).then(r => { result = r; }); });
    await screen.findByText('Drop?');
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    await waitFor(() => expect(result).toBe(false));
  });

  it('resolves false when the backdrop is clicked', async () => {
    const { container } = renderToaster();
    let result: boolean | undefined;
    act(() => { void confirm({ message: 'Backdrop?' }).then(r => { result = r; }); });
    await screen.findByText('Backdrop?');
    const overlay = container.querySelector('.confirm-overlay')!;
    fireEvent.pointerDown(overlay);
    await waitFor(() => expect(result).toBe(false));
  });
});
