export const meta = {
  name: 'docs-freshness',
  description: 'Refresh the docs that describe code which moved, then record each review so the check stays drainable',
  whenToUse: 'Run when `npm run check:docs-freshness` is over budget, or on a routine pass to keep the corpus true. Invoke with: run the docs-freshness workflow. Optional args: { limit: number } for how many stale docs to take this run (default 12), { paths: string[] } to review specific docs instead of the ranked queue.',
  phases: [
    { title: 'Queue', detail: 'one agent ranks the stale docs and splits them into review batches' },
    { title: 'Review', detail: 'one agent per batch, each checking its docs against the commits that drifted' },
    { title: 'Stamp', detail: 'one agent records every verdict with npm run docs:review' },
  ],
}

// The queue agent reads the ranked report rather than guessing which docs matter:
// scripts/doc-freshness.mjs already weights each drifted file by how exclusively
// a doc claims it, so its order is the work order.
const QUEUE_SCHEMA = {
  type: 'object',
  required: ['batches'],
  properties: {
    batches: {
      type: 'array',
      description: 'review batches, each a related group of docs so one agent can share context across them',
      items: {
        type: 'object',
        required: ['area', 'docs'],
        properties: {
          area: { type: 'string', description: 'what these docs are about, e.g. "forge and avatars"' },
          docs: { type: 'array', items: { type: 'string' }, description: 'repo-relative doc paths' },
        },
      },
    },
  },
}

// EDITED / VERIFIED / SNAPSHOT is the whole vocabulary. A doc that was read and
// found correct is as finished as one that needed a fix, which is the point of
// the review baseline: without VERIFIED the queue can only be drained by editing.
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'verdict', 'note'],
        properties: {
          path: { type: 'string' },
          verdict: { type: 'string', enum: ['EDITED', 'VERIFIED', 'SNAPSHOT'] },
          note: { type: 'string', description: 'one sentence: what was wrong, or why it is still right' },
        },
      },
    },
  },
}

const RULES = `Rules that apply to every doc you touch:
- Read /workspaces/three.ws/CLAUDE.md "Tone" and "Documentation" first. The em-dash and en-dash characters are banned everywhere you write.
- \`node scripts/doc-freshness.mjs --doc <path>\` lists every drifted file and the commits behind it. Read those commits (\`git show <sha> -- <file>\`) AND the current source before deciding anything.
- Check every concrete claim: routes, env vars, script and function names, behavior, numbers, fees, file paths, UI copy. Fix what is wrong or materially missing. Keep the doc's structure and voice, correct rather than rewrite, never pad. Every path and link you write must resolve.
- A doc that records a moment (a dated audit, an incident writeup, a finished work order, an upstream issue draft, a test log) must NOT be rewritten to match today's code. That is a SNAPSHOT.
- This worktree is shared with other agents. Edit only the docs you were given. Never run git add/commit/checkout/stash/reset. Never edit source code. Never execute a transaction or spend.
- When done, run \`npm run check:rules -- --paths <docs you edited>\` and fix what it flags.`

phase('Queue')
const limit = (args && args.limit) || 12
const paths = (args && args.paths) || null

const queue = await agent(
  paths
    ? `Group these docs into batches of at most 5, by subject area, so one reviewer per batch can share context: ${paths.join(', ')}. Return the batches.`
    : `Run \`npm run docs:freshness\` in the repository root, then read public/docs-freshness.json. Take the ${limit} docs with status "stale" and the highest signal. Group them into batches of at most 5 by subject area (docs about the same product surface belong together, so one reviewer reads that surface's code once). Return the batches. Do not edit any file.`,
  { label: 'queue:stale-docs', schema: QUEUE_SCHEMA }
)

const reviewed = await parallel(
  queue.batches.map(batch => () =>
    agent(
      `Refresh these stale three.ws docs (${batch.area}): ${batch.docs.join(', ')}.\n\n${RULES}\n\nReturn one verdict per doc, covering every doc listed above exactly once.`,
      { label: `review:${batch.area}`, phase: 'Review', schema: REVIEW_SCHEMA }
    ).then(r => r.verdicts)
  )
)

const verdicts = reviewed.flat().filter(Boolean)
if (!verdicts.length) return { reviewed: 0, note: 'no doc came back with a verdict' }

// Stamping is centralized in one agent on purpose: data/docs-freshness-reviews.json
// is a single file, and several agents writing it at once would lose stamps to a
// last-write-wins race.
phase('Stamp')
const verified = verdicts.filter(v => v.verdict !== 'SNAPSHOT').map(v => v.path)
const snapshots = verdicts.filter(v => v.verdict === 'SNAPSHOT').map(v => v.path)

await agent(
  `Record these doc reviews in the three.ws repo, one command per group, from the repository root:\n` +
    (verified.length
      ? `1. \`npm run docs:review -- ${verified.join(' ')} --note "freshness sweep: checked against the drifted commits"\`\n`
      : '') +
    (snapshots.length
      ? `2. \`npm run docs:review -- ${snapshots.join(' ')} --snapshot --note "dated record, kept as written"\`\n`
      : '') +
    `Then run \`npm run check:docs-freshness\` and report its output verbatim. Do not edit any doc, and do not run any git command that writes (no add, commit, checkout, stash, reset).`,
  { label: 'stamp:reviews', phase: 'Stamp' }
)

return {
  edited: verdicts.filter(v => v.verdict === 'EDITED'),
  verified: verdicts.filter(v => v.verdict === 'VERIFIED'),
  snapshots: verdicts.filter(v => v.verdict === 'SNAPSHOT'),
}
