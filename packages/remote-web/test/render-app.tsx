/**
 * Shared render helper: mount the App against a fixture controller with a
 * pinned locale + viewport mode.
 */

import { act, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { App } from '../src/app.js';
import type { FixtureController, FixtureScenario } from '../src/controller/fixture.js';
import { createFixtureController } from '../src/controller/fixture.js';
import type { RemoteUiActions } from '../src/controller/types.js';
import { ControllerProvider } from '../src/ui/controller-context.js';
import { LocaleProvider } from '../src/i18n/index.js';
import type { Locale } from '../src/i18n/index.js';
import { ViewportProvider } from '../src/ui/viewport.js';
import type { ViewportMode } from '../src/ui/viewport.js';

/** Wrap every controller method in act() so direct calls in tests flush React
 *  updates synchronously (as they would through user events). */
function actWrapped<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        let result: unknown;
        act(() => {
          result = value.apply(obj, args);
        });
        return result;
      };
    },
  });
}

export function renderApp(options: {
  scenario?: FixtureScenario;
  locale?: Locale;
  viewport?: ViewportMode;
}): RenderResult & { controller: FixtureController } {
  const raw = createFixtureController(options.scenario ?? {});
  const controller: FixtureController = new Proxy(raw, {
    get(obj, prop, receiver) {
      if (prop === 'actions') return actWrapped(obj.actions as RemoteUiActions);
      if (prop === 'test') return actWrapped(obj.test);
      return Reflect.get(obj, prop, receiver);
    },
  });
  const result = render(
    <LocaleProvider locale={options.locale ?? 'zh-CN'}>
      <ViewportProvider value={options.viewport ?? 'wide'}>
        <ControllerProvider controller={controller}>
          <App />
        </ControllerProvider>
      </ViewportProvider>
    </LocaleProvider>,
  );
  return { ...result, controller };
}
