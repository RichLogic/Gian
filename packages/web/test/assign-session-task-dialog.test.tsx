import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@gian/shared';
import { describe, expect, it, vi } from 'vitest';
import { AssignSessionTaskDialog } from '../src/components/AssignSessionTaskDialog.js';

function task(id: string, name: string, status: Task['status']): Task {
  return {
    id,
    name,
    status,
    description: null,
    pinned_at: null,
    created_at: '2026-08-12T00:00:00Z',
    updated_at: '2026-08-12T00:00:00Z',
  };
}

describe('AssignSessionTaskDialog', () => {
  it('lists only active tasks and submits the selected task', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const trigger = document.createElement('button');
    trigger.className = 'path-seg session';
    document.body.append(trigger);
    trigger.focus();
    const view = render(
      <AssignSessionTaskDialog
        sessionName="Investigate flaky build"
        tasks={[
          task('open-task', 'Release 0.4.2', 'open'),
          task('done-task', 'Finished work', 'done'),
          task('archived-task', 'Old work', 'archived'),
        ]}
        onSelect={onSelect}
        onCancel={() => {}}
      />,
    );

    const openTask = screen.getByRole('button', { name: 'Release 0.4.2' });
    expect(openTask).toBeTruthy();
    expect(document.activeElement).toBe(openTask);
    expect(screen.queryByText('Finished work')).toBeNull();
    expect(screen.queryByText('Old work')).toBeNull();

    await user.click(openTask);
    expect(onSelect).toHaveBeenCalledWith('open-task');
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('shows the empty state and closes with Escape', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <AssignSessionTaskDialog
        sessionName="Standalone session"
        tasks={[task('done-task', 'Finished work', 'done')]}
        onSelect={() => {}}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('No active tasks.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
