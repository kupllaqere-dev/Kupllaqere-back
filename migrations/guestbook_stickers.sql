-- Sticker Guestbook schema
-- Run this in your Supabase SQL editor (Database > SQL Editor)

-- ── guestbooks ──────────────────────────────────────────────────────────────
-- One guestbook per user profile. Auto-created on first sticker placement.
create table if not exists guestbooks (
  id              uuid primary key default gen_random_uuid(),
  profile_user_id uuid not null references profiles(id) on delete cascade,
  created_at      timestamptz not null default now(),
  constraint guestbooks_profile_user_id_unique unique (profile_user_id)
);

create index if not exists guestbooks_profile_user_id_idx
  on guestbooks(profile_user_id);

-- ── guestbook_stickers ───────────────────────────────────────────────────────
-- Each row is one permanently placed sticker on a guestbook canvas.
-- Positions are stored as normalized floats (0.0–1.0) so they are
-- resolution-independent. placement_finalized is always true for saved rows;
-- the column exists for future draft-save scenarios.
create table if not exists guestbook_stickers (
  id                  uuid    primary key default gen_random_uuid(),
  guestbook_id        uuid    not null references guestbooks(id) on delete cascade,
  placed_by_user_id   uuid    not null references profiles(id)   on delete cascade,
  placed_by_name      text    not null default '',
  sticker_asset_id    text    not null,
  -- Normalized canvas coordinates in [0, 1]
  x                   float8  not null check (x >= 0 and x <= 1),
  y                   float8  not null check (y >= 0 and y <= 1),
  rotation            float8  not null default 0,
  scale               float8  not null default 1 check (scale > 0 and scale <= 3),
  z_index             int     not null default 0,
  -- Saved rows are always finalized; column reserved for future use
  placement_finalized boolean not null default true,
  created_at          timestamptz not null default now()
);

create index if not exists guestbook_stickers_guestbook_id_idx
  on guestbook_stickers(guestbook_id);

create index if not exists guestbook_stickers_placed_by_idx
  on guestbook_stickers(placed_by_user_id);

-- Disable RLS; all access goes through the authenticated backend service role.
alter table guestbooks        disable row level security;
alter table guestbook_stickers disable row level security;
