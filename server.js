const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function dealHand(room) {
  const cardsPerPlayer = 8 - room.currentHand;
  const deck = shuffleDeck(buildDeck());
  room.players.forEach(player => {
    player.hand = deck.splice(0, cardsPerPlayer);
  });
  room.drawPile = deck;

  let topCard = room.drawPile.splice(0, 1)[0];
  while (topCard.rank === '8' || topCard.rank === '3') {
    room.drawPile.push(topCard);
    topCard = room.drawPile.splice(0, 1)[0];
  }

  room.discardPile = [topCard];
  room.currentSuit = topCard.suit;
  room.currentRank = topCard.rank;
  room.pendingPickup = 0;
  room.pendingEffect = null;
  room.skippedPlayers = new Set();
  room.direction = 1;
}

function getNextPlayerIndex(room, fromIndex, steps = 1) {
  const total = room.players.length;
  let index = fromIndex;
  for (let i = 0; i < steps; i++) {
    index = (index + room.direction + total) % total;
  }
  return index;
}

function refillDrawPile(room) {
  if (room.drawPile.length === 0 && room.discardPile.length > 1) {
    const topCard = room.discardPile.pop();
    room.drawPile = shuffleDeck(room.discardPile);
    room.discardPile = [topCard];
  }
}

function broadcastGameState(room, roomCode, message) {
  const topCard = room.discardPile[room.discardPile.length - 1];
  room.players.forEach(player => {
    const playerSocket = io.sockets.sockets.get(player.id);
    if (playerSocket) {
      playerSocket.emit('gameState', {
        hand: player.hand,
        topCard,
        currentSuit: room.currentSuit,
        currentRank: room.currentRank,
        players: room.players.map(p => ({
          name: p.name,
          cardCount: p.hand.length,
          isHost: p.isHost,
          handsWon: p.handsWon,
          score: p.score
        })),
        currentPlayerIndex: room.currentPlayerIndex,
        currentHand: room.currentHand,
        direction: room.direction,
        pendingPickup: room.pendingPickup,
        pendingEffect: room.pendingEffect,
        message: message,
        myName: player.name
      });
    }
  });
}

function isValidPlay(cards, room) {
  const currentSuit = room.currentSuit;
  const currentRank = room.currentRank;
  const pendingEffect = room.pendingEffect;

  if (pendingEffect === 'dink') {
    return cards.every(c => c.rank === '2');
  }
  if (pendingEffect === 'forceFive') {
    return cards.every(c => c.rank === '5');
  }
  if (pendingEffect === 'equalRank') {
    return cards.length >= 2 && cards.every(c => c.rank === cards[0].rank);
  }

  if (!cards.every(c => c.rank === cards[0].rank)) return false;

  const rank = cards[0].rank;
  const suit = cards[0].suit;

  // 8 is full wild — play on anything
  if (rank === '8') return true;

  // 3 is HALF wild — can only play on matching suit or another 3
  if (rank === '3') {
    return suit === currentSuit || currentRank === '3';
  }

  return suit === currentSuit || rank === currentRank;
}

function advanceTurn(room) {
  const total = room.players.length;
  let nextIndex = getNextPlayerIndex(room, room.currentPlayerIndex);

  while (room.skippedPlayers.has(nextIndex)) {
    room.skippedPlayers.delete(nextIndex);
    nextIndex = getNextPlayerIndex(room, nextIndex);
  }

  room.currentPlayerIndex = nextIndex;
}

function startNextHand(roomData, roomCode) {
  const totalHands = 7;
  const handsLeft = totalHands - roomData.currentHand;

  if (handsLeft === 0) {
    const winner = roomData.players.reduce((a, b) => a.handsWon > b.handsWon ? a : b);
    winner.score++;
    io.to(roomCode).emit('roundOver', {
      players: roomData.players.map(p => ({ name: p.name, handsWon: p.handsWon, score: p.score })),
      winner: winner.name,
      message: `🏆 ${winner.name} wins the round with ${roomData.handsWon} hands!`
    });
    return;
  }

  roomData.currentHand++;
  const dealer = (roomData.dealerIndex + roomData.currentHand - 1) % roomData.players.length;
  roomData.dealerIndex = dealer;
  roomData.currentPlayerIndex = (dealer + 1) % roomData.players.length;

  dealHand(roomData);

  const topCard = roomData.discardPile[roomData.discardPile.length - 1];
  roomData.players.forEach(player => {
    const playerSocket = io.sockets.sockets.get(player.id);
    if (playerSocket) {
      playerSocket.emit('nextHand', {
        hand: player.hand,
        topCard,
        currentSuit: roomData.currentSuit,
        players: roomData.players.map(p => ({
          name: p.name,
          cardCount: p.hand.length,
          isHost: p.isHost,
          handsWon: p.handsWon,
          score: p.score
        })),
        currentPlayerIndex: roomData.currentPlayerIndex,
        currentHand: roomData.currentHand,
        direction: roomData.direction,
        pendingPickup: 0,
        pendingEffect: null,
        myName: player.name
      });
    }
  });
}

