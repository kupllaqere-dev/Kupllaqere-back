const express = require("express");
const auth = require("../middleware/auth");
const supabase = require("../lib/supabase");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

function notifySoulMateChanged(req, userIds) {
  const io = req.app.locals.io;
  const socketsForUser = req.app.locals.socketsForUser;
  if (!io || !socketsForUser) return;
  const seen = new Set();
  for (const uid of userIds) {
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    for (const sid of socketsForUser(uid)) {
      io.to(sid).emit("soulmate:refresh");
    }
  }
}

// Build current soulmate state for a user from the soulmates table.
// soulmates rows: { user_id, partner_id, status: 'pending'|'accepted' }
async function buildOwnState(userId) {
  const { data: acceptedRow } = await supabase
    .from("soulmates")
    .select("user_id, partner_id")
    .or(`user_id.eq.${userId},partner_id.eq.${userId}`)
    .eq("status", "accepted")
    .maybeSingle();

  let mine = null;
  if (acceptedRow) {
    const partnerId = acceptedRow.user_id === userId ? acceptedRow.partner_id : acceptedRow.user_id;
    const { data: sm } = await supabase
      .from("profiles")
      .select("id, name")
      .eq("id", partnerId)
      .single();
    if (sm) mine = { id: sm.id, name: sm.name };
  }

  // My outgoing pending request (I am user_id)
  const { data: sentRow } = await supabase
    .from("soulmates")
    .select("partner_id")
    .eq("user_id", userId)
    .eq("status", "pending")
    .maybeSingle();

  let sent = null;
  if (sentRow) {
    const { data: sentUser } = await supabase
      .from("profiles")
      .select("id, name")
      .eq("id", sentRow.partner_id)
      .single();
    if (sentUser) sent = { id: sentUser.id, name: sentUser.name };
  }

  // Incoming pending requests (I am partner_id)
  const { data: receivedRows } = await supabase
    .from("soulmates")
    .select("user_id")
    .eq("partner_id", userId)
    .eq("status", "pending");

  let received = [];
  if (receivedRows && receivedRows.length) {
    const fromIds = receivedRows.map((r) => r.user_id);
    const { data: fromUsers } = await supabase
      .from("profiles")
      .select("id, name")
      .in("id", fromIds);
    received = (fromUsers || []).map((u) => ({ id: u.id, name: u.name }));
  }

  return { mine, sent, received };
}

