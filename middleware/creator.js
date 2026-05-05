const supabase = require("../lib/supabase");

async function requireCreator(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }
  try {
    const { data: { user }, error } = await supabase.auth.getUser(header.split(" ")[1]);
    if (error || !user) return res.status(401).json({ message: "Invalid token." });

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("role, roles, is_banned")
      .eq("id", user.id)
      .single();

    if (profileErr || !profile) return res.status(401).json({ message: "User not found." });
    if (profile.is_banned) return res.status(403).json({ message: "Account is banned." });

    const hasCreator = profile.role === "creator" || (profile.roles || []).includes("creator");
    const hasAdmin   = profile.role === "admin"   || (profile.roles || []).includes("admin");
    if (!hasCreator && !hasAdmin) {
      return res.status(403).json({ message: "Creator access required." });
    }

    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token." });
  }
}

module.exports = requireCreator;
