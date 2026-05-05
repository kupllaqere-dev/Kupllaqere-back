-- Run this in Supabase SQL Editor to remove the google_id column.
-- Safe to run even if the column doesn't exist yet.
ALTER TABLE profiles DROP COLUMN IF EXISTS google_id;
