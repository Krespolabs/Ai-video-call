# three.ws: rules for Codex and other non-Claude agents

Read [CLAUDE.md](CLAUDE.md) in full before doing anything and follow it exactly. It is the
operating rulebook for every agent in this repo, not only Claude. Its hard rules, stop-and-ask
gates, commit-message format, $THREE commit gate, and em-dash ban all apply to you.

The rules agents break most often:

- Stage explicit paths only. Never `git add -A` or `git add .`; other agents share this repo.
- Never `git push`, deploy, run `npm run db:migrate`, or sign or send any on-chain transaction.
- Never write the em-dash or en-dash characters anywhere. Use a period, comma, colon, or hyphen.
- Before each commit run `npm run check:rules -- --paths <every file you changed>` and fix what it reports.
- Commit subjects follow `type(scope): what changed and why it matters`. Generic subjects are rejected.
