# Code graph performance implementation

Status: implemented on `codex/0.8.1-graph-performance`, targeting `codex/0.8.1`.
This is branch work, not a published release. Telemetry remains separate.
The [resource investigation](code-graph-resource-investigation.md) records the
historical baseline and temporary experiments; its timings are not a matched
comparison with this final implementation.
The durable [performance results](code-graph-performance-results.json) retain
the final engine comparison, actual Hub report, and repeated-operation fixture
measurements summarized below.

## Scope

- **Fingerprint publication:** the engine calls the internal
  `upsertFingerprintsInOwnedTransaction(db, entries)` only inside its complete
  publication transaction. Omitting the nested corpus savepoint avoids the
  measured SQLite memory-journal amplification. Ordinary `upsert` and
  `upsertMany` retain independent batch rollback, including when an enclosing
  caller catches a failure and continues. Duplicate entries still use the last
  value; stable references, constraints, aliases, and unaffected rows survive.
- **Statement ownership:** GraphStore reuses a fixed set of synchronous hot
  statements owned by that store and connection. Fingerprint point reads use
  one fixed statement per connection through weak ownership. Dynamic queries
  and caller iterators remain independent; there is no generic global SQL cache.
- **Construction working set:** continuity planning reads old IDs first. When
  every ID survives, it avoids loading old node bodies and fingerprints. Moves
  retain only planned aliases and the minimal fingerprints needed for fallback;
  the old node/signature collections become collectible before publication.
  Fresh nodes come from staging instead of a second database read. Resolved
  compiler references become edges directly; unresolved/fallback references and
  import bindings remain available for resolution.
- **Hub execution:** refresh/rebuild candidate construction runs in a disposable
  Node process. The Hub retains the maintenance lease, validation, source and
  database revalidation, and final atomic publication. Numeric parse counts and
  phase updates reach Jobs without exposing source contents. Redundant nested
  candidate hashes were removed while preserving the complete before/after byte
  identity around validation and the final identity check before publication.

The CLI keeps its in-process default. Changed-source refresh still stages and
rebuilds the full eligible corpus; this does not introduce incremental compiler
indexing, a language rewrite, a new graph schema, or a new public package API.

## Safety and limits

The owned fingerprint function requires **full outer rollback on every failure**.
An active transaction alone is insufficient authorization to use it. Code that
catches a write failure and continues must use the ordinary store methods.
Graph refresh does not renew tracked Markdown grounding fingerprints or
`bodyHash` baselines; existing explicit grounding review rules remain intact.

The parent creates and identity-binds the child's temporary workspace. Child
results cannot authorize publication: they are bounded, validated messages, and
the parent checks the actual candidate after the child closes. Cancellation,
crash, malformed messages, early IPC disconnect, startup failure, and the build
hang guard stop construction without replacing the last trustworthy graph.
Cleanup waits for child `close`, then verifies workspace identity; it refuses to
remove a replaced directory. Full-width device/inode identities remain intact.

A separate child watchdog reads an inherited parent-lifetime pipe while the
compiler thread is busy. Parent death closes that pipe and stops the child;
watchdog failure also stops construction. A fatal parent `SIGKILL` can still
leave its owned temporary workspace or candidate artifacts because parent
cleanup cannot run. Those artifacts are not published as a successful graph.

The private message ceiling is 1 MiB. Ordinary progress updates are throttled
to four per second and respect IPC backpressure, with bounded phase/final-count
exceptions. Startup has a 15-second guard, construction a 30-minute hang guard,
and cancellation escalates termination after 500 ms. These are lifecycle bounds,
**not a CPU or peak-memory quota**. Compiler dependency loading can still create
a large transient working set. Process exit releases that child's address space;
it does not prove that every native, slow, or repository-specific leak is absent.

Initial checks and parent validation/publication still perform synchronous work.
The Hub can pause at those boundaries, and cancellation there waits for the Hub
to handle the request. Cross-platform cleanup and lifecycle cases are included
in the existing macOS/Windows storage-portability matrix without changing its
pinned runners, Node version, or frozen release budgets. Local macOS results do
not establish Windows behavior; platform CI remains required evidence.

## Matched engine comparison

