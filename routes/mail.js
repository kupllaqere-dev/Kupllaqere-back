const express = require("express");
const { v4: uuidv4 } = require("uuid");
const auth = require("../middleware/auth");
const supabase = require("../lib/supabase");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

function notifyMailNew(req, toUserId, summary) {
  const io = req.app.locals.io;
  const socketsForUser = req.app.locals.socketsForUser;
  if (!io || !socketsForUser) return;
  for (const sid of socketsForUser(String(toUserId))) {
    io.to(sid).emit("mail:new", summary);
  }
}

async function buildThreadSummaries(threadIds, userId) {
  if (!threadIds.length) return [];

  const { data: allMessages } = await supabase
    .from("mail")
    .select("id, thread_id, from_id, to_id, subject, body, read, created_at")
    .in("thread_id", threadIds)
    .order("created_at", { ascending: true });

  if (!allMessages || !allMessages.length) return [];

  // Collect participant IDs for a single name-lookup
  const participantIds = [
    ...new Set(allMessages.flatMap((m) => [m.from_id, m.to_id]).filter(Boolean)),
  ];
  const { data: participants } = await supabase
    .from("profiles")
    .select("id, name")
    .in("id", participantIds);
  const nameOf = Object.fromEntries((participants || []).map((p) => [p.id, p.name]));

  // Group messages by thread
  const byThread = {};
  for (const m of allMessages) {
    if (!byThread[m.thread_id]) byThread[m.thread_id] = [];
    byThread[m.thread_id].push(m);
  }

  const summaries = [];
  for (const threadId of threadIds) {
    const msgs = byThread[threadId];
    if (!msgs || !msgs.length) continue;

    const first = msgs[0];
    const last  = msgs[msgs.length - 1];

    // Drop threads where both participants are deleted
    if (!nameOf[first.from_id] && !nameOf[first.to_id]) continue;

    const unreadCount = msgs.filter((m) => m.to_id === userId && !m.read).length;
    const otherParticipantId = first.from_id === userId ? first.to_id : first.from_id;

    summaries.push({
      threadId,
      subject: first.subject,
      otherParticipant: {
        id: otherParticipantId,
        name: nameOf[otherParticipantId] || "Deleted User",
      },
      lastMessage: {
        fromId:    last.from_id,
        fromName:  nameOf[last.from_id] || "Deleted User",
        body:      last.body,
        createdAt: last.created_at,
        isFromMe:  last.from_id === userId,
      },
      unreadCount,
      totalCount: msgs.length,
    });
  }

  return summaries.sort(
    (a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt)
  );
}

