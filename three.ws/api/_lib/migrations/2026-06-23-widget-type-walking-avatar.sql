-- Migration: extend widgets.type CHECK constraint with the walking-avatar widget
-- type (a roaming 3D avatar served from the chrome-less /walk-embed iframe) and
-- backfill bonding-curve, which already shipped a runtime + demo fixture but was
-- never added to the DB constraint or the server enum — so saving one failed.
-- Apply: npm run db:migrate -- --apply --file 2026-06-23-widget-type-walking-avatar.sql
-- Idempotent.

begin;

alter table widgets
    drop constraint if exists widgets_type_check;

alter table widgets
    add constraint widgets_type_check
    check (type in (
        'turntable',
        'animation-gallery',
        'talking-agent',
        'passport',
        'hotspot-tour',
        'pumpfun-feed',
        'kol-trades',
        'live-trades-canvas',
        'bonding-curve',
        'walking-avatar'
    ));

commit;
