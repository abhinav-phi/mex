# mex 0.8.1 — Explore context, share knowledge, keep work moving

MEX 0.8.1 makes project knowledge easier to explore and contribute to, makes
Relays useful before you know who will pick up the work, and keeps compiler
work from blocking the Hub during Graph construction.

## Highlights

- **Explore your project's Context graph.** See Wiki entities and recorded
  relationships together, filter by type, and select an entity to reveal its
  direct code groundings and details. A list view remains available. Inbox,
  Relays, Team, and Activity stay in primary navigation; existing Specs and
  Workstreams remain readable through their direct routes.
- **Turn a discussion into project knowledge.** Inbox now handles additions
  and corrections to existing architecture, components, conventions, decisions,
  patterns, and guides. Use `mex-inbox` to prepare a local draft, publish a
  Markdown proposal for review, and explicitly approve its contribution to the
  Wiki. Evidence and attribution survive; routine knowledge upkeep can still
  happen directly.
- **Leave a Relay open to the team.** Eligible active Members can take an open-to-team
  handoff, including someone who joins later. Drafts can defer recipient
  selection, `mex relay draft save --from <draft.json>` shortens local saving,
  and inactive Members can be reactivated with their original identity.
  Audience and sharing states are visible in Hub and CLI.
- **Choose how much agents log.** Hub Settings and `mex logging` offer a quiet
  `significant` default, batched `checkpoints`, or `manual` logging. Updated
  agent instructions retrieve relevant Timeline notes so useful context is
  easier to reuse; a session note does not automatically become accepted Wiki
  knowledge.
- **Keep grounding changes deliberate.** A successful agent run no longer
  resets drift baselines. Interactive sync asks you to accept individual
  groundings and checks that the reviewed document and code still match.
  Moving a symbol preserves evidence of earlier changes.

## Graph and reliability

Hub refresh/rebuild constructs its Graph candidate in a disposable process,
allowing the Hub to respond during compiler work. The Hub still validates and
publishes the result; initial checks and final publication can still pause it.
Smaller temporary collections and reused database statements remove avoidable
work. This does not add incremental indexing or a peak-memory quota: a changed
source still triggers a build of the eligible corpus, and simultaneous Hub and
worker memory can increase the combined peak. CLI builds remain in process.

Targeted CLI Graph reads can now explain config drift, partial parses, and
excluded changed source files while returning the remaining useful evidence.
Hub reads retain strict freshness. Formatting or dependency-version-only
changes to configuration no longer invalidate an otherwise unchanged graph.
Maintenance can retain a useful graph with documented per-file gaps, and
failures name the diagnostics that stopped publication.

Other fixes preserve exact Wiki bytes and full-width filesystem identities on
Windows, stop unknown context files being assumed to be architecture, improve
write provenance, and report missing SQLite FTS5 support clearly. Explicit
Graph/Wiki maintenance also installs ignore protection before creating stores.

## Telemetry and feedback

Usage events are **pseudonymous and opt-out**. Namespaced CLI outcomes and
fixed Hub page/action/job events share a random installation UUID. Where
available, events include the existing scaffold UUID and configured tool names
from the allowlist: `claude`, `codex`, `copilot`, `cursor`, `opencode`, and
`windsurf`. Configured tools describe setup, not the invoking agent; multiple
installations on one scaffold are a shared-use signal, not proof of team size.

Events exclude names, repository remotes, content, paths, queries, and contact
details. A bounded local queue and cancellable delivery keep network waiting
limited; delivery remains best effort. Inspect or disable it with:

```bash
mex telemetry inspect
mex telemetry disable
```

`DO_NOT_TRACK=1` or `MEX_TELEMETRY=0` also disables collection and sending.
[TELEMETRY.md](TELEMETRY.md) explains the complete catalog, identifiers, limits,
and opt-outs. `mex feedback` now opens the Hub's existing Help shape MEX form;
any contact details you choose to provide there are separate from telemetry,
and MEX adds no analytics identity to the form URL.

## Install and upgrade

MEX requires Node.js 22.5 or newer **with SQLite FTS5 support**. The Node version
alone does not guarantee FTS5; [COMPATIBILITY.md](COMPATIBILITY.md#sqlite-fts5)
includes a check for your Node build.

Start a new project with:

```bash
npx mex-agent@0.8.1 setup
```

For an existing project:

```bash
npm install -g mex-agent@0.8.1
mex skills sync --dry-run
mex skills sync
mex graph status
```

Run `mex skills sync` inside each project whose installed skills and managed
agent instructions you want to update. Review the dry run and any conflicts
before applying, then start a new agent session. Package installation alone
does not change your project's instructions. A completed 0.8.0 setup does not
need to run again solely for this upgrade; follow any explicit maintenance
action reported by `mex graph status`.

**Update teammates before using open-to-team Relays.** Those new handoffs use
schema v4 and require MEX 0.8.1. Existing named v1–v3 Relays remain supported;
new named handoffs continue using v3. Legacy Spec proposals also remain usable.
The Graph store stays at schema v4, and ordinary reads never migrate or repair
an index.

Project Hub remains local. Local drafts belong to the checkout; published
proposals and handoffs are working-tree files that require Git commit/push/pull
to share. MEX does not perform those Git operations or verify delivery. Tracked
Wiki Markdown remains canonical. Graph/Wiki indexes are rebuildable; drafts
and other `.mex/local/` state stay in the checkout and must not be committed.
