import { fireEvent, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AgentLogo } from '../src/components/AgentLogo.js';

it('shows the Agent fallback when a Catalog logo is a transparent 1-pixel placeholder', () => {
  const { container } = render(<AgentLogo
    proxy={null}
    fallback="Grok Build"
    logo={{ light: '/grok/light.png', dark: '/grok/dark.png' }}
  />);
  const images = [...container.querySelectorAll('img')];
  expect(images).toHaveLength(2);
  for (const image of images) {
    Object.defineProperties(image, {
      naturalWidth: { value: 1 },
      naturalHeight: { value: 1 },
    });
    fireEvent.load(image);
  }
  expect(container.querySelectorAll('img')).toHaveLength(0);
  expect(container.querySelectorAll('.agent-logo-fallback')).toHaveLength(2);
  expect(container.textContent).toBe('GG');
});
