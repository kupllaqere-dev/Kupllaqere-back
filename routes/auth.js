const express = require("express");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const User = require("../models/User");
const auth = require("../middleware/auth");

const router = express.Router();

function signToken(user) {
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
}

// ── Register (email + password only, name/gender chosen later via /setup) ──
router.post("/register", async (req, res) => {
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
router.post("/login", async (req, res) => {
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
router.post("/guest", async (req, res) => {
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
router.post("/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ message: "Missing Google credential." });
    }

    // Decode the JWT from Google (header.payload.signature)
    const payload = JSON.parse(
      Buffer.from(credential.split(".")[1], "base64").toString(),
    );

    const { sub: googleId, email } = payload;

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

module.exports = router;
