const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const requireAdmin = require("../middleware/admin");
const User = require("../models/User");
const Item = require("../models/Item");
const Mail = require("../models/Mail");
const Submission = require("../models/Submission");
const { CATEGORY_SUBCATEGORIES } = require("../models/Item");
const online = require("../lib/online");

const router = express.Router();
router.use(requireAdmin);

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
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

async function createItemsFromSubmission(submission) {
  const base = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
  const tasks = submission.variants.map((variant) =>
    new Item({
      name: submission.name,
      gender: submission.gender,
      category: submission.category,
      subcategory: submission.subcategory,
      imageUrl: variant.imageUrl,
      thumbnailUrl: variant.thumbnailUrl || "",
      uploadedBy: submission.uploadedBy,
    }).save()
  );
  return Promise.all(tasks);
}

// ── Stats ──────────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek  = new Date(now); startOfWeek.setDate(now.getDate() - 7);
    const startOf30d   = new Date(now); startOf30d.setDate(now.getDate() - 30);

    const [totalUsers, newToday, newThisWeek, totalItems, totalMail, regAgg] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfToday } }),
      User.countDocuments({ createdAt: { $gte: startOfWeek } }),
      Item.countDocuments(),
      Mail.countDocuments(),
      User.aggregate([
        { $match: { createdAt: { $gte: startOf30d } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({
      totalUsers,
      onlineUsers: online.onlineUserIds().length,
      newToday,
      newThisWeek,
      totalItems,
      totalMail,
      registrationsByDay: regAgg.map((r) => ({ date: r._id, count: r.count })),
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Players ────────────────────────────────────────────────────────────────
router.get("/players", async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const search = (req.query.search || "").trim();

    const filter = {};
    if (search) {
      const re = escapeRegex(search);
      filter.$or = [
        { name:  { $regex: re, $options: "i" } },
        { email: { $regex: re, $options: "i" } },
      ];
    }

    const [players, total] = await Promise.all([
      User.find(filter)
        .select("name email gender role roles isBanned isGuest coins gems createdAt selectedBadge")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const onlineSet = new Set(online.onlineUserIds());
    res.json({
      players: players.map((p) => ({
        ...p,
        id: String(p._id),
        roles: [...new Set([p.role, ...(p.roles || [])])],
        isOnline: onlineSet.has(String(p._id)),
      })),
      total, page, limit,
    });
  } catch (err) {
    console.error("Admin players error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

router.get("/players/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password").lean();
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ player: {
      ...user,
      id: String(user._id),
      roles: [...new Set([user.role, ...(user.roles || [])])],
      isOnline: online.isOnline(user._id),
    }});
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

const VALID_ROLES = ["player", "admin", "creator"];

router.patch("/players/:id", async (req, res) => {
  try {
    const { roles, isBanned, coins, gems, name } = req.body;
    const update = {};

    if (roles !== undefined) {
      if (!Array.isArray(roles) || !roles.every((r) => VALID_ROLES.includes(r))) {
        return res.status(400).json({ message: `Invalid roles. Allowed: ${VALID_ROLES.join(", ")}` });
      }
      // Keep primary role as the "highest" privilege
      update.role  = roles.includes("admin") ? "admin" : roles.includes("player") ? "player" : "player";
      update.roles = roles.filter((r) => r !== update.role);
    }
    if (isBanned !== undefined) update.isBanned = Boolean(isBanned);
    if (coins    !== undefined) update.coins    = Number(coins);
    if (gems     !== undefined) update.gems     = Number(gems);
    if (name     !== undefined) update.name     = String(name).trim().slice(0, 40);

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select("-password").lean();
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ player: {
      ...user,
      id: String(user._id),
      roles: [...new Set([user.role, ...(user.roles || [])])],
    }});
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

router.delete("/players/:id", async (req, res) => {
  try {
    if (String(req.params.id) === String(req.userId)) {
      return res.status(400).json({ message: "Cannot delete your own account." });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── Items ──────────────────────────────────────────────────────────────────
router.get("/items", async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(100, parseInt(req.query.limit) || 20);
    const search   = (req.query.search   || "").trim();
    const category = (req.query.category || "").trim();

    const filter = {};
    if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };
    if (category && CATEGORY_SUBCATEGORIES[category]) filter.category = category;

    const [items, total] = await Promise.all([
      Item.find(filter)
        .populate("uploadedBy", "name email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Item.countDocuments(filter),
    ]);

    res.json({ items: items.map((i) => ({ ...i, id: String(i._id) })), total, page, limit });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

router.post("/items", upload.single("image"), async (req, res) => {
  try {
    const { name, category, subcategory } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: "Name is required." });
    const allowedSubs = CATEGORY_SUBCATEGORIES[category];
    if (!allowedSubs) return res.status(400).json({ message: "Invalid category." });
    if (!allowedSubs.includes(subcategory)) return res.status(400).json({ message: "Invalid subcategory." });
    if (!req.file) return res.status(400).json({ message: "Image required." });
    if (!isPng(req.file.buffer)) return res.status(400).json({ message: "Image must be a valid PNG." });

    const item = new Item({ name: name.trim(), category, subcategory, imageUrl: "", uploadedBy: req.userId });

    const thumbnailBuffer = await sharp(req.file.buffer)
      .extract({ left: 0, top: 4616, width: 510, height: 510 })
      .resize(256, 256)
      .png()
      .toBuffer();

    const key          = `items/${item._id}.png`;
    const thumbnailKey = `item-thumbnails/${item._id}.png`;
    await Promise.all([
      s3.send(new PutObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: key, Body: req.file.buffer, ContentType: "image/png" })),
      s3.send(new PutObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: thumbnailKey, Body: thumbnailBuffer, ContentType: "image/png" })),
    ]);

    const base = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    item.imageUrl     = `${base}/${key}`;
    item.thumbnailUrl = `${base}/${thumbnailKey}`;
    await item.save();
    res.status(201).json({ item: { id: item._id, name: item.name, category: item.category, subcategory: item.subcategory, imageUrl: item.imageUrl, thumbnailUrl: item.thumbnailUrl } });
  } catch (err) {
    console.error("Admin item create error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

router.patch("/items/:id", async (req, res) => {
  try {
    const { name, category, subcategory, gender, storeType } = req.body;
    const update = {};
    if (name !== undefined) update.name = String(name).trim().slice(0, 40);
    if (category !== undefined) {
      if (!CATEGORY_SUBCATEGORIES[category]) return res.status(400).json({ message: "Invalid category." });
      update.category = category;
    }
    if (subcategory !== undefined) update.subcategory = subcategory;
    if (gender !== undefined) update.gender = gender || undefined;
    if (storeType !== undefined) {
      if (storeType !== null && !["normal"].includes(storeType)) {
        return res.status(400).json({ message: "Invalid storeType." });
      }
      update.storeType = storeType || null;
    }

    const item = await Item.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!item) return res.status(404).json({ message: "Item not found." });
    res.json({ item: { ...item, id: String(item._id) } });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

router.delete("/items/:id", async (req, res) => {
  try {
    const item = await Item.findByIdAndDelete(req.params.id).lean();
    if (!item) return res.status(404).json({ message: "Item not found." });
    try {
      await Promise.all([
        s3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: `items/${item._id}.png` })),
        s3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: `item-thumbnails/${item._id}.png` })),
      ]);
    } catch { /* best-effort */ }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── Submissions ────────────────────────────────────────────────────────────
router.get("/submissions", async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const status = (req.query.status || "").trim();

    const filter = {};
    if (["pending", "approved", "declined"].includes(status)) filter.status = status;

    // Fetch non-set submissions and the "first" of each set group
    const allSubs = await Submission.find(filter)
      .populate("uploadedBy", "name email")
      .sort({ createdAt: -1 })
      .lean();

    // Group sets by setCode, keep singles as-is
    const seen = new Set();
    const grouped = [];
    for (const sub of allSubs) {
      if (!sub.isSet) {
        grouped.push({ ...sub, id: String(sub._id) });
      } else {
        if (!seen.has(sub.setCode)) {
          seen.add(sub.setCode);
          // Collect all items of this set (already in allSubs)
          const setItems = allSubs
            .filter((s) => s.setCode === sub.setCode)
            .sort((a, b) => (a.setPosition ?? 0) - (b.setPosition ?? 0))
            .map((s) => ({ ...s, id: String(s._id) }));
          grouped.push({
            isSet: true,
            setCode: sub.setCode,
            status: sub.status,
            uploadedBy: sub.uploadedBy,
            createdAt: sub.createdAt,
            adminNote: sub.adminNote,
            items: setItems,
          });
        }
      }
    }

    const total = grouped.length;
    const paginated = grouped.slice((page - 1) * limit, page * limit);

    res.json({ submissions: paginated, total, page, limit });
  } catch (err) {
    console.error("Admin submissions error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Approve/decline a single submission
router.patch("/submissions/:id/status", async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    if (!["approved", "declined"].includes(status)) {
      return res.status(400).json({ message: "Status must be 'approved' or 'declined'." });
    }
    const update = { status };
    if (adminNote !== undefined) update.adminNote = String(adminNote).slice(0, 500);

    const submission = await Submission.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!submission) return res.status(404).json({ message: "Submission not found." });

    if (status === "approved") {
      await createItemsFromSubmission(submission);
    }

    res.json({ submission: { ...submission, id: String(submission._id) } });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// Approve/decline all items in a set at once
router.patch("/submissions/set/:setCode/status", async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    if (!["approved", "declined"].includes(status)) {
      return res.status(400).json({ message: "Status must be 'approved' or 'declined'." });
    }
    const update = { status };
    if (adminNote !== undefined) update.adminNote = String(adminNote).slice(0, 500);

    const submissions = await Submission.find({ setCode: req.params.setCode }).lean();
    if (!submissions.length) return res.status(404).json({ message: "Set not found." });

    await Submission.updateMany({ setCode: req.params.setCode }, update);

    if (status === "approved") {
      await Promise.all(submissions.map(createItemsFromSubmission));
    }

    res.json({ success: true, count: submissions.length });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── Online ─────────────────────────────────────────────────────────────────
router.get("/online", (req, res) => {
  const players = req.app.locals.players;
  if (!players) return res.json({ players: [], total: 0 });
  const list = Array.from(players.values()).map((p) => ({
    socketId: p.id,
    userId:   p.userId || null,
    name:     p.name,
    map:      p.map,
    x:        Math.round(p.x),
    y:        Math.round(p.y),
  }));
  res.json({ players: list, total: list.length });
});

// ── Mail ───────────────────────────────────────────────────────────────────
router.get("/mail", async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);

    const [mail, total] = await Promise.all([
      Mail.find()
        .populate("from", "name email")
        .populate("to",   "name email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Mail.countDocuments(),
    ]);

    res.json({ mail: mail.map((m) => ({ ...m, id: String(m._id) })), total, page, limit });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

router.delete("/mail/:id", async (req, res) => {
  try {
    await Mail.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
