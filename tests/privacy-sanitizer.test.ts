import { describe, expect, it, vi } from 'vitest';
import { resolveReplayConfig } from '../src/config';
import { ReplayPrivacySanitizer, sanitizeReplayEvent, sanitizeReplayUrl } from '../src/privacy';
import { startRecording } from '../src/recorder';
import { Window } from 'happy-dom';

const recordMock = vi.hoisted(() => vi.fn(() => () => {}));
vi.mock('rrweb', () => ({ record: recordMock }));

const config = () => resolveReplayConfig({ unmask: ['.public'], block: ['.secret'] }, 'test-key', 'https://api.test');

describe('privacy sanitizer', () => {
  it.each([['self', 2], ['ancestor', 1], ['descendant', 3]])('rejects %s rrweb ID collisions and closes ancestry', (_name, collisionId) => {
    const sanitizer = new ReplayPrivacySanitizer(resolveReplayConfig({ unmask: ['.public'] }, 'test-key', 'https://api.test'));
    const snapshot = { type: 2, timestamp: 1, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: 'div', attributes: {}, childNodes: [{ type: 3, id: 3, textContent: 'safe' }] },
    ] } } };
    expect(sanitizer.sanitize(snapshot)).not.toBeNull();
    const collision = { type: 3, timestamp: 2, data: { source: 0, adds: [{ parentId: 2, nextId: null,
      node: { type: 2, id: collisionId, tagName: 'div', attributes: { class: 'public' }, childNodes: [
        { type: 3, id: 4, textContent: 'synthetic-secret-canary' },
      ] },
    }], texts: [], attributes: [], removes: [] } };
    expect(sanitizer.sanitize(collision)).toBeNull();
    expect(sanitizer.sanitize({ type: 3, timestamp: 3, data: { source: 0, adds: [], texts: [{ id: 4, value: 'synthetic-secret-canary' }], attributes: [], removes: [] } })).toBeNull();
    expect(sanitizer.sanitize({ ...snapshot, timestamp: 4 })).not.toBeNull();
  });

  it('retains safe top-level layout beside unsupported nested CSS in an actual rrweb rebuild', async () => {
    const page = new Window({ url: 'https://fixture.test/' });
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', page.document);
    vi.stubGlobal('location', page.location);
    for (const name of Object.getOwnPropertyNames(page)) {
      if (/^(HTML|SVG|CSS|Node$|Element$|Document$|ShadowRoot$)/.test(name) && typeof (page as any)[name] === 'function') vi.stubGlobal(name, (page as any)[name]);
    }
    try {
      const { snapshot, rebuild, createMirror } = await import('rrweb-snapshot');
      page.document.body.innerHTML = `<style>.panel{display:grid;width:500px}@media (max-width:600px){.panel{display:block;content:'synthetic-secret-canary';background-image:url(https://cdn.test/?token=synthetic-secret-canary)}}.button{position:absolute;left:12px}</style><div class="panel"><button class="button">safe</button></div>`;
      const captured = snapshot(page.document, { inlineStylesheet: true, maskTextSelector: '*', maskAllInputs: true });
      expect(JSON.stringify(captured)).toContain('@media');
      const safe = new ReplayPrivacySanitizer(config()).sanitize({ type: 2, timestamp: 1, data: { node: captured, initialOffset: { top: 0, left: 0 } } });
      expect(safe).not.toBeNull();
      expect(JSON.stringify(safe)).not.toContain('synthetic-secret-canary');
      expect(JSON.stringify(safe)).not.toContain('background-image');
      const rebuilt = new page.Document();
      rebuild(JSON.parse(JSON.stringify(safe.data.node)), { doc: rebuilt, mirror: createMirror() });
      const panel = rebuilt.querySelector('div.panel, div[class]')!;
      const button = rebuilt.querySelector('button')!;
      expect(page.getComputedStyle(panel).display).toBe('grid');
      expect(page.getComputedStyle(panel).width).toBe('500px');
      expect(page.getComputedStyle(button).position).toBe('absolute');
    } finally { vi.unstubAllGlobals(); await page.happyDOM.abort(); }
  });
  it('rebuilds an actual rrweb snapshot with stable safe selectors and layout', async () => {
    const page = new Window({ url: 'https://fixture.test/page?token=synthetic-secret-canary' });
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', page.document);
    vi.stubGlobal('location', page.location);
    for (const name of Object.getOwnPropertyNames(page)) {
      if (/^(HTML|SVG|CSS|Node$|Element$|Document$|ShadowRoot$)/.test(name) && typeof (page as any)[name] === 'function') {
        vi.stubGlobal(name, (page as any)[name]);
      }
    }
    try {
      const { snapshot, rebuild, createMirror } = await import('rrweb-snapshot');
      page.document.body.innerHTML = `
        <style>#app .panel { display:grid; width:500px; background-image:url("https://user:synthetic-secret-canary@cdn.test/image?token=synthetic-secret-canary#synthetic-secret-canary"); }
          #app .button { position:absolute; left:12px; content:"synthetic-secret-canary"; }</style>
        <div id="app"><div class="panel" data-secret="synthetic-secret-canary"><button class="button" style="position:absolute;left:12px;content:'synthetic-secret-canary'">Secret</button></div></div>`;
      const captured = snapshot(page.document, { inlineStylesheet: true, maskTextSelector: '*', maskAllInputs: true });
      expect(captured).not.toBeNull();
      expect(JSON.stringify(captured)).toContain('_cssText');
      const sanitizer = new ReplayPrivacySanitizer(config());
      const safe = sanitizer.sanitize({ type: 2, timestamp: 1, data: { node: captured, initialOffset: { top: 0, left: 0 } } });
      expect(safe).not.toBeNull();
      const bytes = JSON.stringify(safe);
      expect(bytes).not.toContain('synthetic-secret-canary');
      expect(bytes).not.toContain('#app');
      expect(bytes).not.toContain('class":"panel');
      const rebuilt = new page.Document();
      rebuild(JSON.parse(JSON.stringify(safe.data.node)), { doc: rebuilt, mirror: createMirror() });
      const button = rebuilt.querySelector('button')!;
      const panel = button.parentElement!;
      expect(panel.className).not.toBe('panel');
      expect(panel.parentElement?.id).not.toBe('app');
      expect(page.getComputedStyle(panel).display).toBe('grid');
      expect(page.getComputedStyle(panel).width).toBe('500px');
      expect(page.getComputedStyle(button).position).toBe('absolute');
    } finally { vi.unstubAllGlobals(); await page.happyDOM.abort(); }
  });

  it('sanitizes stylesheet, declaration, and selector mutations without losing layout values', () => {
    const sanitizer = new ReplayPrivacySanitizer(config());
    const base = sanitizer.sanitize({ type: 2, timestamp: 1, data: { node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: 'div', attributes: { id: 'app', class: 'panel', style: 'display:grid;width:500px;content:"synthetic-secret-canary"' }, childNodes: [] },
    ] }, initialOffset: { top: 0, left: 0 } } });
    expect(JSON.stringify(base)).not.toContain('synthetic-secret-canary');
    const styleRule = sanitizer.sanitize({ type: 3, timestamp: 2, data: { source: 8, id: 5, adds: [{ rule: '#app .panel { display:grid; width:500px; content:"synthetic-secret-canary"; }', index: 0 }] } });
    expect(styleRule).not.toBeNull();
    expect(JSON.stringify(styleRule)).toContain('500px');
    expect(JSON.stringify(styleRule)).not.toContain('synthetic-secret-canary');
    expect(JSON.stringify(styleRule)).not.toContain('#app');
    const declaration = sanitizer.sanitize({ type: 3, timestamp: 3, data: { source: 13, id: 2, index: [0], set: { property: 'position', value: 'absolute', priority: '' } } });
    expect(declaration?.data?.set?.value).toBe('absolute');
    const changed = sanitizer.sanitize({ type: 3, timestamp: 4, data: { source: 0, adds: [], texts: [], attributes: [{ id: 2, attributes: { class: 'panel', id: 'app', style: 'width:500px;content:"synthetic-secret-canary"', _cssText: '#app .panel { display:grid; width:500px; content:"synthetic-secret-canary"; }' } }], removes: [] } });
    expect(JSON.stringify(changed)).toContain('500px');
    expect(JSON.stringify(changed)).not.toContain('synthetic-secret-canary');
    expect(changed.data.attributes[0].attributes.class).toBe(base.data.node.childNodes[0].attributes.class);
    const styleObject = sanitizer.sanitize({ type: 3, timestamp: 5, data: { source: 0, adds: [], texts: [], attributes: [{ id: 2, attributes: { style: { display: 'grid', width: ['500px', ''], content: 'synthetic-secret-canary' } } }], removes: [] } });
    expect(styleObject?.data?.attributes?.[0]?.attributes?.style).toContain('width:500px');
    expect(JSON.stringify(styleObject)).not.toContain('synthetic-secret-canary');
  });
  it('rejects malformed snapshot tags and attributes without granting a valid unmask rule', () => {
    const resolved = resolveReplayConfig({ unmask: ['.public'] }, 'test-key', 'https://api.test');
    const realDocument = globalThis.document;
    vi.stubGlobal('document', {
      createElement(tag: string) {
        if (tag === 'div>') throw new Error('InvalidCharacterError');
        return { setAttribute(name: string) { if (name.includes('>')) throw new Error('InvalidCharacterError'); }, matches: () => false };
      },
      querySelector: () => null,
    });
    try {
      for (const attrs of [{ class: 'not-public' }, { class: 'not-public', 'bad>attribute': 'synthetic-secret-canary' }]) {
        const sanitizer = new ReplayPrivacySanitizer(resolved);
        const badTag = Object.hasOwn(attrs, 'bad>attribute') ? 'div' : 'div>';
        const snapshot = { type: 2, timestamp: 1, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [
          { type: 2, id: 2, tagName: badTag, attributes: attrs, childNodes: [{ type: 3, id: 3, textContent: 'synthetic-secret-canary' }] },
        ] } } };
        const safe = sanitizer.sanitize(snapshot);
        expect(safe).toBeNull();
        const late = sanitizer.sanitize({ type: 3, timestamp: 2, data: { source: 0, adds: [], texts: [{ id: 3, value: 'synthetic-secret-canary' }], attributes: [], removes: [] } });
        expect(late).toBeNull();
      }
    } finally { vi.stubGlobal('document', realDocument); }
  });

  it('rejects malformed mutation additions and clears old unmask ancestry', () => {
    const resolved = resolveReplayConfig({ unmask: ['.public'] }, 'test-key', 'https://api.test');
    const sanitizer = new ReplayPrivacySanitizer(resolved);
    const good = { type: 2, timestamp: 1, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: 'div', attributes: { class: 'public' }, childNodes: [{ type: 3, id: 3, textContent: 'allowed' }] },
    ] } } };
    expect(JSON.stringify(sanitizer.sanitize(good))).toContain('allowed');
    const previousDocument = globalThis.document;
    vi.stubGlobal('document', { createElement: () => { throw new Error('InvalidCharacterError'); }, querySelector: () => null });
    try {
      expect(sanitizer.sanitize({ type: 3, timestamp: 2, data: { source: 0, adds: [{ parentId: 2, nextId: null, node: { type: 2, id: 4, tagName: 'div>', attributes: { class: 'not-public' }, childNodes: [{ type: 3, id: 5, textContent: 'synthetic-secret-canary' }] } }], texts: [], attributes: [], removes: [] } })).toBeNull();
      expect(sanitizer.sanitize({ type: 3, timestamp: 3, data: { source: 0, adds: [], texts: [{ id: 3, value: 'synthetic-secret-canary' }], attributes: [], removes: [] } })).toBeNull();
    } finally { vi.stubGlobal('document', previousDocument); }
    expect(JSON.stringify(sanitizer.sanitize({ ...good, timestamp: 4 }))).toContain('allowed');
  });

  it('rejects malformed attribute mutations and clears protected ancestry', () => {
    const sanitizer = new ReplayPrivacySanitizer(resolveReplayConfig({ unmask: ['.public'] }, 'test-key', 'https://api.test'));
    sanitizer.sanitize({ type: 2, timestamp: 1, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: 'div', attributes: { class: 'public' }, childNodes: [{ type: 3, id: 3, textContent: 'allowed' }] },
    ] } } });
    expect(sanitizer.sanitize({ type: 3, timestamp: 2, data: { source: 0, adds: [], texts: [], attributes: [{ id: 2, attributes: { 'bad>attribute': 'synthetic-secret-canary' } }], removes: [] } })).toBeNull();
    expect(sanitizer.sanitize({ type: 3, timestamp: 3, data: { source: 0, adds: [], texts: [{ id: 3, value: 'synthetic-secret-canary' }], attributes: [], removes: [] } })).toBeNull();
  });
  it('removes credentials, query strings, and fragments from URL fields', () => {
    expect(sanitizeReplayUrl('https://user:secret@example.test/path?token=canary#canary')).toBe('https://example.test/path');
    expect(sanitizeReplayUrl('javascript:canary')).toBe('');
    expect(sanitizeReplayEvent({ type: 4, timestamp: 1, data: { href: 'https://user:secret@example.test/path?token=canary#canary', width: 900, height: 600 } })).toEqual({
      type: 4, timestamp: 1, data: { href: 'https://example.test/path', width: 900, height: 600 },
    });
  });

  it('masks snapshot text and strips unsafe attributes, including protected descendants', () => {
    const input = { type: 2, timestamp: 2, data: { initialOffset: { top: 0, left: 0 }, node: {
      type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'div', attributes: { class: 'ordinary', title: 'canary', href: 'https://u:canary@site.test/x?secret=canary#canary' }, childNodes: [
        { type: 3, id: 3, textContent: 'canary' },
        { type: 2, id: 4, tagName: 'input', attributes: { value: 'canary', type: 'password' }, childNodes: [] },
        { type: 2, id: 5, tagName: 'div', attributes: { 'data-tracekit-block': 'true', class: 'secret' }, childNodes: [{ type: 3, id: 6, textContent: 'canary' }] },
      ] }],
    } } };
    const result = sanitizeReplayEvent(input, config());
    expect(JSON.stringify(result)).not.toContain('canary');
    expect(JSON.stringify(result)).not.toContain('secret=');
    expect(JSON.stringify(result)).not.toContain('title');
    expect(JSON.stringify(result)).not.toContain('value');
    expect(JSON.stringify(result)).toContain('https://site.test/x');
  });

  it('sanitizes mutation additions, attributes, text, and inputs', () => {
    const event = { type: 3, timestamp: 3, data: { source: 0,
      adds: [{ parentId: 1, nextId: null, node: { type: 2, id: 7, tagName: 'a', attributes: { href: 'https://u:canary@site.test/a?x=canary', 'data-secret': 'canary' }, childNodes: [{ type: 3, id: 8, textContent: 'canary' }] } }],
      texts: [{ id: 3, value: 'canary' }], attributes: [{ id: 7, attributes: { href: 'https://u:canary@site.test/b?x=canary', title: 'canary', value: 'canary' } }], removes: [],
    } };
    const result = sanitizeReplayEvent(event, config());
    expect(JSON.stringify(result)).not.toContain('canary');
    expect(JSON.stringify(result)).toContain('https://site.test/a');
    expect(JSON.stringify(result)).toContain('https://site.test/b');
  });

  it('bounds console, network, unknown custom, and malformed payloads', () => {
    const secret = 'canary';
    const consoleEvent = { type: 5, timestamp: 4, data: { tag: 'console-log', payload: { level: 'error', message: secret, data: { nested: { secret } }, stack: secret.repeat(1000) } } };
    const requestEvent = { type: 5, timestamp: 5, data: { tag: 'network-request', payload: { method: 'GET', url: 'https://u:canary@site.test/x?token=canary', error: secret, traceparent: secret } } };
    expect(JSON.stringify(sanitizeReplayEvent(consoleEvent))).not.toContain(secret);
    expect(JSON.stringify(sanitizeReplayEvent(requestEvent))).not.toContain(secret);
    expect(sanitizeReplayEvent({ type: 5, timestamp: 6, data: { tag: 'custom', payload: { secret } } })).toBeNull();
    const cyclic: any = { type: 2, timestamp: 7, data: {} }; cyclic.data.node = cyclic;
    expect(sanitizeReplayEvent(cyclic)).toBeNull();
    expect(sanitizeReplayEvent({ type: 6, timestamp: 8, data: { plugin: 'canary', payload: secret } })).toBeNull();
  });

  it('keeps block and input masking stronger than unmask, and rejects invalid selectors', () => {
    const resolved = config();
    startRecording(resolved, () => {});
    const options = recordMock.mock.lastCall?.[0];
    expect(options.blockSelector).toContain('.secret');
    const protectedElement = { closest: (selector: string) => selector.includes('data-tracekit-block') ? {} : selector.includes('.public') ? {} : null, matches: () => false };
    expect(options.maskTextFn('canary', protectedElement)).toBe('******');
    expect(options.maskTextFn('canary', null)).toBe('******');
    const invalid = resolveReplayConfig({ unmask: ['[broken'], block: ['[broken'] }, 'test-key', 'https://api.test');
    startRecording(invalid, () => {});
    const invalidOptions = recordMock.mock.lastCall?.[0];
    expect(invalidOptions.maskTextFn('canary', protectedElement)).toBe('******');
    expect(invalidOptions.blockSelector).not.toContain('[broken');
  });

  it('preserves explicit unmask only outside protected ancestors and descendants', () => {
    const resolved = resolveReplayConfig({ unmask: ['.public'], mask: ['.masked'], block: ['.secret'] }, 'test-key', 'https://api.test');
    const sanitizer = new ReplayPrivacySanitizer(resolved);
    const snapshot = { type: 2, timestamp: 10, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: 'div', attributes: { class: 'public' }, childNodes: [
        { type: 3, id: 3, textContent: 'public-copy' },
        { type: 2, id: 4, tagName: 'div', attributes: { class: 'secret', 'data-tracekit-unmask': 'true' }, childNodes: [{ type: 3, id: 5, textContent: 'blocked-canary' }] },
        { type: 2, id: 6, tagName: 'div', attributes: { class: 'masked', 'data-tracekit-unmask': 'true' }, childNodes: [{ type: 3, id: 7, textContent: 'masked-canary' }] },
        { type: 2, id: 8, tagName: 'input', attributes: { type: 'password', value: 'password-canary' }, childNodes: [] },
      ] },
    ] } } };
    const result = sanitizer.sanitize(snapshot);
    expect(JSON.stringify(result)).toContain('public-copy');
    expect(JSON.stringify(result)).not.toContain('blocked-canary');
    expect(JSON.stringify(result)).not.toContain('masked-canary');
    expect(JSON.stringify(result)).not.toContain('password-canary');

    const mutation = { type: 3, timestamp: 11, data: { source: 0,
      adds: [
        { parentId: 4, nextId: null, node: { type: 3, id: 9, textContent: 'late-blocked-canary' } },
        { parentId: 2, nextId: null, node: { type: 3, id: 10, textContent: 'late-public-copy' } },
      ],
      texts: [{ id: 3, value: 'changed-public-copy' }, { id: 5, value: 'late-blocked-canary' }, { id: 7, value: 'late-masked-canary' }],
      attributes: [{ id: 4, attributes: { title: 'late-blocked-canary' } }], removes: [],
    } };
    const changed = sanitizer.sanitize(mutation);
    expect(JSON.stringify(changed)).toContain('changed-public-copy');
    expect(JSON.stringify(changed)).toContain('late-public-copy');
    expect(JSON.stringify(changed)).not.toContain('late-blocked-canary');
    expect(JSON.stringify(changed)).not.toContain('late-masked-canary');

    sanitizer.sanitize({ type: 3, timestamp: 11.5, data: { source: 0, adds: [], texts: [], attributes: [{ id: 2, attributes: { class: 'secret' } }], removes: [] } });
    const afterProtection = sanitizer.sanitize({ type: 3, timestamp: 11.6, data: { source: 0, adds: [], texts: [{ id: 3, value: 'new-protected-canary' }], attributes: [], removes: [] } });
    expect(JSON.stringify(afterProtection)).not.toContain('new-protected-canary');

    sanitizer.sanitize({ type: 3, timestamp: 12, data: { source: 0, adds: [], texts: [], attributes: [], removes: [{ parentId: 1, id: 2 }] } });
    const afterRemoval = sanitizer.sanitize({ type: 3, timestamp: 13, data: { source: 0, adds: [], texts: [{ id: 3, value: 'after-remove-canary' }], attributes: [], removes: [] } });
    expect(JSON.stringify(afterRemoval)).not.toContain('after-remove-canary');
  });
});