Baseline and final production engines processed the same frozen MEX source
corpus and seed graph, in separate processes, baseline first. Both indexed all
723 files successfully and produced 33,479 nodes, 88,068 edges, and 23,680
fingerprints. These instrumented local macOS arm64 runs used Node 22.17.1 and
SQLite 3.50.0. They measure the engine refresh, excluding the outer maintenance
service's candidate-copy/validation/publication and Hub costs.

| Measurement | Baseline | Final production |
|---|---:|---:|
| Engine-reported refresh duration | 305,712 ms | 71,046 ms |
| Native statement preparations through sync return | 426,415 | 117 |
| Independently sampled peak RSS | 2,126.469 MiB | 1,681.328 MiB |
| JS heap after close and diagnostic GC | 47.710 MiB | 47.609 MiB |

Refresh took about 77% less time in this pair, or about 4.3 times faster. The
sampled RSS peak was about 21% lower. This is one ordered local pair: compiler
GC, filesystem caches, instrumentation, compression, and host scheduling can
affect both results. It does not establish a portable speedup or memory budget,
and sampled RSS can miss brief peaks. The preparation count stops at sync
return; it excludes the subsequent unchanged refresh.

Normalized output parity passed for all 12 data tables and four representative
ranked full-text queries. The comparison excludes operational timestamps and
surrogate row identifiers, retaining semantic snapshot provenance; both stores
passed SQLite integrity and foreign-key checks. This checks equivalent graph
meaning and retrieval output, not byte-identical database files.

## Repeated-operation characterization

A 180-file multiproject fixture performed five operations in one process,
including real source edits between unchanged checks. The results are retained
in the same [performance results](code-graph-performance-results.json).

| Operation | Elapsed time |
|---|---:|
| Initial build | 2,234.621 ms |
| Unchanged refresh | 36.687 ms |
| Changed-source refresh | 1,995.934 ms |
| Second unchanged refresh | 31.941 ms |
| Second changed-source refresh | 2,007.576 ms |

Every build/changed refresh indexed all 180 files; unchanged refreshes indexed
zero. Heap after engine close and three diagnostic GCs stayed between 40.09 and
41.68 MiB; the maximum sampled RSS was 509.47 MiB. This provides bounded
same-process retention evidence for this fixture, not a long soak or proof that
all leaks are absent. Forced GC is measurement-only and is not used by the
production graph path.

## Actual Hub observation

The local probe used the built Hub on MEX's repository with 723 parsed files,
made a source edit, completed refresh, then made another edit and cancelled the
next refresh during observed parsing. Environment: macOS arm64, Node 22.17.1,
SQLite 3.50.0. The Hub section of the durable
[performance results](code-graph-performance-results.json) was generated at
`2026-09-08T22:05:08.938Z`; CLI SHA-256
`cad49214c1e692a5641a38a5503ba7005bfdce927afb14a2e4b39a71135e8fd8`.

| Observation | Measured result |
|---|---:|
| Completed changed-source refresh | 92.107 s |
| Completed-run job polling p95 / maximum | 3.944 ms / 4.673 s |
| Completed-run session polling p95 / maximum | 2.796 ms / 4.673 s |
| Largest job poll across both runs | 5.238 s, during initial checks |
| Cancel HTTP acknowledgement during parsing | 8.036 ms |
| Cancel request to observed `interrupted` state | 135.598 ms |
| Peak sampled Hub + descendant RSS | 2,058,682,368 bytes (about 1,963 MiB) |
| Peak sampled RSS in observed publication phase, parent only | 335,282,176 bytes (about 320 MiB) |
| HTTP failures / requests across both runs | 0 / 1,489 |

The completed refresh published a different graph and read back as fresh. The
cancelled run left the live graph byte-identical to the completed graph, kept
the second edit stale, stopped the child, and left no candidate files. Only the
Hub parent remained at the end of each run, and the probe stopped it afterward.

