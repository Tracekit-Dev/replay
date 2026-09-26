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
  block: [] as string[],
  mask: [] as string[],
  idleTimeout: 1_800_000, // 30 minutes
  flushInterval: 30_000, // 30 seconds
  maxBufferSize: 24_117_248, // 23MB
  maxEventCount: 10_000,
  maxBufferAgeMs: 120_000,
  maxChunkCount: 4,
  compressionTimeoutMs: 5_000,
  fetchTimeoutMs: 10_000,
  maxRetryAttempts: 3,
  maxRetryAgeMs: 30_000,
  retryBaseDelayMs: 1_000,
  maxBackoffMs: 8_000,
  inlineImages: false,
  blockMedia: true,
} as const;

const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const CEILINGS = {
  flushInterval: 60_000,
  maxBufferSize: 24 * 1024 * 1024,
  maxEventCount: 20_000,
  maxBufferAgeMs: 5 * 60_000,
  maxChunkCount: 8,
  compressionTimeoutMs: 15_000,
  fetchTimeoutMs: 30_000,
  maxRetryAttempts: 5,
  maxRetryAgeMs: 120_000,
  retryBaseDelayMs: 5_000,
  maxBackoffMs: 30_000,
} as const;

function boundedPositive(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(value), ceiling));
}

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
function clampRate(value: number, name: string, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
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

/** Reject malformed selectors before rrweb sees them. A bad block rule blocks all DOM. */
function validSelector(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 256) return false;
  if (!/^(?:\*|[a-z][a-z0-9-]*|[.#][A-Za-z_][A-Za-z0-9_-]*|\[data-tracekit-(?:block|mask|unmask)\])$/i.test(value)) return false;
  try {
    if (typeof document !== 'undefined') document.querySelector(value);
    else if (/\[[^\]]*$|\([^\)]*$|[{}]/.test(value)) return false;
    return true;
  } catch { return false; }
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
    DEFAULTS.sessionSampleRate,
  );

  let errorSampleRate = clampRate(
    config.errorSampleRate ?? DEFAULTS.errorSampleRate,
    'errorSampleRate',
    0,
    1,
    DEFAULTS.errorSampleRate,
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
    unmask: (config.unmask ?? DEFAULTS.unmask).filter(validSelector),
    block: (config.block ?? DEFAULTS.block).every(validSelector) ? [...(config.block ?? DEFAULTS.block)] : ['*'],
    mask: (config.mask ?? DEFAULTS.mask).every(validSelector) ? [...(config.mask ?? DEFAULTS.mask)] : ['*'],
    idleTimeout: resolveIdleTimeout(config.idleTimeout),
    flushInterval: boundedPositive(config.flushInterval, DEFAULTS.flushInterval, CEILINGS.flushInterval),
    maxBufferSize: boundedPositive(config.maxBufferSize, DEFAULTS.maxBufferSize, CEILINGS.maxBufferSize),
    maxEventCount: boundedPositive(config.maxEventCount, DEFAULTS.maxEventCount, CEILINGS.maxEventCount),
    maxBufferAgeMs: boundedPositive(config.maxBufferAgeMs, DEFAULTS.maxBufferAgeMs, CEILINGS.maxBufferAgeMs),
    maxChunkCount: boundedPositive(config.maxChunkCount, DEFAULTS.maxChunkCount, CEILINGS.maxChunkCount),
    compressionTimeoutMs: boundedPositive(config.compressionTimeoutMs, DEFAULTS.compressionTimeoutMs, CEILINGS.compressionTimeoutMs),
    fetchTimeoutMs: boundedPositive(config.fetchTimeoutMs, DEFAULTS.fetchTimeoutMs, CEILINGS.fetchTimeoutMs),
    maxRetryAttempts: boundedPositive(config.maxRetryAttempts, DEFAULTS.maxRetryAttempts, CEILINGS.maxRetryAttempts),
    maxRetryAgeMs: boundedPositive(config.maxRetryAgeMs, DEFAULTS.maxRetryAgeMs, CEILINGS.maxRetryAgeMs),
    retryBaseDelayMs: boundedPositive(config.retryBaseDelayMs, DEFAULTS.retryBaseDelayMs, CEILINGS.retryBaseDelayMs),
    maxBackoffMs: boundedPositive(config.maxBackoffMs, DEFAULTS.maxBackoffMs, CEILINGS.maxBackoffMs),
    inlineImages: config.inlineImages ?? DEFAULTS.inlineImages,
    blockMedia: config.blockMedia ?? DEFAULTS.blockMedia,
    apiKey,
    endpoint,
  };
}
