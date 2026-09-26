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
const SIMPLE_SELECTOR = /^(?:\*|[a-z][a-z0-9-]*|[.#][A-Za-z_][A-Za-z0-9_-]*|\[data-tracekit-(?:block|mask|unmask)\])$/i;
const SAFE_TAG = /^[a-z][a-z0-9-]{0,39}$/i;
const SAFE_ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;
const SAFE_STYLE_TAGS = new Set(['html', 'body', 'head', 'main', 'div', 'span', 'p', 'a', 'button', 'input', 'label', 'form', 'section', 'article', 'header', 'footer', 'nav', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'img', 'svg']);
const LENGTH_VALUE = /^-?(?:\d+|\d*\.\d+)(?:px|%|rem|em|vw|vh|fr)?$/i;
const LENGTH_PROPERTIES = new Set(['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'top', 'right', 'bottom', 'left', 'gap', 'row-gap', 'column-gap', 'font-size', 'line-height', 'border-radius', 'flex-basis']);
const BOX_PROPERTIES = new Set(['margin', 'padding', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
const ENUM_VALUES: Record<string, Set<string>> = {
  display: new Set(['block', 'inline', 'inline-block', 'grid', 'inline-grid', 'flex', 'inline-flex', 'none', 'table', 'table-row', 'table-cell']),
  position: new Set(['static', 'relative', 'absolute', 'fixed', 'sticky']),
  'box-sizing': new Set(['border-box', 'content-box']),
  overflow: new Set(['visible', 'hidden', 'auto', 'scroll', 'clip']),
  'overflow-x': new Set(['visible', 'hidden', 'auto', 'scroll', 'clip']),
  'overflow-y': new Set(['visible', 'hidden', 'auto', 'scroll', 'clip']),
  'flex-direction': new Set(['row', 'row-reverse', 'column', 'column-reverse']),
  'flex-wrap': new Set(['nowrap', 'wrap', 'wrap-reverse']),
  'align-items': new Set(['normal', 'start', 'end', 'center', 'stretch', 'baseline', 'flex-start', 'flex-end']),
  'justify-content': new Set(['normal', 'start', 'end', 'center', 'space-between', 'space-around', 'space-evenly', 'flex-start', 'flex-end']),
};

class PrivacyTokens {
  private classes = new Map<string, string>();
  private ids = new Map<string, string>();
  clear(): void { this.classes.clear(); this.ids.clear(); }
  className(raw: string): string {
    if (!raw || raw.length > 256) throw new Error('unsafe class');
    let token = this.classes.get(raw);
    if (!token) {
      if (this.classes.size >= MAX_NODES) throw new Error('too many class tokens');
      token = `tkc${this.classes.size + 1}`;
      this.classes.set(raw, token);
    }
    return token;
  }
  id(raw: string): string {
    if (!raw || raw.length > 256) throw new Error('unsafe id');
    let token = this.ids.get(raw);
    if (!token) {
      if (this.ids.size >= MAX_NODES) throw new Error('too many id tokens');
      token = `tki${this.ids.size + 1}`;
      this.ids.set(raw, token);
    }
    return token;
  }
}

function cssValue(property: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  const value = raw.trim().toLowerCase();
  if (ENUM_VALUES[property]?.has(value)) return value;
  if (LENGTH_PROPERTIES.has(property) && (LENGTH_VALUE.test(value) || value === 'auto')) return value;
  if (BOX_PROPERTIES.has(property) && value.split(/\s+/).length <= 4 && value.split(/\s+/).every((part) => LENGTH_VALUE.test(part) || part === 'auto')) return value;
  if (['z-index', 'order', 'flex-grow', 'flex-shrink', 'opacity'].includes(property) && /^-?\d+(?:\.\d+)?$/.test(value)) return value;
  if (['grid-template-columns', 'grid-template-rows'].includes(property) && /^(?:(?:-?\d+(?:\.\d+)?(?:px|%|rem|em|fr|vw|vh)?|auto|repeat|minmax|fit-content)[\s,()]*)+$/i.test(value)) return value;
  if (['color', 'background-color'].includes(property) && (/^#[0-9a-f]{3,8}$/i.test(value) || value === 'transparent' || value === 'currentcolor')) return value;
  return null;
}

function cssDeclarations(raw: unknown): string {
  const out: string[] = [];
  if (typeof raw === 'string') {
    if (raw.length > 65_536) throw new Error('unsafe CSS');
    for (const part of raw.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const property = part.slice(0, colon).trim().toLowerCase();
      if (!/^[a-z-]{1,40}$/.test(property)) continue;
      const value = cssValue(property, part.slice(colon + 1));
      if (value !== null) out.push(`${property}:${value}`);
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const entries = Object.entries(raw);
    if (entries.length > 64) throw new Error('unsafe CSS breadth');
    for (const [property, original] of entries) {
      if (!/^[a-z-]{1,40}$/.test(property)) continue;
      const candidate = Array.isArray(original) ? original[0] : original;
      const value = cssValue(property, candidate);
      if (value !== null) out.push(`${property}:${value}`);
    }
  } else throw new Error('unsafe CSS');
  return out.join(';');
}

function cssSelector(raw: string, tokens: PrivacyTokens): string | null {
  if (!raw || raw.length > 512 || !/^[A-Za-z0-9_.#*>\s,-]+$/.test(raw)) return null;
  const parts = raw.trim().split(/(\s+|>|,)/);
  const mapped: string[] = [];
  for (const part of parts) {
    if (!part || /^\s+$/.test(part) || part === '>' || part === ',') { mapped.push(part); continue; }
    if (part === '*') { mapped.push(part); continue; }
    const match = part.match(/^([a-z][a-z0-9-]*)?((?:[.#][A-Za-z_][A-Za-z0-9_-]*)*)$/i);
    if (!match || (!match[1] && !match[2])) return null;
    if (match[1] && !SAFE_STYLE_TAGS.has(match[1].toLowerCase())) return null;
    const suffix = [...match[2].matchAll(/([.#])([A-Za-z_][A-Za-z0-9_-]*)/g)]
      .map((item) => item[1] === '.' ? `.${tokens.className(item[2])}` : `#${tokens.id(item[2])}`).join('');
    mapped.push(`${match[1]?.toLowerCase() ?? ''}${suffix}`);
  }
  return mapped.join('');
}

function cssStylesheet(raw: unknown, tokens: PrivacyTokens): string {
  if (typeof raw !== 'string' || raw.length > 65_536) throw new Error('unsafe stylesheet');
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  if (stripped.includes('/*')) return '';
  const result: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let end = 0;
  for (const found of stripped.matchAll(rule)) {
    if (stripped.slice(end, found.index).trim()) return '';
    end = found.index + found[0].length;
    const selector = cssSelector(found[1], tokens);
    const declarations = cssDeclarations(found[2]);
    if (selector && declarations) result.push(`${selector}{${declarations}}`);
  }
  if (stripped.slice(end).trim()) return '';
  return result.join('');
}

function freezeGraph(root: object): void {
  const pending = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
}

function isFrozenGraph(root: object): boolean {
  const pending = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!Object.isFrozen(value)) return false;
    for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
  }
  return true;
}

interface NodePrivacy {
  parentId: number | null;
  block: boolean;
  mask: boolean;
  unmask: boolean;
  tagName?: string;
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

function attributes(raw: unknown, tokens: PrivacyTokens, tagName = ''): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!SAFE_ATTRIBUTE_NAME.test(key)) throw new Error('unsafe attribute name');
    const lower = key.toLowerCase();
    if (URL_ATTRIBUTES.has(lower)) {
      const cleaned = sanitizeReplayUrl(value);
      if (cleaned) out[lower] = cleaned;
    } else if (lower === 'class' && typeof value === 'string') {
      const classes = value.trim().split(/\s+/).filter(Boolean);
      if (classes.length > 32) throw new Error('unsafe class count');
      if (classes.length > 0) out.class = classes.map((name) => tokens.className(name)).join(' ');
    } else if (lower === 'id' && typeof value === 'string' && value) {
      out.id = tokens.id(value);
    } else if (lower === 'style') {
      const cleaned = cssDeclarations(value);
      if (cleaned) out.style = cleaned;
    } else if (key === '_cssText' && tagName === 'style') {
      const cleaned = cssStylesheet(value, tokens);
      if (cleaned) out._cssText = cleaned;
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
  if (!SIMPLE_SELECTOR.test(selector)) return false;
  if (selector === '*') return true;
  if (selector.startsWith('.') && String(attrs.class ?? '').split(/\s+/).includes(selector.slice(1))) return true;
  if (selector.startsWith('#') && attrs.id === selector.slice(1)) return true;
  if (selector === tag) return true;
  if (selector.startsWith('[')) return Object.prototype.hasOwnProperty.call(attrs, selector.slice(1, -1));
  return false;
}

function isBlocked(node: any, config?: ResolvedReplayConfig): boolean {
  const attrs = node?.attributes;
  if (attrs && typeof attrs === 'object' && Object.prototype.hasOwnProperty.call(attrs, 'data-tracekit-block')) return true;
  const tag = String(node.tagName ?? '').toLowerCase();
  if (config?.blockMedia && ['img', 'video', 'canvas', 'svg', 'iframe'].includes(tag)) return true;
  return (config?.block ?? []).some((selector) => !SIMPLE_SELECTOR.test(selector) || matchesSelector(node, selector));
}

function isMasked(node: any, config?: ResolvedReplayConfig): boolean {
  const attrs = node?.attributes;
  if (attrs && typeof attrs === 'object' && Object.prototype.hasOwnProperty.call(attrs, 'data-tracekit-mask')) return true;
  if (['input', 'textarea', 'select'].includes(String(node.tagName ?? '').toLowerCase())) return true;
  return (config?.mask ?? []).some((selector) => !SIMPLE_SELECTOR.test(selector) || matchesSelector(node, selector));
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

function node(raw: any, depth: number, count: { value: number }, states: Map<number, NodePrivacy>, parentId: number | null, tokens: PrivacyTokens, config?: ResolvedReplayConfig): any {
  if (!raw || typeof raw !== 'object' || depth > MAX_DEPTH || ++count.value > MAX_NODES) throw new Error('unsafe node');
  const type = finite(raw.type), id = finite(raw.id);
  if (type === null || id === null || !Number.isSafeInteger(id)) throw new Error('unsafe node identity');
  const base: any = { type, id };
  states.set(id, { parentId, block: type === 2 && (raw.needBlock === true || isBlocked(raw, config)), mask: type === 2 && isMasked(raw, config), unmask: type === 2 && isUnmasked(raw, config), tagName: type === 2 ? raw.tagName?.toLowerCase() : undefined });
  if (states.size > MAX_NODES) throw new Error('unsafe node state');
  const privacy = effective(id, states);
  if (type === 0) {
    base.childNodes = Array.isArray(raw.childNodes) ? raw.childNodes.map((child: unknown) => node(child, depth + 1, count, states, id, tokens, config)) : [];
  } else if (type === 1) {
    base.name = safeString(raw.name, 40);
    base.publicId = '';
    base.systemId = '';
  } else if (type === 2) {
    if (typeof raw.tagName !== 'string' || !SAFE_TAG.test(raw.tagName)) throw new Error('unsafe tag name');
    base.tagName = raw.tagName.toLowerCase();
    base.attributes = attributes(raw.attributes, tokens, base.tagName);
    if (privacy.block || raw.needBlock === true) {
      base.needBlock = true;
      base.childNodes = [];
      // Keep descendant IDs protected if rrweb later emits their mutations.
      if (Array.isArray(raw.childNodes)) for (const child of raw.childNodes) node(child, depth + 1, count, states, id, tokens, config);
    } else {
      base.childNodes = Array.isArray(raw.childNodes) ? raw.childNodes.map((child: unknown) => node(child, depth + 1, count, states, id, tokens, config)) : [];
    }
  } else if (type === 3 || type === 4 || type === 5) {
    const value = safeString(raw.textContent);
    base.textContent = states.get(parentId ?? -1)?.tagName === 'style' ? cssStylesheet(value, tokens)
      : !privacy.block && !privacy.mask && privacy.unmask ? value : '*'.repeat(value.length);
  } else throw new Error('unknown node type');
  return base;
}

/** Return an independent safe event, or null when no safe representation exists. */
export function sanitizeReplayEvent(event: unknown, config?: ResolvedReplayConfig, states = new Map<number, NodePrivacy>(), tokens = new PrivacyTokens()): any | null {
  try {
    if (!event || typeof event !== 'object') return null;
    if (sanitizedEvents.has(event)) return isFrozenGraph(event) ? event : null;
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
      tokens.clear();
      data = { node: node(raw.data?.node, 0, count, states, null, tokens, config), initialOffset: {
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
          const cleaned = node(item.node, 0, count, states, parentId, tokens, config);
          return protectedParent ? [] : [{ parentId, nextId: finite(item.nextId), previousId: finite(item.previousId), node: cleaned }];
        });
        const texts = raw.data.texts.flatMap((item: any) => {
          const id = finite(item.id);
          if (id === null) return [];
          const privacy = effective(id, states);
          if (privacy.block) return [];
          const value = safeString(item.value);
          const parentTag = states.get(states.get(id)?.parentId ?? -1)?.tagName;
          return [{ id, value: parentTag === 'style' ? cssStylesheet(value, tokens) : !privacy.mask && privacy.unmask ? value : '*'.repeat(value.length) }];
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
          return effective(id, states).block ? [] : [{ id, attributes: attributes(item.attributes, tokens, prior?.tagName) }];
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
    else if (source === 8) {
      const id = finite(raw.data.id), styleId = finite(raw.data.styleId);
      if (id !== null && effective(id, states).block) return null;
      const adds = Array.isArray(raw.data.adds) ? raw.data.adds.slice(0, 100).flatMap((item: any) => {
        const rule = cssStylesheet(item.rule, tokens);
        return rule ? [{ rule, index: finite(item.index) ?? 0 }] : [];
      }) : [];
      const removes = Array.isArray(raw.data.removes) ? raw.data.removes.slice(0, 100).flatMap((item: any) => {
        const index = finite(item.index);
        return index === null ? [] : [{ index }];
      }) : [];
      const replace = raw.data.replace === undefined ? undefined : cssStylesheet(raw.data.replace, tokens);
      const replaceSync = raw.data.replaceSync === undefined ? undefined : cssStylesheet(raw.data.replaceSync, tokens);
      if (!adds.length && !removes.length && !replace && !replaceSync) return null;
      data = { source, id, styleId, adds, removes };
      if (replace) data.replace = replace;
      if (replaceSync) data.replaceSync = replaceSync;
    }
    else if (source === 13) {
      const id = finite(raw.data.id), styleId = finite(raw.data.styleId);
      if (id !== null && effective(id, states).block) return null;
      if (!Array.isArray(raw.data.index) || raw.data.index.length > 32 || raw.data.index.some((index: unknown) => finite(index) === null)) return null;
      data = { source, id, styleId, index: [...raw.data.index] };
      if (raw.data.set) {
        const property = raw.data.set.property;
        const value = cssValue(property, raw.data.set.value);
        if (value === null) return null;
        data.set = { property, value, priority: raw.data.set.priority === 'important' ? 'important' : '' };
      } else if (raw.data.remove && typeof raw.data.remove.property === 'string' && /^[a-z-]{1,40}$/.test(raw.data.remove.property)) {
        data.remove = { property: raw.data.remove.property };
      } else return null;
    }
    else if ([1, 2, 3, 4, 6, 7, 11].includes(source)) {
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
    freezeGraph(safe);
    sanitizedEvents.add(safe);
    return safe;
  } catch { return null; }
}

/** Keep rrweb node ancestry across full snapshots, mutations, and removals. */
export class ReplayPrivacySanitizer {
  private states = new Map<number, NodePrivacy>();
  private tokens = new PrivacyTokens();
  private failed = false;
  constructor(private config?: ResolvedReplayConfig) {}
  sanitize(event: unknown): any | null {
    const isFullSnapshot = !!event && typeof event === 'object' && (event as { type?: unknown }).type === 2;
    const isMutation = !!event && typeof event === 'object' && (event as any).type === 3 && (event as any).data?.source === 0;
    if (this.failed && !isFullSnapshot) return null;
    if (isFullSnapshot) this.failed = false;
    const safe = sanitizeReplayEvent(event, this.config, this.states, this.tokens);
    if (!safe && (isFullSnapshot || isMutation)) {
      this.states.clear();
      this.tokens.clear();
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
  clear(): void { this.states.clear(); this.tokens.clear(); this.failed = false; }
}
