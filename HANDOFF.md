# Replay lifecycle fix handoff

Status: READY_FOR_REVIEW

Last commit: 334f96d

Completed:

- Added trusted visible activity listeners and wall clock expiry checks.
- Kept idle sessions inactive until visible activity or visibility return.
- Preserved sampling mode and validated persisted session and segment state.
- Persisted segment allocation and exposed retained flush identity.
- Added lifecycle recording window calls, hidden start protection, and deadline wiring.
- Validated idle timeout values and updated the README.
- Added fake timer tests for event noise, hidden resume expiry, segment persistence, and listener teardown.
- Evicted stale ring buffer entries during delayed flushes and allowed empty buffer promotion.

Changed files: `src/session.ts`, `src/index.ts`, `src/config.ts`, `README.md`.

Tests: `npm test` passed with 15 tests. `npm run build` passed.

Current blocker: None.

Next action: Parent reviews commits `b4580b8`, `c9c5119`, `c18b603`, and `334f96d`.
