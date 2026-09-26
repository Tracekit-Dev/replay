/** Fail-closed rrweb event sanitizer. No original event escapes on failure. */
import type { ResolvedReplayConfig } from './types';

const MAX_DEPTH = 64;
const MAX_NODES = 20_000;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_STRING = 2_048;
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster']);
const BOOLEAN_ATTRIBUTES = new Set(['checked', 'selected', 'disabled', 'aria-hidden']);
const NUMBER_ATTRIBUTES = new Set(['width', 'height', 'colspan', 'rowspan']);
const ENUM_ATTRIBUTES = new Set(['type', 'role']);

export function sanitizeReplayUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 8_192) return '';
  try {
    const parsed = new URL(raw, typeof location !== 'undefined' ? location.href : 'https://replay.invalid/');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin === 'https://replay.invalid' && !/^https?:/i.test(raw)
      ? parsed.pathname : parsed.toString();
  } catch { return ''; }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeString(value: unknown, max = MAX_STRING): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function attributes(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (URL_ATTRIBUTES.has(lower)) {
      const cleaned = sanitizeReplayUrl(value);
      if (cleaned) out[lower] = cleaned;
    } else if (BOOLEAN_ATTRIBUTES.has(lower) && (value === true || value === '' || value === 'true')) {
      out[lower] = true;
    } else if (NUMBER_ATTRIBUTES.has(lower) && /^(?:[1-9]\d{0,4}|0)$/.test(String(value))) {
      out[lower] = Number(value);
    } else if (ENUM_ATTRIBUTES.has(lower) && typeof value === 'string' && /^[a-z-]{1,32}$/i.test(value)) {
      out[lower] = value.toLowerCase();
    }
  }
  return out;
}

function isBlocked(node: any, config?: ResolvedReplayConfig): boolean {
  const attrs = node?.attributes;
  if (!attrs || typeof attrs !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(attrs, 'data-tracekit-block')) return true;
  const tag = String(node.tagName ?? '').toLowerCase();
  if (config?.blockMedia && ['img', 'video', 'canvas', 'svg', 'iframe'].includes(tag)) return true;
  for (const selector of config?.block ?? []) {
    if (selector === '*') return true;
    if (selector.startsWith('.') && String(attrs.class ?? '').split(/\s+/).includes(selector.slice(1))) return true;
    if (selector.startsWith('#') && attrs.id === selector.slice(1)) return true;
    if (selector === tag) return true;
    try {
      if (typeof document !== 'undefined') {
        const candidate = document.createElement(tag || 'div');
        for (const [key, value] of Object.entries(attrs)) if (typeof value === 'string') candidate.setAttribute(key, value);
        if (candidate.matches(selector)) return true;
      }
    } catch { return true; }
  }
  return false;
}

function node(raw: any, depth: number, count: { value: number }, config?: ResolvedReplayConfig): any {
  if (!raw || typeof raw !== 'object' || depth > MAX_DEPTH || ++count.value > MAX_NODES) throw new Error('unsafe node');
  const type = finite(raw.type), id = finite(raw.id);
  if (type === null || id === null || !Number.isSafeInteger(id)) throw new Error('unsafe node identity');
  const base: any = { type, id };
  if (type === 0) {
    base.childNodes = Array.isArray(raw.childNodes) ? raw.childNodes.map((child: unknown) => node(child, depth + 1, count, config)) : [];
  } else if (type === 1) {
    base.name = safeString(raw.name, 40);
    base.publicId = '';
    base.systemId = '';
  } else if (type === 2) {
    base.tagName = /^[a-z][a-z0-9-]{0,39}$/i.test(raw.tagName) ? raw.tagName.toLowerCase() : 'div';
    base.attributes = attributes(raw.attributes);
    if (isBlocked(raw, config) || raw.needBlock === true) {
      base.needBlock = true;
      base.childNodes = [];
    } else {
      base.childNodes = Array.isArray(raw.childNodes) ? raw.childNodes.map((child: unknown) => node(child, depth + 1, count, config)) : [];
    }
  } else if (type === 3 || type === 4 || type === 5) {
    base.textContent = '*'.repeat(Math.min(String(raw.textContent ?? '').length, MAX_STRING));
  } else throw new Error('unknown node type');
  return base;
}

