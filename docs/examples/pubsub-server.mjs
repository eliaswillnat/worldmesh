// A server for pubsub-network.ts: it only relays, one room per path.
// Run with `npm i ws` and `node pubsub-server.mjs`, then connect to
// ws://localhost:8080/<room>. Before going public it also needs what the
// WorldMesh relay does: refuse other origins, check every field, and limit
// rates and room sizes.
import { WebSocketServer } from 'ws';

const server = new WebSocketServer({ port: 8080, maxPayload: 4096 });
const rooms = new Map(); // path → sockets
let lastId = 0;

server.on('connection', (socket, request) => {
  // Browsers send the page's origin (request.headers.origin): refuse all but your world's here.
  const path = request.url;
  const room = rooms.get(path) ?? rooms.set(path, new Set()).get(path);
  const from = String(++lastId);
  const toOthers = (message) => {
    const text = JSON.stringify({ ...message, from });
    for (const other of room) if (other !== socket) other.send(text);
  };
  room.add(socket);
  toOthers({ t: 'join' });
  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message && typeof message === 'object' && !Array.isArray(message)) toOthers(message);
  });
  socket.on('close', () => {
    room.delete(socket);
    if (!room.size) rooms.delete(path);
    toOthers({ t: 'leave' });
  });
});
