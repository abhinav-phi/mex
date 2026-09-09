# MEX 0.8.1 telemetry

Branch: `codex/0.8.1-telemetry`, based on release commit `d64f171`.
This change targets `codex/0.8.1`; it does not authorize merging to main.

## Product questions and measurement definitions

The shared random installation UUID is explicitly approved for CLI and Hub.
The older scaffold UUID is omitted. An installation is the unit of measurement;
we cannot infer people, organizations, or teams from it. Agent-generated command
activity is included and cannot be reliably separated from human invocations.

| Question | Definition |
| --- | --- |
| Which features get used? | Unique installations and completed invocations by `command`, or explicit Hub `action`; keep CLI/Hub source and stage visible. Report raw volume alongside unique installations so agent loops do not dominate adoption. |
| Where do operations fail? | Failures / completions for the same command/action/job kind and stage. Report job results separately from successful job-start requests. Invalid input rejected before dispatch is outside this denominator. |
| Are new installations activated? | First observed meaningful completion or Hub page visit, followed by a successful knowledge/graph use or applied contribution/Relay. “First observed” is not guaranteed first install because delivery is opt-out and best effort. |
| Do installations return? | UTC day-1/day-7 retention after first meaningful activity: another qualifying activity on that exact later day. Offer a separate rolling-week measure rather than calling both D7 retention. |
| Is use habitual? | DAU/WAU and DAU/MAU of qualifying installation activity; also active days per installation per week. Use completed calendar windows and original event timestamps. |
| Is the Hub useful? | Returning installations with page navigation or explicit actions; views by category; successful apply and terminal job outcomes. A session start, idle timer, polling request, or SSE reconnect is not active use. |

Qualifying CLI engagement is a completed product operation, including a failed
attempt. Exclude `commands`, `completion`, `feedback`, `log`, `heartbeat`,
`doctor`, `check`, `watch`, and launcher-only `mex`/`tui` from the primary
engagement view; keep them in diagnostic feature-use reports. This is an
analysis filter, not a claim about whether an action was automated. CLI
`preview` counts intent but not an applied change. Hub `replayed: true` applies
count as invocations, not additional mutations. CLI completion does not expose
replay detail, so CLI invocations must not be presented as unique mutations.

Do not join voluntary research contact details to installation IDs. The CLI
and Hub open the same hosted form without identifiers in URL parameters.
The form fields and follow-up consent are managed outside this repository.

## Implementation

- `src/telemetry/schema.ts` defines the complete vocabulary and reconstructs
  allowlisted payloads. Stored events are revalidated before delivery.
- `src/cli-telemetry.ts` uses registered Commander ancestry, derives a closed
  stage value, and completes each action once. Action errors retain exit codes
  and output while allowing bounded telemetry cleanup. TUI/watch launcher
  completion describes startup, not eventual session termination.
- `src/hub/telemetry.ts` projects validated server actions. A strict, authenticated
  page-category POST is capped at 128 bytes and 60 events/minute. Browser requests
  have one in-flight operation and a two-second timeout. Query/hash changes,
  polling, normal reads, fixture APIs, and repeated renders stay silent.
- Owned jobs emit a terminal outcome once after durable terminal-state storage;
  reading or reconciling historical jobs does not create another completion.
- The per-user SQLite outbox uses zero busy wait, capped rows/bytes/age/file size,
  rollback journals, and expiring claims. No graph database is opened or rebuilt.
  The existing lazy SQLite adapter avoids loading native SQLite for opt-outs.
- Node HTTP sends fixed-origin batches with no SDK retries or detached process.
  CLI flush has a default 25 ms grace, capped at 50 ms for internal callers;
  Hub batches every 15 seconds with a two-second request timeout. Cancellation
  destroys sockets and cancels the dedicated DNS resolver.
- Explicit opt-out persists before queue cleanup and reports a busy/unavailable
  purge honestly. Its dedicated marker survives unrelated stale preference writes;
  only explicit enable removes it. Inspection never creates identities, repairs queues, or sends.

