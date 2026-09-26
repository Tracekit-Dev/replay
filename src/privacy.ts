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
const sanitizedEvents = new WeakSet<object>();

interface NodePrivacy {
  parentId: number | null;
  block: boolean;
  mask: boolean;
  unmask: boolean;
}

function effective(id: number | null, states: Map<number, NodePrivacy>, seen = new Set<number>()): { block: boolean; mask: boolean; unmask: boolean } {
  if (id === null || seen.has(id)) return { block: false, mask: false, unmask: false };
  seen.add(id);
  const own = states.get(id);
  if (!own) return { block: false, mask: true, unmask: false };
  const parent = own.parentId === null ? { block: false, mask: false, unmask: false } : effective(own.parentId, states, seen);
  return { block: parent.block || own.block, mask: parent.mask || own.mask, unmask: parent.unmask || own.unmask };
}

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

function matchesSelector(node: any, selector: string): boolean {
  const attrs = node?.attributes;
  if (!attrs || typeof attrs !== 'object') return false;
  const tag = String(node.tagName ?? '').toLowerCase();
  if (selector === '*') return true;
  if (selector.startsWith('.') && String(attrs.class ?? '').split(/\s+/).includes(selector.slice(1))) return true;
  if (selector.startsWith('#') && attrs.id === selector.slice(1)) return true;
  if (selector === tag) return true;
  try {
    if (typeof document !== 'undefined') {
      const candidate = document.createElement(tag || 'div');
      for (const [key, value] of Object.entries(attrs)) if (typeof value === 'string') candidate.setAttribute(key, value);
      return candidate.matches(selector);
    }
  } catch { return true; }
  return false;
}

function isBlocked(node: any, config?: ResolvedReplayConfig): boolean {
  const attrs = node?.attributes;
  if (attrs && typeof attrs === 'object' && Object.prototype.hasOwnProperty.call(attrs, 'data-tracekit-block')) return true;
  const tag = String(node.tagName ?? '').toLowerCase();
  if (config?.blockMedia && ['img', 'video', 'canvas', 'svg', 'iframe'].includes(tag)) return true;
  return (config?.block ?? []).some((selector) => matchesSelector(node, selector));
}

function isMasked(node: any, config?: ResolvedReplayConfig): boolean {
  const attrs = node?.attributes;
  if (attrs && typeof attrs === 'object' && Object.prototype.hasOwnProperty.call(attrs, 'data-tracekit-mask')) return true;
  if (['input', 'textarea', 'select'].includes(String(node.tagName ?? '').toLowerCase())) return true;
  return (config?.mask ?? []).some((selector) => matchesSelector(node, selector));
}

function isUnmasked(node: any, config?: ResolvedReplayConfig): boolean {
  const attrs = node?.attributes;
  if (attrs && typeof attrs === 'object' && Object.prototype.hasOwnProperty.call(attrs, 'data-tracekit-unmask')) return true;
  return (config?.unmask ?? []).some((selector) => matchesSelector(node, selector));
}

function forget(id: number, states: Map<number, NodePrivacy>): void {
  const children = new Map<number, number[]>();
  for (const [nodeId, state] of states) {
    if (state.parentId === null) continue;
    const siblings = children.get(state.parentId) ?? [];
    siblings.push(nodeId);
    children.set(state.parentId, siblings);
  }
  const pending = [id];
  while (pending.length > 0) {
    const next = pending.pop()!;
    states.delete(next);
    pending.push(...(children.get(next) ?? []));
  }
}

function node(raw: any, depth: number, count: { value: number }, states: Map<number, NodePrivacy>, parentId: number | null, config?: ResolvedReplayConfig): any {
  if (!raw || typeof raw !== 'object' || depth > MAX_DEPTH || ++count.value > MAX_NODES) throw new Error('unsafe node');
  const type = finite(raw.type), id = finite(raw.id);
  if (type === null || id === null || !Number.isSafeInteger(id)) throw new Error('unsafe node identity');
  const base: any = { type, id };
  states.set(id, { parentId, block: type === 2 && (raw.needBlock === true || isBlocked(raw, config)), mask: type === 2 && isMasked(raw, config), unmask: type === 2 && isUnmasked(raw, config) });
  if (states.size > MAX_NODES) throw new Error('unsafe node state');
  const privacy = effective(id, states);
  if (type === 0) {
    base.childNodes = Array.isArray(raw.childNodes) ? raw.childNodes.map((child: unknown) => node(child, depth + 1, count, states, id, config)) : [];
  } else if (type === 1) {
    base.name = safeString(raw.name, 40);
    base.publicId = '';
    base.systemId = '';
  } else if (type === 2) {
    base.tagName = /^[a-z][a-z0-9-]{0,39}$/i.test(raw.tagName) ? raw.tagName.toLowerCase() : 'div';
    base.attributes = attributes(raw.attributes);
    if (privacy.block || raw.needBlock === true) {
      base.needBlock = true;
      base.childNodes = [];
      // Keep descendant IDs protected if rrweb later emits their mutations.
      if (Array.isArray(raw.childNodes)) for (const child of raw.childNodes) node(child, depth + 1, count, states, id, config);
    } else {
      base.childNodes = Array.isArray(raw.childNodes) ? raw.childNodes.map((child: unknown) => node(child, depth + 1, count, states, id, config)) : [];
    }
  } else if (type === 3 || type === 4 || type === 5) {
    const value = safeString(raw.textContent);
    base.textContent = !privacy.block && !privacy.mask && privacy.unmask ? value : '*'.repeat(value.length);
  } else throw new Error('unknown node type');
  return base;
}

