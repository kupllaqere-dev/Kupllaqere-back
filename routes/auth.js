const express = require("express");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many login attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { message: "Too many accounts created from this IP. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const guestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { message: "Too many guest sessions from this IP. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// email is read-only — synced from auth.users by the DB trigger
function toPublic(profile) {
  const roles = [...new Set([profile.role || "player", ...(profile.roles || [])])];
  const needsSetup = !profile.is_guest && !profile.name;
  return {
    id:           profile.id,
    name:         profile.name || "",
    email:        profile.email,
    gender:       profile.gender,
    avatar:       profile.avatar || "",
    bio:          profile.bio || "",
    selectedBadge: profile.selected_badge || null,
    isGuest:      profile.is_guest || false,
    isBanned:     profile.is_banned || false,
    role:         profile.role || "player",
    roles,
    level:        profile.level || 1,
    coins:        profile.coins || 0,
    gems:         profile.gems || 0,
    customization: profile.customization || {},
    ...(needsSetup ? { needsSetup: true } : {}),
  };
}

// ── Register ──────────────────────────────────────────────
// Uses Supabase signUp — respects project email-confirmation setting.
// Profile is created automatically by the DB trigger on auth.users insert.
router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    const { data, error } = await supabase.auth.signUp({
      email: email.toLowerCase(),
      password,
    });

    if (error) {
      if (error.message?.toLowerCase().includes("already registered")) {
        return res.status(409).json({ message: "Email already in use." });
      }
      throw error;
    }

    // Email confirmation required — session is null until confirmed
    if (!data.session) {
      return res.status(201).json({ message: "Check your email to confirm your account." });
    }

    // Profile was created by the DB trigger
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();
    if (profileError || !profile) return res.status(500).json({ message: "Profile creation failed." });

    res.status(201).json({ user: toPublic(profile), token: data.session.access_token, refreshToken: data.session.refresh_token });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Login ─────────────────────────────────────────────────
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const { data: { session }, error } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase(),
      password,
    });
    if (error) return res.status(401).json({ message: "Invalid email or password." });

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", session.user.id)
      .single();
    if (profileError || !profile) return res.status(404).json({ message: "Profile not found." });

    res.json({ user: toPublic(profile), token: session.access_token, refreshToken: session.refresh_token });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── Guest ─────────────────────────────────────────────────
