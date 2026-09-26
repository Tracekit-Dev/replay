/**
 * TraceKit Replay - Privacy Sanitizer
 *
 * Replay treats recorder output as untrusted data. This module constructs
 * bounded event values before buffering, compression, or upload.
 */

const MAX_DEPTH = 8;
const MAX_KEYS = 100;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 4096;
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_SELECTOR_LENGTH = 256;
const MAX_SELECTORS = 50;
const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const MASKED_KEY = 'data-tracekit-mask';
const BLOCKED_KEY = 'data-tracekit-block';
const UNMASK_KEY = 'data-tracekit-unmask';

const SENSITIVE_KEY = /(?:password|passwd|secret|token|authorization|cookie|credential|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|client[-_ ]?secret|body|value)/i;
const MARKER_STRING = /(?:canary|secret|password|passwd|token|authorization|bearer|cookie|api[-_ ]?key|private[-_ ]?key)/i;
const SAFE_URL_PROTOCOL = /^(?:https?:)$/i;
const URL_FIELD_NAMES = new Set([
  'url', 'href', 'src', 'action', 'formaction', 'poster', 'cite', 'background',
  'longdesc', 'origin', 'referrer', 'endpoint', 'location', 'pageurl',
  'requesturl', 'documenturl', 'sourceurl', 'targeturl', 'redirecturl',
]);
const MEDIA_TAG_NAMES = new Set(['img', 'video', 'canvas', 'svg', 'iframe', 'object', 'embed']);

export interface PrivacyOptions {
  unmask?: string[];
  maxDepth?: number;
  blockMedia?: boolean;
}

interface ResolvedPrivacyOptions {
  unmask: string[];
  maxDepth: number;
  blockMedia: boolean;
}

interface NodeContext {
  protected: boolean;
  unmasked: boolean;
}

const DEFAULT_OPTIONS: ResolvedPrivacyOptions = {
  unmask: [],
  maxDepth: MAX_DEPTH,
  blockMedia: true,
};

function options(value?: PrivacyOptions): ResolvedPrivacyOptions {
  const selectors = Array.isArray(value?.unmask)
    ? value!.unmask
      .filter((selector): selector is string => typeof selector === 'string')
      .map((selector) => selector.slice(0, MAX_SELECTOR_LENGTH))
      .slice(0, MAX_SELECTORS)
    : DEFAULT_OPTIONS.unmask;
  return {
    unmask: selectors,
    maxDepth: Number.isSafeInteger(value?.maxDepth) && value!.maxDepth! > 0
      ? Math.min(value!.maxDepth!, MAX_DEPTH)
      : DEFAULT_OPTIONS.maxDepth,
    blockMedia: value?.blockMedia !== false,
  };
}

function bounded(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}` : value;
}

function mask(value: string): string {
  return '*'.repeat(Math.min(value.length, MAX_STRING_LENGTH));
}

function safeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(-MAX_NUMBER, Math.min(MAX_NUMBER, value));
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isUrlKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return URL_FIELD_NAMES.has(normalized) || normalized.endsWith('url') || normalized.endsWith('href') || normalized.endsWith('src');
}

/** Remove credentials, query strings, fragments, and unsafe protocols. */
export function sanitizeReplayUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const input = value.trim();
  if (!input) return '';

  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(input);
    const parsed = new URL(input, 'https://tracekit.invalid');
    if (!SAFE_URL_PROTOCOL.test(parsed.protocol)) return '';
    const path = parsed.pathname || '/';
    if (absolute) return `${parsed.protocol}//${parsed.host}${path}`;
    return path;
  } catch {
    return '';
  }
}

function sanitizeStack(value: string): string {
  const lines = value.split(/\r?\n/).slice(0, 64).map((line) => {
    if (MARKER_STRING.test(line)) return REDACTED;
    return line.replace(/[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, (url) => sanitizeReplayUrl(url));
  });
  return bounded(lines.join('\n'));
}

function sanitizeString(value: string, key: string, mode: 'generic' | 'metadata' | 'attribute' | 'stack' = 'generic'): string {
  if (mode === 'stack' || key === 'stack' || key === 'stackTrace') return sanitizeStack(value);
  if (isUrlKey(key)) return sanitizeReplayUrl(value);
  if (isSensitiveKey(key) || MARKER_STRING.test(value)) return REDACTED;
  return bounded(value);
}

export function sanitizeMetadataValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  return sanitizeString(value, 'metadata', 'metadata');
}