Polling ran every 100 ms with at most one outstanding request per route, a
10-second HTTP deadline, and a 180-second job deadline. Busy-route ticks were
skipped rather than queued; p95 describes completed requests, so the maxima and
observed pauses matter. Validation/publication also produced multi-second
pauses. Phase attribution comes from client observations and can itself be
delayed by a blocked Hub. RSS sums concurrently observed processes and may count
shared pages twice; it is neither V8 live heap nor macOS physical footprint.
This single local run establishes Hub behavior, not a Hub speedup percentage or
a portable resource budget. The matched engine comparison above measures a
different scope. Pinned release results remain separate evidence.

## Verification

Focused regressions cover fingerprint output parity and full-width references,
foreign-key and partial bucket-write failures, catch-and-continue batch rollback,
outer publication rollback, statement reuse after rollback, iterator isolation,
unchanged-ID continuity without old-body/fingerprint reads, and rename/move alias
chains. Existing graph integrity and compiler tests retain ambiguity and output
checks. Candidate regressions cover process failure, cancellation, parent death,
workspace replacement, protocol failures, and bounded progress delivery.

The root suite ran 216 files / 3,396 tests: 3,376 passed, one skipped, and 19
initially failed. All 19 then passed on targeted reruns: eight 15-second Team
contract timeouts were rerun with one worker; ten process/listener permission
failures were rerun with the necessary sandbox permissions; one exact writer
inventory assertion was updated for identity-bound candidate workspace cleanup.
No timeout, safety detector, or release budget was relaxed. The final candidate
suite passed 12 tests in 6.98 seconds; the final focused integration rerun passed
56 tests. The full Hub web suite passed 428 tests across 18 files in 16.19 seconds.
Typecheck, build, and graph evaluation passed. Emitted package-root declarations
match the prior surface apart from comments.

Final package smoke passed, including refresh/rebuild through the packed graph
entrypoint. The asset-only release gate passed. Rebuilt public declarations
again matched apart from comments, and the real checkout's graph SHA-256 stayed
unchanged. Windows lifecycle and pinned runtime release CI remain pending the PR;
the local runs above do not replace those gates.

## Verify Checklist

These are the seven exact items from `.mex/context/conventions.md`, with current
status and evidence.

1. **The public `src/index.ts` surface and emitted declarations changed only if compatibility work explicitly requires it.**
   **Pass:** `src/index.ts` is unchanged; emitted declarations differ only in
   comments. The owned fingerprint writer stays outside the emitted class API.
2. **Ordinary reads remain non-mutating; writes have explicit authority, containment, revision, and failure-atomicity checks.**
   **Pass:** immutable reads remain unchanged. Parent-held maintenance authority,
   complete publication rollback, independent standalone batches, and exact
   candidate/workspace identity checks retain their regression coverage.
3. **Inputs, scans, output, diagnostics, and retained local state remain deterministically bounded.**
   **Qualified:** corpus, diagnostic, message, and progress bounds remain
   enforced. There is no peak-RSS quota, and repeated fatal-parent exits can
   leave owned temporary artifacts. Their total accumulation is not claimed to
   be globally bounded. Windows lifecycle behavior still requires platform CI.
4. **Focused tests for the changed boundary pass, followed by `npm run typecheck`; run `npm test` without a concurrent build when full coverage is warranted.**
   **Pass with recorded reruns:** root suite and targeted rerun results are
   recorded above; typecheck passed. Final candidate and full Hub web suites
   passed in sequential runs.
5. **Run `npm run build` for packaging/Hub/asset changes and `npm run eval:test` for graph evaluator or protocol changes.**
   **Pass:** build, evaluation, packed refresh/rebuild smoke, and the asset-only
   release gate passed. The local measurements above do not replace pinned
   runtime release performance gates.
6. **`git diff --check` passes and only intended tracked paths changed; generated `.mex/*.db*`, `.mex/local/`, `dist/`, and unrelated worktree files remain unstaged.**
   **Pass at review:** whitespace checks passed, generated state remained
   unstaged, and the live graph SHA-256 stayed unchanged. Recheck the exact
   staged file list before commit.
7. **Graph/Wiki protocol shapes, stable error codes, ordering, cursors, and non-mutation contracts remain covered when affected.**
   **Pass:** existing protocol/integrity/evaluator tests, adapter/maintenance
   regressions, full Hub web tests, and normalized graph/FTS parity cover these
   boundaries.
