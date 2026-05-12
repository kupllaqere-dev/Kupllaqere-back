const express = require("express");
const supabase = require("../lib/supabase");
const online   = require("../lib/online");

const router = express.Router();

// GET /api/users/appearance/:name — public appearance data by player name
router.get("/appearance/:name", async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("profiles")
      .select("id, gender")
      .ilike("name", req.params.name)
      .maybeSingle();

    if (error) throw error;
    if (!user) return res.status(404).json({ message: "User not found." });

    const { data: equippedRows } = await supabase
      .from("equipped_items")
      .select("slot, item_id")
      .eq("user_id", user.id);

    const outfit = {};
    if (equippedRows && equippedRows.length > 0) {
      const itemIds = equippedRows.map((r) => r.item_id);
      const { data: items } = await supabase
        .from("items")
        .select("id, image_url")
        .in("id", itemIds);
      const itemMap = new Map((items || []).map((i) => [i.id, i.image_url]));
      for (const row of equippedRows) {
        const imageUrl = itemMap.get(row.item_id);
        if (imageUrl) outfit[row.slot] = { imageUrl };
      }
    }

    res.json({ gender: user.gender, outfit });
  } catch (err) {
    console.error("Appearance lookup error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/users/:id/status — returns effective presence status and manual preference
router.get("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;

    if (online.isOnline(id)) {
      return res.json({
        status:       online.getEffectiveStatus(id),
        manualStatus: online.getManualStatus(id),
      });
    }

    // User is offline — check DB for their saved manual preference
    const { data: profile } = await supabase
      .from("profiles")
      .select("presence_status")
      .eq("id", id)
      .maybeSingle();

    res.json({
      status:       "offline",
      manualStatus: profile?.presence_status || "online",
    });
  } catch (err) {
    console.error("Status fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/users/:id/profile-view — public, returns saved avatar pose/zoom/pan
router.get("/:id/profile-view", async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("profile_view_locked, profile_pose_index, profile_zoom_index, profile_pan_x, profile_pan_y, profile_theme")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!profile) return res.status(404).json({ message: "User not found." });

    res.json({
      locked:    profile.profile_view_locked ?? false,
      poseIndex: profile.profile_pose_index  ?? 0,
      zoomIndex: profile.profile_zoom_index  ?? 0,
      panX:      profile.profile_pan_x       ?? 0,
      panY:      profile.profile_pan_y       ?? 0,
      themeName: profile.profile_theme       ?? "Violet Dream",
    });
  } catch (err) {
    console.error("Profile view fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
