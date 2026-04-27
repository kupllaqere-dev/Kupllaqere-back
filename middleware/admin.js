const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }
  try {
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("role isBanned").lean();
    if (!user) return res.status(401).json({ message: "User not found." });
    if (user.role !== "admin") return res.status(403).json({ message: "Admin access required." });
    req.userId = decoded.id;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token." });
  }
}

module.exports = requireAdmin;