The complete privacy and delivery contract is [TELEMETRY.md](../../TELEMETRY.md).
Public package exports, emitted root declaration bytes, graph/Wiki protocols,
and repository artifact schemas are unchanged. `posthog-node` is removed from
production dependencies. The published package now includes `TELEMETRY.md`. The transport follows the documented
[PostHog capture API](https://posthog.com/docs/api/capture).

## Performance verification

The standalone benchmark runs actual built CLI entry points from process spawn
through natural close. It pairs a preserved release build with this candidate,
interleaves conditions, and compares telemetry off, healthy loopback delivery,
connection refusal, and a server that accepts requests but never responds.
Success (`mex commands`) and failure (`mex check --json` outside a project) are
both covered, along with pristine-home initialization. Repeated invocations
verify queued completion accounting, output/exit compatibility, bounded request
cleanup, and offline retention.

The harness redirects only the fixed telemetry ingestion origin to loopback
using a test-only Node preload, blocks other egress, and leaves the production
entry point unchanged. It does not measure internet/TLS latency; a separate
transport deadline test covers cancellation. These local measurements are
characterization, not a new portable release budget.

Run after preserving a baseline build and completing other heavy checks:

```sh
npm run benchmark:telemetry:test
npm run benchmark:telemetry -- --baseline /absolute/baseline/dist/cli.js --output test-results/telemetry.json
```

### Measured result

[Retained evidence](telemetry-performance-results.json) includes raw samples and
paired differences. On the local Apple M4 / Node 22.17.1 host, each of 16 CLI
groups completed five warmups and 20 measured invocations. Times below are
paired enabled-minus-disabled differences, in milliseconds.

| Command result | Healthy p50 / p95 | Refused p50 / p95 | Hanging p50 / p95 |
| --- | --- | --- | --- |
| Success | 3.084 / 17.811 | 4.408 / 20.586 | 27.294 / 48.884 |
| Failure | 7.806 / 18.022 | 6.377 / 24.638 | 22.797 / 31.600 |

The short successful command's absolute median was 357.033 ms disabled,
360.396 ms with healthy local ingestion, and 386.629 ms with hanging ingestion.
The older implementation took 1029.530 ms with hanging ingestion; the paired
median improvement was 644.888 ms. The new failure path adds outcome capture
where the old process exited without delivering an event.

Capture-call p95 was at most 2.410 ms, with first queue initialization at most
3.210 ms. The longest observed flush was 29.114 ms, including local cleanup and
scheduling around the 25 ms network grace. These observed times are not hard
wall-clock guarantees on arbitrary disks, hosts, or schedulers.

Every tested healthy candidate command accounted for all 25 starts and 25
completions across warmups and samples, with an empty queue afterward. Refused
and hanging conditions retained all 50 events per command in a 45,056-byte
store, with no active delivery claim left. All processes exited naturally with
expected output/status, no sockets remained, and disabled pristine homes stayed
empty. Receipt and acknowledgement are distinguished; UUID set union prevents
received-but-still-queued events from being counted twice.

Internet/TLS latency and production delivery rates are not measured by the
loopback benchmark. Short-only usage can defer events repeatedly until enough
runtime is available for a send or a Hub session drains the queue. The local
measurements cover backlogs up to 50 events; maximum-cap queue timing is not
claimed. The full implementation validation record follows below.

## Verify Checklist

1. **Public surface/declarations — pass.** `src/index.ts` and root emitted declaration bytes are unchanged; telemetry remains internal.
2. **Read and write safety — pass.** Pure reads skip capture; page input is authenticated and bounded; queued data is revalidated; explicit opt-out owns preference/cleanup.
3. **Deterministic bounds — pass.** Event vocabulary, request body/rate, queue rows/bytes/age/file size, claim life, requests and network grace are bounded. Tests include malformed data, unsafe paths, large SQLite pages, concurrent writers, active opt-out and real stalled DNS.
4. **Tests/typecheck — pass.** Final `npm test -- --maxWorkers=2`: 222 files, 3,500 passed, one skipped (657.24 seconds), with no concurrent build. Hub web: 434 passed. Playwright: two passed (Home screenshot/accessibility and production-Hub integration). Workspace typecheck and standalone benchmark harness (four tests) pass. The actual CLI benchmark passes. The first full run exposed two old-API architecture assertions and one aggregate containment timeout; the guard now covers the actual capture boundary, and the five containment fixtures run independently with their original assertions/timeouts.
5. **Packaging/evaluator — pass.** Full build and fresh packed-install/Project Hub/official-skills smoke pass. The packaged CLI hash matches the retained benchmark candidate. No evaluator or graph protocol change requires a new evaluator run.
6. **Diff and scope — pass.** `git diff --check` passes. Changes are limited to telemetry, feedback, supporting tests/CI and documentation. Generated indexes, checkout local state and dist remain unstaged; the real graph database hash is unchanged.
7. **Graph/Wiki protocols — pass.** Existing command, application-adapter, golden protocol, immutable-read and Hub integration suites pass. No graph/Wiki protocol, error, ordering, cursor, or maintenance contract changed. macOS/Windows CI and the pinned release-performance gate remain required before release.
