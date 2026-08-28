import {
  normalizeBrowserElementCapture,
  type GianBrowserElementCapture,
} from '@gian/shared';

export interface CdpDomNode {
  backendNodeId?: number;
  nodeType?: number;
  nodeName?: string;
  localName?: string;
  nodeValue?: string;
  attributes?: unknown;
}

export interface CdpAxNode {
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
}

function attributesRecord(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < value.length; index += 2) {
    const name = value[index];
    const attributeValue = value[index + 1];
    if (typeof name === 'string' && typeof attributeValue === 'string') {
      result[name.toLowerCase()] = attributeValue;
    }
  }
  return result;
}

function axString(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as { value?: unknown }).value;
  return typeof candidate === 'string' ? candidate : undefined;
}

export function captureFromCdpNode(input: {
  pageUrl: string;
  pageTitle: string;
  node: CdpDomNode;
  axNodes?: CdpAxNode[];
}): GianBrowserElementCapture | null {
  const tagName = (input.node.localName ?? input.node.nodeName ?? '').toLowerCase();
  const rawAttributes = attributesRecord(input.node.attributes);
  const editable = tagName === 'input'
    || tagName === 'textarea'
    || tagName === 'select'
    || tagName === 'option'
    || ('contenteditable' in rawAttributes && rawAttributes.contenteditable !== 'false');
  const ax = input.axNodes?.find(node => (
    node.backendDOMNodeId === input.node.backendNodeId
  )) ?? input.axNodes?.[0];
  return normalizeBrowserElementCapture({
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    tagName,
    role: axString(ax?.role),
    name: editable ? undefined : axString(ax?.name),
    attributes: rawAttributes,
    contentOmitted: editable,
  });
}
