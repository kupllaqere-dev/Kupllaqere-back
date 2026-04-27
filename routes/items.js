const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const auth = require("../middleware/auth");
const Item = require("../models/Item");
const Submission = require("../models/Submission");
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

    // Generate thumbnail: crop at x:0 y:4616 w:510 h:510, resize to 256x256
    const thumbnailBuffer = await sharp(req.file.buffer)
      .extract({ left: 0, top: 4616, width: 510, height: 510 })
      .resize(256, 256)
      .png()
      .toBuffer();

    // Upload full image and thumbnail to S3 in parallel
    const key          = `items/${item._id}.png`;
    const thumbnailKey = `item-thumbnails/${item._id}.png`;
    await Promise.all([
      s3.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: "image/png",
      })),
      s3.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: thumbnailKey,
        Body: thumbnailBuffer,
        ContentType: "image/png",
      })),
    ]);

    const base = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    item.imageUrl     = `${base}/${key}`;
    item.thumbnailUrl = `${base}/${thumbnailKey}`;
    await item.save();

    res.status(201).json({
      item: {
        id: item._id,
        name: item.name,
        category: item.category,
        subcategory: item.subcategory,
        imageUrl: item.imageUrl,
        thumbnailUrl: item.thumbnailUrl,
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

// ── POST /api/items/submit — submit item group (up to 10 color variants) ──
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

    const groupCode = uuidv4();
    const submission = new Submission({
      name: name.trim(),
      groupCode,
      category,
      subcategory,
      gender,
      variants: [],
      uploadedBy: req.userId,
    });

    const base = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;

    const uploadTasks = variantEntries.map(async ({ index, file, color }) => {
      const thumbnailBuffer = await sharp(file.buffer)
        .extract({ left: 0, top: 4616, width: 510, height: 510 })
        .resize(256, 256)
        .png()
        .toBuffer();

      const imgKey   = `submissions/${submission._id}/variant-${index}.png`;
      const thumbKey = `submission-thumbnails/${submission._id}/variant-${index}.png`;

      await Promise.all([
        s3.send(new PutObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: imgKey, Body: file.buffer, ContentType: "image/png" })),
        s3.send(new PutObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: thumbKey, Body: thumbnailBuffer, ContentType: "image/png" })),
      ]);

      return { index, color, imageUrl: `${base}/${imgKey}`, thumbnailUrl: `${base}/${thumbKey}` };
    });

    const uploaded = await Promise.all(uploadTasks);
    uploaded.sort((a, b) => a.index - b.index);
    submission.variants = uploaded.map(({ color, imageUrl, thumbnailUrl }) => ({ color, imageUrl, thumbnailUrl }));
    await submission.save();

    res.status(201).json({
      submission: { id: submission._id, groupCode, name: submission.name, variantCount: submission.variants.length },
    });
  } catch (err) {
    console.error("Submission error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
