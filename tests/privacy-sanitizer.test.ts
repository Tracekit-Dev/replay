import { describe, expect, it, vi } from 'vitest';
import { resolveReplayConfig } from '../src/config';
import { ReplayPrivacySanitizer, sanitizeReplayEvent, sanitizeReplayUrl } from '../src/privacy';
import { startRecording } from '../src/recorder';

const recordMock = vi.hoisted(() => vi.fn(() => () => {}));
vi.mock('rrweb', () => ({ record: recordMock }));

const config = () => resolveReplayConfig({ unmask: ['.public'], block: ['.secret'] }, 'test-key', 'https://api.test');

describe('privacy sanitizer', () => {
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
