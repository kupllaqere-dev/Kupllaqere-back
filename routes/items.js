const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const auth = require("../middleware/auth");
const supabase = require("../lib/supabase");
const { uploadFile } = require("../lib/storage");
const { CATEGORY_SUBCATEGORIES, VALID_SLOTS } = require("../lib/categories");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC);
}

// POST /api/items/upload
router.post("/upload", auth, upload.single("image"), async (req, res) => {
  try {
    const { name, category, subcategory } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ message: "Name is required." });
    if (name.trim().length > 40) return res.status(400).json({ message: "Name must be 40 characters or fewer." });

    const allowedSubs = CATEGORY_SUBCATEGORIES[category];
    if (!allowedSubs) return res.status(400).json({ message: "Invalid category." });
    if (!allowedSubs.includes(subcategory)) {
      return res.status(400).json({ message: `Invalid subcategory for "${category}". Allowed: ${allowedSubs.join(", ")}` });
    }

    if (!req.file) return res.status(400).json({ message: "Image file is required." });
    if (!isPng(req.file.buffer)) return res.status(400).json({ message: "Image must be a valid PNG file." });

    const itemId = uuidv4();

    const [webpBuffer, thumbnailBuffer] = await Promise.all([
      sharp(req.file.buffer).webp({ quality: 85 }).toBuffer(),
      sharp(req.file.buffer)
        .extract({ left: 0, top: 4616, width: 510, height: 510 })
        .resize(256, 256)
        .webp({ quality: 85 })
        .toBuffer(),
    ]);

    const [imageUrl, thumbnailUrl] = await Promise.all([
      uploadFile(`items/${itemId}.webp`, webpBuffer, "image/webp"),
      uploadFile(`item-thumbnails/${itemId}.webp`, thumbnailBuffer, "image/webp"),
    ]);

    const { data: item, error } = await supabase
      .from("items")
      .insert({
        id:            itemId,
        name:          name.trim(),
        category,
        subcategory,
        image_url:     imageUrl,
        thumbnail_url: thumbnailUrl,
        uploaded_by:   req.userId,
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({
      item: {
        id:           item.id,
        name:         item.name,
        category:     item.category,
        subcategory:  item.subcategory,
        imageUrl:     item.image_url,
        thumbnailUrl: item.thumbnail_url,
      },
    });
  } catch (err) {
    console.error("Item upload error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/items
router.get("/", auth, async (req, res) => {
  try {
    const { data: items, error } = await supabase.from("items").select("*").order("created_at");
    if (error) throw error;
    res.json({ items });
  } catch (err) {
    console.error("List items error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/items/outfit — get current user's equipped outfit
router.get("/outfit", auth, async (req, res) => {
  try {
    const { data: equippedRows, error } = await supabase
      .from("equipped_items")
      .select("slot, item_id, subcategory")
      .eq("user_id", req.userId);
    if (error) throw error;

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
        if (imageUrl) outfit[row.slot] = { itemId: row.item_id, imageUrl, subcategory: row.subcategory };
      }
    }

    res.json({ outfit });
  } catch (err) {
    console.error("Get outfit error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// PUT /api/items/outfit — equip outfit
router.put("/outfit", auth, async (req, res) => {
  try {
    const { outfit } = req.body;
    if (!outfit || typeof outfit !== "object") {
      return res.status(400).json({ message: "outfit object is required." });
    }

    const itemEntries = [];
    for (const [slotKey, value] of Object.entries(outfit)) {
      const slotInfo = VALID_SLOTS[slotKey];
      if (!slotInfo) {
        return res.status(400).json({ message: `Invalid slot: ${slotKey}` });
      }
      const { data: item } = await supabase
        .from("items")
        .select("id, category, subcategory, image_url")
        .eq("id", value.itemId)
        .maybeSingle();
      if (!item) return res.status(400).json({ message: `Item not found: ${value.itemId}` });
      if (item.category !== slotInfo.category) {
        return res.status(400).json({ message: `Item ${value.itemId} does not belong to category "${slotInfo.category}".` });
      }
      if (slotInfo.subcategory && item.subcategory !== slotInfo.subcategory) {
        return res.status(400).json({ message: `Item ${value.itemId} subcategory must be "${slotInfo.subcategory}".` });
      }
      if (slotInfo.subcategories && !slotInfo.subcategories.includes(item.subcategory)) {
        return res.status(400).json({ message: `Item ${value.itemId} subcategory must be one of: ${slotInfo.subcategories.join(", ")}.` });
      }
      itemEntries.push({ slotKey, item });
    }

    // Replace all equipped items for this user
    const { error: deleteErr } = await supabase.from("equipped_items").delete().eq("user_id", req.userId);
    if (deleteErr) throw deleteErr;

    if (itemEntries.length > 0) {
      const rows = itemEntries.map(({ slotKey, item }) => ({
        user_id:     req.userId,
        slot:        slotKey,
        subcategory: item.subcategory,
        item_id:     item.id,
      }));
      const { error: insertErr } = await supabase.from("equipped_items").insert(rows);
      if (insertErr) throw insertErr;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Update outfit error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/items/submit — submit item group with up to 10 color variants
const VARIANT_FIELDS = Array.from({ length: 10 }, (_, i) => ({ name: `image_${i}`, maxCount: 1 }));

router.post("/submit", auth, upload.fields(VARIANT_FIELDS), async (req, res) => {
  try {
    const { name, category, subcategory, gender } = req.body;
    let colors;
    try { colors = JSON.parse(req.body.colors || "[]"); } catch { colors = []; }

    if (!name || !name.trim()) return res.status(400).json({ message: "Name is required." });
    if (name.trim().length > 40) return res.status(400).json({ message: "Name must be 40 characters or fewer." });

    const allowedSubs = CATEGORY_SUBCATEGORIES[category];
    if (!allowedSubs) return res.status(400).json({ message: "Invalid category." });
    if (!allowedSubs.includes(subcategory)) return res.status(400).json({ message: "Invalid subcategory." });
    if (!["male", "female"].includes(gender)) return res.status(400).json({ message: "Gender must be 'male' or 'female'." });

    const files = req.files || {};
    const variantEntries = [];
    for (let i = 0; i < 10; i++) {
      const fileArr = files[`image_${i}`];
      if (!fileArr || !fileArr[0]) continue;
      const file = fileArr[0];
      if (!isPng(file.buffer)) return res.status(400).json({ message: `Image ${i + 1} is not a valid PNG.` });
      variantEntries.push({ index: i, file, color: colors[i] || "#ffffff" });
    }
    if (variantEntries.length === 0) return res.status(400).json({ message: "At least one image variant is required." });

    const submissionId = uuidv4();
    const groupCode    = uuidv4();

    const uploadTasks = variantEntries.map(async ({ index, file, color }) => {
      const variantItemId = uuidv4();

      const [webpBuffer, thumbnailBuffer] = await Promise.all([
        sharp(file.buffer).webp({ quality: 85 }).toBuffer(),
        sharp(file.buffer)
          .extract({ left: 0, top: 4616, width: 510, height: 510 })
          .resize(256, 256)
          .webp({ quality: 85 })
          .toBuffer(),
      ]);

      const [imageUrl, thumbnailUrl] = await Promise.all([
        uploadFile(`items/${variantItemId}.webp`, webpBuffer, "image/webp"),
        uploadFile(`item-thumbnails/${variantItemId}.webp`, thumbnailBuffer, "image/webp"),
      ]);

      return { index, color, itemId: variantItemId, imageUrl, thumbnailUrl };
    });

    const uploaded = await Promise.all(uploadTasks);
    uploaded.sort((a, b) => a.index - b.index);
    const variants = uploaded.map(({ color, itemId, imageUrl, thumbnailUrl }) => ({ color, itemId, imageUrl, thumbnailUrl }));

    const { data: submission, error } = await supabase
      .from("submissions")
      .insert({
        id:          submissionId,
        name:        name.trim(),
        group_code:  groupCode,
        category,
        subcategory,
        gender,
        variants,
        uploaded_by: req.userId,
      })
      .select("id, group_code, name, variants")
      .single();
    if (error) throw error;

    res.status(201).json({
      submission: {
        id:           submission.id,
        groupCode:    submission.group_code,
        name:         submission.name,
        variantCount: submission.variants.length,
      },
    });
  } catch (err) {
    console.error("Submission error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