// Uses admin.createUser to bypass email confirmation for disposable accounts.
// Profile is created by the DB trigger, then updated with guest-specific fields.
router.post("/guest", guestLimiter, async (req, res) => {
  try {
    const guestEmail    = `guest_${uuidv4()}@guest.fv`;
    const guestPassword = uuidv4();
    const guestName     = `Guest_${uuidv4().slice(0, 6)}`;

    const { data: { user }, error: createError } = await supabase.auth.admin.createUser({
      email: guestEmail,
      password: guestPassword,
      email_confirm: true,
    });
    if (createError) throw createError;

    // Trigger already inserted the profile row — set guest-specific fields
    await supabase
      .from("profiles")
      .update({ name: guestName, is_guest: true })
      .eq("id", user.id);

    const { data: { session }, error: signInError } = await supabase.auth.signInWithPassword({
      email: guestEmail,
      password: guestPassword,
    });
    if (signInError) throw signInError;

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    res.status(201).json({ user: toPublic(profile), token: session.access_token, refreshToken: session.refresh_token });
  } catch (err) {
    console.error("Guest creation error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Me (used after OAuth redirect to fetch profile) ───────
router.get("/me", auth, async (req, res) => {
  try {
    let { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.userId)
      .single();

    if (!profile) {
      // Auth user exists but profile was deleted — recreate it
      const { data: { user: authUser } } = await supabase.auth.admin.getUserById(req.userId);
      const { data: created, error: insertError } = await supabase
        .from("profiles")
        .insert({ id: req.userId, email: authUser?.email || null })
        .select()
        .single();
      if (insertError || !created) return res.status(404).json({ message: "Profile not found." });
      profile = created;
    }

    res.json({ user: toPublic(profile) });
  } catch (err) {
    console.error("Me error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Setup (choose name + gender after first login) ────────
router.post("/setup", auth, async (req, res) => {
  try {
    const { name, gender } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: "Name is required." });
    if (gender && !["male", "female"].includes(gender)) {
      return res.status(400).json({ message: "Invalid gender." });
    }

    const update = { name: name.trim() };
    if (gender) update.gender = gender;

    const { data: profile, error } = await supabase
      .from("profiles")
      .update(update)
      .eq("id", req.userId)
      .select()
      .single();
    if (error || !profile) return res.status(404).json({ message: "User not found." });

    res.json({ user: toPublic(profile) });
  } catch (err) {
    console.error("Setup error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Refresh token ─────────────────────────────────────────
router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ message: "Refresh token required." });

    const { data: { session }, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !session) return res.status(401).json({ message: "Invalid or expired refresh token." });

    res.json({ token: session.access_token, refreshToken: session.refresh_token });
  } catch (err) {
    console.error("Refresh error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

function extractOutfitShallow(customization) {
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

// ── Lookup user by name (case-insensitive exact match) ────
router.get("/user", auth, async (req, res) => {
  try {
    const name = (req.query.name || "").trim();
    if (!name) return res.status(400).json({ message: "Name required." });
    if (name.length > 100) return res.status(400).json({ message: "Name too long." });

    const { data: user } = await supabase
      .from("profiles")
      .select("id, name, gender, bio, selected_badge, customization")
      .ilike("name", name)
      .maybeSingle();

    if (!user) return res.status(404).json({ message: "User not found." });

    const { data: smRow } = await supabase
      .from("soulmates")
      .select("user_id, partner_id")
      .or(`user_id.eq.${user.id},partner_id.eq.${user.id}`)
      .eq("status", "accepted")
      .maybeSingle();

    let soulMate = null;
    if (smRow) {
      const smId = smRow.user_id === user.id ? smRow.partner_id : smRow.user_id;
      const { data: sm } = await supabase.from("profiles").select("id, name").eq("id", smId).single();
      if (sm) soulMate = { id: sm.id, name: sm.name };
    }

    res.json({
      user: {
        id:           user.id,
        name:         user.name,
        gender:       user.gender,
        bio:          user.bio || "",
        selectedBadge: user.selected_badge || null,
        outfit:       extractOutfitShallow(user.customization),
        soulMate,
      },
    });
  } catch (err) {
    console.error("User lookup error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Update bio ────────────────────────────────────────────
router.patch("/bio", auth, async (req, res) => {
  try {
    const { bio } = req.body;
    if (typeof bio !== "string") return res.status(400).json({ message: "Bio must be a string." });
    const trimmed = bio.trim();
    if (trimmed.length > 500) return res.status(400).json({ message: "Bio must be 500 characters or fewer." });

    const { data: profile, error } = await supabase
      .from("profiles")
      .update({ bio: trimmed })
      .eq("id", req.userId)
      .select("id, bio")
      .single();
    if (error || !profile) return res.status(404).json({ message: "User not found." });

    const players = req.app.locals.players;
    if (players) {
      for (const p of players.values()) {
        if (p.userId === req.userId) p.bio = trimmed;
      }
    }

    req.app.locals.io?.emit("player:bio", { userId: req.userId, bio: trimmed });
    res.json({ bio: trimmed });
  } catch (err) {
    console.error("Bio update error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

const ALLOWED_BADGES = ["diamond", "flame", "medal", "paint", "verified"];

// ── Update badge ──────────────────────────────────────────
router.patch("/badge", auth, async (req, res) => {
  try {
    const { badge } = req.body;
    if (badge !== null && !ALLOWED_BADGES.includes(badge)) {
      return res.status(400).json({ message: "Invalid badge." });
    }

    const { data: profile, error } = await supabase
      .from("profiles")
      .update({ selected_badge: badge ?? null })
      .eq("id", req.userId)
      .select("id, selected_badge")
      .single();
    if (error || !profile) return res.status(404).json({ message: "User not found." });

    const players = req.app.locals.players;
    if (players) {
      for (const p of players.values()) {
        if (p.userId === req.userId) p.selectedBadge = badge;
      }
    }

    req.app.locals.io?.emit("player:badge", { userId: req.userId, badge });
    res.json({ selectedBadge: badge });
  } catch (err) {
    console.error("Badge update error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Save profile view (pose, zoom, pan) ──────────────────
router.patch("/profile-view", auth, async (req, res) => {
  try {
    const { poseIndex, zoomIndex, panX, panY } = req.body;
    if (!Number.isInteger(poseIndex) || poseIndex < 0 || poseIndex > 5)
      return res.status(400).json({ message: "Invalid poseIndex." });
    if (!Number.isInteger(zoomIndex) || zoomIndex < 0 || zoomIndex > 4)
      return res.status(400).json({ message: "Invalid zoomIndex." });
    if (typeof panX !== "number" || typeof panY !== "number")
      return res.status(400).json({ message: "Invalid pan values." });

    const { error } = await supabase
      .from("profiles")
      .update({
        profile_pose_index:  poseIndex,
        profile_zoom_index:  zoomIndex,
        profile_pan_x:       panX,
        profile_pan_y:       panY,
        profile_view_locked: true,
      })
      .eq("id", req.userId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Profile view save error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Clear profile view lock ───────────────────────────────
router.delete("/profile-view", auth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("profiles")
      .update({
        profile_view_locked: false,
        profile_pose_index:  0,
        profile_zoom_index:  0,
        profile_pan_x:       0,
        profile_pan_y:       0,
      })
      .eq("id", req.userId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Profile view unlock error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