function matchesSelector(node: Record<string, unknown>, selector: string): boolean {
  const trimmed = selector.trim();
  if (!trimmed || /[{};]/.test(trimmed)) return false;
  const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  const attributes = node.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes)
    ? node.attributes as Record<string, unknown>
    : {};
  const classes = typeof attributes.class === 'string' ? attributes.class.split(/\s+/) : [];
  const id = typeof attributes.id === 'string' ? attributes.id : '';
  const simple = trimmed.match(/^(?:(\*|[a-z][a-z\d-]*))?(#[\w-]+)?((?:\.[\w-]+)*)(?:\[([\w:-]+)(?:=["']?([^\]"']+)["']?)?\])?$/i);
  if (!simple) return false;
  const [, tag, idSelector, classSelector, attrName, attrValue] = simple;
  if (tag && tag !== '*' && tag.toLowerCase() !== tagName) return false;
  if (idSelector && idSelector.slice(1) !== id) return false;
  if (classSelector && classSelector.split('.').filter(Boolean).some((name) => !classes.includes(name))) return false;
  if (attrName) {
    if (!Object.prototype.hasOwnProperty.call(attributes, attrName)) return false;
    if (attrValue !== undefined && String(attributes[attrName]) !== attrValue) return false;
  }
  return true;
}

function matchesAnySelector(node: Record<string, unknown>, selectors: string[]): boolean {
  return selectors.some((selector) => selector.split(',').some((part) => matchesSelector(node, part)));
}

function protectedElement(node: Record<string, unknown>, opts: ResolvedPrivacyOptions): boolean {
  const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  const attributes = node.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes)
    ? node.attributes as Record<string, unknown>
    : {};
  const type = typeof attributes.type === 'string' ? attributes.type.toLowerCase() : '';
  const className = typeof attributes.class === 'string' ? attributes.class : '';
  return Boolean(
    node.needBlock === true ||
    tagName === 'input' || tagName === 'textarea' || tagName === 'select' ||
    type === 'password' ||
    Object.prototype.hasOwnProperty.call(attributes, MASKED_KEY) ||
    Object.prototype.hasOwnProperty.call(attributes, BLOCKED_KEY) ||
    /(?:^|\s)(?:rr-block|tracekit-block)(?:\s|$)/.test(className) ||
    (opts.blockMedia && MEDIA_TAG_NAMES.has(tagName)),
  );
}

function safeObjectKey(key: string): string {
  return bounded(key).slice(0, MAX_STRING_LENGTH);
}

function sanitizeAttributes(
  attributes: unknown,
  protectedNode: boolean,
  depth: number,
  opts: ResolvedPrivacyOptions,
): Record<string, unknown> {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return {};
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(attributes as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (key === 'toJSON') continue;
    const value = (attributes as Record<string, unknown>)[key];
    const outputKey = safeObjectKey(key);
    if (typeof value === 'string') {
      output[outputKey] = protectedNode ? mask(value) : sanitizeString(value, key, 'attribute');
    } else {
      const safeValue = sanitizeValue(value, key, depth + 1, opts, 'generic');
      if (safeValue !== null) output[outputKey] = safeValue;
    }
  }
  return output;
}

function sanitizeNodeText(value: string, context: NodeContext): string {
  if (context.protected || !context.unmasked) return mask(value);
  const unmasked = bounded(value);
  return MARKER_STRING.test(unmasked) ? REDACTED : unmasked;
}

function copyNodeScalar(output: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (typeof value === 'boolean') output[key] = value;
  else if (typeof value === 'string') output[key] = sanitizeString(value, key, 'attribute');
}

