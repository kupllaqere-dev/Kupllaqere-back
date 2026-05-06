const express = require("express");
const auth = require("../middleware/auth");
const supabase = require("../lib/supabase");

const router = express.Router();

// ── GET /api/store ─────────────────────────────────────────
router.get("/", auth, async (req, res) => {
  try {
    const { data: profile, error: pErr } = await supabase
      .from("profiles")
      .select("gender")
      .eq("id", req.userId)
      .single();
    if (pErr || !profile) return res.status(404).json({ message: "User not found." });

    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const limit    = 50;
    const category = (req.query.category || "").trim();

    // Fetch store items filtered by gender and optionally category
    let query = supabase
      .from("items")
      .select("*")
      .eq("store_type", "normal")
      .order("created_at", { ascending: true });

    if (profile.gender) {
      query = query.or(`gender.eq.${profile.gender},gender.is.null`);
    }
    if (category) query = query.eq("category", category);

    const { data: allItems, error: itemsErr } = await query;
    if (itemsErr) throw itemsErr;

    // Group by name + category + subcategory (JavaScript-side aggregation)
    const groupMap = new Map();
    for (const item of allItems || []) {
      const key = `${item.name}||${item.category}||${item.subcategory}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          name:             item.name,
          category:         item.category,
          subcategory:      item.subcategory,
          rarity:           item.rarity || null,
          notes:            item.notes || "",
          levelRequirement: item.level_requirement ?? null,
          coinPrice:        item.coin_price ?? null,
          gemPrice:         item.gem_price ?? null,
          firstCreatedAt:   item.created_at,
          variants:         [],
        });
      }
      const group = groupMap.get(key);
      group.variants.push({
        _id:          item.id,
        name:         item.name,
        thumbnailUrl: item.thumbnail_url,
        imageUrl:     item.image_url,
        category:     item.category,
        subcategory:  item.subcategory,
        gender:       item.gender,
      });
      // Keep earliest createdAt for sort
      if (item.created_at < group.firstCreatedAt) group.firstCreatedAt = item.created_at;
    }

    // Sort newest-first (by first variant creation time)
    const sorted = Array.from(groupMap.values()).sort(
      (a, b) => new Date(b.firstCreatedAt) - new Date(a.firstCreatedAt)
    );

    const total  = sorted.length;
    const groups = sorted.slice((page - 1) * limit, page * limit).map(({ firstCreatedAt, ...g }) => g);

    // Get owned item IDs
    const { data: inventoryRows } = await supabase
      .from("inventory")
      .select("item_id")
      .eq("user_id", req.userId);
    const ownedIds = (inventoryRows || []).map((r) => r.item_id);

    res.json({
      groups,
      total,
      page,
      hasMore:  page * limit < total,
      ownedIds,
    });
  } catch (err) {
    console.error("Store fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── GET /api/store/inventory ──────────────────────────────
router.get("/inventory", auth, async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from("inventory")
      .select(`
        id,
        item_id,
        currency,
        amount_paid,
        acquired_at,
        items (
          id,
          name,
          category,
          subcategory,
          image_url,
          thumbnail_url,
          gender,
          level_requirement
        )
      `)
      .eq("user_id", req.userId);
    if (error) throw error;

    const items = (rows || [])
      .filter((r) => r.items)
      .map((r) => ({
        _id:              r.id,
        itemId:           r.item_id,
        currency:         r.currency,
        amountPaid:       r.amount_paid,
        acquiredAt:       r.acquired_at,
        name:             r.items.name,
        category:         r.items.category,
        subcategory:      r.items.subcategory,
        imageUrl:         r.items.image_url,
        thumbnailUrl:     r.items.thumbnail_url,
        gender:           r.items.gender,
        levelRequirement: r.items.level_requirement ?? null,
      }));

    res.json({ items });
  } catch (err) {
    console.error("Inventory fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/store/purchase ──────────────────────────────
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

    const { data: profile, error: pErr } = await supabase
      .from("profiles")
      .select("coins, gems")
      .eq("id", req.userId)
      .single();
    if (pErr || !profile) return res.status(404).json({ message: "User not found." });

    const itemIds = purchaseItems.map((pi) => pi.id);

    const { data: dbItems, error: iErr } = await supabase
      .from("items")
      .select("id, name, coin_price, gem_price, store_type")
      .in("id", itemIds)
      .eq("store_type", "normal");
    if (iErr) throw iErr;

    const dbItemIds = new Set((dbItems || []).map((i) => i.id));
    const missing   = itemIds.filter((id) => !dbItemIds.has(id));
    if (missing.length > 0) {
      return res.status(400).json({ message: "One or more items are not available in the store." });
    }

    const itemMap = new Map((dbItems || []).map((i) => [i.id, i]));
    let totalCoins = 0;
    let totalGems  = 0;

    for (const pi of purchaseItems) {
      const item = itemMap.get(pi.id);
      if (!item) continue;
      if (pi.currency === "coins") {
        if (item.coin_price === null || item.coin_price === undefined) {
          return res.status(400).json({ message: `"${item.name}" has no coin price.` });
        }
        totalCoins += item.coin_price;
      } else {
        if (item.gem_price === null || item.gem_price === undefined) {
          return res.status(400).json({ message: `"${item.name}" has no gem price.` });
        }
        totalGems += item.gem_price;
      }
    }

    if (profile.coins < totalCoins) {
      return res.status(400).json({ message: `Not enough coins. Need ${totalCoins}, have ${profile.coins}.` });
    }
    if (profile.gems < totalGems) {
      return res.status(400).json({ message: `Not enough gems. Need ${totalGems}, have ${profile.gems}.` });
    }

    // Deduct currency
    const currencyUpdate = {};
    if (totalCoins > 0) currencyUpdate.coins = profile.coins - totalCoins;
    if (totalGems  > 0) currencyUpdate.gems  = profile.gems  - totalGems;

    // Insert inventory entries
    const inventoryInserts = purchaseItems.map((pi) => {
      const item = itemMap.get(pi.id);
      return {
        user_id:     req.userId,
        item_id:     pi.id,
        currency:    pi.currency,
        amount_paid: pi.currency === "coins" ? item.coin_price : item.gem_price,
      };
    });

    await Promise.all([
      Object.keys(currencyUpdate).length
        ? supabase.from("profiles").update(currencyUpdate).eq("id", req.userId)
        : Promise.resolve(),
      supabase.from("inventory").insert(inventoryInserts),
    ]);

    const { data: updated } = await supabase
      .from("profiles")
      .select("coins, gems")
      .eq("id", req.userId)
      .single();

    res.json({ success: true, coins: updated.coins, gems: updated.gems, purchasedIds: itemIds });
  } catch (err) {
    console.error("Purchase error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── GET /api/store/wishlist ───────────────────────────────
router.get("/wishlist", auth, async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from("wishlist")
      .select(`
        id,
        item_id,
        added_at,
        items (
          id,
          name,
          category,
          subcategory,
          image_url,
          thumbnail_url,
          store_type,
          rarity
        )
      `)
      .eq("user_id", req.userId)
      .order("added_at", { ascending: false });
    if (error) throw error;

    const items = (rows || [])
      .filter((r) => r.items)
      .map((r) => ({
        wishlistId:  r.id,
        itemId:      r.item_id,
        addedAt:     r.added_at,
        name:        r.items.name,
        category:    r.items.category,
        subcategory: r.items.subcategory,
        imageUrl:    r.items.image_url,
        thumbnailUrl: r.items.thumbnail_url,
        storeType:   r.items.store_type,
        rarity:      r.items.rarity || null,
      }));

    res.json({ items });
  } catch (err) {
    console.error("Wishlist fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/store/wishlist ──────────────────────────────
router.post("/wishlist", auth, async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ message: "itemId is required." });

    const { error } = await supabase
      .from("wishlist")
      .insert({ user_id: req.userId, item_id: itemId });
    if (error) {
      if (error.code === "23505") return res.json({ success: true }); // already wishlisted
      throw error;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Wishlist add error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── DELETE /api/store/wishlist/:itemId ────────────────────
router.delete("/wishlist/:itemId", auth, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { error } = await supabase
      .from("wishlist")
      .delete()
      .eq("user_id", req.userId)
      .eq("item_id", itemId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("Wishlist remove error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
