const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");

const router = express.Router();

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function publicSummary(user) {
  if (!user) return null;
  return { id: String(user._id), name: user.name };
}

function notifySoulMateChanged(req, userIds) {
  const io = req.app.locals.io;
  const socketsForUser = req.app.locals.socketsForUser;
  if (!io || !socketsForUser) return;
  const seen = new Set();
  for (const uid of userIds) {
    if (!uid) continue;
    const key = String(uid);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const sid of socketsForUser(key)) {
      io.to(sid).emit("soulmate:refresh");
    }
  }
}

async function buildOwnState(userId) {
  const me = await User.findById(userId)
    .populate("soulMate", "name")
    .populate("soulMateRequestSent", "name")
    .populate("soulMateRequestsReceived", "name")
    .lean();
  if (!me) return null;
  return {
    mine: publicSummary(me.soulMate),
    sent: publicSummary(me.soulMateRequestSent),
    received: (me.soulMateRequestsReceived || []).map(publicSummary).filter(Boolean),
  };
}

// GET /api/soulmate?targetId=...
// Returns my soul mate state. If targetId is supplied, also returns
// public soul mate info for that user and the relationship between us.
router.get("/", auth, async (req, res) => {
  try {
    const own = await buildOwnState(req.userId);
    if (!own) return res.status(404).json({ message: "User not found." });

    const out = { ...own };
    const { targetId } = req.query;
    if (targetId) {
      if (!isValidId(targetId)) {
        return res.status(400).json({ message: "Invalid target id." });
      }
      const target = await User.findById(targetId)
        .populate("soulMate", "name")
        .lean();
      if (!target) {
        return res.status(404).json({ message: "Target not found." });
      }
      const targetSelf = String(targetId) === String(req.userId);
      let relationship = "none";
      if (targetSelf) relationship = "self";
      else if (own.mine && String(own.mine.id) === String(targetId)) {
        relationship = "soulmate";
      } else if (own.sent && String(own.sent.id) === String(targetId)) {
        relationship = "i_sent";
      } else if (own.received.some((r) => String(r.id) === String(targetId))) {
        relationship = "they_sent";
      }
      out.target = {
        id: String(target._id),
        name: target.name,
        soulMate: publicSummary(target.soulMate),
      };
      out.relationship = relationship;
    }
    res.json(out);
  } catch (err) {
    console.error("Get soul mate state error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/soulmate/request — propose soul mate to target
router.post("/request", auth, async (req, res) => {
  try {
    const { targetId } = req.body;
    if (!isValidId(targetId)) {
      return res.status(400).json({ message: "Invalid target id." });
    }
    if (String(targetId) === String(req.userId)) {
      return res.status(400).json({ message: "You cannot soul-mate yourself." });
    }

    const [me, target] = await Promise.all([
      User.findById(req.userId),
      User.findById(targetId),
    ]);
    if (!me || !target) {
      return res.status(404).json({ message: "User not found." });
    }

    if (me.soulMate) {
      return res.status(409).json({ message: "You already have a soul mate." });
    }
    if (target.soulMate) {
      return res
        .status(409)
        .json({ message: "That player already has a soul mate." });
    }
    if (
      me.soulMateRequestSent &&
      String(me.soulMateRequestSent) === String(targetId)
    ) {
      return res.status(409).json({ message: "Request already sent." });
    }

    // If the target already sent me a request, accept it instead.
    const targetAlreadyAskedMe = (me.soulMateRequestsReceived || []).some(
      (id) => String(id) === String(targetId),
    );
    if (targetAlreadyAskedMe) {
      // Become soul mates
      me.soulMate = target._id;
      target.soulMate = me._id;
      // Clear all pending state on both sides
      me.soulMateRequestSent = null;
      me.soulMateRequestsReceived = [];
      target.soulMateRequestSent = null;
      target.soulMateRequestsReceived = [];
      await Promise.all([me.save(), target.save()]);
      notifySoulMateChanged(req, [req.userId, targetId]);
      return res.json({ status: "accepted" });
    }

    // If I previously sent a request to someone else, cancel it first.
    if (me.soulMateRequestSent) {
      const prevTargetId = me.soulMateRequestSent;
      await User.findByIdAndUpdate(prevTargetId, {
        $pull: { soulMateRequestsReceived: me._id },
      });
      notifySoulMateChanged(req, [prevTargetId]);
    }

    me.soulMateRequestSent = target._id;
    if (
      !target.soulMateRequestsReceived.some(
        (id) => String(id) === String(req.userId),
      )
    ) {
      target.soulMateRequestsReceived.push(me._id);
    }
    await Promise.all([me.save(), target.save()]);
    notifySoulMateChanged(req, [req.userId, targetId]);
    res.json({ status: "sent" });
  } catch (err) {
    console.error("Send soul mate request error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/soulmate/accept — accept an incoming request
router.post("/accept", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!isValidId(userId)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    const [me, other] = await Promise.all([
      User.findById(req.userId),
      User.findById(userId),
    ]);
    if (!me || !other) {
      return res.status(404).json({ message: "User not found." });
    }

    if (me.soulMate) {
      return res.status(409).json({ message: "You already have a soul mate." });
    }
    if (other.soulMate) {
      return res
        .status(409)
        .json({ message: "That player already has a soul mate." });
    }

    const hasRequest = (me.soulMateRequestsReceived || []).some(
      (id) => String(id) === String(userId),
    );
    if (!hasRequest) {
      return res
        .status(400)
        .json({ message: "No pending request from this user." });
    }

    // Cancel any other outgoing or incoming requests on either side, since
    // they are now soul mates and a user can only have one.
    const notifyIds = new Set([String(req.userId), String(userId)]);

    if (me.soulMateRequestSent) {
      const prev = me.soulMateRequestSent;
      await User.findByIdAndUpdate(prev, {
        $pull: { soulMateRequestsReceived: me._id },
      });
      notifyIds.add(String(prev));
    }
    if (other.soulMateRequestSent) {
      const prev = other.soulMateRequestSent;
      await User.findByIdAndUpdate(prev, {
        $pull: { soulMateRequestsReceived: other._id },
      });
      notifyIds.add(String(prev));
    }
    // Remove me from anyone else who had asked me, and the other from anyone who asked them
    for (const otherIncomingId of me.soulMateRequestsReceived || []) {
      if (String(otherIncomingId) === String(userId)) continue;
      await User.findByIdAndUpdate(otherIncomingId, {
        $set: { soulMateRequestSent: null },
      });
      notifyIds.add(String(otherIncomingId));
    }
    for (const otherIncomingId of other.soulMateRequestsReceived || []) {
      if (String(otherIncomingId) === String(req.userId)) continue;
      await User.findByIdAndUpdate(otherIncomingId, {
        $set: { soulMateRequestSent: null },
      });
      notifyIds.add(String(otherIncomingId));
    }

    me.soulMate = other._id;
    other.soulMate = me._id;
    me.soulMateRequestSent = null;
    me.soulMateRequestsReceived = [];
    other.soulMateRequestSent = null;
    other.soulMateRequestsReceived = [];

    await Promise.all([me.save(), other.save()]);
    notifySoulMateChanged(req, Array.from(notifyIds));
    res.json({ status: "accepted" });
  } catch (err) {
    console.error("Accept soul mate error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/soulmate/decline — decline an incoming request
router.post("/decline", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!isValidId(userId)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    await User.findByIdAndUpdate(req.userId, {
      $pull: { soulMateRequestsReceived: userId },
    });
    await User.findByIdAndUpdate(userId, {
      $set: { soulMateRequestSent: null },
    });

    notifySoulMateChanged(req, [req.userId, userId]);
    res.json({ status: "declined" });
  } catch (err) {
    console.error("Decline soul mate error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/soulmate/cancel — cancel my outgoing request
router.post("/cancel", auth, async (req, res) => {
  try {
    const me = await User.findById(req.userId);
    if (!me) return res.status(404).json({ message: "User not found." });

    const targetId = me.soulMateRequestSent;
    if (!targetId) {
      return res.status(400).json({ message: "No outgoing request to cancel." });
    }

    me.soulMateRequestSent = null;
    await me.save();
    await User.findByIdAndUpdate(targetId, {
      $pull: { soulMateRequestsReceived: req.userId },
    });

    notifySoulMateChanged(req, [req.userId, targetId]);
    res.json({ status: "cancelled" });
  } catch (err) {
    console.error("Cancel soul mate error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// DELETE /api/soulmate — break up
router.delete("/", auth, async (req, res) => {
  try {
    const me = await User.findById(req.userId);
    if (!me) return res.status(404).json({ message: "User not found." });

    const partnerId = me.soulMate;
    if (!partnerId) {
      return res.status(400).json({ message: "You don't have a soul mate." });
    }

    me.soulMate = null;
    await me.save();
    await User.findByIdAndUpdate(partnerId, { $set: { soulMate: null } });

    notifySoulMateChanged(req, [req.userId, partnerId]);
    res.json({ status: "removed" });
  } catch (err) {
    console.error("Remove soul mate error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
