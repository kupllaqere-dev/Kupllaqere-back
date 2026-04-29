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
          rarity:           { $first: "$rarity" },
          notes:            { $first: "$notes" },
          levelRequirement: { $first: "$levelRequirement" },
          coinPrice:        { $first: "$coinPrice" },
          gemPrice:         { $first: "$gemPrice" },
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
      name:             g._id.name,
      category:         g._id.category,
      subcategory:      g._id.subcategory,
      rarity:           g.rarity || null,
      notes:            g.notes || "",
      levelRequirement: g.levelRequirement ?? null,
      coinPrice:        g.coinPrice ?? null,
      gemPrice:         g.gemPrice ?? null,
      variants:         g.variants,
    }));

    const total = result?.totalCount?.[0]?.count || 0;
    const ownedSet = new Set((user.inventory || []).map(e => String(e.itemId)));

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
    const user = await User.findById(req.userId)
      .select("inventory")
      .populate({ path: "inventory.itemId", select: "name category subcategory imageUrl thumbnailUrl gender levelRequirement" });
    if (!user) return res.status(404).json({ message: "User not found." });

    const items = (user.inventory || []).map(entry => {
      const item = entry.itemId;
      if (!item) return null;
      return {
        _id:              entry._id,
        itemId:           String(item._id),
        currency:         entry.currency,
        amountPaid:       entry.amountPaid,
        name:             item.name,
        category:         item.category,
        subcategory:      item.subcategory,
        imageUrl:         item.imageUrl,
        thumbnailUrl:     item.thumbnailUrl,
        gender:           item.gender,
        levelRequirement: item.levelRequirement ?? null,
      };
    }).filter(Boolean);

    res.json({ items });
  } catch (err) {
    console.error("Inventory fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/store/purchase — buy items ──
// Body: { items: [{ id, currency: "coins"|"gems" }] }
router.post("/purchase", auth, async (req, res) => {
  try {
    const { items: purchaseItems } = req.body;

    if (!Array.isArray(purchaseItems) || purchaseItems.length === 0) {
      return res.status(400).json({ message: "items array is required." });
    }
    const validCurrencies = ["coins", "gems"];
    for (const pi of purchaseItems) {
      if (!pi.id || !validCurrencies.includes(pi.currency)) {
        return res.status(400).json({ message: "Each item must have an id and currency ('coins' or 'gems')." });
      }
    }

    const user = await User.findById(req.userId).select("coins gems inventory");
    if (!user) return res.status(404).json({ message: "User not found." });

    const itemIds = purchaseItems.map((pi) => pi.id);

    // Validate items exist and are in the store
    const dbItems = await Item.find({ _id: { $in: itemIds }, storeType: "normal" }).lean();
    const dbItemIds = new Set(dbItems.map((i) => String(i._id)));
    const missingItems = itemIds.filter((id) => !dbItemIds.has(String(id)));
    if (missingItems.length > 0) {
      return res.status(400).json({ message: "One or more items are not available in the store." });
    }

    // Calculate per-currency totals using item prices
    const itemMap = new Map(dbItems.map((i) => [String(i._id), i]));
    let totalCoins = 0;
    let totalGems  = 0;

    for (const pi of purchaseItems) {
      const item = itemMap.get(String(pi.id));
      if (!item) continue;
      if (pi.currency === "coins") {
        if (item.coinPrice === null || item.coinPrice === undefined) {
          return res.status(400).json({ message: `"${item.name}" has no coin price.` });
        }
        totalCoins += item.coinPrice;
      } else {
        if (item.gemPrice === null || item.gemPrice === undefined) {
          return res.status(400).json({ message: `"${item.name}" has no gem price.` });
        }
        totalGems += item.gemPrice;
      }
    }

    if (user.coins < totalCoins) {
      return res.status(400).json({ message: `Not enough coins. Need ${totalCoins}, have ${user.coins}.` });
    }
    if (user.gems < totalGems) {
      return res.status(400).json({ message: `Not enough gems. Need ${totalGems}, have ${user.gems}.` });
    }

    // Deduct and add to inventory (one entry per purchase, recording currency and amount)
    const inventoryEntries = purchaseItems.map(pi => {
      const item = itemMap.get(String(pi.id));
      return {
        itemId:     pi.id,
        currency:   pi.currency,
        amountPaid: pi.currency === "coins" ? item.coinPrice : item.gemPrice,
      };
    });
    const updateOp = { $push: { inventory: { $each: inventoryEntries } } };
    if (totalCoins > 0 || totalGems > 0) {
      updateOp.$inc = {};
      if (totalCoins > 0) updateOp.$inc.coins = -totalCoins;
      if (totalGems  > 0) updateOp.$inc.gems  = -totalGems;
    }

    const updated = await User.findByIdAndUpdate(req.userId, updateOp, { new: true })
      .select("coins gems inventory")
      .lean();

    res.json({ success: true, coins: updated.coins, gems: updated.gems, purchasedIds: itemIds });
  } catch (err) {
    console.error("Purchase error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
