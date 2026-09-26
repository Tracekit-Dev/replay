import { describe, expect, it } from 'vitest';
import {
  sanitizeConsolePayload,
  sanitizeMetadataValue,
  sanitizeReplayEvent,
  sanitizeReplayUrl,
} from '../src/privacy';

const CANARY = 'tracekit-secret-canary';

describe('Replay privacy sanitizer', () => {
  it('masks snapshot text and protected descendants under broad unmask rules', () => {
    const event = {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'div',
              attributes: { class: 'public' },
              childNodes: [
                { type: 3, id: 3, textContent: 'visible text' },
                {
                  type: 2,
                  id: 4,
                  tagName: 'input',
                  attributes: { value: CANARY, 'data-tracekit-unmask': 'true' },
                  childNodes: [],
                },
              ],
            },
            { type: 3, id: 5, textContent: CANARY },
          ],
        },
        initialOffset: { top: 0, left: 0 },
      },
    };

    const safe = sanitizeReplayEvent(event, { unmask: ['.public'] });

    expect(safe).not.toBeNull();
    expect(JSON.stringify(safe)).not.toContain(CANARY);
    const input = (safe as any).data.node.childNodes[0].childNodes[1];
    expect(input.attributes.value).not.toBe(CANARY);
    expect(input.attributes.value).toMatch(/^\*+$/);
    expect((safe as any).data.node.childNodes[1].textContent).toMatch(/^\*+$/);
    expect((safe as any).data.node.childNodes[0].childNodes[0].textContent).toBe('visible text');
  });

  it('sanitizes mutation text, attributes, and added nodes', () => {
    const event = {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        texts: [{ id: 3, value: CANARY }],
        attributes: [{ id: 4, attributes: {
          href: `https://user:password@example.test/path?secret=${CANARY}#${CANARY}`,
          'data-secret': CANARY,
        } }],
        removes: [],
        adds: [{ parentId: 1, nextId: null, node: {
          type: 2,
          id: 5,
          tagName: 'a',
          attributes: { href: `https://example.test/?q=${CANARY}` },
          childNodes: [{ type: 3, id: 6, textContent: CANARY }],
        } }],
      },
    };

    const safe = sanitizeReplayEvent(event);

    expect(safe).not.toBeNull();
    expect(JSON.stringify(safe)).not.toContain(CANARY);
    expect((safe as any).data.attributes[0].attributes.href).toBe('https://example.test/path');
  });

  it('bounds console objects, stacks, custom payloads, and metadata strings', () => {
    const nested = { level: 0 } as Record<string, unknown>;
    let cursor = nested;
    for (let index = 1; index < 20; index += 1) {
      cursor.next = { level: index };
      cursor = cursor.next as Record<string, unknown>;
    }
    cursor.canary = CANARY;

    const consolePayload = sanitizeConsolePayload({
      level: 'error',
      message: `console ${CANARY}`,
      data: { nested, password: CANARY, url: `https://example.test/?q=${CANARY}` },
      stack: `Error: ${CANARY}\n    at fn (https://example.test/app.js?token=${CANARY}#x:1:2)`,
    });

    expect(JSON.stringify(consolePayload)).not.toContain(CANARY);
    expect(JSON.stringify(consolePayload)).not.toContain('?token=');
    expect(sanitizeMetadataValue(CANARY)).not.toContain(CANARY);
    expect(sanitizeMetadataValue('safe-service')).toBe('safe-service');
  });

  it('removes URL credentials, queries, and fragments by default', () => {
    expect(sanitizeReplayUrl(`https://user:pass@example.test/path?q=${CANARY}#fragment`))
      .toBe('https://example.test/path');
    expect(sanitizeReplayUrl(`/checkout?q=${CANARY}#fragment`)).toBe('/checkout');
    expect(sanitizeReplayUrl('javascript:alert(1)')).toBe('');
  });

  it('discards events that cannot be safely sanitized', () => {
    expect(sanitizeReplayEvent(null)).toBeNull();
    expect(sanitizeReplayEvent({ type: 2, data: { node: undefined } })).toBeNull();
    const unsafe = {} as Record<string, unknown>;
    Object.defineProperty(unsafe, 'data', { get: () => { throw new Error('unsafe getter'); } });
    expect(sanitizeReplayEvent(unsafe)).toBeNull();
  });
});
