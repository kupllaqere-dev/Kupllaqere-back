const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const requireAdmin = require("../middleware/admin");
const supabase = require("../lib/supabase");
const { uploadFile, deleteFiles } = require("../lib/storage");
const { CATEGORY_SUBCATEGORIES } = require("../lib/categories");
const online = require("../lib/online");

const router = express.Router();
router.use(requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPng(buf) { return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC); }

async function createItemsFromSubmission(submission) {
  const inserts = (submission.variants || []).map((variant) => ({
    id:            uuidv4(),
    name:          submission.name,
    gender:        submission.gender,
    category:      submission.category,
    subcategory:   submission.subcategory,
    image_url:     variant.imageUrl,
    thumbnail_url: variant.thumbnailUrl || "",
    uploaded_by:   submission.uploaded_by,
  }));
  if (inserts.length) {
    const { error } = await supabase.from("items").insert(inserts);
    if (error) throw error;
  }
}

// ── Stats ──────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const now         = new Date();
    const startToday  = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startWeek   = new Date(now.getTime() - 7 * 864e5).toISOString();
    const start30d    = new Date(now.getTime() - 30 * 864e5).toISOString();

    const [
      { count: totalUsers },
      { count: newToday },
      { count: newThisWeek },
      { count: totalItems },
      { count: totalMail },
      { data: regs30d },
    ] = await Promise.all([
      supabase.from("profiles").select("*", { count: "exact", head: true }),
      supabase.from("profiles").select("*", { count: "exact", head: true }).gte("created_at", startToday),
      supabase.from("profiles").select("*", { count: "exact", head: true }).gte("created_at", startWeek),
      supabase.from("items").select("*", { count: "exact", head: true }),
      supabase.from("mail").select("*", { count: "exact", head: true }),
      supabase.from("profiles").select("created_at").gte("created_at", start30d),
    ]);

    const byDay = {};
    for (const { created_at } of regs30d || []) {
      const date = created_at.slice(0, 10);
      byDay[date] = (byDay[date] || 0) + 1;
    }
    const registrationsByDay = Object.entries(byDay)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      totalUsers:   totalUsers || 0,
      onlineUsers:  online.onlineUserIds().length,
      newToday:     newToday  || 0,
      newThisWeek:  newThisWeek || 0,
      totalItems:   totalItems || 0,
      totalMail:    totalMail  || 0,
      registrationsByDay,
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Players ────────────────────────────────────────────────
router.get("/players", async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const search = (req.query.search || "").trim();

    let query = supabase
      .from("profiles")
      .select("id, name, email, gender, role, roles, is_banned, is_guest, coins, gems, created_at, selected_badge", { count: "exact" })
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data: players, count: total, error } = await query;
    if (error) throw error;

    const onlineSet = new Set(online.onlineUserIds());
    res.json({
      players: (players || []).map((p) => ({
        ...p,
        roles:    [...new Set([p.role, ...(p.roles || [])])],
        isOnline: onlineSet.has(p.id),
      })),
      total: total || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error("Admin players error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

router.get("/players/:id", async (req, res) => {
  try {
    const { data: player, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error || !player) return res.status(404).json({ message: "User not found." });
    res.json({
      player: {
        ...player,
        roles:    [...new Set([player.role, ...(player.roles || [])])],
        isOnline: online.isOnline(player.id),
      },
    });
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
      update.role  = roles.includes("admin") ? "admin" : "player";
      update.roles = roles.filter((r) => r !== update.role);
    }
    if (isBanned !== undefined) update.is_banned = Boolean(isBanned);
    if (coins    !== undefined) update.coins     = Number(coins);
    if (gems     !== undefined) update.gems      = Number(gems);
    if (name     !== undefined) update.name      = String(name).trim().slice(0, 40);

    const { data: player, error } = await supabase
      .from("profiles")
      .update(update)
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error || !player) return res.status(404).json({ message: "User not found." });
    res.json({ player: { ...player, roles: [...new Set([player.role, ...(player.roles || [])])] } });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

router.delete("/players/:id", async (req, res) => {
  try {
    if (req.params.id === req.userId) {
      return res.status(400).json({ message: "Cannot delete your own account." });
    }
    const { error } = await supabase.auth.admin.deleteUser(req.params.id);
    if (error) return res.status(404).json({ message: "User not found." });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── Items ──────────────────────────────────────────────────
router.get("/items", async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(100, parseInt(req.query.limit) || 20);
    const search   = (req.query.search   || "").trim();
    const category = (req.query.category || "").trim();

    let query = supabase.from("items").select("*, profiles!uploaded_by(name, email)").order("created_at", { ascending: false });

    if (search) query = query.ilike("name", `%${search}%`);
    if (category && CATEGORY_SUBCATEGORIES[category]) query = query.eq("category", category);

    const { data: allItems, error } = await query;
    if (error) throw error;

    const groupMap = new Map();
    for (const item of allItems || []) {
      const key = `${item.name}||${item.category}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          name:             item.name,
          category:         item.category,
          subcategory:      item.subcategory,
          rarity:           item.rarity || null,
          storeType:        item.store_type || null,
          levelRequirement: item.level_requirement ?? null,
          notes:            item.notes || "",
          coinPrice:        item.coin_price ?? null,
          gemPrice:         item.gem_price ?? null,
          uploadedBy:       item.profiles ? { name: item.profiles.name, email: item.profiles.email } : null,
          createdAt:        item.created_at,
          variants:         [],
        });
      }
      groupMap.get(key).variants.push({
        id:          item.id,
        subcategory: item.subcategory,
        gender:      item.gender,
        imageUrl:    item.image_url,
        thumbnailUrl: item.thumbnail_url,
        createdAt:   item.created_at,
      });
    }

    const sorted = Array.from(groupMap.values()).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    const total  = sorted.length;
    const groups = sorted.slice((page - 1) * limit, page * limit);

    res.json({ groups, total, page, limit });
  } catch (err) {
    console.error("Admin items error:", err);
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

    const itemId = uuidv4();

    const thumbnailBuffer = await sharp(req.file.buffer)
      .extract({ left: 0, top: 4616, width: 510, height: 510 })
      .resize(256, 256)
      .png()
      .toBuffer();

    const [imageUrl, thumbnailUrl] = await Promise.all([
      uploadFile(`items/${itemId}.png`, req.file.buffer),
      uploadFile(`item-thumbnails/${itemId}.png`, thumbnailBuffer),
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
      item: { id: item.id, name: item.name, category: item.category, subcategory: item.subcategory, imageUrl: item.image_url, thumbnailUrl: item.thumbnail_url },
    });
  } catch (err) {
    console.error("Admin item create error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Group-level update
router.patch("/items/group", async (req, res) => {
  try {
    const { name, category, newName, rarity, storeType, levelRequirement, notes, coinPrice, gemPrice } = req.body;
    if (!name || !category) return res.status(400).json({ message: "name and category are required." });

    const update = {};
    if (newName          !== undefined) update.name              = String(newName).trim().slice(0, 40);
    if (rarity           !== undefined) update.rarity            = rarity || null;
    if (storeType        !== undefined) update.store_type        = storeType || null;
    if (levelRequirement !== undefined) update.level_requirement = (levelRequirement !== null && levelRequirement !== "") ? Number(levelRequirement) : null;
    if (notes            !== undefined) update.notes             = String(notes).slice(0, 500);
    if (coinPrice        !== undefined) update.coin_price        = (coinPrice !== null && coinPrice !== "") ? Number(coinPrice) : null;
    if (gemPrice         !== undefined) update.gem_price         = (gemPrice  !== null && gemPrice  !== "") ? Number(gemPrice)  : null;

    const { error } = await supabase.from("items").update(update).eq("name", name).eq("category", category);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("Admin group update error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

router.patch("/items/:id", async (req, res) => {
  try {
    const { name, category, subcategory, gender, storeType, rarity, notes, levelRequirement, coinPrice, gemPrice } = req.body;
    const update = {};

    if (name            !== undefined) update.name              = String(name).trim().slice(0, 40);
    if (category        !== undefined) {
      if (!CATEGORY_SUBCATEGORIES[category]) return res.status(400).json({ message: "Invalid category." });
      update.category = category;
    }
    if (subcategory     !== undefined) update.subcategory       = subcategory;
    if (gender          !== undefined) update.gender            = gender || null;
    if (storeType       !== undefined) {
      if (storeType !== null && !["normal"].includes(storeType)) {
        return res.status(400).json({ message: "Invalid storeType." });
      }
      update.store_type = storeType || null;
    }
    if (rarity          !== undefined) update.rarity            = rarity || null;
    if (notes           !== undefined) update.notes             = String(notes).slice(0, 500);
    if (levelRequirement !== undefined) update.level_requirement = levelRequirement ? Number(levelRequirement) : null;
    if (coinPrice       !== undefined) update.coin_price        = (coinPrice !== null && coinPrice !== "") ? Number(coinPrice) : null;
    if (gemPrice        !== undefined) update.gem_price         = (gemPrice  !== null && gemPrice  !== "") ? Number(gemPrice)  : null;

    const { data: item, error } = await supabase
      .from("items")
      .update(update)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error || !item) return res.status(404).json({ message: "Item not found." });
    res.json({ item: { ...item, id: item.id, imageUrl: item.image_url, thumbnailUrl: item.thumbnail_url } });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// Group-level delete
router.delete("/items/group", async (req, res) => {
  try {
    const { name, category } = req.query;
    if (!name || !category) return res.status(400).json({ message: "name and category are required." });

    const { data: items } = await supabase.from("items").select("id").eq("name", name).eq("category", category);

    const paths = (items || []).flatMap((item) => [
      `items/${item.id}.png`,
      `item-thumbnails/${item.id}.png`,
    ]);
    await deleteFiles(paths);

    const { error } = await supabase.from("items").delete().eq("name", name).eq("category", category);
    if (error) throw error;
    res.json({ success: true, deletedCount: (items || []).length });
  } catch (err) {
    console.error("Admin group delete error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

router.delete("/items/:id", async (req, res) => {
  try {
    const { data: item, error } = await supabase
      .from("items")
      .delete()
      .eq("id", req.params.id)
      .select("id")
      .single();
    if (error || !item) return res.status(404).json({ message: "Item not found." });
    await deleteFiles([`items/${item.id}.png`, `item-thumbnails/${item.id}.png`]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── Submissions ────────────────────────────────────────────
router.get("/submissions", async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const status = (req.query.status || "").trim();

    let query = supabase
      .from("submissions")
      .select("*, profiles!uploaded_by(name, email)")
      .order("created_at", { ascending: false });
    if (["pending", "approved", "declined"].includes(status)) query = query.eq("status", status);

    const { data: allSubs, error } = await query;
    if (error) throw error;

    const seen    = new Set();
    const grouped = [];
    for (const sub of allSubs || []) {
      if (!sub.is_set) {
        grouped.push({ ...sub, id: sub.id, uploadedBy: sub.profiles || null });
      } else {
        if (!seen.has(sub.set_code)) {
          seen.add(sub.set_code);
          const setItems = (allSubs || [])
            .filter((s) => s.set_code === sub.set_code)
            .sort((a, b) => (a.set_position ?? 0) - (b.set_position ?? 0))
            .map((s) => ({ ...s, id: s.id }));
          grouped.push({
            isSet:      true,
            setCode:    sub.set_code,
            status:     sub.status,
            uploadedBy: sub.profiles || null,
            createdAt:  sub.created_at,
            adminNote:  sub.admin_note,
            items:      setItems,
          });
        }
      }
    }

    const total     = grouped.length;
    const paginated = grouped.slice((page - 1) * limit, page * limit);
    res.json({ submissions: paginated, total, page, limit });
  } catch (err) {
    console.error("Admin submissions error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

router.patch("/submissions/:id/status", async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    if (!["approved", "declined"].includes(status)) {
      return res.status(400).json({ message: "Status must be 'approved' or 'declined'." });
    }

    const update = { status };
    if (adminNote !== undefined) update.admin_note = String(adminNote).slice(0, 500);

    const { data: submission, error } = await supabase
      .from("submissions")
      .update(update)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error || !submission) return res.status(404).json({ message: "Submission not found." });

    if (status === "approved") await createItemsFromSubmission(submission);

    res.json({ submission: { ...submission, id: submission.id } });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

router.patch("/submissions/set/:setCode/status", async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    if (!["approved", "declined"].includes(status)) {
      return res.status(400).json({ message: "Status must be 'approved' or 'declined'." });
    }

    const { data: submissions, error: fetchErr } = await supabase
      .from("submissions")
      .select("*")
      .eq("set_code", req.params.setCode);
    if (fetchErr || !submissions?.length) return res.status(404).json({ message: "Set not found." });

    const update = { status };
    if (adminNote !== undefined) update.admin_note = String(adminNote).slice(0, 500);

    await supabase.from("submissions").update(update).eq("set_code", req.params.setCode);

    if (status === "approved") {
      await Promise.all(submissions.map(createItemsFromSubmission));
    }

    res.json({ success: true, count: submissions.length });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── Online ─────────────────────────────────────────────────
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

// ── Mail ───────────────────────────────────────────────────
router.get("/mail", async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);

    const { data: mail, count: total, error } = await supabase
      .from("mail")
      .select("*, sender:profiles!from_id(name, email), recipient:profiles!to_id(name, email)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (error) throw error;

    res.json({ mail: (mail || []).map((m) => ({ ...m, id: m.id })), total: total || 0, page, limit });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

router.delete("/mail/:id", async (req, res) => {
  try {
    await supabase.from("mail").delete().eq("id", req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
