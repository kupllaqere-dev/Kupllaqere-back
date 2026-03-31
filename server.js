require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const { Server } = require("socket.io");
const authRoutes = require("./routes/auth");

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

// Track connected players: socketId -> { id, name, x, y }
const players = new Map();

// Chat history (last 50 messages)
const chatHistory = [];
const MAX_CHAT_HISTORY = 50;

// Routes
app.use("/api/auth", authRoutes);

app.get("/", (req, res) => {
  res.json({ status: "ok", players: players.size });
});

io.on("connection", (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Player joins the game with a name
  socket.on("player:join", (data) => {
    const player = {
      id: socket.id,
      name: data.name || "Anonymous",
      x: data.x || 0,
      y: data.y || 0,
    };

    players.set(socket.id, player);

    // Send the new player the current game state
    socket.emit("game:state", {
      you: player,
      players: Array.from(players.values()),
    });

    // Tell everyone else about the new player
    socket.broadcast.emit("player:joined", player);

    console.log(`${player.name} joined (${players.size} players online)`);
  });

  // Player sends position/state update
  socket.on("player:update", (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    player.x = data.x ?? player.x;
    player.y = data.y ?? player.y;
    player.frame = data.frame ?? player.frame;
    player.direction = data.direction ?? player.direction;

    // Broadcast to all other players
    socket.broadcast.emit("player:updated", {
      id: socket.id,
      x: player.x,
      y: player.y,
      frame: player.frame,
      direction: player.direction,
    });
  });

  // Player sends a game action (attack, interact, etc.)
  socket.on("player:action", (data) => {
    socket.broadcast.emit("player:action", {
      id: socket.id,
      action: data.action,
      payload: data.payload,
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

    io.emit("player:left", { id: socket.id });

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
