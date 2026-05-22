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

// Build full outfit object from equipped_items table
async function buildOutfit(userId) {
  const outfit = {};
  if (!userId) return outfit;
  const { data: equippedRows } = await supabase
    .from("equipped_items")
    .select("slot, item_id")
    .eq("user_id", userId);
  if (!equippedRows || equippedRows.length === 0) return outfit;
  const itemIds = equippedRows.map((r) => r.item_id);
  const { data: items } = await supabase
    .from("items")
    .select("id, image_url")
    .in("id", itemIds);
  const itemMap = new Map((items || []).map((i) => [i.id, i.image_url]));
  for (const row of equippedRows) {
    const imageUrl = itemMap.get(row.item_id);
    if (imageUrl) outfit[row.slot] = { itemId: row.item_id, imageUrl };
  }
  return outfit;
}

// Build outfit summaries for a batch of userIds from equipped_items
async function buildOutfitsBatch(userIds) {
  if (!userIds || userIds.length === 0) return {};
  const { data: equippedRows } = await supabase
    .from("equipped_items")
    .select("user_id, slot, item_id")
    .in("user_id", userIds);
  if (!equippedRows || equippedRows.length === 0) return {};
  const allItemIds = [...new Set(equippedRows.map((r) => r.item_id))];
  const { data: items } = await supabase
    .from("items")
    .select("id, image_url")
    .in("id", allItemIds);
  const itemMap = new Map((items || []).map((i) => [i.id, i.image_url]));
  const outfitMap = {};
  for (const row of equippedRows) {
    const imageUrl = itemMap.get(row.item_id);
    if (!imageUrl) continue;
    if (!outfitMap[row.user_id]) outfitMap[row.user_id] = {};
    outfitMap[row.user_id][row.slot] = { imageUrl };
  }
  return outfitMap;
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
    const player = {
      id:            socket.id,
      userId:        data.userId || null,
      name:          data.name || "Anonymous",
      outfit:        {},
      gender:        data.gender === "male" ? "male" : "female",
      bio:           "",
      selectedBadge: null,
    };

    if (data.userId) {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("id, gender, bio, selected_badge, presence_status")
          .eq("id", data.userId)
          .single();

        if (profile) {
          player.outfit        = await buildOutfit(data.userId);
          player.gender        = profile.gender || player.gender;
          player.bio           = profile.bio || "";
          player.selectedBadge = profile.selected_badge || null;

          // Load manual status before computing effective status
          online.setManualStatus(data.userId, profile.presence_status || "online");
          online.add(data.userId);

          const wasFirstSocket = addUserSocket(data.userId, socket.id);
          const effectiveStatus = online.getEffectiveStatus(data.userId);
          online.setLastEmitted(data.userId, effectiveStatus);

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
              .select("id, name, gender")
              .in("id", onlineFriendIds);
            const friendOutfits = await buildOutfitsBatch(onlineFriendIds);
            onlineFriendSummaries = (friendProfiles || []).map((f) => ({
              id:     f.id,
              name:   f.name,
              gender: f.gender,
              outfit: friendOutfits[f.id] || {},
              status: online.getEffectiveStatus(f.id),
            }));
          }
          socket.emit("friends:online", onlineFriendSummaries);

          // Notify friends of status (only on first socket connection)
          if (wasFirstSocket && friendIds.length) {
            const mySummary = {
              id:     profile.id,
              name:   data.name || "",
              gender: profile.gender,
              outfit: player.outfit,
              status: effectiveStatus,
            };
            for (const fid of friendIds) {
              for (const sid of socketsForUser(fid)) {
                io.to(sid).emit("friend:online", mySummary);
                io.to(sid).emit("friend:status", { userId: String(profile.id), status: effectiveStatus });
              }
            }
          }
        }
      } catch (err) {
        console.error("Failed to load outfit:", err);
        online.add(data.userId);
      }
    }

    players.set(socket.id, player);

    socket.emit("game:state", { you: player, players: Array.from(players.values()) });
    socket.broadcast.emit("player:joined", player);

    console.log(`${player.name} joined (${players.size} players online)`);
  });

  socket.on("player:move", (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    player.x = data.x;
    player.y = data.y;
    socket.broadcast.emit("player:move", { id: socket.id, x: data.x, y: data.y, anim: data.anim, frame: data.frame, t: data.t });
  });

  socket.on("player:outfit", (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    player.outfit = data.outfit || {};
    socket.broadcast.emit("player:outfit", { id: socket.id, outfit: player.outfit });
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
          online.clearManualStatus(player.userId);
          online.setLastEmitted(player.userId, "offline");
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
              const payload   = { id: String(player.userId) };
              const statusPayload = { userId: String(player.userId), status: "offline" };
              for (const fid of friendIds) {
                for (const sid of socketsForUser(fid)) {
                  io.to(sid).emit("friend:offline", payload);
                  io.to(sid).emit("friend:status", statusPayload);
                }
              }
            } catch (err) {
              console.error("Friend offline notify failed:", err);
            }
          })();
        }
      }
      socket.broadcast.emit("player:left", { id: socket.id });
    }

    console.log(`${player?.name || "Unknown"} disconnected (${players.size} players online)`);
  });
});

// Periodic away-detection: every 30 s check for online→away transitions and emit friend:status
setInterval(async () => {
  const changes = online.checkStatusChanges();
  if (changes.length === 0) return;
  for (const { userId, status } of changes) {
    try {
      const { data: friendships } = await supabase
        .from("friendships")
        .select("user_id, friend_id")
        .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
        .eq("status", "accepted");
      const friendIds = (friendships || []).map((f) =>
        f.user_id === userId ? f.friend_id : f.user_id
      );
      const payload = { userId: String(userId), status };
      for (const fid of friendIds) {
        for (const sid of socketsForUser(fid)) {
          io.to(sid).emit("friend:status", payload);
        }
      }
    } catch (err) {
      console.error("Periodic status notify failed:", err);
    }
  }
}, 30000);

// Start server (no longer needs to wait for DB connection)
server.listen(PORT, () => {
  console.log(`Game server running on http://localhost:${PORT}`);
  console.log("Using Supabase for data storage.");
});
