require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const { Server } = require("socket.io");
const authRoutes = require("./routes/auth");
const itemRoutes = require("./routes/items");
const friendRoutes = require("./routes/friends");
const User = require("./models/User");
const Item = require("./models/Item");
const { CATEGORY_SUBCATEGORIES } = require("./models/Item");
const online = require("./lib/online");

// Build outfit object from a user's customization field
async function buildOutfit(customization) {
  const outfit = {};
  if (!customization) return outfit;
  for (const category of Object.keys(CATEGORY_SUBCATEGORIES)) {
    const subs = customization[category];
    if (!subs) continue;
    for (const sub of Object.keys(subs)) {
      const imageUrl = subs[sub];
      if (!imageUrl) continue;
      const item = await Item.findOne({ imageUrl, category, subcategory: sub }).lean();
      if (item) {
        outfit[category] = { itemId: item._id, imageUrl };
        break;
      }
    }
  }
  return outfit;
}

// Lightweight outfit used for friend thumbnails — just the first imageUrl per category
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
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Track connected players: socketId -> { id, name, x, y, map }
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

// Set of player IDs whose position changed since last tick
const dirtyPlayers = new Set();

// Server tick rate: broadcast batched updates at this interval
const TICK_RATE = 50; // ms (~20 ticks/sec)

// Chat history (last 50 messages)
const chatHistory = [];
const MAX_CHAT_HISTORY = 50;

// Expose io + helpers to HTTP routes that need to push live events
app.locals.io = io;
app.locals.socketsForUser = socketsForUser;

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/friends", friendRoutes);

app.get("/", (req, res) => {
  res.json({ status: "ok", players: players.size });
});

io.on("connection", (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Player joins the game with a name
  socket.on("player:join", async (data) => {
    const map = data.map || "main";
    const player = {
      id: socket.id,
      userId: data.userId || null,
      name: data.name || "Anonymous",
      x: data.x || 0,
      y: data.y || 0,
      map,
      outfit: {},
    };

    // Load outfit from DB if userId is provided
    if (data.userId) {
      try {
        const user = await User.findById(data.userId).lean();
        if (user) {
          player.outfit = await buildOutfit(user.customization);

          const wasFirstSocket = addUserSocket(data.userId, socket.id);

          // Tell this client which of their friends are currently online
          const friendIds = Array.isArray(user.friends) ? user.friends : [];
          const onlineFriendIds = friendIds.filter((fid) =>
            userIdToSocketIds.has(String(fid))
          );
          let onlineFriendSummaries = [];
          if (onlineFriendIds.length) {
            const friendDocs = await User.find({
              _id: { $in: onlineFriendIds },
            }).lean();
            onlineFriendSummaries = friendDocs.map((f) => ({
              id: String(f._id),
              name: f.name,
              outfit: extractOutfitShallow(f.customization),
            }));
          }
          socket.emit("friends:online", onlineFriendSummaries);

          // Tell this user's friends that I just came online
          if (wasFirstSocket && friendIds.length) {
            const mySummary = {
              id: String(user._id),
              name: user.name,
              outfit: extractOutfitShallow(user.customization),
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

    // Send the new player only the players on the same map
    const playersOnMap = Array.from(players.values()).filter(
      (p) => p.map === map
    );
    socket.emit("game:state", {
      you: player,
      players: playersOnMap,
    });

    // Tell others on the same map about the new player
    socket.to(map).emit("player:joined", player);

    console.log(`${player.name} joined map "${map}" (${players.size} players online)`);
  });

  // Player sends position/state update (stored, broadcast in batched tick)
  socket.on("player:update", (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    player.x = data.x ?? player.x;
    player.y = data.y ?? player.y;
    player.frame = data.frame ?? player.frame;
    player.direction = data.direction ?? player.direction;
    player.anim = data.anim ?? null;

    dirtyPlayers.add(socket.id);
  });

  // Player teleports to a new location (optionally a different map)
  socket.on("player:teleport", (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    const fromMap = player.map;
    const toMap = data.map || fromMap;
    const from = { x: player.x, y: player.y, map: fromMap };

    player.x = data.x;
    player.y = data.y;

    // If changing maps, switch Socket.IO rooms
    if (toMap !== fromMap) {
      // Tell players on the old map this player disappeared
      socket.to(fromMap).emit("player:left", { id: socket.id });
      socket.leave(fromMap);

      player.map = toMap;
      socket.join(toMap);

      // Tell players on the new map this player appeared
      socket.to(toMap).emit("player:joined", player);
    } else {
      // Same map teleport — notify others on this map
      socket.to(fromMap).emit("player:teleported", {
        id: socket.id,
        from,
        to: { x: player.x, y: player.y, map: toMap },
      });
    }

    // Send the teleporting player the new map's players
    const playersOnNewMap = Array.from(players.values()).filter(
      (p) => p.map === toMap
    );
    socket.emit("player:teleported", {
      id: socket.id,
      from,
      to: { x: player.x, y: player.y, map: toMap },
      players: playersOnNewMap,
    });
  });

  // Player sends a game action (attack, interact, etc.)
  socket.on("player:action", (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    socket.to(player.map).emit("player:action", {
      id: socket.id,
      action: data.action,
      payload: data.payload,
    });
  });

  // Player updates their outfit
  socket.on("player:outfit", (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    player.outfit = data.outfit || {};

    socket.to(player.map).emit("player:outfit", {
      id: socket.id,
      outfit: player.outfit,
    });
  });

  // Send chat history to newly connected player
  socket.on("chat:history", () => {
    socket.emit("chat:history", chatHistory);
  });

  // Global chat message
  socket.on("chat:message", (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    const text = (data.text || "").trim();
    if (!text || text.length > 500) return;

    const message = {
      id: Date.now().toString(36) + socket.id.slice(-4),
      from: { id: player.id, name: player.name },
      text,
      timestamp: Date.now(),
    };

    chatHistory.push(message);
    if (chatHistory.length > MAX_CHAT_HISTORY) {
      chatHistory.shift();
    }

    io.emit("chat:message", message);
  });

  // Private / whisper message
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
      from: { id: sender.id, name: sender.name },
      to: data.to,
      text,
      timestamp: Date.now(),
    };

    targetSocket.emit("chat:whisper", whisper);
    socket.emit("chat:whisper", whisper);
  });

  // Handle disconnect
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
              const u = await User.findById(player.userId).lean();
              if (!u || !Array.isArray(u.friends)) return;
              const payload = { id: String(player.userId) };
              for (const fid of u.friends) {
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

    console.log(
      `${player?.name || "Unknown"} disconnected (${players.size} players online)`
    );
  });
});

// Game loop: batch-broadcast dirty player positions per map
setInterval(() => {
  if (dirtyPlayers.size === 0) return;

  // Group dirty players by map
  const byMap = new Map();
  for (const id of dirtyPlayers) {
    const p = players.get(id);
    if (!p) continue;
    let list = byMap.get(p.map);
    if (!list) {
      list = [];
      byMap.set(p.map, list);
    }
    list.push({
      id: p.id,
      x: p.x,
      y: p.y,
      frame: p.frame,
      direction: p.direction,
      anim: p.anim,
    });
  }
  dirtyPlayers.clear();

  // One emit per map with all updated players
  for (const [map, updates] of byMap) {
    io.to(map).emit("players:updated", updates);
  }
}, TICK_RATE);

// Connect to MongoDB then start server
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("Connected to MongoDB");
    server.listen(PORT, () => {
      console.log(`Game server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
