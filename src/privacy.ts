/**
 * TraceKit Replay - Privacy Sanitizer
 *
 * Replay treats recorder output as untrusted data. This module sanitizes
 * events before buffering, and it can run again before every upload path.
 */

const MAX_DEPTH = 8;
const MAX_KEYS = 100;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 4096;
const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const MASKED_KEY = 'data-tracekit-mask';
const BLOCKED_KEY = 'data-tracekit-block';

const SENSITIVE_KEY = /(?:password|passwd|secret|token|authorization|cookie|credential|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|client[-_ ]?secret|body|value)/i;
const URL_KEY = /(?:^|[-_])(url|href|src|action|formaction|poster|cite|background|longdesc|origin|referrer|endpoint|location)(?:$|[-_])/i;
const MARKER_STRING = /(?:canary|secret|password|passwd|token|authorization|bearer|cookie|api[-_ ]?key|private[-_ ]?key)/i;
const SAFE_URL_PROTOCOL = /^(?:https?:)$/i;

export interface PrivacyOptions {
  unmask?: string[];
  maxDepth?: number;
}

interface NodeContext {
  protected: boolean;
  unmasked: boolean;
}

const DEFAULT_OPTIONS: Required<PrivacyOptions> = {
  unmask: [],
  maxDepth: MAX_DEPTH,
};

function options(value?: PrivacyOptions): Required<PrivacyOptions> {
  return {
    unmask: Array.isArray(value?.unmask) ? value!.unmask : DEFAULT_OPTIONS.unmask,
    maxDepth: Number.isSafeInteger(value?.maxDepth) && value!.maxDepth! > 0
      ? Math.min(value!.maxDepth!, MAX_DEPTH)
      : DEFAULT_OPTIONS.maxDepth,
  };
}

function mask(value: string): string {
  return '*'.repeat(Math.min(value.length, MAX_STRING_LENGTH));
}

