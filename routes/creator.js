const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const requireCreator = require("../middleware/creator");
const Submission = require("../models/Submission");
const User = require("../models/User");
const { CATEGORY_SUBCATEGORIES } = require("../models/Item");

const router = express.Router();
router.use(requireCreator);

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPng(buf) { return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC); }

const BASE_URL = () =>
  `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;

async function uploadVariant(fileBuffer, submissionId, variantIndex) {
  const thumbnailBuffer = await sharp(fileBuffer)
    .extract({ left: 0, top: 4616, width: 510, height: 510 })
    .resize(256, 256)
    .png()
    .toBuffer();

  const imgKey   = `submissions/${submissionId}/variant-${variantIndex}.png`;
  const thumbKey = `submission-thumbnails/${submissionId}/variant-${variantIndex}.png`;

  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: imgKey, Body: fileBuffer, ContentType: "image/png" })),
    s3.send(new PutObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: thumbKey, Body: thumbnailBuffer, ContentType: "image/png" })),
  ]);

  return {
    imageUrl: `${BASE_URL()}/${imgKey}`,
    thumbnailUrl: `${BASE_URL()}/${thumbKey}`,
  };
}

// ── GET /api/creator/me ────────────────────────────────────────────────────
router.get("/me", async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password").lean();
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ user: { ...user, id: String(user._id), roles: [...new Set([user.role, ...(user.roles || [])])] } });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── GET /api/creator/submissions ─────────────────────────────────────────
router.get("/submissions", async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const status = (req.query.status || "").trim();

    const filter = { uploadedBy: req.userId };
    if (["pending", "approved", "declined"].includes(status)) filter.status = status;

    const allSubs = await Submission.find(filter).sort({ createdAt: -1 }).lean();

    // Group sets by setCode
    const seen = new Set();
    const grouped = [];
    for (const sub of allSubs) {
      if (!sub.isSet) {
        grouped.push({ ...sub, id: String(sub._id) });
      } else {
        if (!seen.has(sub.setCode)) {
          seen.add(sub.setCode);
          const setItems = allSubs
            .filter((s) => s.setCode === sub.setCode)
            .sort((a, b) => (a.setPosition ?? 0) - (b.setPosition ?? 0))
            .map((s) => ({ ...s, id: String(s._id) }));
          grouped.push({
            isSet: true,
            setCode: sub.setCode,
            status: sub.status,
            adminNote: sub.adminNote,
            createdAt: sub.createdAt,
            items: setItems,
          });
        }
      }
    }

    const total = grouped.length;
    const paginated = grouped.slice((page - 1) * limit, page * limit);
    res.json({ submissions: paginated, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/creator/submit ─────────────────────────────────────────────
// Single: type=single, name, gender, category, subcategory, image_0..image_4
// Set:    type=set, gender,
//         item_0_name, item_0_category, item_0_subcategory,
//         image_0_0..image_0_4, image_1_0..image_1_4, ... (5 items × 5 variants)

const SINGLE_FIELDS = Array.from({ length: 5 }, (_, i) => ({ name: `image_${i}`, maxCount: 1 }));
const SET_FIELDS = [];
for (let item = 0; item < 5; item++) {
  for (let v = 0; v < 5; v++) {
    SET_FIELDS.push({ name: `image_${item}_${v}`, maxCount: 1 });
  }
}
const ALL_UPLOAD_FIELDS = [...SINGLE_FIELDS, ...SET_FIELDS];

router.post("/submit", upload.fields(ALL_UPLOAD_FIELDS), async (req, res) => {
  try {
    const { type, gender } = req.body;

    if (!["male", "female"].includes(gender)) {
      return res.status(400).json({ message: "Gender must be 'male' or 'female'." });
    }

    const files = req.files || {};

    if (type === "single") {
      const { name, category, subcategory } = req.body;
      if (!name?.trim()) return res.status(400).json({ message: "Name is required." });
      if (name.trim().length > 40) return res.status(400).json({ message: "Name must be 40 characters or fewer." });

      const allowedSubs = CATEGORY_SUBCATEGORIES[category];
      if (!allowedSubs) return res.status(400).json({ message: "Invalid category." });
      if (!allowedSubs.includes(subcategory)) return res.status(400).json({ message: "Invalid subcategory." });

      // Collect uploaded variant files
      const variantFiles = [];
      for (let i = 0; i < 5; i++) {
        const arr = files[`image_${i}`];
        if (arr?.[0]) variantFiles.push({ index: i, file: arr[0] });
      }
      if (variantFiles.length === 0) {
        return res.status(400).json({ message: "At least one variant image is required." });
      }
      for (const { file } of variantFiles) {
        if (!isPng(file.buffer)) return res.status(400).json({ message: "All images must be valid PNG files." });
      }

      const groupCode = uuidv4();
      const submission = new Submission({
        name: name.trim(),
        groupCode,
        category,
        subcategory,
        gender,
        variants: [],
        uploadedBy: req.userId,
        isSet: false,
      });

      const uploaded = await Promise.all(
        variantFiles.map(async ({ index, file }) => {
          const urls = await uploadVariant(file.buffer, submission._id, index);
          return { index, ...urls };
        })
      );
      uploaded.sort((a, b) => a.index - b.index);
      submission.variants = uploaded.map(({ imageUrl, thumbnailUrl }) => ({ imageUrl, thumbnailUrl }));
      await submission.save();

      return res.status(201).json({
        submission: { id: submission._id, groupCode, name: submission.name, variantCount: submission.variants.length },
      });
    }

    if (type === "set") {
      // Validate all 5 items
      const setCode = uuidv4();
      const submissions = [];

      for (let itemIdx = 0; itemIdx < 5; itemIdx++) {
        const itemName      = req.body[`item_${itemIdx}_name`];
        const itemCategory  = req.body[`item_${itemIdx}_category`];
        const itemSubcat    = req.body[`item_${itemIdx}_subcategory`];

        if (!itemName?.trim()) return res.status(400).json({ message: `Item ${itemIdx + 1}: name is required.` });
        if (itemName.trim().length > 40) return res.status(400).json({ message: `Item ${itemIdx + 1}: name too long.` });

        const allowedSubs = CATEGORY_SUBCATEGORIES[itemCategory];
        if (!allowedSubs) return res.status(400).json({ message: `Item ${itemIdx + 1}: invalid category.` });
        if (!allowedSubs.includes(itemSubcat)) return res.status(400).json({ message: `Item ${itemIdx + 1}: invalid subcategory.` });

        // All 5 variants required for sets
        const variantFiles = [];
        for (let v = 0; v < 5; v++) {
          const arr = files[`image_${itemIdx}_${v}`];
          if (!arr?.[0]) return res.status(400).json({ message: `Item ${itemIdx + 1}: all 5 variants are required.` });
          if (!isPng(arr[0].buffer)) return res.status(400).json({ message: `Item ${itemIdx + 1} variant ${v + 1}: must be a valid PNG.` });
          variantFiles.push({ index: v, file: arr[0] });
        }

        const groupCode = uuidv4();
        const submission = new Submission({
          name: itemName.trim(),
          groupCode,
          category: itemCategory,
          subcategory: itemSubcat,
          gender,
          variants: [],
          uploadedBy: req.userId,
          isSet: true,
          setCode,
          setPosition: itemIdx,
        });

        const uploaded = await Promise.all(
          variantFiles.map(async ({ index, file }) => {
            const urls = await uploadVariant(file.buffer, submission._id, index);
            return { index, ...urls };
          })
        );
        uploaded.sort((a, b) => a.index - b.index);
        submission.variants = uploaded.map(({ imageUrl, thumbnailUrl }) => ({ imageUrl, thumbnailUrl }));
        submissions.push(submission);
      }

      await Promise.all(submissions.map((s) => s.save()));
      return res.status(201).json({ setCode, count: submissions.length });
    }

    return res.status(400).json({ message: "type must be 'single' or 'set'." });
  } catch (err) {
    console.error("Creator submit error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── PATCH /api/creator/submissions/:id — edit name/category/subcategory ──
router.patch("/submissions/:id", async (req, res) => {
  try {
    const sub = await Submission.findOne({ _id: req.params.id, uploadedBy: req.userId });
    if (!sub) return res.status(404).json({ message: "Submission not found." });
    if (sub.status === "approved") {
      return res.status(400).json({ message: "Cannot edit an approved submission." });
    }

    const { name, category, subcategory } = req.body;
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ message: "Name cannot be empty." });
      if (name.trim().length > 40) return res.status(400).json({ message: "Name must be 40 characters or fewer." });
      sub.name = name.trim();
    }
    if (category !== undefined) {
      const allowedSubs = CATEGORY_SUBCATEGORIES[category];
      if (!allowedSubs) return res.status(400).json({ message: "Invalid category." });
      sub.category = category;
      if (subcategory !== undefined) {
        if (!allowedSubs.includes(subcategory)) return res.status(400).json({ message: "Invalid subcategory." });
        sub.subcategory = subcategory;
      }
    } else if (subcategory !== undefined) {
      const allowedSubs = CATEGORY_SUBCATEGORIES[sub.category];
      if (!allowedSubs?.includes(subcategory)) return res.status(400).json({ message: "Invalid subcategory." });
      sub.subcategory = subcategory;
    }

    // If edited after decline, reset to pending
    if (sub.status === "declined") sub.status = "pending";

    await sub.save();
    res.json({ submission: { ...sub.toObject(), id: String(sub._id) } });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/creator/submissions/:id/variant/:idx — reupload a variant ──
const singleVariantUpload = upload.single("image");
router.post("/submissions/:id/variant/:idx", singleVariantUpload, async (req, res) => {
  try {
    const variantIdx = parseInt(req.params.idx);
    if (isNaN(variantIdx) || variantIdx < 0 || variantIdx > 4) {
      return res.status(400).json({ message: "Variant index must be 0-4." });
    }

    const sub = await Submission.findOne({ _id: req.params.id, uploadedBy: req.userId });
    if (!sub) return res.status(404).json({ message: "Submission not found." });
    if (sub.status === "approved") {
      return res.status(400).json({ message: "Cannot edit an approved submission." });
    }
    if (!req.file || !isPng(req.file.buffer)) {
      return res.status(400).json({ message: "A valid PNG image is required." });
    }

    const { imageUrl, thumbnailUrl } = await uploadVariant(req.file.buffer, sub._id, variantIdx);

    if (sub.variants[variantIdx]) {
      sub.variants[variantIdx].imageUrl    = imageUrl;
      sub.variants[variantIdx].thumbnailUrl = thumbnailUrl;
    } else {
      while (sub.variants.length <= variantIdx) sub.variants.push(null);
      sub.variants[variantIdx] = { imageUrl, thumbnailUrl };
    }

    if (sub.status === "declined") sub.status = "pending";
    await sub.save();

    res.json({ variant: { index: variantIdx, imageUrl, thumbnailUrl } });
  } catch (err) {
    console.error("Reupload variant error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── DELETE /api/creator/submissions/:id/variant/:idx ─────────────────────
router.delete("/submissions/:id/variant/:idx", async (req, res) => {
  try {
    const variantIdx = parseInt(req.params.idx);
    const sub = await Submission.findOne({ _id: req.params.id, uploadedBy: req.userId });
    if (!sub) return res.status(404).json({ message: "Submission not found." });
    if (sub.status === "approved") return res.status(400).json({ message: "Cannot edit an approved submission." });
    if (isNaN(variantIdx) || !sub.variants[variantIdx]) {
      return res.status(404).json({ message: "Variant not found." });
    }
    if (sub.isSet && sub.variants.length <= 5) {
      return res.status(400).json({ message: "Set items must keep all 5 variants." });
    }
    if (!sub.isSet && sub.variants.length <= 1) {
      return res.status(400).json({ message: "Must keep at least one variant." });
    }
    sub.variants.splice(variantIdx, 1);
    if (sub.status === "declined") sub.status = "pending";
    await sub.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
