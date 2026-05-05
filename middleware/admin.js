const supabase = require("../lib/supabase");

async function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }
  try {
    const { data: { user }, error } = await supabase.auth.getUser(header.split(" ")[1]);
    if (error || !user) return res.status(401).json({ message: "Invalid token." });

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("role, roles")
      .eq("id", user.id)
      .single();

    if (profileErr || !profile) return res.status(401).json({ message: "User not found." });

    const isAdmin = profile.role === "admin" || (profile.roles || []).includes("admin");
    if (!isAdmin) return res.status(403).json({ message: "Admin access required." });

    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token." });
  }
}

module.exports = requireAdmin;
