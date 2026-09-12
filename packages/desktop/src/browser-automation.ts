import { randomUUID } from 'node:crypto';
import type { Debugger, WebContents } from 'electron';
import type {
  GianBrowserPageReference,
  GianBrowserTabSnapshot,
  GianToolErrorCode,
  GianToolMethod,
  GianToolMethodData,
  GianToolMethodParams,
} from '@gian/shared';
import type { BrowserController } from './browser-controller.js';
import type { BrowserControlLease } from './browser-domain.js';

const BROWSER_METHODS = new Set<GianToolMethod>([
  'browser.tabs',
  'browser.open',
  'browser.snapshot',
  'browser.click',
  'browser.fill',
  'browser.press',
  'browser.wait',
  'browser.evaluate',
  'browser.screenshot',
  'browser.go_back',
  'browser.reload',
  'browser.close',
]);
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);
const MAX_SNAPSHOT_TEXT = 128 * 1024;
const MAX_EVALUATION_BYTES = 256 * 1024;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

interface AxValue {
  value?: unknown;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: Array<{ name?: string; value?: AxValue }>;
}

interface BrowserSnapshotReference {
  backendNodeId: number;
}

interface BrowserSnapshotRecord {
  id: string;
  page: GianBrowserPageReference;
  refs: Map<string, BrowserSnapshotReference>;
}

export class BrowserAutomationError extends Error {
  constructor(
    readonly code: GianToolErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserAutomationError';
  }
}

export function isBrowserToolMethod(method: GianToolMethod): boolean {
  return BROWSER_METHODS.has(method);
}

function axString(value: AxValue | undefined): string {
  if (typeof value?.value === 'string') return value.value;
  if (typeof value?.value === 'number' || typeof value?.value === 'boolean') {
    return String(value.value);
  }
  return '';
}