function sanitizeNode(node: unknown, context: NodeContext, depth: number, opts: ResolvedPrivacyOptions): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  if (depth > opts.maxDepth) return null;
  const source = node as Record<string, unknown>;
  const type = safeNumber(source.type);
  if (type === null) return null;
  const output: Record<string, unknown> = { type };
  const id = safeNumber(source.id);
  if (id !== null) output.id = id;

  if (type === 3 || type === 4 || type === 5) {
    const key = type === 3 || type === 4 ? 'textContent' : 'text';
    const value = typeof source[key] === 'string' ? source[key] as string : '';
    output[key] = sanitizeNodeText(value, context);
    return output;
  }

  const isElement = type === 2;
  const isProtected = context.protected || (isElement && protectedElement(source, opts));
  const attributes = source.attributes;
  if (attributes !== undefined) output.attributes = sanitizeAttributes(attributes, isProtected, depth, opts);
  if (typeof source.tagName === 'string') output.tagName = sanitizeString(source.tagName, 'tagName', 'attribute');
  if (Array.isArray(source.childNodes)) {
    const children: unknown[] = [];
    for (const child of source.childNodes.slice(0, MAX_ARRAY_ITEMS)) {
      const unmasked = !isProtected && (
        context.unmasked ||
        (isElement && (matchesAnySelector(source, opts.unmask) || Object.prototype.hasOwnProperty.call(
          attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {}, UNMASK_KEY,
        )))
      );
      const safeChild = sanitizeNode(child, { protected: isProtected, unmasked }, depth + 1, opts);
      if (safeChild !== null) children.push(safeChild);
    }
    output.childNodes = children;
  }

  for (const key of ['isSVG', 'needBlock', 'isShadow', 'publicId', 'systemId', 'name', 'value', 'checked', 'selected']) {
    copyNodeScalar(output, source, key);
  }
  return output;
}

function sanitizeValue(
  value: unknown,
  key: string,
  depth: number,
  opts: ResolvedPrivacyOptions,
  mode: 'generic' | 'console' | 'custom',
): unknown {
  if (depth > opts.maxDepth) return TRUNCATED;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return safeNumber(value);
  if (typeof value === 'string') return sanitizeString(value, key, mode === 'console' ? 'metadata' : 'generic');
  if (typeof value === 'bigint') return bounded(String(value));
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, key, depth + 1, opts, mode));
  }
  const output: Record<string, unknown> = {};
  for (const childKey of Object.keys(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (childKey === 'toJSON') continue;
    const childValue = (value as Record<string, unknown>)[childKey];
    if (typeof childValue === 'function') continue;
    const safeValue = sanitizeValue(childValue, childKey, depth + 1, opts, mode);
    if (safeValue !== null) output[safeObjectKey(childKey)] = safeValue;
  }
  return output;
}

export function sanitizeConsolePayload(value: unknown, privacyOptions?: PrivacyOptions): unknown {
  return sanitizeValue(value, 'console', 0, options(privacyOptions), 'console');
}

export function sanitizeCustomEventPayload(value: unknown, privacyOptions?: PrivacyOptions): unknown {
  return sanitizeValue(value, 'custom-event', 0, options(privacyOptions), 'custom');
}

function sanitizeMutation(data: Record<string, unknown>, opts: ResolvedPrivacyOptions): Record<string, unknown> {
  const output: Record<string, unknown> = { source: 0 };
  if (Array.isArray(data.texts)) {
    const texts: Record<string, unknown>[] = [];
    for (const value of data.texts.slice(0, MAX_ARRAY_ITEMS)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const source = value as Record<string, unknown>;
      const item: Record<string, unknown> = {};
      const id = safeNumber(source.id);
      if (id !== null) item.id = id;
      if (typeof source.value === 'string') item.value = mask(source.value);
      texts.push(item);
    }
    output.texts = texts;
  }
  if (Array.isArray(data.attributes)) {
    const attributes: Record<string, unknown>[] = [];
    for (const value of data.attributes.slice(0, MAX_ARRAY_ITEMS)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const source = value as Record<string, unknown>;
      const item: Record<string, unknown> = {};
      const id = safeNumber(source.id);
      if (id !== null) item.id = id;
      item.attributes = sanitizeAttributes(source.attributes, false, 0, opts);
      attributes.push(item);
    }
    output.attributes = attributes;
  }
  if (Array.isArray(data.removes)) {
    const removes: Record<string, unknown>[] = [];
    for (const value of data.removes.slice(0, MAX_ARRAY_ITEMS)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const source = value as Record<string, unknown>;
      const item: Record<string, unknown> = {};
      const parentId = safeNumber(source.parentId);
      const id = safeNumber(source.id);
      if (parentId !== null) item.parentId = parentId;
      if (id !== null) item.id = id;
      removes.push(item);
    }
    output.removes = removes;
  }
  if (Array.isArray(data.adds)) {
    const adds: Record<string, unknown>[] = [];
    for (const value of data.adds.slice(0, MAX_ARRAY_ITEMS)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const source = value as Record<string, unknown>;
      const node = sanitizeNode(source.node, { protected: false, unmasked: false }, 0, opts);
      if (!node) continue;
      const item: Record<string, unknown> = { node };
      const parentId = safeNumber(source.parentId);
      const nextId = safeNumber(source.nextId);
      if (parentId !== null) item.parentId = parentId;
      if (nextId !== null) item.nextId = nextId;
      else if (source.nextId === null) item.nextId = null;
      adds.push(item);
    }
    output.adds = adds;
  }
  return output;
}

