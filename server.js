// ================================================
// Rucoy Online - Servidor Privado
// Un solo puerto para HTTP y TCP
// ================================================

const net = require('net');
const http = require('http');
const express = require('express');
const app = express();

const players = {};
const connectedPlayers = new Map();

const SERVER_NAME = "Mi Servidor Rucoy";
const SERVER_VERSION = 78;
const PORT = process.env.PORT || 4001;
const MY_IP = process.env.MY_IP || 'yamabiko.proxy.rlwy.net';
const MY_PORT = process.env.MY_PORT || 30555;

const SPAWN = { x: 50, y: 50, map: "town1" };

const PACKET = {
  LOGIN: 1, REGISTER: 2, MOVE: 3, ATTACK: 4, CHAT: 5, PING: 6,
  LOGIN_OK: 101, LOGIN_FAIL: 102, PLAYER_DATA: 103, WORLD_DATA: 104,
  PLAYER_MOVE: 105, CHAT_MSG: 106, PONG: 107, ERROR: 108,
};

function createPacket(type, data) {
  const jsonData = JSON.stringify({ type, data });
  const buf = Buffer.alloc(4 + jsonData.length);
  buf.writeUInt32BE(jsonData.length, 0);
  buf.write(jsonData, 4, 'utf8');
  return buf;
}

function parsePackets(buffer) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    if (offset + 4 + len > buffer.length) break;
    try {
      const json = buffer.slice(offset + 4, offset + 4 + len).toString('utf8');
      packets.push(JSON.parse(json));
    } catch (e) {}
    offset += 4 + len;
  }
  return { packets, remaining: buffer.slice(offset) };
}

function getPlayerBySocket(socket) {
  for (const [username, data] of connectedPlayers) {
    if (data.socket === socket) return { ...data, username };
  }
  return null;
}

function broadcast(type, data) {
  const packet = createPacket(type, data);
  for (const [, player] of connectedPlayers) {
    try { player.socket.write(packet); } catch (e) {}
  }
}

function broadcastExcept(excludeUsername, type, data) {
  const packet = createPacket(type, data);
  for (const [username, player] of connectedPlayers) {
    if (username !== excludeUsername) {
      try { player.socket.write(packet); } catch (e) {}
    }
  }
}

function handlePacket(socket, packet, setPlayer) {
  const { type, data } = packet;
  switch (type) {
    case PACKET.PING:
      socket.write(createPacket(PACKET.PONG, { time: Date.now() }));
      break;
    case PACKET.LOGIN: {
      const { username, password } = data;
      if (!username || !password) {
        socket.write(createPacket(PACKET.LOGIN_FAIL, { message: "Usuario o contraseña vacíos" }));
        return;
      }
      if (!players[username]) {
        players[username] = {
          password, x: SPAWN.x, y: SPAWN.y, map: SPAWN.map,
          level: 1, hp: 100, maxHp: 100, mp: 50, maxMp: 50,
          exp: 0, gold: 100, class: data.class || 0, kills: 0, deaths: 0
        };
        console.log(`Nuevo jugador: ${username}`);
      }
      const player = players[username];
      if (player.password !== password) {
        socket.write(createPacket(PACKET.LOGIN_FAIL, { message: "Contraseña incorrecta" }));
        return;
      }
      setPlayer(username);
      connectedPlayers.set(username, { socket, ...player, username });
      console.log(`Jugador conectado: ${username}`);
      socket.write(createPacket(PACKET.LOGIN_OK, {
        username, x: player.x, y: player.y, map: player.map,
        level: player.level, hp: player.hp, maxHp: player.maxHp,
        mp: player.mp, maxMp: player.maxMp, exp: player.exp,
        gold: player.gold, class: player.class
      }));
      broadcastExcept(username, PACKET.CHAT_MSG, { message: `${username} entró al servidor!`, system: true });
      break;
    }
    case PACKET.MOVE: {
      const player = getPlayerBySocket(socket);
      if (!player) return;
      players[player.username].x = data.x;
      players[player.username].y = data.y;
      break;
    }
    case PACKET.CHAT: {
      const player = getPlayerBySocket(socket);
      if (!player || !data.message) return;
      broadcast(PACKET.CHAT_MSG, { username: player.username, message: data.message.trim(), system: false });
      break;
    }
  }
}

// ================================================
// HTTP Routes
// ================================================
app.get('/server_list.json', (req, res) => {
  res.json({
    servers: [{
      ip: MY_IP,
      port: parseInt(MY_PORT),
      name: SERVER_NAME,
      region: 3,
      version: SERVER_VERSION,
      visible: true,
      languages: "es",
      characters_online: connectedPlayers.size
    }],
    apk_version: 259,
    ios_version: 259,
    message: "Bienvenido al servidor privado!",
    daily_message: "Servidor privado activo"
  });
});

app.get('/s.json', (req, res) => res.redirect('/server_list.json'));

app.get('/', (req, res) => {
  res.json({
    server: SERVER_NAME,
    status: 'online',
    players_online: connectedPlayers.size,
    total_accounts: Object.keys(players).length
  });
});

// ================================================
// Servidor que detecta HTTP vs TCP
// ================================================
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let isHTTP = null;
  let playerName = null;

  socket.once('data', (firstChunk) => {
    // Detectar si es HTTP
    const firstBytes = firstChunk.slice(0, 4).toString('ascii');
    if (firstBytes.startsWith('GET') || firstBytes.startsWith('POST') || firstBytes.startsWith('HEAD')) {
      isHTTP = true;
      // Pasar al servidor HTTP
      httpServer.emit('connection', socket);
      socket.unshift(firstChunk);
    } else {
      isHTTP = false;
      // Es TCP del juego
      buffer = Buffer.concat([buffer, firstChunk]);
      const { packets, remaining } = parsePackets(buffer);
      buffer = remaining;
      for (const packet of packets) {
        handlePacket(socket, packet, (name) => { playerName = name; });
      }

      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        const { packets, remaining } = parsePackets(buffer);
        buffer = remaining;
        for (const packet of packets) {
          handlePacket(socket, packet, (name) => { playerName = name; });
        }
      });

      socket.on('close', () => {
        if (playerName) {
          connectedPlayers.delete(playerName);
          console.log(`Jugador desconectado: ${playerName}`);
          broadcastExcept(playerName, PACKET.CHAT_MSG, { message: `${playerName} salió`, system: true });
        }
      });

      socket.on('error', (err) => console.log(`Error socket: ${err.message}`));
    }
  });
});

const httpServer = http.createServer(app);

server.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT} (HTTP + TCP)`);
  console.log(`🎮 ${SERVER_NAME} iniciado!`);
  console.log(`📋 TCP público: ${MY_IP}:${MY_PORT}`);
});
