const express = require("express");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const auth = require("../middleware/auth");
const Item = require("../models/Item");
const { CATEGORY_SUBCATEGORIES } = require("../models/Item");
const User = require("../models/User");

const router = express.Router();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
});

// PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC);
}

router.post("/upload", auth, upload.single("image"), async (req, res) => {
  try {
    const { name, category, subcategory } = req.body;

    // Validate name
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Name is required." });
    }
    if (name.trim().length > 40) {
      return res.status(400).json({ message: "Name must be 40 characters or fewer." });
    }

    // Validate category
    const allowedSubs = CATEGORY_SUBCATEGORIES[category];
    if (!allowedSubs) {
      return res.status(400).json({ message: "Invalid category." });
    }

    // Validate subcategory
    if (!allowedSubs.includes(subcategory)) {
      return res.status(400).json({
        message: `Invalid subcategory for "${category}". Allowed: ${allowedSubs.join(", ")}`,
      });
    }

    // Validate image
    if (!req.file) {
      return res.status(400).json({ message: "Image file is required." });
    }
    if (!isPng(req.file.buffer)) {
      return res.status(400).json({ message: "Image must be a valid PNG file." });
    }

    // Create DB document first to get the _id
    const item = new Item({
      name: name.trim(),
      category,
      subcategory,
      imageUrl: "", // placeholder until S3 upload completes
      uploadedBy: req.userId,
    });

    // Upload to S3 using the document _id as key
    const key = `items/${item._id}.png`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: "image/png",
      }),
    );

    item.imageUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    await item.save();

    res.status(201).json({
      item: {
        id: item._id,
        name: item.name,
        category: item.category,
        subcategory: item.subcategory,
        imageUrl: item.imageUrl,
      },
    });
  } catch (err) {
    console.error("Item upload error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── GET /api/items — list all items ──
router.get("/", auth, async (req, res) => {
  try {
    const items = await Item.find().lean();
    res.json({ items });
  } catch (err) {
    console.error("List items error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── GET /api/items/outfit — get current user's equipped outfit ──
router.get("/outfit", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).lean();
    if (!user) return res.status(404).json({ message: "User not found." });

    const outfit = {};
    const customization = user.customization || {};

    for (const category of Object.keys(CATEGORY_SUBCATEGORIES)) {
      const subs = customization[category];
      if (!subs) continue;
      for (const sub of Object.keys(subs)) {
        const imageUrl = subs[sub];
        if (!imageUrl) continue;
        // Find the item by imageUrl to get the itemId
        const item = await Item.findOne({ imageUrl, category, subcategory: sub }).lean();
        if (item) {
          outfit[category] = { itemId: item._id, imageUrl };
          break; // one equipped item per category
        }
      }
    }

    res.json({ outfit });
  } catch (err) {
    console.error("Get outfit error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── PUT /api/items/outfit — equip outfit ──
router.put("/outfit", auth, async (req, res) => {
  try {
    const { outfit } = req.body;
    if (!outfit || typeof outfit !== "object") {
      return res.status(400).json({ message: "outfit object is required." });
    }

    // Validate all itemIds exist and collect item data
    const itemEntries = [];
    for (const [category, value] of Object.entries(outfit)) {
      if (!CATEGORY_SUBCATEGORIES[category]) {
        return res.status(400).json({ message: `Invalid category: ${category}` });
      }
      const item = await Item.findById(value.itemId).lean();
      if (!item) {
        return res.status(400).json({ message: `Item not found: ${value.itemId}` });
      }
      if (item.category !== category) {
        return res.status(400).json({ message: `Item ${value.itemId} is not a ${category} item.` });
      }
      itemEntries.push({ category, item });
    }

    // Build the customization update — clear all, then set equipped
    const customization = {};
    for (const category of Object.keys(CATEGORY_SUBCATEGORIES)) {
      customization[category] = {};
      for (const sub of CATEGORY_SUBCATEGORIES[category]) {
        customization[category][sub] = null;
      }
    }
    for (const { category, item } of itemEntries) {
      customization[category][item.subcategory] = item.imageUrl;
    }

    await User.findByIdAndUpdate(req.userId, { customization });
    res.json({ success: true });
  } catch (err) {
    console.error("Update outfit error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
