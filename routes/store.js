const express = require("express");
const auth = require("../middleware/auth");
const Item = require("../models/Item");
const User = require("../models/User");

const router = express.Router();

// ── GET /api/store — items grouped by name (gender-filtered, paginated) ──
router.get("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("gender inventory").lean();
    if (!user) return res.status(404).json({ message: "User not found." });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const category = (req.query.category || "").trim();

    const matchFilter = { storeType: "normal" };

    // Gender filter: show items matching player's gender or gender-neutral items
    if (user.gender) {
      matchFilter.$or = [
        { gender: user.gender },
        { gender: null },
        { gender: { $exists: false } },
      ];
    }

    if (category) matchFilter.category = category;

    const pipeline = [
      { $match: matchFilter },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: { name: "$name", category: "$category", subcategory: "$subcategory" },
          variants: { $push: { _id: "$_id", name: "$name", thumbnailUrl: "$thumbnailUrl", imageUrl: "$imageUrl", category: "$category", subcategory: "$subcategory", gender: "$gender" } },
          firstCreatedAt: { $min: "$createdAt" },
          rarity: { $first: "$rarity" },
          notes: { $first: "$notes" },
          levelRequirement: { $first: "$levelRequirement" },
        },
      },
      { $sort: { firstCreatedAt: -1 } },
      {
        $facet: {
          groups: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const [result] = await Item.aggregate(pipeline);
    const groups = (result?.groups || []).map((g) => ({
      name: g._id.name,
      category: g._id.category,
      subcategory: g._id.subcategory,
      rarity: g.rarity || null,
      notes: g.notes || "",
      levelRequirement: g.levelRequirement ?? null,
      variants: g.variants,
    }));

    const total = result?.totalCount?.[0]?.count || 0;
    const ownedSet = new Set((user.inventory || []).map(String));

    res.json({
      groups,
      total,
      page,
      hasMore: page * limit < total,
      ownedIds: [...ownedSet],
    });
  } catch (err) {
    console.error("Store fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── GET /api/store/inventory — player's owned items ──
router.get("/inventory", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("inventory").lean();
    if (!user) return res.status(404).json({ message: "User not found." });

    const items = await Item.find({ _id: { $in: user.inventory || [] } })
      .select("name category subcategory imageUrl thumbnailUrl gender")
      .lean();

    res.json({ items });
  } catch (err) {
    console.error("Inventory fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/store/purchase — buy items ──
router.post("/purchase", auth, async (req, res) => {
  try {
    const { itemIds, currency } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ message: "itemIds array is required." });
    }
    if (!["coins", "gems"].includes(currency)) {
      return res.status(400).json({ message: "currency must be 'coins' or 'gems'." });
    }

    const user = await User.findById(req.userId).select("coins gems inventory");
    if (!user) return res.status(404).json({ message: "User not found." });

    // Validate items exist and are in the store
    const items = await Item.find({ _id: { $in: itemIds }, storeType: "normal" }).lean();
    if (items.length !== itemIds.length) {
      return res.status(400).json({ message: "One or more items are not available in the store." });
    }

    // Check not already owned
    const ownedSet = new Set((user.inventory || []).map(String));
    const alreadyOwned = itemIds.filter((id) => ownedSet.has(String(id)));
    if (alreadyOwned.length > 0) {
      return res.status(400).json({ message: "You already own one or more of these items." });
    }

    // Each item costs 1 coin or 1 gem
    const cost = itemIds.length;
    if (currency === "coins" && user.coins < cost) {
      return res.status(400).json({ message: `Not enough coins. Need ${cost}, have ${user.coins}.` });
    }
    if (currency === "gems" && user.gems < cost) {
      return res.status(400).json({ message: `Not enough gems. Need ${cost}, have ${user.gems}.` });
    }

    // Deduct cost and add to inventory
    const update = {
      $push: { inventory: { $each: itemIds } },
    };
    if (currency === "coins") update.$inc = { coins: -cost };
    else update.$inc = { gems: -cost };

    const updated = await User.findByIdAndUpdate(req.userId, update, { new: true })
      .select("coins gems inventory")
      .lean();

    res.json({
      success: true,
      coins: updated.coins,
      gems: updated.gems,
      purchasedIds: itemIds,
    });
  } catch (err) {
    console.error("Purchase error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
