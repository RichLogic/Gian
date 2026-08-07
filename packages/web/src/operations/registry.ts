/**
 * UI Operation Layer — closed operation registry (Phase 1).
 *
 * Design choice (proposal §4.2 requires "adding a name without a definition
 * fails somewhere mechanically"): the proposal sketch uses a literal
 * `operations = { ... } satisfies Record<OperationName, OperationDefinition>`.
 * That form cannot ship EMPTY — `{}` fails the satisfies check — but Phase 1
 * deliberately ships the registry with NO product definitions (entry points
 * migrate in Phases 2–3). So instead:
 *
 * - definitions live in a `Map<OperationName, OperationDefinition>` behind a
 *   type-safe `registerOperation` — the `OperationName` key type keeps the
 *   closed union enforced at compile time;
 * - registration checks at runtime that the definition's policy matches
 *   `OPERATION_POLICIES[name]` and that exactly one transport
 *   (`buildMessage` WS / `execute` REST) is declared — a definition that
 *   disagrees with the policy table fails immediately, in every env;
 * - `assertRegistryComplete()` verifies every `OperationName` (enumerated at
 *   runtime from `OPERATION_POLICIES`) has a definition. It is called from
 *   the dispatcher's first product use and from the test suite, so adding a
 *   name to the union without a definition fails mechanically in dev/test
 *   even though it cannot fail at compile time with the Map form.
 *
 * Phase 1 ships the default `registry` EMPTY. Tests build their own fixture
 * registries via `createRegistry()` — see
 * `packages/web/test/operation-registry.test.ts`; no fixture definitions are
 * exported for product use here.
 */
import {
  OPERATION_POLICIES,
  type OperationDefinition,
  type OperationName,
  type OperationPolicy,
} from './types.js';

/** Any registered definition; inputs/results are per-operation and erased here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperationDefinition = OperationDefinition<any, unknown>;

export interface OperationRegistry {
  register<Input, Result>(name: OperationName, definition: OperationDefinition<Input, Result>): void;
  get(name: OperationName): AnyOperationDefinition;
  has(name: OperationName): boolean;
  /** Throw unless every OperationName has a registered definition. */
  assertComplete(): void;
  /** Registered names (for diagnostics/tests). */
  names(): OperationName[];
}

export function createOperationRegistry(): OperationRegistry {
  const definitions = new Map<OperationName, AnyOperationDefinition>();

  return {
    register(name, definition) {
      const expected: OperationPolicy = OPERATION_POLICIES[name];
      if (definition.policy !== expected) {
        throw new Error(
          `operation "${name}": policy "${definition.policy}" does not match OPERATION_POLICIES "${expected}"`,
        );
      }
      const hasWs = definition.buildMessage !== undefined;
      const hasRest = definition.execute !== undefined;
      if (hasWs === hasRest) {
        throw new Error(
          `operation "${name}": declare exactly one transport (buildMessage for WS, execute for REST)`,
        );
      }
      if (definition.policy === 'optimistic' && !definition.optimisticWrites) {
        throw new Error(`operation "${name}": optimistic policy requires optimisticWrites`);
      }
      if (definitions.has(name)) {
        throw new Error(`operation "${name}": already registered`);
      }
      definitions.set(name, definition as AnyOperationDefinition);
    },

    get(name) {
      const definition = definitions.get(name);
      if (!definition) {
        throw new Error(
          `operation "${name}" is not registered — every dispatched action must map to a registered operation (proposal §2)`,
        );
      }
      return definition;
    },

    has(name) {
      return definitions.has(name);
    },

    assertComplete() {
      const missing = (Object.keys(OPERATION_POLICIES) as OperationName[]).filter(
        name => !definitions.has(name),
      );
      if (missing.length > 0) {
        throw new Error(`operation registry incomplete; missing definitions: ${missing.join(', ')}`);
      }
    },

    names() {
      return [...definitions.keys()];
    },
  };
}

/**
 * The product registry. EMPTY in Phase 1 — Phase 2/3 register definitions
 * per domain (session.ts, queue.ts, task.ts, ...). Do not register fixture
 * definitions here; tests use `createOperationRegistry()`.
 */
export const registry: OperationRegistry = createOperationRegistry();
