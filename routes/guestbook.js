const express = require("express");
const auth = require("../middleware/auth");
const supabase = require("../lib/supabase");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

// GET /api/guestbook/:userId
router.get("/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidId(userId)) return res.status(400).json({ message: "Invalid user ID" });

    const { data: comments, error } = await supabase
      .from("guestbook_comments")
      .select("*")
      .eq("profile_user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;

    res.json({ comments: comments || [] });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/guestbook/:userId
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

    const [{ data: profileUser }, { data: author }] = await Promise.all([
      supabase.from("profiles").select("id").eq("id", userId).maybeSingle(),
      supabase.from("profiles").select("id, name").eq("id", req.userId).single(),
    ]);
    if (!profileUser) return res.status(404).json({ message: "User not found" });
    if (!author) return res.status(401).json({ message: "Author not found" });

    const { data: comment, error } = await supabase
      .from("guestbook_comments")
      .insert({
        profile_user_id: userId,
        author_id:       req.userId,
        author_name:     author.name,
        message:         message.trim(),
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ comment });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/guestbook/:commentId
router.delete("/:commentId", auth, async (req, res) => {
  try {
    const { commentId } = req.params;
    if (!isValidId(commentId)) return res.status(400).json({ message: "Invalid comment ID" });

    const { data: comment, error: fetchErr } = await supabase
      .from("guestbook_comments")
      .select("id, profile_user_id")
      .eq("id", commentId)
      .maybeSingle();

    if (fetchErr || !comment) return res.status(404).json({ message: "Comment not found" });

    if (comment.profile_user_id !== req.userId) {
      return res.status(403).json({ message: "Only the profile owner can delete comments" });
    }

    await supabase.from("guestbook_comments").delete().eq("id", commentId);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
