import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp } from './render-app.js';

const PNG = 'data:image/png;base64,aGk=';
const PNG_DARK = 'data:image/png;base64,aGkK';

describe('proxy logos', () => {
  it('renders the fetched logo image in the new-chat agent picker', () => {
    renderApp({
      scenario: {
        view: { kind: 'new-chat', presetTaskId: 'task-1' },
        hostData: { 'host-home': { logos: { codex: { light: PNG } } } },
      },
      viewport: 'wide',
    });
    const logo = screen.getByRole('radio', { name: 'Codex' }).querySelector('img.proxy-logo');
    expect(logo).not.toBeNull();
    expect(logo!.getAttribute('src')).toBe(PNG);
  });

  it('uses the dark variant when the resolved theme is dark', () => {
    renderApp({
      scenario: {
        view: { kind: 'new-chat', presetTaskId: 'task-1' },
        settings: { theme: 'dark', accent: 'azure' },
        hostData: { 'host-home': { logos: { codex: { light: PNG, dark: PNG_DARK } } } },
      },
      viewport: 'wide',
    });
    const logo = screen.getByRole('radio', { name: 'Codex' }).querySelector('img.proxy-logo');
    expect(logo!.getAttribute('src')).toBe(PNG_DARK);
  });

  it('falls back to a monogram while no logo bytes are available', () => {
    renderApp({
      scenario: { view: { kind: 'new-chat', presetTaskId: 'task-1' } },
      viewport: 'wide',
    });
    const picker = screen.getByRole('radio', { name: 'Codex' });
    expect(picker.querySelector('img.proxy-logo')).toBeNull();
    expect(picker.querySelector('.proxy-logo-mono')?.textContent).toBe('C');
  });
});
