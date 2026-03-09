// ================================================
// Rucoy Online - Servidor Privado
// Puerto TCP: 4000
// ================================================

const net = require('net');
const http = require('http');
const express = require('express');
const app = express();

// ================================================
// BASE DE DATOS EN MEMORIA (temporal)
// En el futuro se puede cambiar a una base de datos real
// ================================================
const players = {}; // { username: { password, x, y, map, level, hp, mp, exp, gold, class } }

// ================================================
// CONFIGURACION DEL SERVIDOR
// ================================================
const SERVER_NAME = "Mi Servidor Rucoy";
const SERVER_VERSION = 78; // Debe coincidir con el cliente
const TCP_PORT = 4000;
const HTTP_PORT = process.env.PORT || 3000;

// Mapa inicial donde aparecen los jugadores
const SPAWN = { x: 50, y: 50, map: "town1" };

// ================================================
// PROTOCOLO - Tipos de paquetes
// (Descubiertos del análisis del APK)
// ================================================
const PACKET = {
  // Cliente -> Servidor
  LOGIN: 1,
  REGISTER: 2,
  MOVE: 3,
  ATTACK: 4,
  CHAT: 5,
  PING: 6,

  // Servidor -> Cliente  
  LOGIN_OK: 101,
  LOGIN_FAIL: 102,
  PLAYER_DATA: 103,
  WORLD_DATA: 104,
  PLAYER_MOVE: 105,
  CHAT_MSG: 106,
  PONG: 107,
  ERROR: 108,
};

// ================================================
// UTILIDADES DE PAQUETES
// ================================================
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
    } catch (e) {
      console.log('Error parseando paquete:', e.message);
    }

    offset += 4 + len;
  }

  return { packets, remaining: buffer.slice(offset) };
}

// ================================================
// LISTA DE JUGADORES CONECTADOS
// ================================================
const connectedPlayers = new Map(); // socket -> playerData

// ================================================
// SERVIDOR TCP - Aqui es donde los clientes se conectan
// ================================================
const tcpServer = net.createServer((socket) => {
  console.log(`Nueva conexión desde: ${socket.remoteAddress}`);
  
  let buffer = Buffer.alloc(0);
  let playerName = null;

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
      broadcastExcept(playerName, PACKET.CHAT_MSG, {
        message: `${playerName} salió del servidor`,
        system: true
      });
    }
  });

  socket.on('error', (err) => {
    console.log(`Error de socket: ${err.message}`);
  });
});

// ================================================
// MANEJADOR DE PAQUETES
// ================================================
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

      // Registrar jugador nuevo automáticamente si no existe
      if (!players[username]) {
        players[username] = {
          password,
          x: SPAWN.x,
          y: SPAWN.y,
          map: SPAWN.map,
          level: 1,
          hp: 100,
          maxHp: 100,
          mp: 50,
          maxMp: 50,
          exp: 0,
          gold: 100,
          class: data.class || 0, // 0=warrior, 1=archer, 2=mage
          kills: 0,
          deaths: 0
        };
        console.log(`Nuevo jugador registrado: ${username}`);
      }

      const player = players[username];

      if (player.password !== password) {
        socket.write(createPacket(PACKET.LOGIN_FAIL, { message: "Contraseña incorrecta" }));
        return;
      }

      // Login exitoso
      setPlayer(username);
      connectedPlayers.set(username, { socket, ...player, username });

      console.log(`Jugador conectado: ${username}`);

      // Enviar datos del jugador
      socket.write(createPacket(PACKET.LOGIN_OK, {
        username,
        x: player.x,
        y: player.y,
        map: player.map,
        level: player.level,
        hp: player.hp,
        maxHp: player.maxHp,
        mp: player.mp,
        maxMp: player.maxMp,
        exp: player.exp,
        gold: player.gold,
        class: player.class
      }));

      // Anunciar llegada
      broadcastExcept(username, PACKET.CHAT_MSG, {
        message: `${username} entró al servidor!`,
        system: true
      });

      break;
    }

    case PACKET.MOVE: {
      const player = getPlayerBySocket(socket);
      if (!player) return;

      const { x, y, map } = data;
      players[player.username].x = x;
      players[player.username].y = y;
      if (map) players[player.username].map = map;

      // Broadcast movimiento a otros jugadores en el mismo mapa
      broadcastToMap(player.map, player.username, PACKET.PLAYER_MOVE, {
        username: player.username,
        x, y
      });
      break;
    }

    case PACKET.CHAT: {
      const player = getPlayerBySocket(socket);
      if (!player) return;

      const { message } = data;
      if (!message || message.trim() === '') return;

      console.log(`[CHAT] ${player.username}: ${message}`);

      broadcast(PACKET.CHAT_MSG, {
        username: player.username,
        message: message.trim(),
        system: false
      });
      break;
    }

    default:
      console.log(`Paquete desconocido tipo: ${type}`);
  }
}

// ================================================
// UTILIDADES DE BROADCAST
// ================================================
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

function broadcastToMap(map, excludeUsername, type, data) {
  const packet = createPacket(type, data);
  for (const [username, player] of connectedPlayers) {
    if (username !== excludeUsername && player.map === map) {
      try { player.socket.write(packet); } catch (e) {}
    }
  }
}

// ================================================
// SERVIDOR HTTP - Para el server_list.json
// ================================================
app.get('/server_list.json', (req, res) => {
  const myIp = process.env.MY_IP || '0.0.0.0';
  res.json({
    servers: [
      {
        ip: myIp,
        port: TCP_PORT,
        name: SERVER_NAME,
        region: 3,
        version: SERVER_VERSION,
        visible: true,
        languages: "es",
        characters_online: connectedPlayers.size
      }
    ],
    apk_version: 259,
    ios_version: 259,
    message: "Bienvenido al servidor privado!",
    daily_message: "Servidor privado activo"
  });
});

app.get('/', (req, res) => {
  res.json({
    server: SERVER_NAME,
    status: 'online',
    players_online: connectedPlayers.size,
    total_accounts: Object.keys(players).length
  });
});

// ================================================
// INICIAR SERVIDORES
// ================================================
tcpServer.listen(TCP_PORT, () => {
  console.log(`✅ Servidor TCP escuchando en puerto ${TCP_PORT}`);
});

http.createServer(app).listen(HTTP_PORT, () => {
  console.log(`✅ Servidor HTTP escuchando en puerto ${HTTP_PORT}`);
  console.log(`📋 Server list: http://localhost:${HTTP_PORT}/server_list.json`);
});

console.log(`🎮 ${SERVER_NAME} iniciado!`);
