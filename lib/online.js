// Tracks which user IDs currently have an active socket connection.
// Multiple sockets can map to the same user (e.g. multiple tabs) so we keep a
// reference count per user id.

const counts = new Map(); // userId (string) -> connection count

function add(userId) {
  if (!userId) return;
  const key = String(userId);
  counts.set(key, (counts.get(key) || 0) + 1);
}

function remove(userId) {
  if (!userId) return;
  const key = String(userId);
  const current = counts.get(key) || 0;
  if (current <= 1) counts.delete(key);
  else counts.set(key, current - 1);
}

function isOnline(userId) {
  if (!userId) return false;
  return counts.has(String(userId));
}

function onlineUserIds() {
  return Array.from(counts.keys());
}

module.exports = { add, remove, isOnline, onlineUserIds };
