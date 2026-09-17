/**
 * TraceKit Replay - Configuration Resolution
 * @package @tracekit/replay
 *
 * Resolves user-provided ReplayConfig with privacy-first defaults.
 * Validates and clamps rate values to valid ranges.
 */

import type { ReplayConfig, ResolvedReplayConfig } from './types';

const DEFAULTS = {
  sessionSampleRate: 0.1,
  errorSampleRate: 0.0,
  unmask: [] as string[],
  idleTimeout: 1_800_000, // 30 minutes
  flushInterval: 30_000, // 30 seconds
  maxBufferSize: 24_117_248, // 23MB
  inlineImages: false,
  blockMedia: true,
} as const;

const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function resolveIdleTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULTS.idleTimeout;
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`[TraceKit Replay] idleTimeout (${value}) is invalid, using ${DEFAULTS.idleTimeout}`);
    return DEFAULTS.idleTimeout;
  }
  if (value < MIN_IDLE_TIMEOUT_MS) {
    console.warn(`[TraceKit Replay] idleTimeout (${value}) is below ${MIN_IDLE_TIMEOUT_MS}, clamping`);
    return MIN_IDLE_TIMEOUT_MS;
  }
  if (value > MAX_IDLE_TIMEOUT_MS) {
    console.warn(`[TraceKit Replay] idleTimeout (${value}) is above ${MAX_IDLE_TIMEOUT_MS}, clamping`);
    return MAX_IDLE_TIMEOUT_MS;
  }
  return value;
}

/**
 * Clamp a value to the [min, max] range, logging a warning if clamped.
 */
function clampRate(value: number, name: string, min: number, max: number): number {
  if (value < min) {
    console.warn(`[TraceKit Replay] ${name} (${value}) is below ${min}, clamping to ${min}`);
    return min;
  }
  if (value > max) {
    console.warn(`[TraceKit Replay] ${name} (${value}) is above ${max}, clamping to ${max}`);
    return max;
  }
  return value;
}

/**
 * Resolve user-provided replay config with defaults.
 * Validates sample rates are in [0, 1] and their sum does not exceed 1.0.
 */
export function resolveReplayConfig(
  config: ReplayConfig,
  apiKey: string,
  endpoint: string,
): ResolvedReplayConfig {
  let sessionSampleRate = clampRate(
    config.sessionSampleRate ?? DEFAULTS.sessionSampleRate,
    'sessionSampleRate',
    0,
    1,
  );

  let errorSampleRate = clampRate(
    config.errorSampleRate ?? DEFAULTS.errorSampleRate,
    'errorSampleRate',
    0,
    1,
  );

  // Ensure combined rate does not exceed 1.0
  if (sessionSampleRate + errorSampleRate > 1.0) {
    console.warn(
      `[TraceKit Replay] sessionSampleRate (${sessionSampleRate}) + errorSampleRate (${errorSampleRate}) exceeds 1.0, clamping errorSampleRate`,
    );
    errorSampleRate = 1.0 - sessionSampleRate;
  }

  return {
    sessionSampleRate,
    errorSampleRate,
    unmask: config.unmask ?? DEFAULTS.unmask,
    idleTimeout: resolveIdleTimeout(config.idleTimeout),
    flushInterval: config.flushInterval ?? DEFAULTS.flushInterval,
    maxBufferSize: config.maxBufferSize ?? DEFAULTS.maxBufferSize,
    inlineImages: config.inlineImages ?? DEFAULTS.inlineImages,
    blockMedia: config.blockMedia ?? DEFAULTS.blockMedia,
    apiKey,
    endpoint,
  };
}
