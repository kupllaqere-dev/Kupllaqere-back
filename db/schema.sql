-- ============================================================
-- Supabase PostgreSQL Schema for fv-game-back
-- Run this in the Supabase SQL editor after creating your project
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── profiles ──────────────────────────────────────────────
-- Extends auth.users. One row per user.
CREATE TABLE profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT DEFAULT '',
  email           TEXT,
  gender          TEXT DEFAULT 'female' CHECK (gender IN ('male', 'female')),
  avatar          TEXT DEFAULT '',
  bio             TEXT DEFAULT '' CHECK (char_length(bio) <= 500),
  selected_badge  TEXT CHECK (selected_badge IN ('diamond', 'flame', 'medal', 'paint', 'verified')),
  is_guest        BOOLEAN DEFAULT FALSE,
  is_banned       BOOLEAN DEFAULT FALSE,
  role            TEXT DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  roles           TEXT[] DEFAULT '{}',
  google_id       TEXT UNIQUE,
  level           INTEGER DEFAULT 1,
  coins           INTEGER DEFAULT 0,
  gems            INTEGER DEFAULT 0,
  soul_mate       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  customization   JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Unique case-insensitive name index (enforces unique display names)
CREATE UNIQUE INDEX profiles_name_lower_idx ON profiles (lower(name)) WHERE name <> '';

-- ── items ─────────────────────────────────────────────────
CREATE TABLE items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL CHECK (char_length(name) <= 40),
  gender            TEXT CHECK (gender IN ('male', 'female')),
  category          TEXT NOT NULL,
  subcategory       TEXT NOT NULL,
  image_url         TEXT NOT NULL DEFAULT '',
  thumbnail_url     TEXT DEFAULT '',
  store_type        TEXT CHECK (store_type IN ('normal')),
  rarity            TEXT CHECK (rarity IN ('nonRare', 'rare', 'superRare')),
  notes             TEXT DEFAULT '',
  level_requirement INTEGER,
  coin_price        INTEGER,
  gem_price         INTEGER,
  uploaded_by       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX items_category_idx ON items (category);
CREATE INDEX items_store_type_idx ON items (store_type);
CREATE INDEX items_name_category_idx ON items (name, category);

-- ── inventory ─────────────────────────────────────────────
CREATE TABLE inventory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id     UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  currency    TEXT NOT NULL CHECK (currency IN ('coins', 'gems')),
  amount_paid INTEGER NOT NULL,
  acquired_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX inventory_user_id_idx ON inventory (user_id);

-- ── friendships ───────────────────────────────────────────
-- One row per relationship. requester_id sent the request.
-- status: 'pending' = request sent, 'accepted' = friends
CREATE TABLE friendships (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);

CREATE INDEX friendships_addressee_idx ON friendships (addressee_id);
CREATE INDEX friendships_requester_idx ON friendships (requester_id);

-- ── soulmate_requests ─────────────────────────────────────
-- Tracks pending soul mate proposals. from_id → to_id.
-- Each user can only have one outgoing request (enforced in app logic).
CREATE TABLE soulmate_requests (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  to_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (from_id, to_id),
  CHECK (from_id <> to_id)
);

CREATE INDEX soulmate_requests_to_idx ON soulmate_requests (to_id);

-- ── submissions ───────────────────────────────────────────
-- Creator-submitted items awaiting admin approval.
-- variants stored as JSONB: [{ color, imageUrl, thumbnailUrl }]
CREATE TABLE submissions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL CHECK (char_length(name) <= 40),
  group_code   TEXT UNIQUE NOT NULL,
  category     TEXT NOT NULL,
  subcategory  TEXT NOT NULL,
  gender       TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  variants     JSONB DEFAULT '[]',
  uploaded_by  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  admin_note   TEXT,
  set_code     TEXT,
  is_set       BOOLEAN DEFAULT FALSE,
  set_position INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX submissions_uploaded_by_idx ON submissions (uploaded_by);
CREATE INDEX submissions_set_code_idx ON submissions (set_code);
CREATE INDEX submissions_status_idx ON submissions (status);

-- ── mail ──────────────────────────────────────────────────
-- Thread-based messaging. thread_id groups messages in a conversation.
CREATE TABLE mail (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id TEXT NOT NULL,
  from_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  to_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  subject   TEXT NOT NULL CHECK (char_length(subject) <= 100),
  body      TEXT NOT NULL CHECK (char_length(body) <= 2000),
  read      BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX mail_thread_id_idx ON mail (thread_id);
CREATE INDEX mail_to_id_idx ON mail (to_id);
CREATE INDEX mail_from_id_idx ON mail (from_id);

-- ── guestbook_comments ────────────────────────────────────
CREATE TABLE guestbook_comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  author_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  author_name     TEXT NOT NULL,
  message         TEXT NOT NULL CHECK (char_length(message) <= 100),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX guestbook_profile_user_id_idx ON guestbook_comments (profile_user_id);

-- ============================================================
-- Row Level Security (RLS)
-- All tables: service_role bypasses RLS (used by the Express server).
-- These policies allow the Supabase dashboard and direct DB access
-- to work, but the Express backend always uses the service_role key
-- which bypasses RLS entirely.
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE soulmate_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail ENABLE ROW LEVEL SECURITY;
ALTER TABLE guestbook_comments ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically.
-- Add permissive policies if you want anon/authenticated dashboard reads:
-- CREATE POLICY "service_role_all" ON profiles USING (true);