io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  socket.on('joinRoom', ({ name, room }) => {
    if (rooms[room] && rooms[room].players.length >= 5) {
      socket.emit('roomFull');
      return;
    }
    if (rooms[room] && rooms[room].players.find(p => p.name === name)) {
      socket.emit('nameTaken');
      return;
    }
    if (!rooms[room]) {
      rooms[room] = {
        players: [],
        gameStarted: false,
        host: socket.id,
        currentHand: 1,
        dealerIndex: 0,
        currentPlayerIndex: 0,
        direction: 1,
        drawPile: [],
        discardPile: [],
        currentSuit: null,
        currentRank: null,
        pendingPickup: 0,
        pendingEffect: null,
        skippedPlayers: new Set()
      };
    }

    const player = {
      id: socket.id,
      name,
      isHost: rooms[room].host === socket.id,
      hand: [],
      handsWon: 0,
      score: 0
    };

    rooms[room].players.push(player);
    socket.join(room);
    socket.roomCode = room;
    socket.playerName = name;

    socket.emit('joinedRoom', {
      room,
      players: rooms[room].players.map(p => ({ name: p.name, isHost: p.isHost })),
      isHost: player.isHost
    });

    socket.to(room).emit('playerJoined', {
      players: rooms[room].players.map(p => ({ name: p.name, isHost: p.isHost }))
    });
  });

  socket.on('pickDealer', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    if (rooms[room].host !== socket.id) return;

    const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
    const SUITS = ['hearts','diamonds','clubs','spades'];
    const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

    function flipCards(playerList) {
      // Assign each player a random card
      const flippedCards = playerList.map(p => ({
        name: p.name,
        card: { rank: RANKS[Math.floor(Math.random() * RANKS.length)], suit: SUITS[Math.floor(Math.random() * SUITS.length)] }
      }));

      // Find highest value
      const maxValue = Math.max(...flippedCards.map(f => RANK_VALUES[f.card.rank]));
      const winners = flippedCards.filter(f => RANK_VALUES[f.card.rank] === maxValue);

      return { flippedCards, winners };
    }

    let { flippedCards, winners } = flipCards(rooms[room].players);

    // Keep flipping tied players until one winner
    while (winners.length > 1) {
      const tied = flipCards(winners.map(w => ({ name: w.name })));
      flippedCards = flippedCards.map(f => {
        const reFlipped = tied.flippedCards.find(t => t.name === f.name);
        return reFlipped || f;
      });
      winners = tied.winners;
    }

    const winnerName = winners[0].name;
    const dealerIndex = rooms[room].players.findIndex(p => p.name === winnerName);
    rooms[room].dealerIndex = dealerIndex;

    // Send flip results to all players
    io.to(room).emit('cardFlipResult', {
      players: rooms[room].players.map(p => ({ name: p.name, isHost: p.isHost })),
      flippedCards,
      dealerIndex,
      winnerName
    });
  });

  socket.on('startGame', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    if (rooms[room].players.length < 2) {
      socket.emit('notEnoughPlayers');
      return;
    }

    rooms[room].gameStarted = true;
    rooms[room].currentHand = 1;
    rooms[room].players.forEach(p => { p.handsWon = 0; p.score = 0; });

    const dealer = rooms[room].dealerIndex || 0;
    rooms[room].currentPlayerIndex = (dealer + 1) % rooms[room].players.length;

    dealHand(rooms[room]);

    const topCard = rooms[room].discardPile[rooms[room].discardPile.length - 1];
    rooms[room].players.forEach(player => {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        playerSocket.emit('gameStarted', {
          hand: player.hand,
          topCard,
          currentSuit: rooms[room].currentSuit,
          players: rooms[room].players.map(p => ({
            name: p.name,
            cardCount: p.hand.length,
            isHost: p.isHost,
            handsWon: p.handsWon,
            score: p.score
          })),
          currentPlayerIndex: rooms[room].currentPlayerIndex,
          currentHand: rooms[room].currentHand,
          direction: rooms[room].direction,
          pendingPickup: 0,
          pendingEffect: null,
          myName: player.name
        });
      }
    });
  });

  socket.on('playCards', ({ cardIndices }) => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;

    const roomData = rooms[room];
    const playerIndex = roomData.players.findIndex(p => p.id === socket.id);

    if (playerIndex !== roomData.currentPlayerIndex) {
      socket.emit('invalidPlay', 'It is not your turn!');
      return;
    }

    const player = roomData.players[playerIndex];
    const cards = cardIndices.map(i => player.hand[i]);

    if (!isValidPlay(cards, roomData)) {
      socket.emit('invalidPlay', 'You cannot play those cards!');
      return;
    }

    player.hand = player.hand.filter((_, i) => !cardIndices.includes(i));
    cards.forEach(c => roomData.discardPile.push(c));

    const rank = cards[0].rank;
    const suit = cards[0].suit;
    const count = cards.length;

    // Update current suit and rank
    // The LAST card played determines the active suit
    const lastCard = cards[cards.length - 1];
    roomData.currentRank = lastCard.rank;
    roomData.currentSuit = lastCard.suit;
    roomData.pendingEffect = null;

    let message = `${player.name} played ${count > 1 ? count + 'x ' : ''}${rank}`;
    let extraTurn = false;

    if (rank === '2') {
      roomData.pendingPickup = (roomData.pendingPickup || 0) + (count * 2);
      if (roomData.pendingPickup > 8) roomData.pendingPickup = 8;
      roomData.pendingEffect = 'dink';
      message = `${player.name} played a Dink! Next player picks up ${roomData.pendingPickup}!`;
    }

    else if (rank === '3') {
      roomData.pendingEffect = 'chooseSuit';
      message = `${player.name} played a 3! Choosing suit...`;
      broadcastGameState(roomData, room, message);
      socket.emit('chooseSuit');
      return;
    }

    else if (rank === '4') {
      if (count % 2 !== 0) {
        refillDrawPile(roomData);
        const drawn = roomData.drawPile.splice(0, 1);
        player.hand.push(...drawn);
        message = `${player.name} played an odd number of 4s and picked up 1!`;
      }
    }

    else if (rank === '5') {
      // 5s always stack — next player must always play a 5 or pick up
      roomData.pendingEffect = 'forceFive';
      message = `${player.name} played a 5! Next player must play a 5!`;
    }

    else if (rank === '6') {
      roomData.pendingEffect = 'equalRank';
      message = `${player.name} played a 6! Next player must play 2+ cards of same rank!`;
    }

    else if (rank === '8') {
      roomData.pendingEffect = 'chooseSuit';
      message = `${player.name} played a wild 8! Choosing suit...`;
      broadcastGameState(roomData, room, message);
      socket.emit('chooseSuit');
      return;
    }

    else if (rank === '9') {
      if (roomData.players.length > 2) {
        roomData.direction *= -1;
        message = `${player.name} reversed the direction!`;
      } else {
        message = `${player.name} played a 9 (no effect in 2-player)`;
      }
    }

    else if (rank === '10') {
      const colorSwap = { hearts: 'diamonds', diamonds: 'hearts', clubs: 'spades', spades: 'clubs' };
      roomData.currentSuit = colorSwap[suit];
      message = `${player.name} played a 10! Suit changed to ${roomData.currentSuit}!`;
    }

    else if (rank === 'J') {
      const nextIndex = getNextPlayerIndex(roomData, playerIndex);
      if (roomData.players.length > 2) {
        roomData.skippedPlayers.add(nextIndex);
        message = `${player.name} played a Jack! ${roomData.players[nextIndex].name} is skipped!`;
      } else {
        extraTurn = true;
        message = `${player.name} played a Jack! Play returns to ${player.name}!`;
      }
    }

    else if (rank === 'K') {
      if (count % 2 === 0) {
        extraTurn = true;
        message = `${player.name} played ${count} Kings and gets another turn!`;
      }
    }

    else if (rank === 'A') {
      if (count % 2 !== 0) {
        roomData.skippedPlayers.add(playerIndex);
        message = `${player.name} played an odd Ace and loses their next turn!`;
      }
    }

    if (player.hand.length === 0) {
      player.handsWon++;
      message = `🎉 ${player.name} won hand ${roomData.currentHand}!`;
      broadcastGameState(roomData, room, message);
      setTimeout(() => startNextHand(roomData, room), 2000);
      return;
    }

    if (!extraTurn) {
      advanceTurn(roomData);
    }

    broadcastGameState(roomData, room, message);
  });

  socket.on('drawCard', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;

    const roomData = rooms[room];
    const playerIndex = roomData.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== roomData.currentPlayerIndex) return;

    const player = roomData.players[playerIndex];

    if (roomData.pendingPickup > 0) {
      refillDrawPile(roomData);
      const drawn = roomData.drawPile.splice(0, roomData.pendingPickup);
      player.hand.push(...drawn);
      const msg = `${player.name} picked up ${drawn.length} cards!`;
      roomData.pendingPickup = 0;
      roomData.pendingEffect = null;
      advanceTurn(roomData);
      broadcastGameState(roomData, room, msg);
      return;
    }

    if (roomData.pendingEffect === 'forceFive' || roomData.pendingEffect === 'equalRank') {
      refillDrawPile(roomData);
      const drawn = roomData.drawPile.splice(0, 1);
      player.hand.push(...drawn);
      const msg = `${player.name} couldn't respond and picked up 1!`;
      roomData.pendingEffect = null;
      advanceTurn(roomData);
      broadcastGameState(roomData, room, msg);
      return;
    }

    refillDrawPile(roomData);
    const drawn = roomData.drawPile.splice(0, 1);
    player.hand.push(...drawn);
    const msg = `${player.name} drew a card.`;
    advanceTurn(roomData);
    broadcastGameState(roomData, room, msg);
  });

  socket.on('suitChosen', ({ suit }) => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const roomData = rooms[room];
    roomData.currentSuit = suit;
    roomData.pendingEffect = null;
    const player = roomData.players.find(p => p.id === socket.id);
    const msg = `${player.name} chose ${suit}!`;
    advanceTurn(roomData);
    broadcastGameState(roomData, room, msg);
  });

