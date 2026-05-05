require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
const authRoutes = require("./routes/auth");
const itemRoutes = require("./routes/items");
const friendRoutes = require("./routes/friends");
const soulMateRoutes = require("./routes/soulmate");
const userRoutes = require("./routes/users");
const mailRoutes = require("./routes/mail");
const adminRoutes = require("./routes/admin");
const creatorRoutes = require("./routes/creator");
const storeRoutes = require("./routes/store");
const guestBookRoutes = require("./routes/guestbook");
const supabase = require("./lib/supabase");
const { CATEGORY_SUBCATEGORIES } = require("./lib/categories");
const online = require("./lib/online");

// Build full outfit object from customization JSONB (looks up item IDs from DB)
async function buildOutfit(customization) {
  const outfit = {};
  if (!customization) return outfit;
  for (const category of Object.keys(CATEGORY_SUBCATEGORIES)) {
    const subs = customization[category];
    if (!subs) continue;
    for (const sub of Object.keys(subs)) {
      const imageUrl = subs[sub];
      if (!imageUrl) continue;
      const { data: item } = await supabase
        .from("items")
        .select("id")
        .eq("image_url", imageUrl)
        .eq("category", category)
        .eq("subcategory", sub)
        .maybeSingle();
      if (item) {
        outfit[category] = { itemId: item.id, imageUrl };
        break;
      }
    }
  }
  return outfit;
}

// Lightweight outfit for friend thumbnails — just the first imageUrl per category
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

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use("/assets", express.static(path.join(__dirname, "../fv-game/public/assets")));

// Track connected players: socketId -> { id, name, x, y, map, ... }
const players = new Map();

// userId -> Set<socketId>
const userIdToSocketIds = new Map();

function addUserSocket(userId, socketId) {
  if (!userId) return false;
  const key = String(userId);
  let set = userIdToSocketIds.get(key);
  const firstConnection = !set;
  if (!set) {
    set = new Set();
    userIdToSocketIds.set(key, set);
  }
  set.add(socketId);
  return firstConnection;
}

function removeUserSocket(userId, socketId) {
  if (!userId) return false;
  const key = String(userId);
  const set = userIdToSocketIds.get(key);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    userIdToSocketIds.delete(key);
    return true;
  }
  return false;
}

function socketsForUser(userId) {
  if (!userId) return [];
  const set = userIdToSocketIds.get(String(userId));
  return set ? Array.from(set) : [];
}

const dirtyPlayers = new Set();
const TICK_RATE = 50;

const chatHistory = [];
const MAX_CHAT_HISTORY = 50;