function compactText(value: string, limit = 500): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}...` : compact;
}

function quoted(value: string): string {
  return JSON.stringify(compactText(value));
}

function isFocusable(node: AxNode): boolean {
  return node.properties?.some(property => (
    (property.name === 'focusable' || property.name === 'editable' || property.name === 'clickable')
    && property.value?.value === true
  )) === true;
}

function pageSnapshot(controller: BrowserController, tabId: string): GianBrowserTabSnapshot {
  const tab = controller.listTabs().tabs.find(candidate => candidate.id === tabId);
  if (!tab) throw new BrowserAutomationError('NOT_FOUND', `Browser tab not found: ${tabId}`);
  return tab;
}

function cdpError(error: unknown): BrowserAutomationError {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|Could not find node|No node/i.test(message)) {
    return new BrowserAutomationError('NOT_FOUND', 'Browser element is no longer available');
  }
  if (/debugger is already attached|Another debugger/i.test(message)) {
    return new BrowserAutomationError('CONFLICT', 'Browser inspection or DevTools is already using this page');
  }
  return new BrowserAutomationError('INTERNAL_ERROR', 'Browser automation command failed');
}

async function withCdp<T>(contents: WebContents, run: (debuggerApi: Debugger) => Promise<T>): Promise<T> {
  const debuggerApi = contents.debugger;
  if (debuggerApi.isAttached()) {
    throw new BrowserAutomationError('CONFLICT', 'Browser inspection is already using this page');
  }
  try {
    debuggerApi.attach('1.3');
    return await run(debuggerApi);
  } catch (error) {
    if (error instanceof BrowserAutomationError) throw error;
    throw cdpError(error);
  } finally {
    if (debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function resolveObjectId(debuggerApi: Debugger, backendNodeId: number): Promise<string> {
  const resolved = await debuggerApi.sendCommand('DOM.resolveNode', { backendNodeId }) as {
    object?: { objectId?: string };
  };
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new BrowserAutomationError('NOT_FOUND', 'Browser element is no longer available');
  return objectId;
}

function keyDefinition(input: string): {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers: number;
} {
  const parts = input.split('+').map(part => part.trim()).filter(Boolean);
  const rawKey = parts.pop();
  if (!rawKey) throw new BrowserAutomationError('INVALID_ARGUMENT', 'Browser key is invalid');
  let modifiers = 0;
  for (const modifier of parts) {
    if (/^alt$/i.test(modifier)) modifiers |= 1;
    else if (/^(control|ctrl)$/i.test(modifier)) modifiers |= 2;
    else if (/^(meta|command|cmd)$/i.test(modifier)) modifiers |= 4;
    else if (/^shift$/i.test(modifier)) modifiers |= 8;
    else throw new BrowserAutomationError('INVALID_ARGUMENT', `Unsupported Browser key modifier: ${modifier}`);
  }
  const special: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  };
  const known = special[rawKey.toLowerCase()];
  if (known) return { ...known, modifiers };
  if ([...rawKey].length !== 1) {
    throw new BrowserAutomationError('INVALID_ARGUMENT', `Unsupported Browser key: ${rawKey}`);
  }
  const key = (modifiers & 8) !== 0 ? rawKey.toUpperCase() : rawKey;
  const upper = key.toUpperCase();
  return {
    key,
    code: /^[A-Z]$/.test(upper) ? `Key${upper}` : key,
    keyCode: upper.charCodeAt(0),
    ...((modifiers & (1 | 2 | 4)) === 0 ? { text: key } : {}),
    modifiers,
  };
}

export class BrowserAutomationService {
  private readonly snapshots = new Map<string, BrowserSnapshotRecord>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly controller: BrowserController) {}

  call<M extends GianToolMethod>(
    method: M,
    params: GianToolMethodParams[M],
    actor: { callerId: string; sessionId: string | null },
  ): Promise<GianToolMethodData[M]> {
    const run = this.operationTail.then(() => this.dispatch(method, params, actor));
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async dispatch<M extends GianToolMethod>(
    method: M,
    params: GianToolMethodParams[M],
    actor: { callerId: string; sessionId: string | null },
  ): Promise<GianToolMethodData[M]> {
    if (!isBrowserToolMethod(method)) {
      throw new BrowserAutomationError('INVALID_ARGUMENT', `Unsupported Browser method: ${method}`);
    }
    if (method === 'browser.tabs') return this.controller.listTabs() as GianToolMethodData[M];

    const input = params as Record<string, unknown>;
    let tabId = typeof input['tab_id'] === 'string' ? input['tab_id'] : '';
    if (method === 'browser.open' && !tabId) {
      tabId = this.controller.createTab({
        sourceSessionId: actor.sessionId,
        activate: input['activate'] !== false,
      }).id;
    }
    pageSnapshot(this.controller, tabId);
    let lease: BrowserControlLease;
    try {
      lease = this.controller.acquireControl(tabId, `tool:${actor.callerId}`);
    } catch {
      throw new BrowserAutomationError('CONFLICT', `Browser tab is controlled by another actor: ${tabId}`);
    }
    try {
      let result: unknown;
      switch (method) {
        case 'browser.open': result = await this.open(tabId, params as GianToolMethodParams['browser.open']); break;
        case 'browser.snapshot': result = await this.snapshot(tabId, params as GianToolMethodParams['browser.snapshot']); break;
        case 'browser.click': result = await this.click(tabId, params as GianToolMethodParams['browser.click']); break;
        case 'browser.fill': result = await this.fill(tabId, params as GianToolMethodParams['browser.fill']); break;
        case 'browser.press': result = await this.press(tabId, params as GianToolMethodParams['browser.press']); break;
        case 'browser.wait': result = await this.wait(tabId, params as GianToolMethodParams['browser.wait']); break;
        case 'browser.evaluate': result = await this.evaluate(tabId, params as GianToolMethodParams['browser.evaluate']); break;
        case 'browser.screenshot': result = await this.screenshot(tabId, params as GianToolMethodParams['browser.screenshot']); break;
        case 'browser.go_back': result = { tab: this.afterNavigation(tabId, () => this.controller.goBack(tabId)) }; break;
        case 'browser.reload': {
          const reload = params as GianToolMethodParams['browser.reload'];
          result = { tab: this.afterNavigation(tabId, () => this.controller.reload(tabId, reload.ignore_cache === true)) };
          break;
        }
        case 'browser.close':
          this.snapshots.delete(tabId);
          this.controller.closeTab(tabId);
          result = { tab_id: tabId, closed: true };
          break;
        default: throw new BrowserAutomationError('INVALID_ARGUMENT', `Unsupported Browser method: ${method}`);
      }
      return result as GianToolMethodData[M];
    } finally {
      this.controller.releaseControl(lease);
    }
  }

  private async open(
    tabId: string,
    params: GianToolMethodParams['browser.open'],
  ): Promise<GianToolMethodData['browser.open']> {
    const state = await this.controller.navigate(tabId, params.url);
    if (state.error) throw new BrowserAutomationError('INVALID_ARGUMENT', state.error);
    return { tab: pageSnapshot(this.controller, tabId) };
  }

  private async snapshot(
    tabId: string,
    params: GianToolMethodParams['browser.snapshot'],
  ): Promise<GianToolMethodData['browser.snapshot']> {
    const { reference, contents } = this.controller.automationPage(tabId);
    if (!contents.getURL() || contents.getURL() === 'about:blank') {
      throw new BrowserAutomationError('PRECONDITION_FAILED', 'Open a page before taking a Browser snapshot');
    }
    const maxNodes = params.max_nodes ?? 500;
    const response = await withCdp(contents, async debuggerApi => {
      await debuggerApi.sendCommand('Accessibility.enable');
      return debuggerApi.sendCommand('Accessibility.getFullAXTree') as Promise<{ nodes?: AxNode[] }>;
    });
    if (!this.controller.resolvePage(reference)) {
      throw new BrowserAutomationError('PRECONDITION_FAILED', 'Browser page changed while taking the snapshot');
    }
    const nodes = Array.isArray(response.nodes) ? response.nodes : [];
    const byId = new Map(nodes.map(node => [node.nodeId, node]));
    const children = new Set(nodes.flatMap(node => node.childIds ?? []));
    const roots = nodes.filter(node => !children.has(node.nodeId));
    const orderedRoots = roots.length > 0 ? roots : nodes.slice(0, 1);
    const refs = new Map<string, BrowserSnapshotReference>();
    const lines: string[] = [];
    let visited = 0;
    let truncated = false;
    const stack = orderedRoots.slice().reverse().map(node => ({ node, depth: 0 }));
    while (stack.length > 0) {
      const current = stack.pop()!;
      const node = current.node;
      if (visited >= maxNodes) {
        truncated = true;
        break;
      }
      visited += 1;
      const role = compactText(axString(node.role), 80) || 'unknown';
      const name = axString(node.name);
      const value = axString(node.value);
      const description = axString(node.description);
      if (!node.ignored && (role !== 'none' || name || value)) {
        const actionable = typeof node.backendDOMNodeId === 'number'
          && (INTERACTIVE_ROLES.has(role.toLowerCase()) || isFocusable(node));
        const ref = actionable ? `@e${refs.size + 1}` : null;
        if (ref) refs.set(ref, { backendNodeId: node.backendDOMNodeId! });
        const details = [
          name ? quoted(name) : '',
          ref ? `[ref=${ref}]` : '',
          value && role.toLowerCase() !== 'textbox' ? `value=${quoted(value)}` : '',
          description ? `description=${quoted(description)}` : '',
        ].filter(Boolean).join(' ');
        lines.push(`${'  '.repeat(Math.min(current.depth, 12))}- ${role}${details ? ` ${details}` : ''}`);
        if (lines.join('\n').length > MAX_SNAPSHOT_TEXT) {
          truncated = true;
          break;
        }
      }
      const childDepth = node.ignored ? current.depth : current.depth + 1;
      for (const childId of [...(node.childIds ?? [])].reverse()) {
        const child = byId.get(childId);
        if (child) stack.push({ node: child, depth: childDepth });
      }
    }
    const id = `browser-snapshot-${randomUUID()}`;
    this.snapshots.set(tabId, { id, page: reference, refs });
    return {
      tab_id: tabId,
      page_generation: reference.pageGeneration,
      snapshot_id: id,
      url: contents.getURL(),
      title: contents.getTitle(),
      tree: lines.join('\n'),
      truncated,
    };
  }

  private reference(tabId: string, snapshotId: string, ref: string): {
    page: GianBrowserPageReference;
    backendNodeId: number;
    contents: WebContents;
  } {
    const snapshot = this.snapshots.get(tabId);
    if (!snapshot || snapshot.id !== snapshotId) {
      throw new BrowserAutomationError('PRECONDITION_FAILED', 'Browser snapshot is stale; take a new snapshot');
    }
    const target = snapshot.refs.get(ref);
    if (!target) throw new BrowserAutomationError('NOT_FOUND', `Browser element ref not found: ${ref}`);
    const contents = this.controller.resolvePage(snapshot.page);
    if (!contents) {
      throw new BrowserAutomationError('PRECONDITION_FAILED', 'Browser page changed; take a new snapshot');
    }
    return { page: snapshot.page, backendNodeId: target.backendNodeId, contents };
  }

  private async click(
    tabId: string,
    params: GianToolMethodParams['browser.click'],
  ): Promise<GianToolMethodData['browser.click']> {
    const target = this.reference(tabId, params.snapshot_id, params.ref);
    await withCdp(target.contents, async debuggerApi => {
      const objectId = await resolveObjectId(debuggerApi, target.backendNodeId);
      await debuggerApi.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ this.scrollIntoView({block:"center",inline:"center"}); }',
      });
      const response = await debuggerApi.sendCommand('DOM.getBoxModel', {
        backendNodeId: target.backendNodeId,
      }) as { model?: { border?: number[]; content?: number[] } };
      const quad = response.model?.border ?? response.model?.content;
      if (!quad || quad.length < 8) {
        throw new BrowserAutomationError('NOT_FOUND', 'Browser element has no clickable layout box');
      }
      const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
      const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    });
    return { tab_id: tabId, clicked: true };
  }

  private async fill(
    tabId: string,
    params: GianToolMethodParams['browser.fill'],
  ): Promise<GianToolMethodData['browser.fill']> {
    const target = this.reference(tabId, params.snapshot_id, params.ref);
    await withCdp(target.contents, async debuggerApi => {
      const objectId = await resolveObjectId(debuggerApi, target.backendNodeId);
      const response = await debuggerApi.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(text){
          this.scrollIntoView({block:'center',inline:'center'});
          this.focus();
          if (this.isContentEditable) this.textContent = text;
          else if (this instanceof HTMLInputElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (!setter) return false;
            setter.call(this, text);
          } else if (this instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (!setter) return false;
            setter.call(this, text);
          } else return false;
          this.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertText',data:text}));
          this.dispatchEvent(new Event('change', {bubbles:true}));
          return true;
        }`,
        arguments: [{ value: params.text }],
        returnByValue: true,
      }) as { result?: { value?: unknown } };
      if (response.result?.value !== true) {
        throw new BrowserAutomationError('INVALID_ARGUMENT', 'Browser element is not editable');
      }
    });
    return { tab_id: tabId, filled: true };
  }

  private async press(
    tabId: string,
    params: GianToolMethodParams['browser.press'],
  ): Promise<GianToolMethodData['browser.press']> {
    const contents = params.ref && params.snapshot_id
      ? this.reference(tabId, params.snapshot_id, params.ref).contents
      : this.controller.automationPage(tabId).contents;
    const target = params.ref && params.snapshot_id
      ? this.reference(tabId, params.snapshot_id, params.ref)
      : null;
    const key = keyDefinition(params.key);
    await withCdp(contents, async debuggerApi => {
      if (target) {
        const objectId = await resolveObjectId(debuggerApi, target.backendNodeId);
        await debuggerApi.sendCommand('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){ this.scrollIntoView({block:"center",inline:"center"}); this.focus(); }',
        });
      }
      const event = {
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        nativeVirtualKeyCode: key.keyCode,
        modifiers: key.modifiers,
        ...(key.text !== undefined ? { text: key.text, unmodifiedText: key.text } : {}),
      };
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event, text: '' });
    });
    return { tab_id: tabId, pressed: params.key };
  }

  private async wait(
    tabId: string,
    params: GianToolMethodParams['browser.wait'],
  ): Promise<GianToolMethodData['browser.wait']> {
    const condition = params.condition ?? 'load';
    const timeout = params.timeout_ms ?? 10_000;
    const contents = this.controller.automationPage(tabId).contents;
    const deadline = Date.now() + timeout;
    while (Date.now() <= deadline) {
      if (contents.isDestroyed()) throw new BrowserAutomationError('PRECONDITION_FAILED', 'Browser page closed while waiting');
      if (condition === 'load') {
        if (!contents.isLoading()) return { tab_id: tabId, condition, satisfied: true };
      } else {
        const expected = params.text!;
        const found = await contents.executeJavaScript(
          `Boolean(document.body?.innerText?.includes(${JSON.stringify(expected)}))`,
          true,
        ).catch(() => false) as boolean;
        if (found) return { tab_id: tabId, condition, satisfied: true };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new BrowserAutomationError('TIMEOUT', `Timed out waiting for Browser ${condition}`);
  }

  private async evaluate(
    tabId: string,
    params: GianToolMethodParams['browser.evaluate'],
  ): Promise<GianToolMethodData['browser.evaluate']> {
    const contents = this.controller.automationPage(tabId).contents;
    const value = await withCdp(contents, async debuggerApi => {
      const response = await debuggerApi.sendCommand('Runtime.evaluate', {
        expression: params.expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: 5_000,
        disableBreaks: true,
      }) as {
        result?: { value?: unknown; unserializableValue?: string; description?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      if (response.exceptionDetails) {
        throw new BrowserAutomationError(
          'INVALID_ARGUMENT',
          compactText(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Browser evaluation failed', 1_000),
        );
      }
      return response.result?.value
        ?? response.result?.unserializableValue
        ?? response.result?.description
        ?? null;
    });
    let encoded: string;
    try {
      encoded = JSON.stringify(value);
    } catch {
      throw new BrowserAutomationError('INVALID_ARGUMENT', 'Browser evaluation result is not serializable');
    }
    if (Buffer.byteLength(encoded ?? 'null') > MAX_EVALUATION_BYTES) {
      throw new BrowserAutomationError('INVALID_ARGUMENT', 'Browser evaluation result exceeds 256 KiB');
    }
    return { tab_id: tabId, value };
  }

  private async screenshot(
    tabId: string,
    params: GianToolMethodParams['browser.screenshot'],
  ): Promise<GianToolMethodData['browser.screenshot']> {
    const contents = this.controller.automationPage(tabId).contents;
    let image = await contents.capturePage();
    if (image.isEmpty()) throw new BrowserAutomationError('INTERNAL_ERROR', 'Browser screenshot is empty');
    const requestedWidth = params.max_width ?? 1_600;
    if (image.getSize().width > requestedWidth) image = image.resize({ width: requestedWidth, quality: 'good' });
    let png = image.toPNG();
    while (png.byteLength > MAX_SCREENSHOT_BYTES && image.getSize().width > 320) {
      image = image.resize({ width: Math.max(320, Math.floor(image.getSize().width * 0.75)), quality: 'good' });
      png = image.toPNG();
    }
    if (png.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new BrowserAutomationError('INTERNAL_ERROR', 'Browser screenshot exceeds the 4 MiB response limit');
    }
    const size = image.getSize();
    return {
      tab_id: tabId,
      mime_type: 'image/png',
      base64: png.toString('base64'),
      width: size.width,
      height: size.height,
    };
  }

  private afterNavigation(tabId: string, navigate: () => unknown): GianBrowserTabSnapshot {
    navigate();
    this.snapshots.delete(tabId);
    return pageSnapshot(this.controller, tabId);
  }
}