function sanitizeEventData(type: number, data: Record<string, unknown>, opts: ResolvedPrivacyOptions, privacyOptions?: PrivacyOptions): Record<string, unknown> | null {
  if (type === 2 && Object.prototype.hasOwnProperty.call(data, 'node')) {
    const node = sanitizeNode(data.node, { protected: false, unmasked: false }, 0, opts);
    if (!node) return null;
    const output: Record<string, unknown> = { node };
    if (data.initialOffset !== undefined) {
      const initialOffset = sanitizeValue(data.initialOffset, 'initialOffset', 0, opts, 'generic');
      if (initialOffset !== null) output.initialOffset = initialOffset;
    }
    return output;
  }
  if (type === 3 && data.source === 0) return sanitizeMutation(data, opts);
  if (type === 3 && data.source === 5) {
    const output: Record<string, unknown> = { source: 5 };
    if (typeof data.text === 'string') output.text = mask(data.text);
    if (typeof data.isChecked === 'boolean') output.isChecked = data.isChecked;
    return output;
  }
  if (type === 4) {
    const output = sanitizeValue(data, 'data', 0, opts, 'generic');
    return output && typeof output === 'object' && !Array.isArray(output)
      ? output as Record<string, unknown>
      : null;
  }
  if (type === 5) {
    if (typeof data.tag !== 'string') return null;
    return {
      tag: sanitizeMetadataValue(data.tag),
      payload: sanitizeCustomEventPayload(data.payload, privacyOptions),
    };
  }
  const output = sanitizeValue(data, 'data', 0, opts, 'generic');
  return output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown>
    : null;
}

/** Sanitize one rrweb event. Return null when the event is unsafe or malformed. */
function sanitizeReplayEventUnsafe(value: unknown, privacyOptions?: PrivacyOptions): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const type = safeNumber(source.type);
  if (type === null) return null;
  const output: Record<string, unknown> = { type };
  const timestamp = safeNumber(source.timestamp);
  if (timestamp !== null) output.timestamp = timestamp;
  const opts = options(privacyOptions);
  if (source.data === undefined) {
    output.data = {};
    return output;
  }
  if (!source.data || typeof source.data !== 'object' || Array.isArray(source.data)) return null;
  const data = sanitizeEventData(type, source.data as Record<string, unknown>, opts, privacyOptions);
  if (!data) return null;
  output.data = data;
  return output;
}

export function sanitizeReplayEvent(value: unknown, privacyOptions?: PrivacyOptions): Record<string, unknown> | null {
  try {
    return sanitizeReplayEventUnsafe(value, privacyOptions);
  } catch {
    return null;
  }
}

export function sanitizeReplayEvents(events: unknown[], privacyOptions?: PrivacyOptions): Record<string, unknown>[] {
  if (!Array.isArray(events)) return [];
  return events.slice(0, MAX_ARRAY_ITEMS)
    .map((event) => sanitizeReplayEvent(event, privacyOptions))
    .filter((event): event is Record<string, unknown> => event !== null);
}
