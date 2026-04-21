const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const { isOnline } = require("../lib/online");

const router = express.Router();

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
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

function publicSummary(user) {
  return {
    id: user._id,
    name: user.name,
    avatar: user.avatar,
    online: isOnline(user._id),
  };
}

// ── GET /api/friends — list friends + pending requests ──
router.get("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .populate("friends", "name avatar customization")
      .populate("friendRequestsReceived", "name avatar customization")
      .populate("friendRequestsSent", "name avatar customization")
      .lean();

    if (!user) return res.status(404).json({ message: "User not found." });

    const friends = (user.friends || []).map((f) => ({
      id: f._id,
      name: f.name,
      avatar: f.avatar,
      outfit: extractOutfit(f.customization),
      online: isOnline(f._id),
    }));

    const received = (user.friendRequestsReceived || []).map((f) => ({
      id: f._id,
      name: f.name,
      avatar: f.avatar,
      outfit: extractOutfit(f.customization),
    }));

    const sent = (user.friendRequestsSent || []).map((f) => ({
      id: f._id,
      name: f.name,
      avatar: f.avatar,
      outfit: extractOutfit(f.customization),
    }));

    res.json({ friends, received, sent });
  } catch (err) {
    console.error("List friends error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/friends/request — send a friend request ──
router.post("/request", auth, async (req, res) => {
  try {
    const { targetId } = req.body;

    if (!isValidId(targetId)) {
      return res.status(400).json({ message: "Invalid target id." });
    }
    if (String(targetId) === String(req.userId)) {
      return res.status(400).json({ message: "You cannot friend yourself." });
    }

    const [me, target] = await Promise.all([
      User.findById(req.userId),
      User.findById(targetId),
    ]);

    if (!me || !target) {
      return res.status(404).json({ message: "User not found." });
    }

    if (me.friends.some((id) => String(id) === String(targetId))) {
      return res.status(409).json({ message: "Already friends." });
    }

    // If the target had already sent me a request, accept it instead.
    if (me.friendRequestsReceived.some((id) => String(id) === String(targetId))) {
      me.friendRequestsReceived = me.friendRequestsReceived.filter(
        (id) => String(id) !== String(targetId),
      );
      target.friendRequestsSent = target.friendRequestsSent.filter(
        (id) => String(id) !== String(req.userId),
      );
      me.friends.push(target._id);
      target.friends.push(me._id);
      await Promise.all([me.save(), target.save()]);
      return res.json({ status: "accepted" });
    }

    if (me.friendRequestsSent.some((id) => String(id) === String(targetId))) {
      return res.status(409).json({ message: "Request already sent." });
    }

    me.friendRequestsSent.push(target._id);
    target.friendRequestsReceived.push(me._id);
    await Promise.all([me.save(), target.save()]);

    res.json({ status: "sent" });
  } catch (err) {
    console.error("Send friend request error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/friends/accept — accept a received request ──
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

    if (!me.friendRequestsReceived.some((id) => String(id) === String(userId))) {
      return res.status(400).json({ message: "No pending request from this user." });
    }

    me.friendRequestsReceived = me.friendRequestsReceived.filter(
      (id) => String(id) !== String(userId),
    );
    other.friendRequestsSent = other.friendRequestsSent.filter(
      (id) => String(id) !== String(req.userId),
    );

    if (!me.friends.some((id) => String(id) === String(userId))) {
      me.friends.push(other._id);
    }
    if (!other.friends.some((id) => String(id) === String(req.userId))) {
      other.friends.push(me._id);
    }

    await Promise.all([me.save(), other.save()]);
    res.json({ status: "accepted" });
  } catch (err) {
    console.error("Accept friend error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/friends/decline — decline a received request ──
router.post("/decline", auth, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!isValidId(userId)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    await User.findByIdAndUpdate(req.userId, {
      $pull: { friendRequestsReceived: userId },
    });
    await User.findByIdAndUpdate(userId, {
      $pull: { friendRequestsSent: req.userId },
    });

    res.json({ status: "declined" });
  } catch (err) {
    console.error("Decline friend error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── POST /api/friends/cancel — cancel a sent request ──
router.post("/cancel", auth, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!isValidId(userId)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    await User.findByIdAndUpdate(req.userId, {
      $pull: { friendRequestsSent: userId },
    });
    await User.findByIdAndUpdate(userId, {
      $pull: { friendRequestsReceived: req.userId },
    });

    res.json({ status: "cancelled" });
  } catch (err) {
    console.error("Cancel friend error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── DELETE /api/friends/:id — remove a friend ──
router.delete("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    await User.findByIdAndUpdate(req.userId, { $pull: { friends: id } });
    await User.findByIdAndUpdate(id, { $pull: { friends: req.userId } });

    res.json({ status: "removed" });
  } catch (err) {
    console.error("Remove friend error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
