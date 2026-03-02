# @tracekit/replay

TraceKit Session Replay for privacy-first session recording linked to distributed traces.

## Installation

```bash
npm install @tracekit/replay @tracekit/browser
```

## Quick Start

```javascript
import { init } from '@tracekit/browser';
import { replayIntegration } from '@tracekit/replay';

init({
  dsn: 'https://your-project-dsn@tracekit.dev/1',
  integrations: [replayIntegration()],
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maskAllText` | `boolean` | `true` | Mask all text content for privacy |
| `maskAllInputs` | `boolean` | `true` | Mask all input field values |
| `blockAllMedia` | `boolean` | `true` | Block images, videos, and media elements |
| `sampleRate` | `number` | `0.1` | Session sample rate (0.0 to 1.0) |
| `errorSampleRate` | `number` | `1.0` | Sample rate for sessions with errors |

## Documentation

Full documentation: https://app.tracekit.dev/docs/frontend/session-replay

## License

MIT
