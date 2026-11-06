#!/usr/bin/env bash
# Restore the tables that exist on the LEGACY Neon DB but are MISSING on the new
# canonical DB after the 2026-06-24 Vercel account switch. This is the data-safe
# fix for the production "relation \"X\" does not exist" storm (~98% of error
# volume in the 2026-06-24 log export): it copies ONLY the tables the new DB
# lacks, so anything the new DB has already written since the switch is left
# completely untouched.
#
# Usage:
#   export OLD_URL='postgres://…ep-floral-snow-afc6cye1…/neondb?sslmode=require'   # SOURCE (legacy), UNPOOLED
#   export NEW_URL='postgres://…ep-curly-cherry-a6cvth74…/neondb?sslmode=require'  # DESTINATION (canonical), UNPOOLED
#   bash scripts/restore-missing-tables.sh            # dry-run: prints the missing-table plan
#   bash scripts/restore-missing-tables.sh --apply    # actually copy the missing tables
#
# Notes:
#   - Use the UNPOOLED endpoints (no `-pooler`): pgbouncer breaks pg_dump.
#   - Needs postgresql-client-17 (both DBs are PG 17.10).
#   - Extensions: pg_dump --schema=public omits CREATE EXTENSION, and the schema
#     uses citext/pg_trgm/pgcrypto, so we pre-create them on the destination.
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

: "${OLD_URL:?set OLD_URL to the legacy (source) unpooled connection string}"
: "${NEW_URL:?set NEW_URL to the canonical (destination) unpooled connection string}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

list_tables() { # $1=conn  -> base-table names in public, one per line, sorted
	psql "$1" -At -c \
		"select tablename from pg_tables where schemaname='public' order by tablename"
}

echo "› Enumerating public tables on both databases…"
list_tables "$OLD_URL" > "$WORK/old.txt"
list_tables "$NEW_URL" > "$WORK/new.txt"
comm -23 "$WORK/old.txt" "$WORK/new.txt" > "$WORK/missing.txt"

OLD_N=$(wc -l < "$WORK/old.txt"); NEW_N=$(wc -l < "$WORK/new.txt"); MISS_N=$(wc -l < "$WORK/missing.txt")
echo "  legacy (source):      $OLD_N tables"
echo "  canonical (dest):     $NEW_N tables"
echo "  missing on dest:      $MISS_N tables"
echo
if [[ "$MISS_N" -eq 0 ]]; then
	echo "✓ Destination already has every legacy table. Nothing to restore."
	exit 0
fi
echo "Missing tables to copy:"
sed 's/^/  - /' "$WORK/missing.txt"
echo

if [[ "$APPLY" -ne 1 ]]; then
	echo "Dry run. Re-run with --apply to copy the tables above (schema + data)."
	exit 0
fi

# Build -t flags for exactly the missing tables.
TFLAGS=()
while IFS= read -r t; do [[ -n "$t" ]] && TFLAGS+=( -t "public.\"$t\"" ); done < "$WORK/missing.txt"

echo "› Pre-creating required extensions on destination…"
psql "$NEW_URL" -v ON_ERROR_STOP=1 -c \
	"CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;"

echo "› Dumping $MISS_N missing tables from legacy (custom format)…"
pg_dump "$OLD_URL" -Fc --no-owner --no-acl "${TFLAGS[@]}" -f "$WORK/missing.dump"

echo "› Restoring into canonical DB (parallel, no-owner/no-acl)…"
# --no-acl/--no-owner: Neon roles differ across accounts. A benign
# "schema public already exists" is expected and harmless.
pg_restore --no-owner --no-acl -j 4 -d "$NEW_URL" "$WORK/missing.dump" || true

echo "› Verifying the previously-missing tables now exist with row counts…"
while IFS= read -r t; do
	[[ -z "$t" ]] && continue
	cnt=$(psql "$NEW_URL" -At -c "select count(*) from public.\"$t\"" 2>/dev/null || echo "MISSING")
	printf '  %-34s %s\n' "$t" "$cnt"
done < "$WORK/missing.txt"

echo
echo "✓ Done. Re-check production: the relation-does-not-exist errors should stop."