/** Return an independent safe event, or null when no safe representation exists. */
export function sanitizeReplayEvent(event: unknown, config?: ResolvedReplayConfig, states = new Map<number, NodePrivacy>()): any | null {
  try {
    if (!event || typeof event !== 'object') return null;
    if (sanitizedEvents.has(event)) return event;
    const raw = event as any;
    const type = finite(raw.type), timestamp = finite(raw.timestamp);
    if (type === null || timestamp === null) return null;
    let data: any;
    if (type === 0 || type === 1) data = {};
    else if (type === 2) {
      // Preserve payload-free legacy transport markers without importing content.
      if (raw.data === undefined || (raw.data && Object.keys(raw.data).length === 0)) return { type, timestamp, data: {} };
      const count = { value: 0 };
      states.clear();
      data = { node: node(raw.data?.node, 0, count, states, null, config), initialOffset: {
        top: finite(raw.data?.initialOffset?.top) ?? 0,
        left: finite(raw.data?.initialOffset?.left) ?? 0,
      } };
    } else if (type === 3) {
      if (raw.data === undefined || (raw.data && Object.keys(raw.data).length === 0)) return { type, timestamp, data: {} };
      const source = finite(raw.data?.source);
      if (source === null) return null;
      if (source === 0) {
        const count = { value: 0 };
        for (const key of ['adds', 'texts', 'attributes', 'removes']) if (!Array.isArray(raw.data[key]) || raw.data[key].length > MAX_NODES) return null;
        const adds = raw.data.adds.flatMap((item: any) => {
          const parentId = finite(item.parentId);
          if (parentId === null) return [];
          const protectedParent = effective(parentId, states).block;
          const cleaned = node(item.node, 0, count, states, parentId, config);
          return protectedParent ? [] : [{ parentId, nextId: finite(item.nextId), previousId: finite(item.previousId), node: cleaned }];
        });
        const texts = raw.data.texts.flatMap((item: any) => {
          const id = finite(item.id);
          if (id === null) return [];
          const privacy = effective(id, states);
          if (privacy.block) return [];
          const value = safeString(item.value);
          return [{ id, value: !privacy.mask && privacy.unmask ? value : '*'.repeat(value.length) }];
        });
        const changedAttributes = raw.data.attributes.flatMap((item: any) => {
          const id = finite(item.id);
          if (id === null) return [];
          const prior = states.get(id);
          if (prior && item.attributes && typeof item.attributes === 'object') {
            if (Object.prototype.hasOwnProperty.call(item.attributes, 'data-tracekit-block')) prior.block = true;
            if (Object.prototype.hasOwnProperty.call(item.attributes, 'data-tracekit-mask')) prior.mask = true;
            if (Object.prototype.hasOwnProperty.call(item.attributes, 'data-tracekit-unmask')) prior.unmask = item.attributes['data-tracekit-unmask'] !== null;
            if (Object.prototype.hasOwnProperty.call(item.attributes, 'class') || Object.prototype.hasOwnProperty.call(item.attributes, 'id')) {
              const changedNode = { tagName: 'div', attributes: item.attributes };
              prior.block ||= isBlocked(changedNode, config);
              prior.mask ||= isMasked(changedNode, config);
              prior.unmask = isUnmasked(changedNode, config);
            }
          }
          return effective(id, states).block ? [] : [{ id, attributes: attributes(item.attributes) }];
        });
        const removes = raw.data.removes.map((item: any) => ({ parentId: finite(item.parentId), id: finite(item.id) }));
        for (const item of removes) if (item.id !== null) forget(item.id, states);
        data = { source, adds, texts, attributes: changedAttributes, removes };
    } else if (source === 5) {
      const id = finite(raw.data.id);
      const privacy = effective(id, states);
      if (privacy.block) return null;
      data = { source, id, text: '*'.repeat(Math.min(String(raw.data.text ?? '').length, MAX_STRING)), isChecked: raw.data.isChecked === true };
    }
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
    sanitizedEvents.add(safe);
    return safe;
  } catch { return null; }
}

/** Keep rrweb node ancestry across full snapshots, mutations, and removals. */
export class ReplayPrivacySanitizer {
  private states = new Map<number, NodePrivacy>();
  private failed = false;
  constructor(private config?: ResolvedReplayConfig) {}
  sanitize(event: unknown): any | null {
    const isFullSnapshot = !!event && typeof event === 'object' && (event as { type?: unknown }).type === 2;
    const isMutation = !!event && typeof event === 'object' && (event as any).type === 3 && (event as any).data?.source === 0;
    if (this.failed && !isFullSnapshot) return null;
    if (isFullSnapshot) this.failed = false;
    const safe = sanitizeReplayEvent(event, this.config, this.states);
    if (!safe && (isFullSnapshot || isMutation)) {
      this.states.clear();
      this.failed = true;
      return null;
    }
    if (this.states.size > MAX_NODES) {
      this.clear();
      this.failed = true;
      return null;
    }
    return safe;
  }
  clear(): void { this.states.clear(); this.failed = false; }
}
