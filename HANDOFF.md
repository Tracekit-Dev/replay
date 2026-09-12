# Replay lifecycle fix handoff

Status: READY_FOR_REVIEW

Last commit: pending checkpoint

Completed:

- Added trusted visible activity listeners and wall clock expiry checks.
- Kept idle sessions inactive until visible activity or visibility return.
- Preserved sampling mode and validated persisted session and segment state.
- Persisted segment allocation and exposed retained flush identity.
- Added lifecycle recording window calls, hidden start protection, and deadline wiring.
- Validated idle timeout values and updated the README.

Changed files: `src/session.ts`, `src/index.ts`, `src/config.ts`, `README.md`.

Tests: `npm test` passed. `npm run build` passed.

Current blocker: Parent integration must use `getFlushSessionId()` for old-session flushes.

Next action: Parent reviews and integrates the lifecycle API with transport flush behavior.
