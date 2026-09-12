import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';

describe('conversation rail (B3)', () => {
  it('renders only the Doing Task hierarchy without an Unassigned surface', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const sidebar = document.querySelector('.sidebar')!;
    const rows = within(sidebar as HTMLElement);
    expect(rows.getByText('进行中')).toBeInTheDocument();
    expect(rows.queryByText('未归属')).toBeNull();
    // The sticky list heading replaces the obsolete Chats dropdown + global +.
    const first = sidebar.querySelector('.sb-scroll')!.firstElementChild!;
    expect(first).toHaveClass('sb-toprow');
    expect(first.textContent).toContain('Tasks');
    expect(rows.getByText('Gian 0.5.4 发布')).toBeInTheDocument();
    expect(rows.queryByText('周末发布 checklist 起草')).toBeNull();
    expect(sidebar.querySelector('.rw-newchat')).toBeNull();
  });

  it('no task menu / pin / complete / archive actions exist', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    expect(screen.queryByRole('button', { name: /置顶|Pin|Mark complete|归档|Archive/i })).toBeNull();
    expect(document.querySelector('.task-menu, .sb-menu, .sb-group-menu')).toBeNull();
  });

  it('task header + opens New Chat with the task preselected', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getAllByTitle('New Chat（预选此 Task）')[0]!);
    expect(controller.state.view).toEqual({ kind: 'new-chat', presetTaskId: 'task-1' });
  });

  it('section and Task collapse state use the same disclosure pattern as local rails', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'wide' });
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    const rows = within(sidebar);

    const doing = screen.getByTestId('remote-section-doing');
    expect(doing).toHaveAttribute('aria-expanded', 'true');
    await user.click(doing);
    expect(doing).toHaveAttribute('aria-expanded', 'false');
    expect(rows.queryByText('Gian 0.5.4 发布')).toBeNull();

    await user.click(doing);
    const task = rows.getByText('Gian 0.5.4 发布').closest('.task-group')!;
    expect(task).toHaveAttribute('aria-expanded', 'true');
    await user.click(task);
    expect(task).toHaveAttribute('aria-expanded', 'false');
    expect(rows.queryByText('pre-push hook 接入 verify:quick')).toBeNull();
  });

  it('session rows carry an accessible status label', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const running = screen.getByRole('button', { name: /pre-push hook 接入 verify:quick — 运行中/ });
    const pending = screen.getByRole('button', { name: /Remote Web 协议 §12 走查 — 待审批/ });
    const done = screen.getByRole('button', { name: /模型结果复核 — 已完成/ });
    expect(running.querySelector('.gico.ring')).not.toBeNull();
    expect(pending.querySelector('.gico.unread.pend .gfill')).not.toBeNull();
    expect(done.querySelector('.gico.unread.done .gfill')).not.toBeNull();
    expect(done).not.toHaveTextContent('已完成');
  });

  it('clicking a session navigates into chat', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('button', { name: /Remote Web 协议 §12 走查/ }));
    expect(controller.state.view).toEqual({ kind: 'chat', sessionId: 's-2' });
  });

  it('narrow layout renders the rail as a full-screen page with a back button', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'narrow' });
    await user.click(screen.getByRole('button', { name: '对话列表' }));
    expect(controller.state.mobilePage).toBe('rail');
    const page = document.querySelector('.rw-page[data-page="rail"]')!;
    expect(page).toBeInTheDocument();
    expect(within(page as HTMLElement).getByText('Tasks')).toBeInTheDocument();
    await user.click(within(page as HTMLElement).getByRole('button', { name: '后退' }));
    expect(controller.state.mobilePage).toBe('chat');
  });
});
