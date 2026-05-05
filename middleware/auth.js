const supabase = require("../lib/supabase");

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided." });
  }
  try {
    const { data: { user }, error } = await supabase.auth.getUser(header.split(" ")[1]);
    if (error || !user) {
      return res.status(401).json({ message: "Invalid token." });
    }
    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token." });
  }
}

module.exports = auth;
