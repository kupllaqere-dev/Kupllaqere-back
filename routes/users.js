const express = require("express");
const supabase = require("../lib/supabase");

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

module.exports = router;
