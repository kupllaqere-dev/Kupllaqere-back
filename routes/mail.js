const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const Mail = require("../models/Mail");
const User = require("../models/User");

const router = express.Router();

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function notifyMailNew(req, toUserId, summary) {
  const io = req.app.locals.io;
  const socketsForUser = req.app.locals.socketsForUser;
  if (!io || !socketsForUser) return;
  for (const sid of socketsForUser(String(toUserId))) {
    io.to(sid).emit("mail:new", summary);
  }
}

// GET /api/mail/unread-count
router.get("/unread-count", auth, async (req, res) => {
  try {
    const count = await Mail.countDocuments({ to: req.userId, read: false });
    res.json({ count });
  } catch (err) {
    console.error("Unread count error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/mail/inbox
router.get("/inbox", auth, async (req, res) => {
  try {
    const mails = await Mail.find({ to: req.userId })
      .sort({ createdAt: -1 })
      .populate("from", "name")
      .lean();
    res.json(
      mails.map((m) => ({
        id: String(m._id),
        from: { id: String(m.from._id), name: m.from.name },
        subject: m.subject,
        body: m.body,
        read: m.read,
        createdAt: m.createdAt,
      }))
    );
  } catch (err) {
    console.error("Inbox error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/mail/sent
router.get("/sent", auth, async (req, res) => {
  try {
    const mails = await Mail.find({ from: req.userId })
      .sort({ createdAt: -1 })
      .populate("to", "name")
      .lean();
    res.json(
      mails.map((m) => ({
        id: String(m._id),
        to: { id: String(m.to._id), name: m.to.name },
        subject: m.subject,
        body: m.body,
        createdAt: m.createdAt,
      }))
    );
  } catch (err) {
    console.error("Sent error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/mail/send
router.post("/send", auth, async (req, res) => {
  try {
    const { targetId, subject, body } = req.body;
    if (!isValidId(targetId)) {
      return res.status(400).json({ message: "Invalid target." });
    }
    if (String(targetId) === String(req.userId)) {
      return res.status(400).json({ message: "You cannot mail yourself." });
    }
    if (!subject?.trim() || subject.trim().length > 100) {
      return res.status(400).json({ message: "Subject must be 1–100 characters." });
    }
    if (!body?.trim() || body.trim().length > 2000) {
      return res.status(400).json({ message: "Body must be 1–2000 characters." });
    }

    const target = await User.findById(targetId).lean();
    if (!target) {
      return res.status(404).json({ message: "Player not found." });
    }

    const mail = await Mail.create({
      from: req.userId,
      to: targetId,
      subject: subject.trim(),
      body: body.trim(),
    });

    const me = await User.findById(req.userId).select("name").lean();
    notifyMailNew(req, targetId, {
      id: String(mail._id),
      from: { id: String(req.userId), name: me?.name || "Unknown" },
      subject: mail.subject,
    });

    res.json({ id: String(mail._id) });
  } catch (err) {
    console.error("Send mail error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// PATCH /api/mail/:id/read
router.patch("/:id/read", auth, async (req, res) => {
  try {
    const mail = await Mail.findById(req.params.id);
    if (!mail) return res.status(404).json({ message: "Mail not found." });
    if (String(mail.to) !== String(req.userId)) {
      return res.status(403).json({ message: "Forbidden." });
    }
    mail.read = true;
    await mail.save();
    res.json({ ok: true });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
