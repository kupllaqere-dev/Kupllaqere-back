// Tracks online presence: socket counts, last activity timestamps, and manual status overrides.
// Multiple sockets per user are reference-counted.

const counts       = new Map(); // userId (string) -> socket count
const lastActivity = new Map(); // userId (string) -> Date.now() ms
const manualStatus = new Map(); // userId (string) -> 'online'|'away'|'invisible'
const lastEmitted  = new Map(); // userId (string) -> last effective status emitted to friends

const AWAY_MS = 15 * 60 * 1000; // 15 minutes idle → away

function add(userId) {
  if (!userId) return;
  const key = String(userId);
  counts.set(key, (counts.get(key) || 0) + 1);
  updateActivity(userId);
}

function remove(userId) {
  if (!userId) return;
  const key = String(userId);
  const current = counts.get(key) || 0;
  if (current <= 1) {
    counts.delete(key);
    lastActivity.delete(key);
  } else {
    counts.set(key, current - 1);
  }
}

function isOnline(userId) {
  if (!userId) return false;
  return counts.has(String(userId));
}

function updateActivity(userId) {
  if (!userId) return;
  lastActivity.set(String(userId), Date.now());
}

function setManualStatus(userId, status) {
  if (!userId) return;
  const valid = ['online', 'away', 'invisible'];
  manualStatus.set(String(userId), valid.includes(status) ? status : 'online');
}

function getManualStatus(userId) {
  return manualStatus.get(String(userId)) || 'online';
}

function clearManualStatus(userId) {
  if (!userId) return;
  manualStatus.delete(String(userId));
}

// Returns the effective status visible to others: 'online' | 'away' | 'offline'
// invisible users appear as 'offline' to everyone else.
function getEffectiveStatus(userId) {
  const key = String(userId);
  const manual = manualStatus.get(key) || 'online';
  if (manual === 'invisible') return 'offline';
  if (!counts.has(key)) return 'offline';
  if (manual === 'away') return 'away';
  // manual is 'online' — check idle time
  const last = lastActivity.get(key);
  if (!last || (Date.now() - last) > AWAY_MS) return 'away';
  return 'online';
}

function setLastEmitted(userId, status) {
  if (!userId) return;
  lastEmitted.set(String(userId), status);
}

function getLastEmitted(userId) {
  return lastEmitted.get(String(userId)) || null;
}

function onlineUserIds() {
  return Array.from(counts.keys());
}

// Returns { userId, status } pairs for connected users whose effective status changed since last emit.
// Used by the periodic status-check interval.
function checkStatusChanges() {
  const changes = [];
  for (const userId of counts.keys()) {
    const current = getEffectiveStatus(userId);
    const prev    = lastEmitted.get(userId);
    if (prev !== undefined && prev !== current) {
      lastEmitted.set(userId, current);
      changes.push({ userId, status: current });
    }
  }
  return changes;
}

module.exports = {
  add,
  remove,
  isOnline,
  updateActivity,
  setManualStatus,
  getManualStatus,
  clearManualStatus,
  getEffectiveStatus,
  setLastEmitted,
  getLastEmitted,
  onlineUserIds,
  checkStatusChanges,
};
