const express = require("express");
const auth = require("../middleware/auth");
const supabase = require("../lib/supabase");
const { isOnline } = require("../lib/online");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

function extractOutfit(customization) {
  const outfit = {};
  if (!customization) return outfit;
  for (const [cat, subs] of Object.entries(customization)) {
    if (!subs || typeof subs !== "object") continue;
    for (const sub of Object.keys(subs)) {
      const url = subs[sub];
      if (url) {
        outfit[cat] = { imageUrl: url };
        break;
      }
    }
  }
  return outfit;
}

function notifyFriendsChanged(req, userIds) {
  const io = req.app.locals.io;
  const socketsForUser = req.app.locals.socketsForUser;
  if (!io || !socketsForUser) return;
  for (const uid of userIds) {
    for (const sid of socketsForUser(uid)) {
      io.to(sid).emit("friends:refresh");
    }
  }
}

// Helper: get all accepted friend IDs for a user
async function getFriendIds(userId) {
  const { data: rows } = await supabase
    .from("friendships")
    .select("user_id, friend_id")
    .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
    .eq("status", "accepted");
  return (rows || []).map((r) => (r.user_id === userId ? r.friend_id : r.user_id));
}

// ── GET /api/friends ──────────────────────────────────────
router.get("/", auth, async (req, res) => {
  try {
    const userId = req.userId;

    // Accepted friends
    const { data: acceptedRows } = await supabase
      .from("friendships")
      .select("user_id, friend_id")
      .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
      .eq("status", "accepted");

    // Pending received (someone sent me a request: they are user_id, I am friend_id)
    const { data: receivedRows } = await supabase
      .from("friendships")
      .select("user_id")
      .eq("friend_id", userId)
      .eq("status", "pending");

    // Pending sent (I sent requests: I am user_id, they are friend_id)
    const { data: sentRows } = await supabase
      .from("friendships")
      .select("friend_id")
      .eq("user_id", userId)
      .eq("status", "pending");

    const friendIds   = (acceptedRows || []).map((r) => (r.user_id === userId ? r.friend_id : r.user_id));
    const receivedIds = (receivedRows || []).map((r) => r.user_id);
    const sentIds     = (sentRows || []).map((r) => r.friend_id);
    const allIds      = [...new Set([...friendIds, ...receivedIds, ...sentIds])];

    let profileMap = {};
    if (allIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, name, avatar, gender, customization")
        .in("id", allIds);
      for (const p of profiles || []) profileMap[p.id] = p;
    }

    const toEntry = (id) => {
      const p = profileMap[id] || {};
      return { id, name: p.name, avatar: p.avatar, gender: p.gender, outfit: extractOutfit(p.customization) };
    };

    res.json({
      friends:  friendIds.map((id)   => ({ ...toEntry(id), online: isOnline(id) })),
      received: receivedIds.map(toEntry),
      sent:     sentIds.map(toEntry),
    });
  } catch (err) {
    console.error("List friends error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/friends/request ─────────────────────────────
router.post("/request", auth, async (req, res) => {
  try {
    const { targetId } = req.body;
    if (!isValidId(targetId)) return res.status(400).json({ message: "Invalid target id." });
    if (targetId === req.userId) return res.status(400).json({ message: "You cannot friend yourself." });

    const { data: target } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", targetId)
      .maybeSingle();
    if (!target) return res.status(404).json({ message: "User not found." });

    // Check for any existing row between these two users
    const { data: existing } = await supabase
      .from("friendships")
      .select("id, user_id, friend_id, status")
      .or(
        `and(user_id.eq.${req.userId},friend_id.eq.${targetId}),` +
        `and(user_id.eq.${targetId},friend_id.eq.${req.userId})`
      )
      .maybeSingle();

    if (existing) {
      if (existing.status === "accepted") {
        return res.status(409).json({ message: "Already friends." });
      }
      if (existing.user_id === req.userId) {
        return res.status(409).json({ message: "Request already sent." });
      }
      // Target had sent me a request → accept it
      await supabase.from("friendships").update({ status: "accepted" }).eq("id", existing.id);
      notifyFriendsChanged(req, [req.userId, targetId]);
      return res.json({ status: "accepted" });
    }

    await supabase.from("friendships").insert({
      user_id:   req.userId,
      friend_id: targetId,
      status:    "pending",
    });

    notifyFriendsChanged(req, [req.userId, targetId]);
    res.json({ status: "sent" });
  } catch (err) {
    console.error("Send friend request error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/friends/accept ──────────────────────────────
router.post("/accept", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ message: "Invalid user id." });

    // They sent me a request: user_id = userId, friend_id = req.userId
    const { data: row } = await supabase
      .from("friendships")
      .select("id, status")
      .eq("user_id", userId)
      .eq("friend_id", req.userId)
      .eq("status", "pending")
      .maybeSingle();

    if (!row) return res.status(400).json({ message: "No pending request from this user." });

    await supabase.from("friendships").update({ status: "accepted" }).eq("id", row.id);
    notifyFriendsChanged(req, [req.userId, userId]);
    res.json({ status: "accepted" });
  } catch (err) {
    console.error("Accept friend error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/friends/decline ─────────────────────────────
router.post("/decline", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ message: "Invalid user id." });

    await supabase
      .from("friendships")
      .delete()
      .eq("user_id", userId)
      .eq("friend_id", req.userId)
      .eq("status", "pending");

    notifyFriendsChanged(req, [req.userId, userId]);
    res.json({ status: "declined" });
  } catch (err) {
    console.error("Decline friend error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/friends/cancel ──────────────────────────────
router.post("/cancel", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ message: "Invalid user id." });

    await supabase
      .from("friendships")
      .delete()
      .eq("user_id", req.userId)
      .eq("friend_id", userId)
      .eq("status", "pending");

    notifyFriendsChanged(req, [req.userId, userId]);
    res.json({ status: "cancelled" });
  } catch (err) {
    console.error("Cancel friend error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── DELETE /api/friends/:id ───────────────────────────────
router.delete("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ message: "Invalid user id." });

    await supabase
      .from("friendships")
      .delete()
      .or(
        `and(user_id.eq.${req.userId},friend_id.eq.${id}),` +
        `and(user_id.eq.${id},friend_id.eq.${req.userId})`
      )
      .eq("status", "accepted");

    notifyFriendsChanged(req, [req.userId, id]);
    res.json({ status: "removed" });
  } catch (err) {
    console.error("Remove friend error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
module.exports.getFriendIds = getFriendIds;