// GET /api/soulmate?targetId=...
router.get("/", auth, async (req, res) => {
  try {
    const own = await buildOwnState(req.userId);
    if (!own) return res.status(404).json({ message: "User not found." });

    const out = { ...own };
    const { targetId } = req.query;

    if (targetId) {
      if (!isValidId(targetId)) return res.status(400).json({ message: "Invalid target id." });

      const { data: target } = await supabase
        .from("profiles")
        .select("id, name")
        .eq("id", targetId)
        .maybeSingle();
      if (!target) return res.status(404).json({ message: "Target not found." });

      let relationship = "none";
      if (targetId === req.userId) {
        relationship = "self";
      } else if (own.mine && own.mine.id === targetId) {
        relationship = "soulmate";
      } else if (own.sent && own.sent.id === targetId) {
        relationship = "i_sent";
      } else if (own.received.some((r) => r.id === targetId)) {
        relationship = "they_sent";
      }

      // Look up target's accepted soulmate from the table
      const { data: targetSMRow } = await supabase
        .from("soulmates")
        .select("user_id, partner_id")
        .or(`user_id.eq.${targetId},partner_id.eq.${targetId}`)
        .eq("status", "accepted")
        .maybeSingle();

      let targetSoulMate = null;
      if (targetSMRow) {
        const tsmId = targetSMRow.user_id === targetId ? targetSMRow.partner_id : targetSMRow.user_id;
        const { data: tsm } = await supabase
          .from("profiles")
          .select("id, name")
          .eq("id", tsmId)
          .single();
        if (tsm) targetSoulMate = { id: tsm.id, name: tsm.name };
      }

      out.target = { id: target.id, name: target.name, soulMate: targetSoulMate };
      out.relationship = relationship;
    }

    res.json(out);
  } catch (err) {
    console.error("Get soul mate state error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/soulmate/request
router.post("/request", auth, async (req, res) => {
  try {
    const { targetId } = req.body;
    if (!isValidId(targetId)) return res.status(400).json({ message: "Invalid target id." });
    if (targetId === req.userId) return res.status(400).json({ message: "You cannot soul-mate yourself." });

    // Check if target profile exists
    const { data: target } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", targetId)
      .maybeSingle();
    if (!target) return res.status(404).json({ message: "User not found." });

    // Check if either party already has an accepted soulmate
    const [{ data: myAccepted }, { data: theirAccepted }] = await Promise.all([
      supabase.from("soulmates").select("id")
        .or(`user_id.eq.${req.userId},partner_id.eq.${req.userId}`)
        .eq("status", "accepted").maybeSingle(),
      supabase.from("soulmates").select("id")
        .or(`user_id.eq.${targetId},partner_id.eq.${targetId}`)
        .eq("status", "accepted").maybeSingle(),
    ]);
    if (myAccepted) return res.status(409).json({ message: "You already have a soul mate." });
    if (theirAccepted) return res.status(409).json({ message: "That player already has a soul mate." });

    // Check if I already sent a request to this person
    const { data: alreadySent } = await supabase
      .from("soulmates")
      .select("id")
      .eq("user_id", req.userId)
      .eq("partner_id", targetId)
      .eq("status", "pending")
      .maybeSingle();
    if (alreadySent) return res.status(409).json({ message: "Request already sent." });

    // Check if target already sent me a request → auto-accept
    const { data: theyAsked } = await supabase
      .from("soulmates")
      .select("id")
      .eq("user_id", targetId)
      .eq("partner_id", req.userId)
      .eq("status", "pending")
      .maybeSingle();

    if (theyAsked) {
      // Clear all pending requests involving either party, then accept their request
      await supabase.from("soulmates").delete()
        .or(`user_id.eq.${req.userId},partner_id.eq.${req.userId},user_id.eq.${targetId},partner_id.eq.${targetId}`)
        .eq("status", "pending");
      await supabase.from("soulmates").insert({ user_id: targetId, partner_id: req.userId, status: "accepted" });
      notifySoulMateChanged(req, [req.userId, targetId]);
      return res.json({ status: "accepted" });
    }

    // Cancel any previous outgoing request I had to someone else
    const { data: prevSent } = await supabase
      .from("soulmates")
      .select("partner_id")
      .eq("user_id", req.userId)
      .eq("status", "pending")
      .maybeSingle();
    if (prevSent) {
      await supabase.from("soulmates").delete()
        .eq("user_id", req.userId)
        .eq("status", "pending");
      notifySoulMateChanged(req, [prevSent.partner_id]);
    }

    await supabase.from("soulmates").insert({ user_id: req.userId, partner_id: targetId, status: "pending" });
    notifySoulMateChanged(req, [req.userId, targetId]);
    res.json({ status: "sent" });
  } catch (err) {
    console.error("Send soul mate request error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/soulmate/accept
router.post("/accept", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ message: "Invalid user id." });

    // Check neither party already has an accepted soulmate
    const [{ data: myAccepted }, { data: theirAccepted }] = await Promise.all([
      supabase.from("soulmates").select("id")
        .or(`user_id.eq.${req.userId},partner_id.eq.${req.userId}`)
        .eq("status", "accepted").maybeSingle(),
      supabase.from("soulmates").select("id")
        .or(`user_id.eq.${userId},partner_id.eq.${userId}`)
        .eq("status", "accepted").maybeSingle(),
    ]);
    if (myAccepted) return res.status(409).json({ message: "You already have a soul mate." });
    if (theirAccepted) return res.status(409).json({ message: "That player already has a soul mate." });

    // They sent me a request: user_id = userId, partner_id = req.userId
    const { data: request } = await supabase
      .from("soulmates")
      .select("id")
      .eq("user_id", userId)
      .eq("partner_id", req.userId)
      .eq("status", "pending")
      .maybeSingle();
    if (!request) return res.status(400).json({ message: "No pending request from this user." });

    // Collect all affected pending rows for notifications
    const { data: allPending } = await supabase
      .from("soulmates")
      .select("user_id, partner_id")
      .or(`user_id.eq.${req.userId},partner_id.eq.${req.userId},user_id.eq.${userId},partner_id.eq.${userId}`)
      .eq("status", "pending");

    const notifyIds = new Set([req.userId, userId]);
    for (const r of allPending || []) {
      notifyIds.add(r.user_id);
      notifyIds.add(r.partner_id);
    }

    // Clear all pending requests involving either party
    await supabase.from("soulmates").delete()
      .or(`user_id.eq.${req.userId},partner_id.eq.${req.userId},user_id.eq.${userId},partner_id.eq.${userId}`)
      .eq("status", "pending");

    // Insert accepted pair (initiator = userId since they asked)
    await supabase.from("soulmates").insert({ user_id: userId, partner_id: req.userId, status: "accepted" });

    notifySoulMateChanged(req, Array.from(notifyIds));
    res.json({ status: "accepted" });
  } catch (err) {
    console.error("Accept soul mate error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/soulmate/decline
router.post("/decline", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!isValidId(userId)) return res.status(400).json({ message: "Invalid user id." });

    await supabase.from("soulmates").delete()
      .eq("user_id", userId)
      .eq("partner_id", req.userId)
      .eq("status", "pending");

    notifySoulMateChanged(req, [req.userId, userId]);
    res.json({ status: "declined" });
  } catch (err) {
    console.error("Decline soul mate error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/soulmate/cancel
router.post("/cancel", auth, async (req, res) => {
  try {
    const { data: sentRow } = await supabase
      .from("soulmates")
      .select("partner_id")
      .eq("user_id", req.userId)
      .eq("status", "pending")
      .maybeSingle();

    if (!sentRow) return res.status(400).json({ message: "No outgoing request to cancel." });

    await supabase.from("soulmates").delete()
      .eq("user_id", req.userId)
      .eq("status", "pending");

    notifySoulMateChanged(req, [req.userId, sentRow.partner_id]);
    res.json({ status: "cancelled" });
  } catch (err) {
    console.error("Cancel soul mate error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// DELETE /api/soulmate — break up
router.delete("/", auth, async (req, res) => {
  try {
    const { data: smRow } = await supabase
      .from("soulmates")
      .select("user_id, partner_id")
      .or(`user_id.eq.${req.userId},partner_id.eq.${req.userId}`)
      .eq("status", "accepted")
      .maybeSingle();

    if (!smRow) return res.status(400).json({ message: "You don't have a soul mate." });

    const partnerId = smRow.user_id === req.userId ? smRow.partner_id : smRow.user_id;

    await supabase.from("soulmates").delete()
      .or(`user_id.eq.${req.userId},partner_id.eq.${req.userId}`)
      .eq("status", "accepted");

    notifySoulMateChanged(req, [req.userId, partnerId]);
    res.json({ status: "removed" });
  } catch (err) {
    console.error("Remove soul mate error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
