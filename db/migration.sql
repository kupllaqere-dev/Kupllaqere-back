-- ============================================================
-- fv-game-back — Supabase migration
-- Run this in the Supabase SQL editor (Project → SQL Editor)
-- Safe to re-run: uses IF NOT EXISTS guards throughout
-- ============================================================


-- ── 1. profiles ──────────────────────────────────────────────
-- email is populated automatically by the trigger below (§9).
-- Do NOT set it manually from the backend.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS email         TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS role          TEXT        NOT NULL DEFAULT 'player',
  ADD COLUMN IF NOT EXISTS roles         JSONB       NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS is_guest      BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_banned     BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customization JSONB       NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS bio           TEXT        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS selected_badge TEXT,
  ADD COLUMN IF NOT EXISTS avatar        TEXT        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS level         INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS coins         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gems          INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();


-- ── 2. friendships ───────────────────────────────────────────
-- Table already has user_id / friend_id.
-- Add status (pending | accepted) and surrogate PK if missing.
ALTER TABLE friendships
  ADD COLUMN IF NOT EXISTS id         UUID        DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS status     TEXT        NOT NULL DEFAULT 'accepted',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'friendships' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE friendships ADD PRIMARY KEY (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_friendships_user_id   ON friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend_id ON friendships(friend_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status    ON friendships(status);


-- ── 3. soulmates ─────────────────────────────────────────────
-- Table already has user_id / partner_id.
-- Add status so pending requests are stored here (not a separate table).
ALTER TABLE soulmates
  ADD COLUMN IF NOT EXISTS id         UUID        DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS status     TEXT        NOT NULL DEFAULT 'accepted',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'soulmates' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE soulmates ADD PRIMARY KEY (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_soulmates_user_id    ON soulmates(user_id);
CREATE INDEX IF NOT EXISTS idx_soulmates_partner_id ON soulmates(partner_id);
CREATE INDEX IF NOT EXISTS idx_soulmates_status     ON soulmates(status);


-- ── 4. items ─────────────────────────────────────────────────
-- Existing columns (type, image_path, creator_id) are left untouched.
-- New columns are added alongside them for the code to use.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS category          TEXT,
  ADD COLUMN IF NOT EXISTS subcategory       TEXT,
  ADD COLUMN IF NOT EXISTS gender            TEXT,
  ADD COLUMN IF NOT EXISTS image_url         TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_url     TEXT        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS store_type        TEXT,
  ADD COLUMN IF NOT EXISTS rarity            TEXT,
  ADD COLUMN IF NOT EXISTS notes             TEXT        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS level_requirement INTEGER,
  ADD COLUMN IF NOT EXISTS coin_price        INTEGER,
  ADD COLUMN IF NOT EXISTS gem_price         INTEGER,
  ADD COLUMN IF NOT EXISTS uploaded_by       UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_items_category    ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_store_type  ON items(store_type);
CREATE INDEX IF NOT EXISTS idx_items_uploaded_by ON items(uploaded_by);


-- ── 5. inventory ─────────────────────────────────────────────
-- Assumes table already has user_id and item_id columns.
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS id          UUID        DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'inventory' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE inventory ADD PRIMARY KEY (id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'inventory' AND constraint_name = 'inventory_item_id_fkey'
  ) THEN
    ALTER TABLE inventory
      ADD CONSTRAINT inventory_item_id_fkey
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_user_id ON inventory(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_item_id ON inventory(item_id);


-- ── 6. mail (new table) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  UUID        NOT NULL,
  from_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  to_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject    TEXT        NOT NULL DEFAULT '',
  body       TEXT        NOT NULL,
  read       BOOLEAN     NOT NULL DEFAULT false,
  parent_id  UUID        REFERENCES mail(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Rename is_read → read if this table was created before this fix
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mail' AND column_name = 'is_read'
  ) THEN
    ALTER TABLE mail RENAME COLUMN is_read TO read;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mail_to_id     ON mail(to_id);
CREATE INDEX IF NOT EXISTS idx_mail_from_id   ON mail(from_id);
CREATE INDEX IF NOT EXISTS idx_mail_thread_id ON mail(thread_id);


-- ── 7. guestbook_comments (new table) ────────────────────────
CREATE TABLE IF NOT EXISTS guestbook_comments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_user_id UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  author_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  author_name     TEXT        NOT NULL,
  message         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guestbook_profile ON guestbook_comments(profile_user_id);
CREATE INDEX IF NOT EXISTS idx_guestbook_author  ON guestbook_comments(author_id);


-- ── 8. submissions (new table) ────────────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  group_code   TEXT,
  gender       TEXT,
  category     TEXT        NOT NULL,
  subcategory  TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending',
  admin_note   TEXT,
  uploaded_by  UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  is_set       BOOLEAN     NOT NULL DEFAULT false,
  set_code     TEXT,
  set_position INTEGER,
  variants     JSONB       NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add group_code if table already existed without it
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS group_code TEXT;
CREATE INDEX IF NOT EXISTS idx_submissions_status   ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_set_code ON submissions(set_code);


-- ── 9. Profile auto-creation trigger ─────────────────────────
-- Fires whenever a new user signs up (email/password OR Google OAuth).
-- Creates the profiles row automatically — no manual insert needed.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();


-- ── 10. Email sync trigger ────────────────────────────────────
-- Keeps profiles.email in sync if the user changes their email in Supabase Auth.
CREATE OR REPLACE FUNCTION public.handle_user_email_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles SET email = NEW.email WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_email_updated ON auth.users;
CREATE TRIGGER on_auth_user_email_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_user_email_update();
