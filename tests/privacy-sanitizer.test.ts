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

  it('constructs bounded snapshot and navigation events without callable serialization hooks', () => {
    const snapshot: Record<string, unknown> = {
      type: 2,
      timestamp: 1,
      toJSON: () => ({ leaked: CANARY }),
      data: {
        toJSON: () => ({ leaked: CANARY }),
        node: {
          type: 2,
          id: 1,
          tagName: 'main',
          attributes: {},
          childNodes: [{
            type: 3,
            id: 2,
            textContent: 'public text',
            toJSON: () => ({ leaked: CANARY }),
            extra: CANARY,
          }],
          toJSON: () => ({ leaked: CANARY }),
        },
      },
    };
    const navigation = {
      type: 4,
      timestamp: 2,
      data: {
        href: 'https://example.test/path?query=one#fragment',
        pageUrl: 'https://example.test/page?query=two#fragment',
        toJSON: () => ({ leaked: CANARY }),
      },
    };

    const safeSnapshot = sanitizeReplayEvent(snapshot);
    const safeNavigation = sanitizeReplayEvent(navigation);

    expect(safeSnapshot).not.toBeNull();
    expect(safeNavigation).not.toBeNull();
    expect(JSON.stringify(safeSnapshot)).not.toContain(CANARY);
    expect(JSON.stringify(safeSnapshot)).not.toContain('toJSON');
    expect(JSON.stringify(safeNavigation)).not.toContain('toJSON');
    expect((safeNavigation as any).data.href).toBe('https://example.test/path');
    expect((safeNavigation as any).data.pageUrl).toBe('https://example.test/page');
  });

  it('redacts markers after unmask decisions and blocks media descendants', () => {
    const event = {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: 'section',
          attributes: { class: 'public' },
          childNodes: [
            { type: 3, id: 2, textContent: `visible ${CANARY}` },
            {
              type: 2,
              id: 3,
              tagName: 'img',
              attributes: {},
              childNodes: [{ type: 3, id: 4, textContent: CANARY }],
            },
          ],
        },
      },
    };
    const safe = sanitizeReplayEvent(event, { unmask: ['.public'] });

    expect(safe).not.toBeNull();
    expect(JSON.stringify(safe)).not.toContain(CANARY);
    const children = (safe as any).data.node.childNodes;
    expect(children[0].textContent).toBe('[REDACTED]');
    expect(children[1].childNodes[0].textContent).toMatch(/^\*+$/);
  });

  it('sanitizes camelCase URL fields and stack URLs without marker words', () => {
    const event = {
      type: 5,
      timestamp: 1,
      data: {
        tag: 'metadata',
        payload: {
          pageUrl: 'https://user:pass@example.test/page?query=one#fragment',
          requestUrl: 'https://user:pass@example.test/request?query=two#fragment',
          documentURL: 'https://user:pass@example.test/document?query=three#fragment',
          stack: 'Error at https://user:pass@example.test/app.js?query=four#fragment:1:2',
        },
      },
    };
    const safe = sanitizeReplayEvent(event);

    expect(safe).not.toBeNull();
    const json = JSON.stringify(safe);
    expect(json).not.toContain('user:pass');
    expect(json).not.toContain('?query=');
    expect(json).not.toContain('#fragment');
    expect((safe as any).data.payload.pageUrl).toBe('https://example.test/page');
    expect((safe as any).data.payload.requestUrl).toBe('https://example.test/request');
    expect((safe as any).data.payload.documentURL).toBe('https://example.test/document');
  });

  it('constructs mutation and custom event shapes without top-level canaries', () => {
    const mutation = sanitizeReplayEvent({
      type: 3,
      timestamp: 1,
      canary: CANARY,
      data: {
        source: 0,
        canary: CANARY,
        texts: [{ id: 1, value: CANARY, canary: CANARY }],
        attributes: [{ id: 2, attributes: { title: CANARY }, canary: CANARY }],
        adds: [{ parentId: 1, nextId: null, node: {
          type: 3,
          id: 3,
          textContent: CANARY,
          canary: CANARY,
        }, canary: CANARY }],
      },
    });
    const custom = sanitizeReplayEvent({
      type: 5,
      timestamp: 2,
      canary: CANARY,
      data: {
        tag: 'custom',
        payload: { canary: CANARY, toJSON: () => ({ leaked: CANARY }) },
      },
    });

    expect(JSON.stringify(mutation)).not.toContain(CANARY);
    expect(JSON.stringify(custom)).not.toContain(CANARY);
    expect(JSON.stringify(custom)).not.toContain('toJSON');
  });

  it('drops unsafe dynamic keys in console, custom events, and attributes', () => {
    const unsafeUrlKey = 'https://user:pass@example.test/path?query=plain#fragment';
    const consolePayload = sanitizeConsolePayload({
      [CANARY]: 'value',
      'password-field': 'value',
      [unsafeUrlKey]: 'value',
      'line\nfeed': 'value',
      safe: 'visible',
    });
    const custom = sanitizeReplayEvent({
      type: 5,
      timestamp: 1,
      data: {
        tag: 'custom',
        payload: {
          [CANARY]: 'value',
          authorizationHeader: 'value',
          [unsafeUrlKey]: 'value',
          safe: 'visible',
        },
      },
    });
    const attributes = sanitizeReplayEvent({
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: 'div',
          attributes: {
            [CANARY]: 'value',
            'data-secret': 'value',
            [unsafeUrlKey]: 'value',
            class: 'safe',
          },
          childNodes: [],
        },
      },
    });

    expect(JSON.stringify(consolePayload)).not.toContain(CANARY);
    expect(JSON.stringify(consolePayload)).not.toContain('password-field');
    expect(JSON.stringify(consolePayload)).not.toContain('user:pass');
    expect(JSON.stringify(consolePayload)).toContain('safe');
    expect(JSON.stringify(custom)).not.toContain(CANARY);
    expect(JSON.stringify(custom)).not.toContain('authorizationHeader');
    expect(JSON.stringify(attributes)).not.toContain(CANARY);
    expect(JSON.stringify(attributes)).not.toContain('data-secret');
    expect((attributes as any).data.node.attributes.class).toBe('safe');
  });

  it('preserves rrweb input, mutation, iframe, document, shadow, and node structure', () => {
    const input = sanitizeReplayEvent({
      type: 3,
      timestamp: 1,
      data: { source: 5, id: 10, text: CANARY, isChecked: true, userTriggered: true },
    });
    const mutation = sanitizeReplayEvent({
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        isAttachIframe: true,
        texts: [{ id: 11, value: CANARY }],
        attributes: [{ id: 12, attributes: { removed: null, title: CANARY } }],
        removes: [{ parentId: 1, id: 12, isShadow: true }],
        adds: [{
          parentId: 1,
          previousId: 13,
          nextId: null,
          node: {
            type: 0,
            id: 14,
            compatMode: 'CSS1Compat',
            rootId: 15,
            isShadowHost: true,
            isShadow: true,
            childNodes: [{
              type: 2,
              id: 16,
              tagName: 'custom-element',
              isCustom: true,
              childNodes: [],
              attributes: {},
            }, {
              type: 1,
              id: 17,
              name: 'html',
              publicId: '',
              systemId: '',
            }],
          },
        }],
      },
    });
    const variants = [
      { type: 0, data: {} },
      { type: 1, data: {} },
      { type: 4, data: { href: 'https://example.test/' , width: 100, height: 200 } },
      { type: 5, data: { tag: 'custom', payload: { safe: true } } },
      { type: 6, data: { plugin: 'plugin', payload: { safe: true } } },
      { type: 3, data: { source: 1, positions: [{ x: 1, y: 2, id: 3, timeOffset: 4 }] } },
      { type: 3, data: { source: 2, type: 2, id: 3, x: 1, y: 2, pointerType: 0 } },
      { type: 3, data: { source: 3, id: 3, x: 1, y: 2 } },
      { type: 3, data: { source: 4, width: 100, height: 200 } },
      { type: 3, data: { source: 6, id: 3, type: 0, currentTime: 1 } },
      { type: 3, data: { source: 7, id: 3, type: 0, currentTime: 1 } },
      { type: 3, data: { source: 8, id: 3, index: [0], adds: [], removes: [] } },
      { type: 3, data: { source: 9, id: 3, type: 0, commands: [] } },
      { type: 3, data: { source: 10, family: 'sans', fontSource: '', buffer: false } },
      { type: 3, data: { source: 14, ranges: [] } },
      { type: 3, data: { source: 15, id: 3, styleIds: [] } },
      { type: 3, data: { source: 16, define: { name: 'custom-element' } } },
    ];

    expect((input as any).data).toMatchObject({ source: 5, id: 10, isChecked: true, userTriggered: true });
    expect((mutation as any).data.isAttachIframe).toBe(true);
    expect((mutation as any).data.attributes[0].attributes.removed).toBeNull();
    expect((mutation as any).data.adds[0].previousId).toBe(13);
    expect((mutation as any).data.adds[0].nextId).toBeNull();
    const documentNode = (mutation as any).data.adds[0].node;
    expect(documentNode).toMatchObject({ compatMode: 'CSS1Compat', rootId: 15, isShadowHost: true, isShadow: true });
    expect(documentNode.childNodes[0]).toMatchObject({ isCustom: true });
    expect(documentNode.childNodes[1]).toMatchObject({ name: 'html', publicId: '', systemId: '' });
    for (const variant of variants) expect(sanitizeReplayEvent(variant)).not.toBeNull();
  });

  it('emits every serialized node type and core delay with exact safe shapes', () => {
    const safe = sanitizeReplayEvent({
      type: 2,
      timestamp: 10,
      delay: 25,
      data: {
        node: {
          type: 0,
          id: 1,
          compatMode: 'CSS1Compat',
          rootId: 9,
          isShadowHost: true,
          isShadow: true,
          childNodes: [
            { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
            {
              type: 2,
              id: 3,
              tagName: 'div',
              attributes: { class: 'safe', removed: null },
              childNodes: [],
              isSVG: true,
              needBlock: true,
              isCustom: true,
            },
            { type: 3, id: 4, textContent: 'text', isStyle: true },
            { type: 4, id: 5, textContent: 'cdata' },
            { type: 5, id: 6, textContent: 'comment' },
          ],
        },
        initialOffset: { top: 1, left: 2 },
      },
    });

    expect(safe).toEqual({
      type: 2,
      timestamp: 10,
      delay: 25,
      data: {
        node: {
          type: 0,
          id: 1,
          rootId: 9,
          isShadowHost: true,
          isShadow: true,
          compatMode: 'CSS1Compat',
          childNodes: [
            { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
            {
              type: 2,
              id: 3,
              tagName: 'div',
              attributes: { class: '****', removed: null },
              childNodes: [],
              isSVG: true,
              needBlock: true,
              isCustom: true,
            },
            { type: 3, id: 4, textContent: '****', isStyle: true },
            { type: 4, id: 5, textContent: '*****' },
            { type: 5, id: 6, textContent: '*******' },
          ],
        },
        initialOffset: { top: 1, left: 2 },
      },
    });
  });

  it('emits every installed rrweb incremental source with exact safe shapes', () => {
    const variants = [
      [{ source: 0, texts: [{ id: 1, value: null }], attributes: [], removes: [], adds: [] }, { source: 0, texts: [{ id: 1, value: null }], attributes: [], removes: [], adds: [] }],
      [{ source: 1, positions: [{ x: 1, y: 2, id: 3, timeOffset: 4 }] }, { source: 1, positions: [{ x: 1, y: 2, id: 3, timeOffset: 4 }] }],
      [{ source: 2, type: 2, id: 3, x: 1, y: 2, pointerType: 0 }, { source: 2, type: 2, id: 3, x: 1, y: 2, pointerType: 0 }],
      [{ source: 3, id: 3, x: 1, y: 2 }, { source: 3, id: 3, x: 1, y: 2 }],
      [{ source: 4, width: 100, height: 200 }, { source: 4, width: 100, height: 200 }],
      [{ source: 5, id: 3, text: 'value', isChecked: false, userTriggered: true }, { source: 5, id: 3, text: '*****', isChecked: false, userTriggered: true }],
      [{ source: 6, positions: [{ x: 1, y: 2, id: 3, timeOffset: 4 }] }, { source: 6, positions: [{ x: 1, y: 2, id: 3, timeOffset: 4 }] }],
      [{ source: 7, type: 0, id: 3, currentTime: 1, volume: 2, muted: true, loop: false, playbackRate: 3 }, { source: 7, type: 0, id: 3, currentTime: 1, volume: 2, muted: true, loop: false, playbackRate: 3 }],
      [{ source: 8, id: 3, styleId: 4, removes: [{ index: 1 }], adds: [{ rule: 'body{}', index: 0 }], replace: 'body{}', replaceSync: 'body{}' }, { source: 8, id: 3, styleId: 4, removes: [{ index: 1 }], adds: [{ rule: 'body{}', index: 0 }], replace: 'body{}', replaceSync: 'body{}' }],
      [{ source: 9, id: 3, type: 0, commands: [{ property: 'fillStyle', args: ['red'], setter: true }] }, { source: 9, id: 3, type: 0, commands: [{ property: 'fillStyle', args: ['red'], setter: true }] }],
      [{ source: 10, family: 'sans', fontSource: 'font', buffer: false, descriptors: { style: 'normal' } }, { source: 10, family: 'sans', fontSource: 'font', buffer: false, descriptors: { style: 'normal' } }],
      [{ source: 11, level: 'info', payload: 'message' }, { source: 11, level: 'info', payload: 'message' }],
      [{ source: 12, positions: [{ x: 1, y: 2, id: 3, timeOffset: 4 }] }, { source: 12, positions: [{ x: 1, y: 2, id: 3, timeOffset: 4 }] }],
      [{ source: 13, id: 3, styleId: 4, index: [0], set: { property: 'color', value: null, priority: undefined }, remove: { property: 'background' } }, { source: 13, id: 3, styleId: 4, index: [0], set: { property: 'color', value: null }, remove: { property: 'background' } }],
      [{ source: 14, ranges: [{ start: 1, startOffset: 2, end: 3, endOffset: 4 }] }, { source: 14, ranges: [{ start: 1, startOffset: 2, end: 3, endOffset: 4 }] }],
      [{ source: 15, id: 3, styleIds: [4], styles: [{ styleId: 4, rules: [{ rule: 'body{}', index: 0 }] }] }, { source: 15, id: 3, styleIds: [4], styles: [{ styleId: 4, rules: [{ rule: 'body{}', index: 0 }] }] }],
      [{ source: 16, define: { name: 'custom-element' } }, { source: 16, define: { name: 'custom-element' } }],
    ] as const;

    for (const [input, expectedData] of variants) {
      expect(sanitizeReplayEvent({ type: 3, timestamp: 1, data: input })).toEqual({
        type: 3,
        timestamp: 1,
        data: expectedData,
      });
    }
  });
});
