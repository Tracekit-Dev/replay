/**
 * TraceKit Replay - Configuration Resolution
 * @package @tracekit/replay
 *
 * Resolves user-provided ReplayConfig with privacy-first defaults.
 * Validates and clamps rate values to valid ranges.
 */

import type { ReplayConfig, ResolvedReplayConfig } from './types';
import { configureRingBufferDefaults } from './buffer';

const DEFAULTS = {
  sessionSampleRate: 0.1,
  errorSampleRate: 0.0,
  unmask: [] as string[],
  idleTimeout: 1_800_000, // 30 minutes
  flushInterval: 30_000, // 30 seconds
  maxBufferSize: 24_117_248, // 23MB
  maxBufferEvents: 10_000,
  maxBufferAgeMs: 60_000,
  maxChunkEvents: 5_000,
  maxChunkBytes: 25 * 1024 * 1024,
  fetchTimeoutMs: 10_000,
  retryMaxAgeMs: 30_000,
  inlineImages: false,
  blockMedia: true,
} as const;

const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_UNMASK_SELECTORS = 50;
const MAX_UNMASK_SELECTOR_LENGTH = 256;
const MAX_BUFFER_SIZE = 64 * 1024 * 1024;
const MAX_BUFFER_EVENTS = 100_000;
const MAX_BUFFER_AGE_MS = 30 * 60 * 1000;
const MAX_CHUNK_EVENTS = 50_000;
const MAX_CHUNK_BYTES = 25 * 1024 * 1024;
const MAX_FETCH_TIMEOUT_MS = 60_000;
const MAX_RETRY_AGE_MS = 5 * 60 * 1000;

function resolveUnmask(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return DEFAULTS.unmask;
  return value
    .filter((selector): selector is string => typeof selector === 'string')
    .map((selector) => selector.trim().slice(0, MAX_UNMASK_SELECTOR_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_UNMASK_SELECTORS);
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
function clampRate(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    console.warn(`[TraceKit Replay] ${name} (${value}) is not finite, disabling this sample rate`);
    return min;
  }
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

function resolvePositive(value: number | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`[TraceKit Replay] ${name} (${value}) is invalid, using ${fallback}`);
    return fallback;
  }
  if (value > maximum) {
    console.warn(`[TraceKit Replay] ${name} (${value}) exceeds ${maximum}, clamping`);
    return maximum;
  }
  return Math.floor(value);
}

/**
 * Resolve user-provided replay config with defaults.
 * Validates sample rates are in [0, 1] and their sum does not exceed 1.0.
 */
export function resolveReplayConfig(
  config: ReplayConfig,
  apiKey: string,
  endpoint: string,
  serviceName = '',
  identityUserId = '',
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

  const resolved = {
    sessionSampleRate,
    errorSampleRate,
    unmask: resolveUnmask(config.unmask),
    idleTimeout: resolveIdleTimeout(config.idleTimeout),
    flushInterval: config.flushInterval ?? DEFAULTS.flushInterval,
    maxBufferSize: resolvePositive(config.maxBufferSize, DEFAULTS.maxBufferSize, MAX_BUFFER_SIZE, 'maxBufferSize'),
    maxBufferEvents: resolvePositive(config.maxBufferEvents, DEFAULTS.maxBufferEvents, MAX_BUFFER_EVENTS, 'maxBufferEvents'),
    maxBufferAgeMs: resolvePositive(config.maxBufferAgeMs, DEFAULTS.maxBufferAgeMs, MAX_BUFFER_AGE_MS, 'maxBufferAgeMs'),
    maxChunkEvents: resolvePositive(config.maxChunkEvents, DEFAULTS.maxChunkEvents, MAX_CHUNK_EVENTS, 'maxChunkEvents'),
    maxChunkBytes: resolvePositive(config.maxChunkBytes, DEFAULTS.maxChunkBytes, MAX_CHUNK_BYTES, 'maxChunkBytes'),
    fetchTimeoutMs: resolvePositive(config.fetchTimeoutMs, DEFAULTS.fetchTimeoutMs, MAX_FETCH_TIMEOUT_MS, 'fetchTimeoutMs'),
    retryMaxAgeMs: resolvePositive(config.retryMaxAgeMs, DEFAULTS.retryMaxAgeMs, MAX_RETRY_AGE_MS, 'retryMaxAgeMs'),
    inlineImages: config.inlineImages ?? DEFAULTS.inlineImages,
    blockMedia: config.blockMedia ?? DEFAULTS.blockMedia,
    serviceName: config.serviceName ?? serviceName,
    identityUserId,
    apiKey,
    endpoint,
  };
  configureRingBufferDefaults(resolved);
  return resolved;
}
