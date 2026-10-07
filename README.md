# @tracekit/replay

Privacy-first session recording for TraceKit. Replay masks text and inputs by default. It strips URL credentials, queries, and fragments before upload. Server-side trace links require a validated same-organization relationship.

## Installation

```bash
npm install @tracekit/replay @tracekit/browser
```

## Quick Start

```javascript
import { init } from '@tracekit/browser';
import { replayIntegration } from '@tracekit/replay';

init({
  apiKey: 'your-api-key',
  addons: [replayIntegration()],
});
```

## Configuration

All options are optional. Defaults are privacy-first and production-ready.

```javascript
replayIntegration({
  sessionSampleRate: 0.1,   // Record 10% of sessions
  errorSampleRate: 0.0,     // Capture replay on error (0.0 = off, 1.0 = all errors)
  unmask: ['.public-text'], // CSS selectors to unmask (default: everything masked)
  block: ['.private-panel'], // Block these regions, including protected descendants
  mask: ['.account-number'], // Mask these regions, even inside unmask targets
  idleTimeout: 1800000,     // End session after 30min inactivity
  flushInterval: 30000,     // Upload chunks every 30 seconds
  maxBufferSize: 24117248,  // 23MB max buffer before dropping oldest events
  inlineImages: false,      // Capture images as base64 data URIs
  blockMedia: true,         // Block img/video/canvas/svg/iframe from recording
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessionSampleRate` | `number` | `0.1` | Percentage of sessions to record (0.0 to 1.0) |
| `errorSampleRate` | `number` | `0.0` | Capture replay when an error occurs (0.0 to 1.0) |
| `unmask` | `string[]` | `[]` | CSS selectors for elements to unmask |
| `block` | `string[]` | `[]` | CSS selectors for regions to block |
| `mask` | `string[]` | `[]` | CSS selectors for regions to mask |
| `idleTimeout` | `number` | `1800000` | Milliseconds without visible user activity before session ends (30 min) |
| `flushInterval` | `number` | `30000` | Milliseconds between chunk uploads (30s) |
| `maxBufferSize` | `number` | `24117248` | Max buffer size in bytes before dropping oldest events (23MB) |
| `inlineImages` | `boolean` | `false` | Inline images as base64 data URIs in the recording |
| `blockMedia` | `boolean` | `true` | Replace media elements with placeholders |

## Metadata

The SDK automatically sends session metadata with each chunk upload:

- **Page URL** — current page URL without credentials, query, or fragment
- **User ID** — from the browser SDK scope (`setUser()`)
- **User-Agent** — for device, OS, and browser detection
- **Click count** — accumulated mouse clicks in the session
- **Keypress count** — accumulated input events in the session

These are displayed in the replay list as country flags, browser/device/OS icons, and interaction counts.

## API

```javascript
const replay = replayIntegration();

// Force upload pending events (e.g., before navigation)
replay.flush();

// Get the current session ID (for linking to errors)
replay.getSessionId();

// Aggregate capture and delivery state. It contains no URL or recorded content.
replay.getStatus();

// Subscribe to aggregate state changes. Call the returned function to unsubscribe.
const unsubscribe = replay.subscribeStatus((status) => console.log(status.captureState, status.deliveryState));

// Stop capture and discard unsent replay data after permission withdrawal.
replay.stop();

// Start a new recording with a fresh Replay ID after permission returns.
replay.start();
```

The host application owns the permission decision. Use the Browser SDK's existing
`enabled` setting when you initialize it. A disabled client does not create Replay
recording resources. To withdraw permission, reinitialize the Browser SDK with
`init({...config, enabled: false})`. That call destroys the prior Replay addon.
Reinitialize with `enabled: true` and a new Replay addon when permission returns.
Do not mutate `getConfig().enabled` directly. That mutation does not stop active
Browser collectors or Replay observers.

`stop()` synchronously stops Replay observers and discards unsent replay data.
It also aborts active Replay fetches and prevents automatic visibility or input
events from restarting recording. A request that the server already accepted
cannot be recalled. `start()` is idempotent and checks Browser enablement.
Each allowed start after a stop uses a fresh document-local Replay ID.
Reloads and copied tabs also use a fresh ID. They do not restore a prior document ID.
The first automatic pageview uses the same ID when recording starts successfully.

`getStatus()` reports bounded counts and a reason. A beacon is queued, not acknowledged.
Missing final or dropped-event evidence leaves recording health unknown or partial.
The viewer marks unsupported legacy intervals and starts again at a real FullSnapshot.
It does not display a known-wrong frame across a missing chunk.
The viewer labels each unreconstructable interval as a gap.

Replay fetch uploads and retries use `referrerPolicy: 'no-referrer'`.
During unload, Replay uses `sendBeacon` only when the actual host URL needs no sanitization.
A host URL with query data, a fragment, credentials, or another removed URL component uses
`fetch` with `keepalive: true` and `referrerPolicy: 'no-referrer'` instead.
Replay does not change the host page's global referrer policy.
Neither unload transport guarantees server acknowledgement.

Initial capture serializes the current document synchronously. The fixed 10,000-node
fixture measured one 303 ms startup task at 4x CPU throttling. Its steady input latency
met the unchanged 10 ms added p95 limit. This is not a zero-blocking startup guarantee.
When delayed capture is acceptable, schedule the host's initial Browser `init` with
the Replay addon through `requestIdleCallback`. Use a host-selected timeout or
`setTimeout` fallback. A timeout can still interrupt active work, and delayed capture
misses earlier events. Exclude unnecessary subtrees with rrweb's supported `.rr-block`
class. That exclusion also removes their playback detail. These mitigations require
measurement on the host's real document; the fixed fixture does not measure their benefit.

Replay uses owned breadcrumb subscriptions when the Browser SDK supports them.
With older Browser bundles, Replay disables breadcrumb capture and reports a
bounded compatibility reason. It does not replace a host breadcrumb listener.
An older scope without tag removal keeps its prior tags unchanged. Replay then
omits a temporary error link when no `replay_id` tag existed before capture.

## Documentation

Full documentation: https://app.tracekit.dev/docs/frontend/session-replay

## License

MIT

### Recorded duration (0.3.4)

Replay uploads include timestamp boundaries for each visible recording interval.
The server uses these intervals to exclude hidden periods and upload delays from duration.
This measures recorded time, not Analytics engagement time.
Deploy the server duration migration before publishing this package.
Older uploads without boundaries keep an unknown duration.
The server also marks chunks longer than 30 minutes as unknown.
Keep `flushInterval` below that limit (default: 30 seconds).

For the real Browser-bundle lifecycle test, build Browser and Replay first.
Then run `npm run test:browser-lifecycle` with Playwright installed.
Set `PLAYWRIGHT_MODULE` to its module path when using an external installation.
The script reports unavailable engines instead of counting them as passing.
