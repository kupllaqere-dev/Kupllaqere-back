const { io } = require("socket.io-client");

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const NUM_PLAYERS = parseInt(process.env.NUM_PLAYERS || "10", 10);
const MAP = process.env.MAP || "main";

// Map boundaries — adjust to match your actual map size
const MAP_MIN_X = 0;
const MAP_MAX_X = 2000;
const MAP_MIN_Y = 0;
const MAP_MAX_Y = 2000;

// Movement speed: frontend uses 300px/sec, updates at ~60fps.
// We send updates every 200ms, so per tick: 300 * 0.2 = 60px base.
// Add some variance so bots don't all move identically.
const BASE_SPEED = 20;
const UPDATE_INTERVAL = 50;

// Idle frame indices (matching frontend PlayerManager.js)
const IDLE_FRAMES = {
  FRONT: 0,
  FRONT_LEFT: 1,
  LEFT: 2,
  BACK: 3,
  FRONT_RIGHT: 4,
  RIGHT: 5,
};

// Walk animation keys (matching frontend LocalPlayer.js)
const WALK_ANIMS = {
  left: "walk-left",
  right: "walk-right",
  down: "walk-down",
  up: "walk-up",
};

// Idle frame to show when stopping after walking in a direction
const STOP_FRAMES = {
  left: IDLE_FRAMES.FRONT_LEFT,
  right: IDLE_FRAMES.FRONT_RIGHT,
  up: IDLE_FRAMES.BACK,
  down: IDLE_FRAMES.FRONT,
};

const DIRECTIONS = ["up", "down", "left", "right"];

const NAMES = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
  "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa",
  "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey",
  "Xray", "Yankee", "Zulu", "Ash", "Blake", "Cruz", "Dawn", "Eve", "Finn",
  "Gray", "Haze", "Iris", "Jade", "Knox", "Luna", "Mars", "Nova", "Onyx",
  "Pike", "Quinn", "Reed", "Sage", "Troy", "Uma", "Vale", "Wren", "Zara",
];

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function randomInRange(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

const bots = [];

function spawnBot(index) {
  const socket = io(SERVER_URL, { transports: ["websocket"] });
  const name = `Bot_${NAMES[index % NAMES.length]}${index >= NAMES.length ? index : ""}`;

  let x = randomInRange(MAP_MIN_X + 100, MAP_MAX_X - 100);
  let y = randomInRange(MAP_MIN_Y + 100, MAP_MAX_Y - 100);

  // Bot state machine: "walking" or "idle"
  let state = "idle";
  let direction = DIRECTIONS[Math.floor(Math.random() * 4)];
  let frame = IDLE_FRAMES.FRONT;
  let anim = null;

  // Ticks remaining in current state
  let ticksRemaining = randomInRange(3, 15); // start idle briefly

  socket.on("connect", () => {
    socket.emit("player:join", { name, x, y, map: MAP });
  });

  const interval = setInterval(() => {
    if (!socket.connected) return;

    ticksRemaining--;

    if (ticksRemaining <= 0) {
      if (state === "idle") {
        // Start walking in a random direction
        state = "walking";
        direction = DIRECTIONS[Math.floor(Math.random() * 4)];
        anim = WALK_ANIMS[direction];
        // Walk for 1-6 seconds (5-30 ticks at 200ms)
        ticksRemaining = randomInRange(5, 30);
      } else {
        // Stop and idle
        state = "idle";
        anim = null;
        frame = STOP_FRAMES[direction];
        // Idle for 0.4-3 seconds (2-15 ticks)
        ticksRemaining = randomInRange(2, 15);
      }
    }

    if (state === "walking") {
      const speed = BASE_SPEED * (0.7 + Math.random() * 0.6);

      switch (direction) {
        case "up":    y -= speed; break;
        case "down":  y += speed; break;
        case "left":  x -= speed; break;
        case "right": x += speed; break;
      }

      x = clamp(Math.round(x), MAP_MIN_X, MAP_MAX_X);
      y = clamp(Math.round(y), MAP_MIN_Y, MAP_MAX_Y);

      // Bounce off walls — pick a new direction and keep walking
      if (x <= MAP_MIN_X || x >= MAP_MAX_X) {
        direction = x <= MAP_MIN_X ? "right" : "left";
        anim = WALK_ANIMS[direction];
      }
      if (y <= MAP_MIN_Y || y >= MAP_MAX_Y) {
        direction = y <= MAP_MIN_Y ? "down" : "up";
        anim = WALK_ANIMS[direction];
      }
    }

    socket.emit("player:update", { x, y, frame, anim });
  }, UPDATE_INTERVAL);

  bots.push({ socket, interval, name });
}

// Stagger connections so we don't slam the server all at once
console.log(`Spawning ${NUM_PLAYERS} bots connecting to ${SERVER_URL} on map "${MAP}"...`);

let spawned = 0;
const spawnInterval = setInterval(() => {
  if (spawned >= NUM_PLAYERS) {
    clearInterval(spawnInterval);
    console.log(`All ${NUM_PLAYERS} bots spawned. Press Ctrl+C to stop.`);
    return;
  }
  spawnBot(spawned);
  spawned++;
  process.stdout.write(`\rSpawned ${spawned}/${NUM_PLAYERS}`);
}, 100);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nDisconnecting all bots...");
  for (const bot of bots) {
    clearInterval(bot.interval);
    bot.socket.disconnect();
  }
  process.exit(0);
});