// GET /api/mail/unread-count
router.get("/unread-count", auth, async (req, res) => {
  try {
    const { count, error } = await supabase
      .from("mail")
      .select("*", { count: "exact", head: true })
      .eq("to_id", req.userId)
      .eq("read", false);
    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (err) {
    console.error("Unread count error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/mail/inbox — threads where you received the first message
router.get("/inbox", auth, async (req, res) => {
  try {
    const { data: allMails } = await supabase
      .from("mail")
      .select("thread_id, from_id, to_id")
      .or(`from_id.eq.${req.userId},to_id.eq.${req.userId}`)
      .order("created_at", { ascending: true });

    const firstByThread = {};
    for (const m of allMails || []) {
      if (!firstByThread[m.thread_id]) firstByThread[m.thread_id] = m;
    }

    const inboxThreadIds = Object.entries(firstByThread)
      .filter(([, first]) => first.to_id === req.userId)
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
    const { data: allMails } = await supabase
      .from("mail")
      .select("thread_id, from_id, to_id")
      .or(`from_id.eq.${req.userId},to_id.eq.${req.userId}`)
      .order("created_at", { ascending: true });

    const firstByThread = {};
    for (const m of allMails || []) {
      if (!firstByThread[m.thread_id]) firstByThread[m.thread_id] = m;
    }

    const sentThreadIds = Object.entries(firstByThread)
      .filter(([, first]) => first.from_id === req.userId)
      .map(([threadId]) => threadId);

    const summaries = await buildThreadSummaries(sentThreadIds, req.userId);
    res.json(summaries);
  } catch (err) {
    console.error("Sent error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// GET /api/mail/thread/:threadId
router.get("/thread/:threadId", auth, async (req, res) => {
  try {
    const { threadId } = req.params;

    const { data: allMessages } = await supabase
      .from("mail")
      .select("id, thread_id, from_id, to_id, subject, body, read, created_at")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true });

    if (!allMessages || !allMessages.length) {
      return res.status(404).json({ message: "Thread not found." });
    }

    // Verify participation
    const isParticipant = allMessages.some(
      (m) => m.from_id === req.userId || m.to_id === req.userId
    );
    if (!isParticipant) return res.status(403).json({ message: "Forbidden." });

    // Fetch participant names
    const participantIds = [...new Set(allMessages.flatMap((m) => [m.from_id, m.to_id]).filter(Boolean))];
    const { data: participants } = await supabase
      .from("profiles")
      .select("id, name")
      .in("id", participantIds);
    const nameOf = Object.fromEntries((participants || []).map((p) => [p.id, p.name]));

    const first = allMessages[0];
    const otherParticipantId = first.from_id === req.userId ? first.to_id : first.from_id;

    res.json({
      threadId,
      subject: first.subject,
      otherParticipant: {
        id: otherParticipantId,
        name: nameOf[otherParticipantId] || "Deleted User",
      },
      messages: allMessages.map((m) => ({
        id:       m.id,
        fromId:   m.from_id,
        fromName: nameOf[m.from_id] || "Deleted User",
        body:     m.body,
        read:     m.read,
        isFromMe: m.from_id === req.userId,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error("Thread fetch error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// PATCH /api/mail/thread/:threadId/read
router.patch("/thread/:threadId/read", auth, async (req, res) => {
  try {
    await supabase
      .from("mail")
      .update({ read: true })
      .eq("thread_id", req.params.threadId)
      .eq("to_id", req.userId)
      .eq("read", false);
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
    if (!isValidId(targetId)) return res.status(400).json({ message: "Invalid target." });
    if (targetId === req.userId) return res.status(400).json({ message: "You cannot mail yourself." });
    if (!subject?.trim() || subject.trim().length > 100) {
      return res.status(400).json({ message: "Subject must be 1–100 characters." });
    }
    if (!body?.trim() || body.trim().length > 2000) {
      return res.status(400).json({ message: "Body must be 1–2000 characters." });
    }

    const { data: target } = await supabase.from("profiles").select("id").eq("id", targetId).maybeSingle();
    if (!target) return res.status(404).json({ message: "Player not found." });

    const threadId = uuidv4();

    const { data: mail, error } = await supabase
      .from("mail")
      .insert({
        thread_id: threadId,
        from_id:   req.userId,
        to_id:     targetId,
        subject:   subject.trim(),
        body:      body.trim(),
      })
      .select("id")
      .single();
    if (error) throw error;

    const { data: me } = await supabase.from("profiles").select("name").eq("id", req.userId).single();
    notifyMailNew(req, targetId, {
      id:       mail.id,
      threadId,
      from:     { id: req.userId, name: me?.name || "Unknown" },
      subject:  subject.trim(),
    });

    res.json({ id: mail.id, threadId });
  } catch (err) {
    console.error("Send mail error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// POST /api/mail/reply
router.post("/reply", auth, async (req, res) => {
  try {
    const { threadId, body } = req.body;
    if (!threadId) return res.status(400).json({ message: "threadId required." });
    if (!body?.trim() || body.trim().length > 2000) {
      return res.status(400).json({ message: "Body must be 1–2000 characters." });
    }

    const { data: firstMessage } = await supabase
      .from("mail")
      .select("from_id, to_id, subject")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!firstMessage) return res.status(404).json({ message: "Thread not found." });

    if (firstMessage.from_id !== req.userId && firstMessage.to_id !== req.userId) {
      return res.status(403).json({ message: "Not a participant." });
    }

    const recipientId = firstMessage.from_id === req.userId ? firstMessage.to_id : firstMessage.from_id;

    const { data: mail, error } = await supabase
      .from("mail")
      .insert({
        thread_id: threadId,
        from_id:   req.userId,
        to_id:     recipientId,
        subject:   firstMessage.subject,
        body:      body.trim(),
      })
      .select("id")
      .single();
    if (error) throw error;

    const { data: me } = await supabase.from("profiles").select("name").eq("id", req.userId).single();
    notifyMailNew(req, recipientId, {
      id:      mail.id,
      threadId,
      from:    { id: req.userId, name: me?.name || "Unknown" },
      subject: firstMessage.subject,
    });

    res.json({ id: mail.id, threadId });
  } catch (err) {
    console.error("Reply error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