/** Return an independent safe event, or null when no safe representation exists. */
export function sanitizeReplayEvent(event: unknown, config?: ResolvedReplayConfig): any | null {
  try {
    if (!event || typeof event !== 'object') return null;
    const raw = event as any;
    const type = finite(raw.type), timestamp = finite(raw.timestamp);
    if (type === null || timestamp === null) return null;
    let data: any;
    if (type === 0 || type === 1) data = {};
    else if (type === 2) {
      const count = { value: 0 };
      data = { node: node(raw.data?.node, 0, count, config), initialOffset: {
        top: finite(raw.data?.initialOffset?.top) ?? 0,
        left: finite(raw.data?.initialOffset?.left) ?? 0,
      } };
    } else if (type === 3) {
      const source = finite(raw.data?.source);
      if (source === null) return null;
      if (source === 0) {
        const count = { value: 0 };
        data = { source, adds: (raw.data.adds ?? []).map((item: any) => ({
          parentId: finite(item.parentId), nextId: finite(item.nextId), previousId: finite(item.previousId),
          node: node(item.node, 0, count, config),
        })), texts: (raw.data.texts ?? []).map((item: any) => ({ id: finite(item.id), value: '*'.repeat(Math.min(String(item.value ?? '').length, MAX_STRING)) })),
        attributes: (raw.data.attributes ?? []).map((item: any) => ({ id: finite(item.id), attributes: attributes(item.attributes) })),
        removes: (raw.data.removes ?? []).map((item: any) => ({ parentId: finite(item.parentId), id: finite(item.id) })),
      };
    } else if (source === 5) data = { source, id: finite(raw.data.id), text: '*'.repeat(Math.min(String(raw.data.text ?? '').length, MAX_STRING)), isChecked: raw.data.isChecked === true };
    else if ([1, 2, 3, 4, 6, 7, 11, 13].includes(source)) {
      data = { source };
      for (const key of ['id', 'x', 'y', 'type', 'width', 'height', 'top', 'left', 'scale', 'scrollX', 'scrollY']) {
        const value = finite(raw.data[key]); if (value !== null) data[key] = value;
      }
      if (Array.isArray(raw.data.positions)) data.positions = raw.data.positions.slice(0, 100).map((p: any) => ({ x: finite(p.x) ?? 0, y: finite(p.y) ?? 0, id: finite(p.id) ?? 0, timeOffset: finite(p.timeOffset) ?? 0 }));
    } else return null;
    } else if (type === 4) {
      data = { href: sanitizeReplayUrl(raw.data?.href), width: finite(raw.data?.width) ?? 0, height: finite(raw.data?.height) ?? 0 };
    } else if (type === 5) {
      const tag = raw.data?.tag;
      const payload = raw.data?.payload;
      if (tag === 'tracekit.recording-boundary' && ['start', 'end'].includes(payload?.kind)) data = { tag, payload: { kind: payload.kind } };
      else if (tag === 'network-request') data = { tag, payload: {
        method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(payload?.method) ? payload.method : 'OTHER',
        url: sanitizeReplayUrl(payload?.url), status: finite(payload?.status), duration: finite(payload?.duration),
      } };
      else if (tag === 'console-log') data = { tag, payload: { level: ['log', 'info', 'warn', 'error', 'debug'].includes(payload?.level) ? payload.level : 'log', message: '[redacted]' } };
      else return null;
    } else return null;
    const safe = { type, timestamp, data };
    if (new TextEncoder().encode(JSON.stringify(safe)).byteLength > MAX_EVENT_BYTES) return null;
    return safe;
  } catch { return null; }
}
