import { afterEach, expect, it, vi } from 'vitest';
import { ReplayTransport } from '../src/transport';
import { resolveReplayConfig } from '../src/config';

afterEach(() => { vi.unstubAllGlobals(); });

it('sends one bounded service name with asynchronous and beacon uploads', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  const beacon = vi.fn().mockReturnValue(true);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { userAgent: 'test', sendBeacon: beacon });
  const config = resolveReplayConfig({}, 'test-key', 'https://example.test');
  config.serviceName = 'checkout-api';
  const worker = { compress: vi.fn().mockResolvedValue({ compressed: new Uint8Array([1]), originalSize: 1 }) };
  const transport = new ReplayTransport(config, worker as any);
  let segment = 0;
  transport.start(() => 'session-a', () => segment++, () => 'session', () => '', () => '');
  transport.stop();
  transport.addEvent({ type: 2, timestamp: 100 });
  await transport.flush();
  expect(fetchMock.mock.calls[0][1].headers['X-Replay-Service-Name']).toBe('checkout-api');
  transport.addEvent({ type: 2, timestamp: 200 });
  transport.flushSync();
  const beaconURL = new URL(beacon.mock.calls[0][0]);
  expect(beaconURL.searchParams.get('service_name')).toBe('checkout-api');
  expect(beaconURL.searchParams.has('project_id')).toBe(false);
  transport.destroy();
});