function bounded(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}` : value;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function isUrlKey(key: string): boolean {
  return URL_KEY.test(key);
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
    return line.replace(/([a-z][a-z\d+.-]*:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/gi, '$1');
  });
  return bounded(lines.join('\n'));
}

function sanitizeString(value: string, key: string, mode: 'generic' | 'metadata' | 'attribute' | 'stack' = 'generic'): string {
  if (mode === 'stack' || key === 'stack') return sanitizeStack(value);
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
  const attributes = node.attributes && typeof node.attributes === 'object'
    ? node.attributes as Record<string, unknown>
    : {};
  const classes = typeof attributes.class === 'string' ? attributes.class.split(/\s+/) : [];
  const id = typeof attributes.id === 'string' ? attributes.id : '';

  const simple = trimmed.match(/^(?:(\*|[a-z][a-z\d-]*))?(#[\w-]+)?((?:\.[\w-]+)*)?(?:\[([\w:-]+)(?:=["']?([^\]"']+)["']?)?\])?$/i);
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

function protectedElement(node: Record<string, unknown>): boolean {
  const tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  const attributes = node.attributes && typeof node.attributes === 'object'
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
    /(?:^|\s)(?:rr-block|tracekit-block)(?:\s|$)/.test(className),
  );
}

function sanitizeAttributes(attributes: unknown, protectedNode: boolean, depth: number, opts: Required<PrivacyOptions>): Record<string, unknown> {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (typeof value === 'string') {
      if (isUrlKey(key)) {
        output[key] = sanitizeReplayUrl(value);
      } else if (protectedNode || isSensitiveKey(key)) {
        output[key] = mask(value);
      } else {
        output[key] = sanitizeString(value, key, 'attribute');
      }
    } else {
      output[key] = sanitizeValue(value, key, depth + 1, opts, 'generic');
    }
  }
  return output;
}

function sanitizeNode(node: unknown, context: NodeContext, depth: number, opts: Required<PrivacyOptions>): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  if (depth > opts.maxDepth) return null;
  const source = node as Record<string, unknown>;
  const type = source.type;
  if (type === 3 || type === 4 || type === 5) {
    const key = type === 3 ? 'textContent' : type === 4 ? 'textContent' : 'text';
    const value = typeof source[key] === 'string' ? source[key] as string : '';
    return { ...source, [key]: context.protected || !context.unmasked ? mask(value) : bounded(value) };
  }

  const isElement = type === 2;
  const isProtected = context.protected || (isElement && protectedElement(source));
  const isUnmasked = !isProtected && (context.unmasked || (isElement && matchesAnySelector(source, opts.unmask)));
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source).slice(0, MAX_KEYS)) {
    if (key === 'attributes') {
      output[key] = sanitizeAttributes(value, isProtected, depth, opts);
    } else if (key === 'childNodes' && Array.isArray(value)) {
      output[key] = value.slice(0, MAX_ARRAY_ITEMS)
        .map((child) => sanitizeNode(child, { protected: isProtected, unmasked: isUnmasked }, depth + 1, opts))
        .filter((child) => child !== null);
    } else if (typeof value === 'string') {
      output[key] = sanitizeString(value, key, 'attribute');
    } else {
      output[key] = sanitizeValue(value, key, depth + 1, opts, 'generic');
    }
  }
  return output;
}

function sanitizeValue(value: unknown, key: string, depth: number, opts: Required<PrivacyOptions>, mode: 'generic' | 'console' | 'custom'): unknown {
  if (depth > opts.maxDepth) return TRUNCATED;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeString(value, key, mode === 'console' ? 'metadata' : 'generic');
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, key, depth + 1, opts, mode));
  }
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (typeof childValue === 'string' && isUrlKey(childKey)) {
      output[childKey] = sanitizeReplayUrl(childValue);
    } else if (typeof childValue === 'string' && (childKey === 'stack' || childKey === 'stackTrace')) {
      output[childKey] = sanitizeStack(childValue);
    } else if (typeof childValue === 'string' && isSensitiveKey(childKey)) {
      output[childKey] = REDACTED;
    } else {
      output[childKey] = sanitizeValue(childValue, childKey, depth + 1, opts, mode);
    }
  }
  return output;
}

export function sanitizeConsolePayload(value: unknown, privacyOptions?: PrivacyOptions): unknown {
  return sanitizeValue(value, 'console', 0, options(privacyOptions), 'console');
}

export function sanitizeCustomEventPayload(value: unknown, privacyOptions?: PrivacyOptions): unknown {
  return sanitizeValue(value, 'custom-event', 0, options(privacyOptions), 'custom');
}

/** Sanitize one rrweb event. Return null when the event is unsafe or malformed. */
function sanitizeReplayEventUnsafe(value: unknown, privacyOptions?: PrivacyOptions): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.type !== 'number') return null;
  if (source.data === undefined) return { ...source, data: {} };
  if (!source.data || typeof source.data !== 'object') return null;
  const opts = options(privacyOptions);
  const output: Record<string, unknown> = { ...source };
  const data = source.data as Record<string, unknown>;

  if (source.type === 2) {
    if (!Object.prototype.hasOwnProperty.call(data, 'node')) return output;
    if (!data.node) return null;
    const node = sanitizeNode(data.node, { protected: false, unmasked: false }, 0, opts);
    if (!node) return null;
    output.data = { ...data, node };
    return output;
  }

  if (source.type === 3 && data.source === 0) {
    const safeData: Record<string, unknown> = { ...data };
    if (Array.isArray(data.texts)) safeData.texts = data.texts.slice(0, MAX_ARRAY_ITEMS).map((text) => ({
      ...(text as Record<string, unknown>),
      value: typeof (text as Record<string, unknown>).value === 'string' ? mask((text as Record<string, unknown>).value as string) : null,
    }));
    if (Array.isArray(data.attributes)) {
      safeData.attributes = data.attributes.slice(0, MAX_ARRAY_ITEMS).map((mutation) => {
        const item = mutation as Record<string, unknown>;
        return { ...item, attributes: sanitizeAttributes(item.attributes, false, 0, opts) };
      });
    }
    if (Array.isArray(data.adds)) {
      safeData.adds = data.adds.slice(0, MAX_ARRAY_ITEMS).map((addition) => {
        const item = addition as Record<string, unknown>;
        return { ...item, node: sanitizeNode(item.node, { protected: false, unmasked: false }, 0, opts) };
      }).filter((item) => item.node !== null);
    }
    output.data = safeData;
    return output;
  }

  if (source.type === 3 && data.source === 5) {
    output.data = { ...data, text: typeof data.text === 'string' ? mask(data.text) : '' };
    return output;
  }

  if (source.type === 4 && typeof data.href === 'string') {
    output.data = { ...data, href: sanitizeReplayUrl(data.href) };
    return output;
  }

  if (source.type === 5) {
    if (typeof data.tag !== 'string') return null;
    output.data = {
      ...data,
      tag: sanitizeMetadataValue(data.tag),
      payload: sanitizeCustomEventPayload(data.payload, privacyOptions),
    };
    return output;
  }

  output.data = sanitizeValue(data, 'data', 0, opts, 'generic');
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
  return events.map((event) => sanitizeReplayEvent(event, privacyOptions)).filter((event): event is Record<string, unknown> => event !== null);
}
