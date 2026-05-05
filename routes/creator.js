const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const requireCreator = require("../middleware/creator");
const supabase = require("../lib/supabase");
const { uploadFile } = require("../lib/storage");
const { CATEGORY_SUBCATEGORIES } = require("../lib/categories");

const router = express.Router();
router.use(requireCreator);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPng(buf) { return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC); }

async function uploadVariant(fileBuffer, submissionId, variantIndex) {
  const thumbnailBuffer = await sharp(fileBuffer)
    .extract({ left: 0, top: 4616, width: 510, height: 510 })
    .resize(256, 256)
    .png()
    .toBuffer();

  const [imageUrl, thumbnailUrl] = await Promise.all([
    uploadFile(`submissions/${submissionId}/variant-${variantIndex}.png`, fileBuffer),
    uploadFile(`submission-thumbnails/${submissionId}/variant-${variantIndex}.png`, thumbnailBuffer),
  ]);

  return { imageUrl, thumbnailUrl };
}

// GET /api/creator/me
router.get("/me", async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.userId)
      .single();
    if (error || !profile) return res.status(404).json({ message: "User not found." });
    res.json({ user: { ...profile, id: profile.id, roles: [...new Set([profile.role, ...(profile.roles || [])])] } });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/creator/submissions
router.get("/submissions", async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const status = (req.query.status || "").trim();

    let query = supabase
      .from("submissions")
      .select("*")
      .eq("uploaded_by", req.userId)
      .order("created_at", { ascending: false });
    if (["pending", "approved", "declined"].includes(status)) query = query.eq("status", status);

    const { data: allSubs, error } = await query;
    if (error) throw error;

    const seen    = new Set();
    const grouped = [];
    for (const sub of allSubs || []) {
      if (!sub.is_set) {
        grouped.push({ ...sub, id: sub.id });
      } else {
        if (!seen.has(sub.set_code)) {
          seen.add(sub.set_code);
          const setItems = (allSubs || [])
            .filter((s) => s.set_code === sub.set_code)
            .sort((a, b) => (a.set_position ?? 0) - (b.set_position ?? 0))
            .map((s) => ({ ...s, id: s.id }));
          grouped.push({
            isSet:     true,
            setCode:   sub.set_code,
            status:    sub.status,
            adminNote: sub.admin_note,
            createdAt: sub.created_at,
            items:     setItems,
          });
        }
      }
    }

    const total     = grouped.length;
    const paginated = grouped.slice((page - 1) * limit, page * limit);
    res.json({ submissions: paginated, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/creator/submit
const SINGLE_FIELDS = Array.from({ length: 5 }, (_, i) => ({ name: `image_${i}`, maxCount: 1 }));
const SET_FIELDS = [];
for (let item = 0; item < 5; item++) {
  for (let v = 0; v < 5; v++) SET_FIELDS.push({ name: `image_${item}_${v}`, maxCount: 1 });
}

router.post("/submit", upload.fields([...SINGLE_FIELDS, ...SET_FIELDS]), async (req, res) => {
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

      const variantFiles = [];
      for (let i = 0; i < 5; i++) {
        const arr = files[`image_${i}`];
        if (arr?.[0]) variantFiles.push({ index: i, file: arr[0] });
      }
      if (variantFiles.length === 0) return res.status(400).json({ message: "At least one variant image is required." });
      for (const { file } of variantFiles) {
        if (!isPng(file.buffer)) return res.status(400).json({ message: "All images must be valid PNG files." });
      }

      const submissionId = uuidv4();
      const groupCode    = uuidv4();

      const uploaded = await Promise.all(
        variantFiles.map(async ({ index, file }) => {
          const urls = await uploadVariant(file.buffer, submissionId, index);
          return { index, ...urls };
        })
      );
      uploaded.sort((a, b) => a.index - b.index);
      const variants = uploaded.map(({ imageUrl, thumbnailUrl }) => ({ imageUrl, thumbnailUrl }));

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
          is_set:      false,
        })
        .select("id, group_code, name, variants")
        .single();
      if (error) throw error;

      return res.status(201).json({
        submission: { id: submission.id, groupCode: submission.group_code, name: submission.name, variantCount: submission.variants.length },
      });
    }

    if (type === "set") {
      const setCode     = uuidv4();
      const submissions = [];

      for (let itemIdx = 0; itemIdx < 5; itemIdx++) {
        const itemName     = req.body[`item_${itemIdx}_name`];
        const itemCategory = req.body[`item_${itemIdx}_category`];
        const itemSubcat   = req.body[`item_${itemIdx}_subcategory`];

        if (!itemName?.trim()) return res.status(400).json({ message: `Item ${itemIdx + 1}: name is required.` });
        if (itemName.trim().length > 40) return res.status(400).json({ message: `Item ${itemIdx + 1}: name too long.` });

        const allowedSubs = CATEGORY_SUBCATEGORIES[itemCategory];
        if (!allowedSubs) return res.status(400).json({ message: `Item ${itemIdx + 1}: invalid category.` });
        if (!allowedSubs.includes(itemSubcat)) return res.status(400).json({ message: `Item ${itemIdx + 1}: invalid subcategory.` });

        const variantFiles = [];
        for (let v = 0; v < 5; v++) {
          const arr = files[`image_${itemIdx}_${v}`];
          if (!arr?.[0]) return res.status(400).json({ message: `Item ${itemIdx + 1}: all 5 variants are required.` });
          if (!isPng(arr[0].buffer)) return res.status(400).json({ message: `Item ${itemIdx + 1} variant ${v + 1}: must be a valid PNG.` });
          variantFiles.push({ index: v, file: arr[0] });
        }

        const submissionId = uuidv4();
        const groupCode    = uuidv4();

        const uploaded = await Promise.all(
          variantFiles.map(async ({ index, file }) => {
            const urls = await uploadVariant(file.buffer, submissionId, index);
            return { index, ...urls };
          })
        );
        uploaded.sort((a, b) => a.index - b.index);
        const variants = uploaded.map(({ imageUrl, thumbnailUrl }) => ({ imageUrl, thumbnailUrl }));

        submissions.push({
          id:           submissionId,
          name:         itemName.trim(),
          group_code:   groupCode,
          category:     itemCategory,
          subcategory:  itemSubcat,
          gender,
          variants,
          uploaded_by:  req.userId,
          is_set:       true,
          set_code:     setCode,
          set_position: itemIdx,
        });
      }

      const { error } = await supabase.from("submissions").insert(submissions);
      if (error) throw error;

      return res.status(201).json({ setCode, count: submissions.length });
    }

    return res.status(400).json({ message: "type must be 'single' or 'set'." });
  } catch (err) {
    console.error("Creator submit error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// PATCH /api/creator/submissions/:id
router.patch("/submissions/:id", async (req, res) => {
  try {
    const { data: sub, error: fetchErr } = await supabase
      .from("submissions")
      .select("*")
      .eq("id", req.params.id)
      .eq("uploaded_by", req.userId)
      .single();
    if (fetchErr || !sub) return res.status(404).json({ message: "Submission not found." });
    if (sub.status === "approved") return res.status(400).json({ message: "Cannot edit an approved submission." });

    const { name, category, subcategory } = req.body;
    const update = {};

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ message: "Name cannot be empty." });
      if (name.trim().length > 40) return res.status(400).json({ message: "Name must be 40 characters or fewer." });
      update.name = name.trim();
    }

    const resolvedCategory = category !== undefined ? category : sub.category;
    if (category !== undefined) {
      const allowedSubs = CATEGORY_SUBCATEGORIES[category];
      if (!allowedSubs) return res.status(400).json({ message: "Invalid category." });
      update.category = category;
    }
    if (subcategory !== undefined) {
      const allowedSubs = CATEGORY_SUBCATEGORIES[resolvedCategory];
      if (!allowedSubs?.includes(subcategory)) return res.status(400).json({ message: "Invalid subcategory." });
      update.subcategory = subcategory;
    }

    if (sub.status === "declined") update.status = "pending";

    const { data: updated, error: updateErr } = await supabase
      .from("submissions")
      .update(update)
      .eq("id", req.params.id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    res.json({ submission: { ...updated, id: updated.id } });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/creator/submissions/:id/variant/:idx — reupload a variant
router.post("/submissions/:id/variant/:idx", upload.single("image"), async (req, res) => {
  try {
    const variantIdx = parseInt(req.params.idx);
    if (isNaN(variantIdx) || variantIdx < 0 || variantIdx > 4) {
      return res.status(400).json({ message: "Variant index must be 0-4." });
    }

    const { data: sub, error: fetchErr } = await supabase
      .from("submissions")
      .select("*")
      .eq("id", req.params.id)
      .eq("uploaded_by", req.userId)
      .single();
    if (fetchErr || !sub) return res.status(404).json({ message: "Submission not found." });
    if (sub.status === "approved") return res.status(400).json({ message: "Cannot edit an approved submission." });
    if (!req.file || !isPng(req.file.buffer)) return res.status(400).json({ message: "A valid PNG image is required." });

    const { imageUrl, thumbnailUrl } = await uploadVariant(req.file.buffer, sub.id, variantIdx);

    const variants = [...(sub.variants || [])];
    if (variants[variantIdx]) {
      variants[variantIdx].imageUrl    = imageUrl;
      variants[variantIdx].thumbnailUrl = thumbnailUrl;
    } else {
      while (variants.length <= variantIdx) variants.push(null);
      variants[variantIdx] = { imageUrl, thumbnailUrl };
    }

    const update = { variants };
    if (sub.status === "declined") update.status = "pending";

    await supabase.from("submissions").update(update).eq("id", sub.id);
    res.json({ variant: { index: variantIdx, imageUrl, thumbnailUrl } });
  } catch (err) {
    console.error("Reupload variant error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// DELETE /api/creator/submissions/:id/variant/:idx
router.delete("/submissions/:id/variant/:idx", async (req, res) => {
  try {
    const variantIdx = parseInt(req.params.idx);

    const { data: sub, error: fetchErr } = await supabase
      .from("submissions")
      .select("*")
      .eq("id", req.params.id)
      .eq("uploaded_by", req.userId)
      .single();
    if (fetchErr || !sub) return res.status(404).json({ message: "Submission not found." });
    if (sub.status === "approved") return res.status(400).json({ message: "Cannot edit an approved submission." });

    const variants = [...(sub.variants || [])];
    if (isNaN(variantIdx) || !variants[variantIdx]) {
      return res.status(404).json({ message: "Variant not found." });
    }
    if (sub.is_set && variants.length <= 5) {
      return res.status(400).json({ message: "Set items must keep all 5 variants." });
    }
    if (!sub.is_set && variants.length <= 1) {
      return res.status(400).json({ message: "Must keep at least one variant." });
    }

    variants.splice(variantIdx, 1);
    const update = { variants };
    if (sub.status === "declined") update.status = "pending";

    await supabase.from("submissions").update(update).eq("id", sub.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
