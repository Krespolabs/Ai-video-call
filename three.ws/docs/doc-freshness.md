# Doc freshness: keeping documentation true to the code

Documentation rots quietly. Nobody edits a doc to make it wrong; the code it describes just
moves, and the page keeps saying what used to be true. The only signal that used to exist was
a confused reader.

This is the system that measures that rot and drains it. It runs on every doc in the
repository, needs no annotations, and publishes what it finds at
[three.ws/docs/freshness](https://three.ws/docs/freshness).

## What it measures

A doc already tells you what it is about. It names files, `npm run` commands, and `/api/`
routes in its own text. [scripts/doc-freshness.mjs](../scripts/doc-freshness.mjs) reads those
references, resolves the ones that point at real source files, and treats them as that doc's
dependencies. Then it asks git one question per dependency: was this file committed to after
the doc was last written or last reviewed?

Code that moved after the page was last checked is code the page has never been checked
against. That is the whole measurement.

Two refinements keep the ranking honest:

- **Weight by exclusivity.** `vercel.json` is named by dozens of docs. If every one of them
  lit up whenever it changed, the ranking would be red everywhere and nobody would read it. A
  file only one doc names counts fully; a file forty docs name counts for a fortieth. The doc
  that is uniquely responsible for a file surfaces above the doc that happened to mention a
  busy one.
- **Ignore generated output.** The changelog gaining an entry is not evidence that a tutorial
  went wrong, so build artifacts and the machine-translated locale tree are excluded from the
  dependency graph entirely. The system's own bookkeeping is excluded for the same reason: the
  review store and the budget are rewritten by every sweep, and counting them would make this
  very page go stale every time anyone records a review.

## The five statuses

| Status | Meaning |
|---|---|
| **Verified** | Nothing it documents has changed since it was written or reviewed. |
| **Watch** | Some movement, below the threshold. Worth a skim, not urgent. |
| **Stale** | The equivalent of one file only this doc documents has changed. Someone should re-read it. |
| **Conceptual** | Names no code, so there is nothing to check. Not a problem, and not counted as drift. |
| **Record** | A dated record of a moment. Code moving under it is not drift. |

## Recording a review

The measurement has one blind spot that a timestamp cannot cover: reading a page carefully,
checking every claim, and finding it already correct. That is real work with no diff to show
for it. Before review stamps existed, the only ways to record it were a cosmetic edit, which
lies about what happened in the history, or leaving a permanent false positive, which teaches
people to ignore the dashboard. The last full sweep ended with eight docs stuck in exactly
that state.

A stamp is the second clock:

```bash
# You read the doc, checked it against the code, and it was right.
npm run docs:review -- docs/forge-pipeline.md --note "lanes, timeouts and failover verified"

# Several at once, against the commit you actually reviewed.
npm run docs:review -- docs/a.md docs/b.md --at 53f2a200f --note "swept with the x402 pass"

# A dated record that must not be rewritten to match today's code.
npm run docs:review -- docs/security/review-2026-06-24.md --snapshot

npm run docs:review -- --list     # every stamp, newest first
npm run docs:review -- --prune    # drop stamps for docs that no longer exist
```

Stamps live in [data/docs-freshness-reviews.json](../data/docs-freshness-reviews.json).
Freshness is then measured from whichever is newer, the doc's last commit or its last review.
A stamp naming a commit this repository does not have is a hard error, not a silent skip: a
baseline nobody can check would quietly suppress real drift.

Use `--snapshot` only for a doc that documents a moment rather than current behavior: a dated
audit, an incident writeup, a finished work order, an upstream issue draft, a test log.
Rewriting one of those to match today's code destroys the record it exists to keep.

## Working the queue

```bash
npm run docs:freshness                         # rank everything, write the report
npm run docs:freshness -- --top 40             # show more rows
npm run docs:freshness -- --doc docs/forge.md  # one doc, with the exact commits to read
npm run check:docs-freshness                   # the gate: fail when drift exceeds the budget
```

`--doc` is the one to reach for. It prints every drifted file, the commits behind it, and
their subjects, which is the reading list for refreshing that page:

```
docs/terminal.md

  status        stale (signal 1.063)
  last edited   2026-09-01 (b6194ae82), 15d ago
  documents     14 file(s)

  2 of them changed after this doc was last edited:

  src/mission-control/index.js  (1 commit)
      2026-09-01  ab5034ed9  fix(terminal): make Mission Control honest signed out and reachable on a phone
```

Read those commits. Fix what the doc gets wrong. Then stamp it, whether or not it needed an
edit.

## Where it runs

- **`npm run gate`** runs `check:docs-freshness`, which fails when the number of stale docs
  exceeds `maxStale` in [data/docs-freshness-budget.json](../data/docs-freshness-budget.json).
  The budget is a ratchet: it goes down as docs are refreshed, and never up without a reason
  recorded in the file's own history. Normal weekly churn has headroom; a regression does not.
- **`npm run build:gcp`** runs `docs:freshness` before the frontend build, so
  `public/docs-freshness.json` and its summary are regenerated at the commit being deployed
  and copied into `dist/`. Without that step the published dashboard would show whatever the
  last person to run the command by hand happened to measure.

## What readers see

Every docs page renders a small freshness badge above the article, mounted from
[public/doc-freshness.js](../public/doc-freshness.js). It reads a compact summary
(`/docs-freshness-summary.json`, four or five fields per doc) rather than the full report,
because the full report is about a megabyte of evidence and belongs only to the dashboard.

A verified page gets a quiet line. A page whose code has moved says so plainly, names how many
files moved, and links to the evidence on [/docs/freshness](https://three.ws/docs/freshness).
It never scolds and never blocks the content: the reader came for the doc, and the honest
thing is to tell them how much to trust it while they read.

## Related

- [Guard wiring](./ops/guard-wiring.md): which checks actually run, and why this one is in `gate`
- [STRUCTURE.md](../STRUCTURE.md): where every product surface lives