socket.on('nextRound', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    if (rooms[room].host !== socket.id) return;

    // Reset hands won for all players
    rooms[room].players.forEach(p => { p.handsWon = 0; });

    // Move dealer to next player
    rooms[room].dealerIndex = (rooms[room].dealerIndex + 1) % rooms[room].players.length;
    rooms[room].currentPlayerIndex = (rooms[room].dealerIndex + 1) % rooms[room].players.length;
    rooms[room].currentHand = 1;

    dealHand(rooms[room]);

    const topCard = rooms[room].discardPile[rooms[room].discardPile.length - 1];
    rooms[room].players.forEach(player => {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        playerSocket.emit('nextHand', {
          hand: player.hand,
          topCard,
          currentSuit: rooms[room].currentSuit,
          players: rooms[room].players.map(p => ({
            name: p.name,
            cardCount: p.hand.length,
            isHost: p.isHost,
            handsWon: p.handsWon,
            score: p.score
          })),
          currentPlayerIndex: rooms[room].currentPlayerIndex,
          currentHand: rooms[room].currentHand,
          direction: rooms[room].direction,
          pendingPickup: 0,
          pendingEffect: null,
          myName: player.name
        });
      }
    });
  });

  socket.on('disconnect', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    rooms[room].players = rooms[room].players.filter(p => p.id !== socket.id);
    if (rooms[room].players.length === 0) {
      delete rooms[room];
      return;
    }
    if (rooms[room].host === socket.id) {
      rooms[room].host = rooms[room].players[0].id;
      rooms[room].players[0].isHost = true;
    }
    io.to(room).emit('playerLeft', {
      players: rooms[room].players.map(p => ({ name: p.name, isHost: p.isHost })),
      name: socket.playerName
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dink server running on port ${PORT}`);
});