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

// Build thread summary objects for a set of threadIds, from the perspective of req.userId
async function buildThreadSummaries(threadIds, userId) {
  const summaries = await Promise.all(
    threadIds.map(async (threadId) => {
      const messages = await Mail.find({ threadId })
        .populate("from", "name")
        .populate("to", "name")
        .sort({ createdAt: 1 })
        .lean();
      if (!messages.length) return null;

      const unreadCount = messages.filter(
        (m) => String(m.to._id) === String(userId) && !m.read
      ).length;

      const last = messages[messages.length - 1];
      const first = messages[0];

      // The other participant is whoever isn't us in the first message
      const otherParticipant =
        String(first.from._id) === String(userId)
          ? { id: String(first.to._id), name: first.to.name }
          : { id: String(first.from._id), name: first.from.name };

      return {
        threadId,
        subject: first.subject,
        otherParticipant,
        lastMessage: {
          fromId: String(last.from._id),
          fromName: last.from.name,
          body: last.body,
          createdAt: last.createdAt,
          isFromMe: String(last.from._id) === String(userId),
        },
        unreadCount,
        totalCount: messages.length,
      };
    })
  );

  return summaries
    .filter(Boolean)
    .sort((a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt));
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

// GET /api/mail/inbox — threads where you received the first message
router.get("/inbox", auth, async (req, res) => {
  try {
    // Find threadIds where the first (oldest) message was addressed TO me
    const allMails = await Mail.find({
      $or: [{ to: req.userId }, { from: req.userId }],
    })
      .select("threadId from to createdAt")
      .sort({ createdAt: 1 })
      .lean();

    // For each thread, find the first message
    const firstByThread = new Map();
    for (const m of allMails) {
      if (!firstByThread.has(m.threadId)) {
        firstByThread.set(m.threadId, m);
      }
    }

    const inboxThreadIds = Array.from(firstByThread.entries())
      .filter(([, first]) => String(first.to) === String(req.userId))
      .map(([threadId]) => threadId);

    const summaries = await buildThreadSummaries(inboxThreadIds, req.userId);
    res.json(summaries);
  } catch (err) {
    console.error("Inbox error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/mail/sent — threads where you sent the first message
router.get("/sent", auth, async (req, res) => {
  try {
    const allMails = await Mail.find({
      $or: [{ to: req.userId }, { from: req.userId }],
    })
      .select("threadId from to createdAt")
      .sort({ createdAt: 1 })
      .lean();

    const firstByThread = new Map();
    for (const m of allMails) {
      if (!firstByThread.has(m.threadId)) {
        firstByThread.set(m.threadId, m);
      }
    }

    const sentThreadIds = Array.from(firstByThread.entries())
      .filter(([, first]) => String(first.from) === String(req.userId))
      .map(([threadId]) => threadId);

    const summaries = await buildThreadSummaries(sentThreadIds, req.userId);
    res.json(summaries);
  } catch (err) {
    console.error("Sent error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/mail/thread/:threadId — full message list for a thread
router.get("/thread/:threadId", auth, async (req, res) => {
  try {
    const { threadId } = req.params;
    const messages = await Mail.find({ threadId })
      .populate("from", "name")
      .populate("to", "name")
      .sort({ createdAt: 1 })
      .lean();

    if (!messages.length) return res.status(404).json({ message: "Thread not found." });

    // Verify the requesting user is a participant
    const isParticipant = messages.some(
      (m) =>
        String(m.from._id) === String(req.userId) ||
        String(m.to._id) === String(req.userId)
    );
    if (!isParticipant) return res.status(403).json({ message: "Forbidden." });

    const first = messages[0];
    const otherParticipant =
      String(first.from._id) === String(req.userId)
        ? { id: String(first.to._id), name: first.to.name }
        : { id: String(first.from._id), name: first.from.name };

    res.json({
      threadId,
      subject: first.subject,
      otherParticipant,
      messages: messages.map((m) => ({
        id: String(m._id),
        fromId: String(m.from._id),
        fromName: m.from.name,
        body: m.body,
        read: m.read,
        isFromMe: String(m.from._id) === String(req.userId),
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    console.error("Thread fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// PATCH /api/mail/thread/:threadId/read — mark all unread messages in thread as read
router.patch("/thread/:threadId/read", auth, async (req, res) => {
  try {
    await Mail.updateMany(
      { threadId: req.params.threadId, to: req.userId, read: false },
      { $set: { read: true } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Mark thread read error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/mail/send — start a new thread
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
    if (!target) return res.status(404).json({ message: "Player not found." });

    const threadId = new mongoose.Types.ObjectId().toString();

    const mail = await Mail.create({
      threadId,
      from: req.userId,
      to: targetId,
      subject: subject.trim(),
      body: body.trim(),
    });

    const me = await User.findById(req.userId).select("name").lean();
    notifyMailNew(req, targetId, {
      id: String(mail._id),
      threadId,
      from: { id: String(req.userId), name: me?.name || "Unknown" },
      subject: mail.subject,
    });

    res.json({ id: String(mail._id), threadId });
  } catch (err) {
    console.error("Send mail error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/mail/reply — reply within an existing thread
router.post("/reply", auth, async (req, res) => {
  try {
    const { threadId, body } = req.body;
    if (!threadId) return res.status(400).json({ message: "threadId required." });
    if (!body?.trim() || body.trim().length > 2000) {
      return res.status(400).json({ message: "Body must be 1–2000 characters." });
    }

    // Find the thread and verify participation
    const firstMessage = await Mail.findOne({ threadId })
      .sort({ createdAt: 1 })
      .lean();
    if (!firstMessage) return res.status(404).json({ message: "Thread not found." });

    const fromStr = String(firstMessage.from);
    const toStr = String(firstMessage.to);
    const meStr = String(req.userId);

    if (fromStr !== meStr && toStr !== meStr) {
      return res.status(403).json({ message: "Not a participant." });
    }

    // Reply goes to the other participant
    const recipientId = fromStr === meStr ? toStr : fromStr;

    const mail = await Mail.create({
      threadId,
      from: req.userId,
      to: recipientId,
      subject: firstMessage.subject,
      body: body.trim(),
    });

    const me = await User.findById(req.userId).select("name").lean();
    notifyMailNew(req, recipientId, {
      id: String(mail._id),
      threadId,
      from: { id: meStr, name: me?.name || "Unknown" },
      subject: firstMessage.subject,
    });

    res.json({ id: String(mail._id), threadId });
  } catch (err) {
    console.error("Reply error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
