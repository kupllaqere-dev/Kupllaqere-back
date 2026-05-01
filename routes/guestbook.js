const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const GuestBookComment = require("../models/GuestBookComment");
const User = require("../models/User");

const router = express.Router();

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// GET /api/guestbook/:userId — fetch all comments for a profile
router.get("/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidId(userId)) return res.status(400).json({ message: "Invalid user ID" });

    const comments = await GuestBookComment.find({ profileUserId: userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ comments });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/guestbook/:userId — post a comment on someone's profile
router.post("/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidId(userId)) return res.status(400).json({ message: "Invalid user ID" });

    const { message } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ message: "Message is required" });
    }
    if (message.trim().length > 100) {
      return res.status(400).json({ message: "Message too long (max 100 characters)" });
    }

    const [profileUser, author] = await Promise.all([
      User.findById(userId).lean(),
      User.findById(req.userId).lean(),
    ]);
    if (!profileUser) return res.status(404).json({ message: "User not found" });
    if (!author) return res.status(401).json({ message: "Author not found" });

    const comment = await GuestBookComment.create({
      profileUserId: userId,
      authorId: req.userId,
      authorName: author.name,
      message: message.trim(),
    });

    res.status(201).json({ comment });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/guestbook/:commentId — delete a comment (profile owner only)
router.delete("/:commentId", auth, async (req, res) => {
  try {
    const { commentId } = req.params;
    if (!isValidId(commentId)) return res.status(400).json({ message: "Invalid comment ID" });

    const comment = await GuestBookComment.findById(commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    if (String(comment.profileUserId) !== String(req.userId)) {
      return res.status(403).json({ message: "Only the profile owner can delete comments" });
    }

    await comment.deleteOne();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