app.locals.io = io;
app.locals.socketsForUser = socketsForUser;
app.locals.players = players;

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/soulmate", soulMateRoutes);
app.use("/api/users", userRoutes);
app.use("/api/mail", mailRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/creator", creatorRoutes);
app.use("/api/store", storeRoutes);
app.use("/api/guestbook", guestBookRoutes);

app.get("/", (req, res) => {
  res.json({ status: "ok", players: players.size });
});

io.on("connection", (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on("player:join", async (data) => {
    const map = data.map || "main";
    const player = {
      id:            socket.id,
      userId:        data.userId || null,
      name:          data.name || "Anonymous",
      x:             data.x || 0,
      y:             data.y || 0,
      map,
      outfit:        {},
      gender:        data.gender === "male" ? "male" : "female",
      bio:           "",
      selectedBadge: null,
    };

    if (data.userId) {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("id, gender, bio, selected_badge, customization")
          .eq("id", data.userId)
          .single();

        if (profile) {
          player.outfit        = await buildOutfit(profile.customization);
          player.gender        = profile.gender || player.gender;
          player.bio           = profile.bio || "";
          player.selectedBadge = profile.selected_badge || null;

          const wasFirstSocket = addUserSocket(data.userId, socket.id);

          // Tell this client which friends are currently online
          const { data: friendships } = await supabase
            .from("friendships")
            .select("user_id, friend_id")
            .or(`user_id.eq.${data.userId},friend_id.eq.${data.userId}`)
            .eq("status", "accepted");

          const friendIds = (friendships || []).map((f) =>
            f.user_id === data.userId ? f.friend_id : f.user_id
          );
          const onlineFriendIds = friendIds.filter((fid) => userIdToSocketIds.has(String(fid)));

          let onlineFriendSummaries = [];
          if (onlineFriendIds.length) {
            const { data: friendProfiles } = await supabase
              .from("profiles")
              .select("id, name, gender, customization")
              .in("id", onlineFriendIds);
            onlineFriendSummaries = (friendProfiles || []).map((f) => ({
              id:     f.id,
              name:   f.name,
              gender: f.gender,
              outfit: extractOutfitShallow(f.customization),
            }));
          }
          socket.emit("friends:online", onlineFriendSummaries);

          // Notify this user's friends that they came online
          if (wasFirstSocket && friendIds.length) {
            const mySummary = {
              id:     profile.id,
              name:   data.name || "",
              gender: profile.gender,
              outfit: extractOutfitShallow(profile.customization),
            };
            for (const fid of friendIds) {
              for (const sid of socketsForUser(fid)) {
                io.to(sid).emit("friend:online", mySummary);
              }
            }
          }
        }
      } catch (err) {
        console.error("Failed to load outfit:", err);
      }
      online.add(data.userId);
    }

    players.set(socket.id, player);
    socket.join(map);

    const playersOnMap = Array.from(players.values()).filter((p) => p.map === map);
    socket.emit("game:state", { you: player, players: playersOnMap });
    socket.to(map).emit("player:joined", player);

    console.log(`${player.name} joined map "${map}" (${players.size} players online)`);
  });

  socket.on("player:update", (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    player.x         = data.x         ?? player.x;
    player.y         = data.y         ?? player.y;
    player.frame     = data.frame     ?? player.frame;
    player.direction = data.direction ?? player.direction;
    player.anim      = data.anim      ?? null;
    dirtyPlayers.add(socket.id);
  });

  socket.on("player:teleport", (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    const fromMap = player.map;
    const toMap   = data.map || fromMap;
    const from    = { x: player.x, y: player.y, map: fromMap };

    player.x = data.x;
    player.y = data.y;

    if (toMap !== fromMap) {
      socket.to(fromMap).emit("player:left", { id: socket.id });
      socket.leave(fromMap);
      player.map = toMap;
      socket.join(toMap);
      socket.to(toMap).emit("player:joined", player);
    } else {
      socket.to(fromMap).emit("player:teleported", {
        id: socket.id,
        from,
        to: { x: player.x, y: player.y, map: toMap },
      });
    }

    const playersOnNewMap = Array.from(players.values()).filter((p) => p.map === toMap);
    socket.emit("player:teleported", {
      id: socket.id,
      from,
      to: { x: player.x, y: player.y, map: toMap },
      players: playersOnNewMap,
    });
  });

  socket.on("player:action", (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    socket.to(player.map).emit("player:action", {
      id:      socket.id,
      action:  data.action,
      payload: data.payload,
    });
  });

  socket.on("player:outfit", (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    player.outfit = data.outfit || {};
    socket.to(player.map).emit("player:outfit", { id: socket.id, outfit: player.outfit });
  });

  socket.on("chat:history", () => {
    socket.emit("chat:history", chatHistory);
  });

  socket.on("chat:message", (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    const text = (data.text || "").trim();
    if (!text || text.length > 500) return;

    const message = {
      id:        Date.now().toString(36) + socket.id.slice(-4),
      from:      { id: player.id, name: player.name },
      text,
      timestamp: Date.now(),
    };

    chatHistory.push(message);
    if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();
    io.emit("chat:message", message);
  });

  socket.on("chat:whisper", (data) => {
    const sender = players.get(socket.id);
    if (!sender) return;
    const text = (data.text || "").trim();
    if (!text || text.length > 500) return;

    const targetSocket = io.sockets.sockets.get(data.to);
    if (!targetSocket) {
      socket.emit("chat:error", { message: "Player not found or offline." });
      return;
    }

    const whisper = {
      from:      { id: sender.id, name: sender.name },
      to:        data.to,
      text,
      timestamp: Date.now(),
    };
    targetSocket.emit("chat:whisper", whisper);
    socket.emit("chat:whisper", whisper);
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);
    players.delete(socket.id);

    if (player) {
      if (player.userId) {
        online.remove(player.userId);
        const wasLastSocket = removeUserSocket(player.userId, socket.id);
        if (wasLastSocket) {
          (async () => {
            try {
              const { data: friendships } = await supabase
                .from("friendships")
                .select("user_id, friend_id")
                .or(`user_id.eq.${player.userId},friend_id.eq.${player.userId}`)
                .eq("status", "accepted");

              const friendIds = (friendships || []).map((f) =>
                f.user_id === player.userId ? f.friend_id : f.user_id
              );
              const payload = { id: String(player.userId) };
              for (const fid of friendIds) {
                for (const sid of socketsForUser(fid)) {
                  io.to(sid).emit("friend:offline", payload);
                }
              }
            } catch (err) {
              console.error("Friend offline notify failed:", err);
            }
          })();
        }
      }
      socket.to(player.map).emit("player:left", { id: socket.id });
    }

    console.log(`${player?.name || "Unknown"} disconnected (${players.size} players online)`);
  });
});

// Game loop: batch-broadcast dirty player positions per map
setInterval(() => {
  if (dirtyPlayers.size === 0) return;

  const byMap       = new Map();
  const dirtyIdsByMap = new Map();
  for (const id of dirtyPlayers) {
    const p = players.get(id);
    if (!p) continue;
    let list = byMap.get(p.map);
    if (!list) {
      list = [];
      byMap.set(p.map, list);
      dirtyIdsByMap.set(p.map, new Set());
    }
    list.push({ id: p.id, x: p.x, y: p.y, frame: p.frame, direction: p.direction, anim: p.anim });
    dirtyIdsByMap.get(p.map).add(p.id);
  }
  dirtyPlayers.clear();

  for (const [map, updates] of byMap) {
    const dirtyIds  = dirtyIdsByMap.get(map);
    const excludeIds = Array.from(dirtyIds);
    io.to(map).except(excludeIds).emit("players:updated", updates);
    for (const senderId of dirtyIds) {
      const filtered = updates.filter((u) => u.id !== senderId);
      if (filtered.length > 0) io.to(senderId).emit("players:updated", filtered);
    }
  }
}, TICK_RATE);

// Start server (no longer needs to wait for DB connection)
server.listen(PORT, () => {
  console.log(`Game server running on http://localhost:${PORT}`);
  console.log("Using Supabase for data storage.");
});
