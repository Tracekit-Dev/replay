import { describe, expect, it, vi } from 'vitest';
import { resolveReplayConfig } from '../src/config';
import { sanitizeReplayEvent, sanitizeReplayUrl } from '../src/privacy';
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
      type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'div', attributes: { class: 'public', title: 'canary', href: 'https://u:canary@site.test/x?secret=canary#canary' }, childNodes: [
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
});
