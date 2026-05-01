const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { OAuth2Client } = require("google-auth-library");
const { v4: uuidv4 } = require("uuid");
const User = require("../models/User");
const auth = require("../middleware/auth");

const router = express.Router();

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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

function signToken(user) {
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
}

// ── Register (email + password only, name/gender chosen later via /setup) ──
router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required." });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters." });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: "Email already in use." });
    }

    const user = await User.create({ email, password });
    const token = signToken(user);

    res.status(201).json({ user: user.toPublic(), token });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Login ──
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required." });
    }

    const user = await User.findOne({ email });
    if (!user || !user.password) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const match = await user.comparePassword(password);
    if (!match) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const token = signToken(user);
    res.json({ user: user.toPublic(), token });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ── Guest ──
router.post("/guest", guestLimiter, async (req, res) => {
  try {
    const guestName = `Guest_${uuidv4().slice(0, 6)}`;
    const user = await User.create({ name: guestName, isGuest: true });
    const token = signToken(user);

    res.status(201).json({ user: user.toPublic(), token });
  } catch (err) {
    console.error("Guest creation error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Google ──
router.post("/google", loginLimiter, async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ message: "Missing Google credential." });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    const { sub: googleId, email, email_verified } = payload;
    if (!email_verified) {
      return res.status(401).json({ message: "Google email not verified." });
    }

    let user = await User.findOne({ googleId });

    if (!user) {
      // Check if email already exists (link accounts)
      user = await User.findOne({ email });
      if (user) {
        user.googleId = googleId;
        await user.save();
      } else {
        // Create without name/avatar — user picks them in /setup
        user = await User.create({ email, googleId });
      }
    }

    const token = signToken(user);
    res.json({ user: user.toPublic(), token });
  } catch (err) {
    if (err.message?.includes("Token") || err.message?.includes("audience")) {
      return res.status(401).json({ message: "Invalid Google credential." });
    }
    console.error("Google login error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Character Setup (choose name + gender after register / first Google login) ──
router.post("/setup", auth, async (req, res) => {
  try {
    const { name, gender } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Name is required." });
    }

    if (gender && !["male", "female"].includes(gender)) {
      return res.status(400).json({ message: "Invalid gender." });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    user.name = name.trim();
    if (gender) user.gender = gender;
    await user.save();

    res.json({ user: user.toPublic() });
  } catch (err) {
    console.error("Setup error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

// ── Lookup a user by exact (case-insensitive) name ──
router.get("/user", auth, async (req, res) => {
  try {
    const name = (req.query.name || "").trim();
    if (!name) return res.status(400).json({ message: "Name required." });
    if (name.length > 100) {
      return res.status(400).json({ message: "Name too long." });
    }

    const user = await User.findOne({
      name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
    })
      .populate("soulMate", "name")
      .lean();

    if (!user) return res.status(404).json({ message: "User not found." });

    res.json({
      user: {
        id: String(user._id),
        name: user.name,
        gender: user.gender,
        bio: user.bio || "",
        selectedBadge: user.selectedBadge || null,
        outfit: extractOutfitShallow(user.customization),
        soulMate: user.soulMate
          ? { id: String(user.soulMate._id), name: user.soulMate.name }
          : null,
      },
    });
  } catch (err) {
    console.error("User lookup error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ── Update bio ──
router.patch("/bio", auth, async (req, res) => {
  try {
    const { bio } = req.body;
    if (typeof bio !== "string") {
      return res.status(400).json({ message: "Bio must be a string." });
    }
    const trimmed = bio.trim();
    if (trimmed.length > 500) {
      return res.status(400).json({ message: "Bio must be 500 characters or fewer." });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found." });

    user.bio = trimmed;
    await user.save();

    // Update in-memory player records so newly joining clients see the fresh
    // bio without reloading the full user from DB
    const players = req.app.locals.players;
    if (players) {
      for (const p of players.values()) {
        if (String(p.userId) === String(user._id)) p.bio = user.bio;
      }
    }

    // Notify everyone — clients that don't know this user just ignore
    req.app.locals.io?.emit("player:bio", {
      userId: String(user._id),
      bio: user.bio,
    });

    res.json({ bio: user.bio });
  } catch (err) {
    console.error("Bio update error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

const ALLOWED_BADGES = ["diamond", "flame", "medal", "paint", "verified"];

// ── Update selected badge ──
router.patch("/badge", auth, async (req, res) => {
  try {
    const { badge } = req.body;
    if (badge !== null && !ALLOWED_BADGES.includes(badge)) {
      return res.status(400).json({ message: "Invalid badge." });
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: { selectedBadge: badge } },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: "User not found." });

    const players = req.app.locals.players;
    if (players) {
      for (const p of players.values()) {
        if (String(p.userId) === String(user._id)) p.selectedBadge = user.selectedBadge;
      }
    }

    req.app.locals.io?.emit("player:badge", {
      userId: String(user._id),
      badge: user.selectedBadge,
    });

    res.json({ selectedBadge: user.selectedBadge });
  } catch (err) {
    console.error("Badge update error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

module.exports = router;
