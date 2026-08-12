import { expect, it, vi } from 'vitest';
import { renderWithOperations } from './operation-test-utils.js';

it('disposes the operation dispatcher when its rendered tree unmounts', () => {
  const rendered = renderWithOperations(<div>operation harness</div>);
  const dispose = vi.spyOn(rendered.dispatcher, 'dispose');

  rendered.unmount();

  expect(dispose).toHaveBeenCalledOnce();
});
