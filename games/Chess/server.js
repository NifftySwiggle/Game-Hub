const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Chess = require('chess.js').Chess;
const path = require("path");
const cors = require("cors");
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.static(__dirname));

/ Handle GET /
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "chessV1.html"));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running at https://game-hub-fnqa.onrender.com`);
});

const games = {};
const tournaments = {};

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      console.error("Failed to parse JSON:", err);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON format.' }));
      return;
    }

    if (!data || typeof data.type !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing or invalid message type.' }));
      return;
    }

    // === Fetch Lobby ===
    if (data.type === 'fetchLobby') {
      ws.send(JSON.stringify({
        type: 'lobbyData',
        games: Object.keys(games).map(id => ({
          id,
          players: games[id].players.length,
          timeControl: games[id].timeControl
        })),
        tournaments: Object.keys(tournaments).map(id => ({
          id,
          name: tournaments[id].name,
          players: tournaments[id].players.length,
          timeControl: tournaments[id].timeControl
        }))
      }));
    }

    // === Create Game ===
    if (data.type === 'createGame') {
      if (!data.timeControl || typeof data.timeControl.minutes !== 'number') {
        console.error('Invalid timeControl:', data.timeControl);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Missing or invalid timeControl. Expected format: { minutes: <number> }'
        }));
        return;
      }

      const gameId = Math.random().toString(36).substring(7);
      games[gameId] = {
        chess: new Chess(),
        players: [{ ws, color: 'w' }],
        timeControl: data.timeControl,
        timers: {
          white: data.timeControl.minutes * 60,
          black: data.timeControl.minutes * 60
        }
      };
      ws.send(JSON.stringify({ type: 'gameCreated', gameId, color: 'w' }));
      broadcastLobby();
    }

    // === Join Game ===
    if (data.type === 'joinGame') {
      const game = games[data.gameId];
      if (game && game.players.length < 2) {
        game.players.push({ ws, color: 'b' });
        ws.send(JSON.stringify({ type: 'opponentJoined', gameId: data.gameId, color: 'b' }));
        game.players.forEach(player => {
          player.ws.send(JSON.stringify({ type: 'gameStart', fen: game.chess.fen(), gameId: data.gameId }));
          startTimer(data.gameId, 'white');
        });
        broadcastLobby();
      }
    }

    // === Handle Moves ===
    if (data.type === 'move') {
      const game = games[data.gameId];
      if (game && game.chess.move(data.move)) {
        game.players.forEach(player => {
          player.ws.send(JSON.stringify({
            type: 'move',
            fen: game.chess.fen(),
            move: data.move
          }));
        });
        switchTimer(data.gameId, game.chess.turn());
      }
    }

    // === Create Tournament ===
    if (data.type === 'createTournament') {
      const tournamentId = Math.random().toString(36).substring(7);
      tournaments[tournamentId] = {
        name: data.name || `Tournament ${tournamentId}`,
        players: [ws],
        games: [],
        started: false
      };
      ws.send(JSON.stringify({ type: 'tournamentCreated', tournamentId }));
      broadcastLobby();
    }

    // === Join Tournament ===
    if (data.type === 'joinTournament') {
      const tournament = tournaments[data.tournamentId];
      if (tournament && !tournament.started) {
        tournament.players.push(ws);
        ws.send(JSON.stringify({ type: 'tournamentJoined', tournamentId: data.tournamentId }));
        if (tournament.players.length >= 2) {
          startTournament(data.tournamentId);
        }
        broadcastLobby();
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    for (const gameId in games) {
      games[gameId].players = games[gameId].players.filter(p => p.ws !== ws);
      if (games[gameId].players.length === 0) delete games[gameId];
    }
    for (const tournamentId in tournaments) {
      tournaments[tournamentId].players = tournaments[tournamentId].players.filter(p => p !== ws);
      if (tournaments[tournamentId].players.length === 0) delete tournaments[tournamentId];
    }
    broadcastLobby();
  });
});

// === Timer Functions ===
function startTimer(gameId, player) {
  const game = games[gameId];
  if (!game.timers[player]) {
    game.timers[player] = setInterval(() => {
      game.timers[player === 'white' ? 'white' : 'black'] -= 1;
      if (game.timers[player] <= 0) {
        clearInterval(game.timers[player]);
        game.players.forEach(p => p.ws.send(JSON.stringify({ type: 'timeOut', player })));
      } else {
        game.players.forEach(p => p.ws.send(JSON.stringify({
          type: 'timeUpdate',
          player,
          timeLeft: game.timers[player]
        })));
      }
    }, 1000);
  }
}

function switchTimer(gameId, nextPlayer) {
  const game = games[gameId];
  clearInterval(game.timers[nextPlayer === 'w' ? 'black' : 'white']);
  game.timers[nextPlayer === 'w' ? 'black' : 'white'] = null;
  startTimer(gameId, nextPlayer === 'w' ? 'white' : 'black');
}

function startTournament(tournamentId) {
  const tournament = tournaments[tournamentId];
  tournament.started = true;
  const players = tournament.players;
  for (let i = 0; i < players.length - 1; i += 2) {
    const gameId = Math.random().toString(36).substring(7);
    games[gameId] = {
      chess: new Chess(),
      players: [
        { ws: players[i], color: 'w' },
        { ws: players[i + 1], color: 'b' }
      ],
      timeControl: { minutes: 10, increment: 0 },
      timers: { white: 10 * 60, black: 10 * 60 }
    };
    tournament.games.push(gameId);
    games[gameId].players.forEach(player => {
      player.ws.send(JSON.stringify({
        type: 'gameStart',
        fen: games[gameId].chess.fen(),
        gameId,
        color: player.color
      }));
      startTimer(gameId, 'white');
    });
  }
}

function broadcastLobby() {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'lobbyData',
        games: Object.keys(games).map(id => ({
          id,
          players: games[id].players.length,
          timeControl: games[id].timeControl
        })),
        tournaments: Object.keys(tournaments).map(id => ({
          id,
          name: tournaments[id].name,
          players: tournaments[id].players.length
        }))
      }));
    }
  });
}
