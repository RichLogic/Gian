export const MAX_BROWSER_ELEMENT_PAGE_URL_CHARS = 2_048;
export const MAX_BROWSER_ELEMENT_PAGE_TITLE_CHARS = 200;
export const MAX_BROWSER_ELEMENT_TAG_CHARS = 64;
export const MAX_BROWSER_ELEMENT_SELECTOR_CHARS = 512;
export const MAX_BROWSER_ELEMENT_NAME_CHARS = 2_048;
export const MAX_BROWSER_ELEMENT_ATTRIBUTE_COUNT = 16;
export const MAX_BROWSER_ELEMENT_ATTRIBUTE_NAME_CHARS = 64;
export const MAX_BROWSER_ELEMENT_ATTRIBUTE_VALUE_CHARS = 256;
export const MAX_BROWSER_ELEMENT_SNIPPET_CHARS = 8_192;

const ALLOWED_ATTRIBUTES = new Set([
  'id',
  'class',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-expanded',
  'aria-selected',
  'aria-checked',
  'aria-current',
  'alt',
  'title',
  'href',
  'src',
  'type',
  'name',
  'placeholder',
  'data-testid',
  'data-test',
  'data-cy',
]);
const URL_ATTRIBUTES = new Set(['href', 'src']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const FORM_TAGS = new Set(['input', 'textarea', 'select', 'option']);

export interface GianBrowserElementCapture {
  pageUrl: string;
  pageTitle: string;
  tagName: string;
  selector: string;
  role?: string;
  name?: string;
  attributes: Record<string, string>;
  contentOmitted: boolean;
  snippet: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function sanitizeBrowserPageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'gian-browser:') {
      return null;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    if (url.protocol === 'gian-browser:') url.hostname = 'project';
    return url.toString().slice(0, MAX_BROWSER_ELEMENT_PAGE_URL_CHARS);
  } catch {
    return null;
  }
}

function sanitizeUrlAttribute(value: string, pageUrl: string): string | null {
  try {
    const url = new URL(value, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'gian-browser:') {
      return null;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    if (url.protocol === 'gian-browser:') url.hostname = 'project';
    return url.toString().slice(0, MAX_BROWSER_ELEMENT_ATTRIBUTE_VALUE_CHARS);
  } catch {
    return null;
  }
}

export function sanitizeBrowserElementAttributes(
  value: unknown,
  pageUrl: string,
): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, string]> = [];
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase().slice(0, MAX_BROWSER_ELEMENT_ATTRIBUTE_NAME_CHARS);
    if (!ALLOWED_ATTRIBUTES.has(name) || typeof rawValue !== 'string') continue;
    const collapsed = collapseWhitespace(rawValue);
    if (!collapsed) continue;
    const normalized = URL_ATTRIBUTES.has(name)
      ? sanitizeUrlAttribute(collapsed, pageUrl)
      : collapsed.slice(0, MAX_BROWSER_ELEMENT_ATTRIBUTE_VALUE_CHARS);
    if (!normalized) continue;
    entries.push([name, normalized]);
    if (entries.length >= MAX_BROWSER_ELEMENT_ATTRIBUTE_COUNT) break;
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function selectorAttribute(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function browserElementSelector(
  tagName: string,
  attributes: Record<string, string>,
): string {
  const tag = tagName.toLowerCase();
  if (attributes.id) return `${tag}[id="${selectorAttribute(attributes.id)}"]`.slice(0, MAX_BROWSER_ELEMENT_SELECTOR_CHARS);
  for (const testAttribute of ['data-testid', 'data-test', 'data-cy']) {
    const value = attributes[testAttribute];
    if (value) return `${tag}[${testAttribute}="${selectorAttribute(value)}"]`.slice(0, MAX_BROWSER_ELEMENT_SELECTOR_CHARS);
  }
  const classes = (attributes.class ?? '')
    .split(/\s+/)
    .filter(entry => /^-?[_a-zA-Z]+[_a-zA-Z0-9-]*$/.test(entry))
    .slice(0, 3);
  if (classes.length > 0) return `${tag}.${classes.join('.')}`.slice(0, MAX_BROWSER_ELEMENT_SELECTOR_CHARS);
  if (attributes['aria-label']) {
    return `${tag}[aria-label="${selectorAttribute(attributes['aria-label'])}"]`
      .slice(0, MAX_BROWSER_ELEMENT_SELECTOR_CHARS);
  }
  return tag;
}

export function browserElementSnippet(input: {
  tagName: string;
  attributes: Record<string, string>;
  name?: string;
  contentOmitted: boolean;
}): string {
  const attributes = Object.entries(input.attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  const open = `<${input.tagName}${attributes}>`;
  if (VOID_TAGS.has(input.tagName)) return open.slice(0, MAX_BROWSER_ELEMENT_SNIPPET_CHARS);
  const content = input.contentOmitted
    ? '…'
    : escapeText(input.name ?? '');
  return `${open}${content}</${input.tagName}>`.slice(0, MAX_BROWSER_ELEMENT_SNIPPET_CHARS);
}

/** Revalidates Desktop-captured element context at every trust boundary. */
export function normalizeBrowserElementCapture(value: unknown): GianBrowserElementCapture | null {
  if (!isRecord(value)) return null;
  const pageUrl = sanitizeBrowserPageUrl(value.pageUrl);
  if (!pageUrl) return null;
  const rawTag = boundedString(value.tagName, MAX_BROWSER_ELEMENT_TAG_CHARS).toLowerCase();
  if (!/^[a-z][a-z0-9:-]*$/.test(rawTag)) return null;
  const attributes = sanitizeBrowserElementAttributes(value.attributes, pageUrl);
  const contentOmitted = value.contentOmitted === true || FORM_TAGS.has(rawTag);
  const role = collapseWhitespace(boundedString(value.role, 64));
  const name = contentOmitted
    ? ''
    : collapseWhitespace(boundedString(value.name, MAX_BROWSER_ELEMENT_NAME_CHARS));
  const normalized: GianBrowserElementCapture = {
    pageUrl,
    pageTitle: collapseWhitespace(boundedString(value.pageTitle, MAX_BROWSER_ELEMENT_PAGE_TITLE_CHARS)),
    tagName: rawTag,
    selector: browserElementSelector(rawTag, attributes),
    attributes,
    contentOmitted,
    snippet: '',
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
  };
  normalized.snippet = browserElementSnippet(normalized);
  return normalized;
}
