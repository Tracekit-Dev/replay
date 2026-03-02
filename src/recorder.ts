/**
 * TraceKit Replay - rrweb Recorder Wrapper
 * @package @tracekit/replay
 *
 * Wraps rrweb's record() function with privacy-first defaults:
 * - All text masked with same-length asterisk replacement
 * - All inputs masked
 * - Images, videos, canvas, SVGs, and iframes blocked
 * - Unmasking via CSS selectors and data-tracekit-unmask attribute
 * - Periodic full snapshots every 30s aligned with upload interval
 */

import { record } from 'rrweb';
import type { ResolvedReplayConfig } from './types';

/**
 * Create a maskTextFn that masks all text EXCEPT elements matching
 * unmask selectors or the data-tracekit-unmask attribute.
 *
 * Privacy-first: when in doubt (null element, invalid selector), mask.
 */
function createMaskTextFn(
  unmaskSelectors: string[],
): (text: string, element: HTMLElement | null) => string {
  // Build combined CSS selector for unmask targets
  const selectorParts = ['[data-tracekit-unmask]'];
  if (unmaskSelectors.length > 0) {
    selectorParts.push(...unmaskSelectors);
  }
  const combinedSelector = selectorParts.join(', ');

  return (text: string, element: HTMLElement | null): string => {
    // Privacy-first: mask when element is null (uncertain context)
    if (!element) {
      return '*'.repeat(text.length);
    }

    // Check if element (or any ancestor) matches unmask selectors
    try {
      if (element.matches(combinedSelector) || element.closest(combinedSelector)) {
        return text; // Unmask: return original text
      }
    } catch {
      // Invalid selector -- fail safe by masking
    }

    // Default: same-length asterisk replacement
    return '*'.repeat(text.length);
  };
}

/**
 * Start rrweb recording with privacy-first defaults.
 *
 * @param config - Resolved replay configuration
 * @param onEvent - Callback invoked for each rrweb event
 * @returns A stop function to halt recording, or null if recording failed to start
 */
export function startRecording(
  config: ResolvedReplayConfig,
  onEvent: (event: unknown, isCheckout: boolean) => void,
): (() => void) | null {
  try {
    const stopFn = record({
      emit: (event, isCheckout) => {
        onEvent(event, isCheckout ?? false);
      },

      // ================================================================
      // Privacy-first settings (LOCKED decisions)
      // ================================================================

      // Mask all text by matching all elements
      maskTextSelector: '*',

      // Mask all input values
      maskAllInputs: true,

      // Custom mask function: same-length asterisk replacement with unmask support
      maskTextFn: createMaskTextFn(config.unmask),

      // Block all media and embedded content
      blockSelector: 'img, video, canvas, svg, iframe',

      // Do NOT record canvas content
      recordCanvas: false,

      // Do NOT record cross-origin iframes
      recordCrossOriginIframes: false,

      // Do NOT inline images
      inlineImages: false,

      // ================================================================
      // Recording lifecycle
      // ================================================================

      // Periodic full snapshot every 30s, aligned with upload interval
      checkoutEveryNms: 30_000,

      // Sampling configuration to reduce event volume
      sampling: {
        mousemove: 50,
        mouseInteraction: true,
        scroll: 150,
        input: 'last',
      },
    });

    // rrweb record() returns undefined if it fails to start
    return stopFn ?? null;
  } catch {
    // Never crash the host application
    return null;
  }
}
