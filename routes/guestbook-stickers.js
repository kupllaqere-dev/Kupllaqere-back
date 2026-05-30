const express  = require("express");
const auth     = require("../middleware/auth");
const supabase = require("../lib/supabase");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s) => typeof s === "string" && UUID_RE.test(s);

const MAX_STICKERS = 100;

// Valid sticker asset IDs — must stay in sync with StickerAssets.js
const VALID_ASSET_IDS = new Set([
  "heart_pink", "heart_sparkle", "heart_ribbon", "kiss_mark",
  "star_yellow", "shooting_star", "sparkles", "magic_wand",
  "cherry_blossom", "rose", "rainbow", "four_leaf", "butterfly",
  "crescent_moon", "sun",
  "cat_face", "crown", "bow", "gem", "balloon",
  "birthday_cake", "lollipop", "strawberry", "cherry",
  "fire", "musical_note", "diamond_suit",
]);

// ── GET /api/guestbook-stickers/:profileUserId ────────────────────────────
// Returns all finalized stickers for the given profile's guestbook.
router.get("/:profileUserId", auth, async (req, res) => {
  try {
    const { profileUserId } = req.params;
    if (!isUUID(profileUserId))
      return res.status(400).json({ message: "Invalid profile user ID" });

    // Look up guestbook (may not exist yet — return empty list)
    const { data: gb } = await supabase
      .from("guestbooks")
      .select("id")
      .eq("profile_user_id", profileUserId)
      .maybeSingle();

    if (!gb) return res.json({ stickers: [] });

    const { data: stickers, error } = await supabase
      .from("guestbook_stickers")
      .select("*")
      .eq("guestbook_id", gb.id)
      .eq("placement_finalized", true)
      .order("z_index", { ascending: true });

    if (error) throw error;
    res.json({ stickers: stickers || [] });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// ── DELETE /api/guestbook-stickers/sticker/:stickerId ────────────────────
// Deletes a sticker. Caller must be the sticker's placer OR the profile owner.
router.delete("/sticker/:stickerId", auth, async (req, res) => {
  try {
    const { stickerId } = req.params;
    if (!isUUID(stickerId))
      return res.status(400).json({ message: "Invalid sticker ID" });

    const { data: sticker, error: fetchErr } = await supabase
      .from("guestbook_stickers")
      .select("id, guestbook_id, placed_by_user_id")
      .eq("id", stickerId)
      .maybeSingle();

    if (fetchErr || !sticker)
      return res.status(404).json({ message: "Sticker not found" });

    // Resolve profile owner
    const { data: gb } = await supabase
      .from("guestbooks")
      .select("profile_user_id")
      .eq("id", sticker.guestbook_id)
      .single();

    const isPlacer = String(sticker.placed_by_user_id) === String(req.userId);
    const isOwner  = gb && String(gb.profile_user_id)  === String(req.userId);

    if (!isPlacer && !isOwner)
      return res.status(403).json({ message: "Not authorized to delete this sticker" });

    const { error: delErr } = await supabase
      .from("guestbook_stickers")
      .delete()
      .eq("id", stickerId);

    if (delErr) throw delErr;
    res.json({ ok: true });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = { router, VALID_ASSET_IDS, MAX_STICKERS };
