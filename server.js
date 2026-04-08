require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const { Server } = require("socket.io");
const authRoutes = require("./routes/auth");
const itemRoutes = require("./routes/items");
const User = require("./models/User");
const Item = require("./models/Item");
const { CATEGORY_SUBCATEGORIES } = require("./models/Item");

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

// Chat history (last 50 messages)
const chatHistory = [];
const MAX_CHAT_HISTORY = 50;

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/items", itemRoutes);

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
        }
      } catch (err) {
        console.error("Failed to load outfit:", err);
      }
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

  // Player sends position/state update
  socket.on("player:update", (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    player.x = data.x ?? player.x;
    player.y = data.y ?? player.y;
    player.frame = data.frame ?? player.frame;
    player.direction = data.direction ?? player.direction;
    player.anim = data.anim ?? null;

    // Broadcast to other players on the same map
    socket.to(player.map).emit("player:updated", {
      id: socket.id,
      x: player.x,
      y: player.y,
      frame: player.frame,
      direction: player.direction,
      anim: player.anim,
    });
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
      socket.to(player.map).emit("player:left", { id: socket.id });
    }

    console.log(
      `${player?.name || "Unknown"} disconnected (${players.size} players online)`
    );
  });
});

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
