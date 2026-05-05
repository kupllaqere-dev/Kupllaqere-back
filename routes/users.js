const express = require("express");
const supabase = require("../lib/supabase");

const router = express.Router();

function extractOutfit(customization) {
  const outfit = {};
  if (!customization) return outfit;
  for (const [cat, subs] of Object.entries(customization)) {
    if (!subs || typeof subs !== "object") continue;
    for (const sub of Object.keys(subs)) {
      const url = subs[sub];
      if (url) {
        outfit[cat] = { imageUrl: url };
        break;
      }
    }
  }
  return outfit;
}

// GET /api/users/appearance/:name — public appearance data by player name
router.get("/appearance/:name", async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("profiles")
      .select("gender, customization")
      .ilike("name", req.params.name)
      .maybeSingle();

    if (error) throw error;
    if (!user) return res.status(404).json({ message: "User not found." });

    res.json({ gender: user.gender, outfit: extractOutfit(user.customization) });
  } catch (err) {
    console.error("Appearance lookup error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
