-- Migration: add presence_status to profiles
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query)

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS presence_status TEXT NOT NULL DEFAULT 'online'
    CHECK (presence_status IN ('online', 'away', 'invisible'));
