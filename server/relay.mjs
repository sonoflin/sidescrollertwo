import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.RELAY_PORT || 8788);
const rooms = new Map();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function code() {
  let value = "";
  do {
    value = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(value));
  return value;
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function cleanRoom(roomCode, socket) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const playerId = room.players.indexOf(socket);
  if (playerId >= 0) room.players[playerId] = null;
  const survivor = room.players.find(Boolean);
  if (survivor) send(survivor, { type: "opponent-left" });
  if (!room.players.some(Boolean)) rooms.delete(roomCode);
}

const wss = new WebSocketServer({ port, host: "0.0.0.0" });

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  socket.on("message", (buffer) => {
    let message;
    try { message = JSON.parse(buffer.toString()); } catch { return; }

    if (message.type === "create") {
      if (socket.roomCode) cleanRoom(socket.roomCode, socket);
      const roomCode = code();
      rooms.set(roomCode, { players: [socket, null], createdAt: Date.now() });
      socket.roomCode = roomCode;
      socket.playerId = 0;
      send(socket, { type: "waiting", code: roomCode, playerId: 0 });
      return;
    }

    if (message.type === "join") {
      const roomCode = String(message.code || "").trim().toUpperCase();
      const room = rooms.get(roomCode);
      if (!room) return send(socket, { type: "error", message: "Room not found. Check the five-character code." });
      if (room.players[1]) return send(socket, { type: "error", message: "That room is already in combat." });
      room.players[1] = socket;
      socket.roomCode = roomCode;
      socket.playerId = 1;
      room.players.forEach((player, playerId) => send(player, { type: "start", code: roomCode, playerId }));
      return;
    }

    if (message.type === "relay" && socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      const opponent = room?.players[socket.playerId === 0 ? 1 : 0];
      send(opponent, { type: "relay", from: socket.playerId, payload: message.payload });
    }
  });

  socket.on("close", () => socket.roomCode && cleanRoom(socket.roomCode, socket));
  socket.on("error", () => socket.roomCode && cleanRoom(socket.roomCode, socket));
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (!socket.isAlive) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
  const cutoff = Date.now() - 1000 * 60 * 60;
  rooms.forEach((room, roomCode) => {
    if (room.createdAt < cutoff && !room.players[1]) {
      room.players.forEach((socket) => socket?.close());
      rooms.delete(roomCode);
    }
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));
console.log(`Riftbound relay listening on ws://0.0.0.0:${port}`);
