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
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

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
  room.pendingPickup = 0;
  room.pendingEffect = null;
  room.skippedPlayers = new Set();
  room.direction = 1;
  room.lastCardDeclared = false;
  room.flippedCardAceCount = 0;

  // Flip top card
  let topCard = room.drawPile.splice(0, 1)[0];

  // If flipped card is an 8 or 3, redraw
  while (topCard.rank === '8' || topCard.rank === '3') {
    room.drawPile.push(topCard);
    topCard = room.drawPile.splice(0, 1)[0];
  }

  room.discardPile = [topCard];
  room.currentSuit = topCard.suit;
  room.currentRank = topCard.rank;

  // Handle flipped card effects
  room.flippedCardEffect = null;
  if (topCard.rank === 'A') {
    // Dealer can choose to accept or reject penalty
    room.flippedCardEffect = 'ace';
    room.flippedCardAceCount = 1;
  } else if (topCard.rank === '4') {
    room.flippedCardEffect = 'four';
  } else if (topCard.rank === '2') {
    room.pendingPickup = 2;
    room.pendingEffect = 'dink';
  } else if (topCard.rank === '5') {
    room.pendingEffect = 'forceFive';
  } else if (topCard.rank === '6') {
    room.pendingEffect = 'equalRank';
  } else if (topCard.rank === '9') {
    if (room.players.length > 2) room.direction = -1;
  } else if (topCard.rank === '10') {
    const colorSwap = { hearts: 'diamonds', diamonds: 'hearts', clubs: 'spades', spades: 'clubs' };
    room.currentSuit = colorSwap[topCard.suit];
  } else if (topCard.rank === 'J') {
    room.flippedCardEffect = 'jack';
  }
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
        myName: player.name,
        flippedCardEffect: room.flippedCardEffect,
        dealerIndex: room.dealerIndex
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

  if (rank === '8') return true;

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

  if (roomData.currentHand >= totalHands) {
    const winner = roomData.players.reduce((a, b) => a.handsWon > b.handsWon ? a : b);
    winner.score++;
    io.to(roomCode).emit('roundOver', {
      players: roomData.players.map(p => ({ name: p.name, handsWon: p.handsWon, score: p.score })),
      winner: winner.name,
      message: `🏆 ${winner.name} wins the round!`
    });
    return;
  }

  roomData.currentHand++;
  const dealer = (roomData.dealerIndex + roomData.currentHand - 1) % roomData.players.length;
  roomData.dealerIndex = dealer;
  roomData.currentPlayerIndex = (dealer + 1) % roomData.players.length;

  dealHand(roomData);

  const topCard = roomData.discardPile[roomData.discardPile.length - 1];

  // Handle jack flipped card — goes back to dealer
  if (roomData.flippedCardEffect === 'jack') {
    if (roomData.players.length === 2) {
      roomData.currentPlayerIndex = dealer;
    } else {
      roomData.skippedPlayers.add(roomData.currentPlayerIndex);
    }
  }

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
        pendingPickup: roomData.pendingPickup,
        pendingEffect: roomData.pendingEffect,
        myName: player.name,
        flippedCardEffect: roomData.flippedCardEffect,
        dealerIndex: roomData.dealerIndex
      });
    }
  });
}

io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  socket.on('joinRoom', ({ name, room }) => {
    if (rooms[room] && rooms[room].players.length >= 5) { socket.emit('roomFull'); return; }
    if (rooms[room] && rooms[room].players.find(p => p.name === name)) { socket.emit('nameTaken'); return; }
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
        skippedPlayers: new Set(),
        lastCardDeclared: false,
        flippedCardEffect: null,
        flippedCardAceCount: 0
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

    const FLIP_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const FLIP_SUITS = ['hearts','diamonds','clubs','spades'];

    function flipCards(playerList) {
      const flippedCards = playerList.map(p => ({
        name: p.name,
        card: { rank: FLIP_RANKS[Math.floor(Math.random() * FLIP_RANKS.length)], suit: FLIP_SUITS[Math.floor(Math.random() * FLIP_SUITS.length)] }
      }));
      const maxValue = Math.max(...flippedCards.map(f => RANK_VALUES[f.card.rank]));
      const winners = flippedCards.filter(f => RANK_VALUES[f.card.rank] === maxValue);
      return { flippedCards, winners };
    }

    let { flippedCards, winners } = flipCards(rooms[room].players);
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
    if (rooms[room].players.length < 2) { socket.emit('notEnoughPlayers'); return; }

    rooms[room].gameStarted = true;
    rooms[room].currentHand = 1;
    rooms[room].players.forEach(p => { p.handsWon = 0; p.score = 0; });

    const dealer = rooms[room].dealerIndex || 0;
    rooms[room].currentPlayerIndex = (dealer + 1) % rooms[room].players.length;

    dealHand(rooms[room]);

    // Handle jack flipped card effect at game start
    if (rooms[room].flippedCardEffect === 'jack') {
      if (rooms[room].players.length === 2) {
        rooms[room].currentPlayerIndex = dealer;
      } else {
        rooms[room].skippedPlayers.add(rooms[room].currentPlayerIndex);
      }
    }

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
          pendingPickup: rooms[room].pendingPickup,
          pendingEffect: rooms[room].pendingEffect,
          myName: player.name,
          flippedCardEffect: rooms[room].flippedCardEffect,
          dealerIndex: rooms[room].dealerIndex
        });
      }
    });
  });

  // Dealer accepts or rejects flipped card penalty (Ace or 4)
  socket.on('dealerPenaltyChoice', ({ accept, cardIndex }) => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const roomData = rooms[room];
    const dealer = roomData.players[roomData.dealerIndex];
    if (!dealer || dealer.id !== socket.id) return;

    if (accept) {
      if (roomData.flippedCardEffect === 'ace') {
        roomData.skippedPlayers.add(roomData.dealerIndex);
        broadcastGameState(roomData, room, `${dealer.name} accepted the Ace penalty and loses their first turn!`);
      } else if (roomData.flippedCardEffect === 'four') {
        refillDrawPile(roomData);
        const drawn = roomData.drawPile.splice(0, 1);
        dealer.hand.push(...drawn);
        broadcastGameState(roomData, room, `${dealer.name} accepted the 4 penalty and picked up one card!`);
      }
    } else {
      // Rejecting — play the card from hand immediately
      const card = dealer.hand[cardIndex];
      if (!card) {
        socket.emit('invalidPlay', 'You do not have a card to reject with!');
        return;
      }

      if (roomData.flippedCardEffect === 'ace' && card.rank !== 'A') {
        socket.emit('invalidPlay', 'You can only reject with an Ace!');
        return;
      }
      if (roomData.flippedCardEffect === 'four' && card.rank !== '4') {
        socket.emit('invalidPlay', 'You can only reject with a 4!');
        return;
      }

      // Play the card
      dealer.hand = dealer.hand.filter((_, i) => i !== cardIndex);
      roomData.discardPile.push(card);
      roomData.currentRank = card.rank;
      roomData.currentSuit = card.suit;

      const effectName = roomData.flippedCardEffect === 'ace' ? 'Ace' : '4';
      broadcastGameState(roomData, room, `${dealer.name} rejected the ${effectName} penalty by playing their own ${effectName}! Even number — no effect!`);
    }

    roomData.flippedCardEffect = null;
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

    const lastCard = cards[cards.length - 1];
    const rank = lastCard.rank;
    const suit = lastCard.suit;
    const count = cards.length;

    roomData.currentRank = rank;
    roomData.currentSuit = suit;
    roomData.pendingEffect = null;

    // Better message for multiple cards
    let cardLabel = count === 1 ? rank : `${count}x ${rank}s`;
    let message = `${player.name} played ${cardLabel}`;
    let extraTurn = false;

    if (rank === '2') {
      roomData.pendingPickup = (roomData.pendingPickup || 0) + (count * 2);
      if (roomData.pendingPickup > 8) roomData.pendingPickup = 8;
      roomData.pendingEffect = 'dink';
      const dinkLabel = roomData.pendingPickup === 2 ? 'a Dink' : `${roomData.pendingPickup / 2} Dinks`;
      message = `${player.name} played ${dinkLabel}! Next player picks up ${roomData.pendingPickup}!`;
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
        message = `${player.name} played an odd number of 4s and picked up one card!`;
      } else {
        message = `${player.name} played ${count} 4s — no penalty!`;
      }
    }

    else if (rank === '5') {
      roomData.pendingEffect = 'forceFive';
      message = `${player.name} played a 5! Next player must play a 5!`;
    }

    else if (rank === '6') {
      roomData.pendingEffect = 'equalRank';
      message = `${player.name} played a 6! Next player must play 2 or more cards of the same rank!`;
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
        message = `${player.name} played a 9 — no effect in 2-player!`;
      }
    }

    else if (rank === '10') {
      const colorSwap = { hearts: 'diamonds', diamonds: 'hearts', clubs: 'spades', spades: 'clubs' };
      roomData.currentSuit = colorSwap[suit];
      message = `${player.name} played a 10! Suit swapped to ${roomData.currentSuit}!`;
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
      } else {
        message = `${player.name} played ${count} King${count > 1 ? 's' : ''} — no extra turn!`;
      }
    }

    else if (rank === 'A') {
      // Count total aces including flipped card
      const totalAces = count + (roomData.flippedCardAceCount || 0);
      roomData.flippedCardAceCount = 0;
      if (totalAces % 2 !== 0) {
        roomData.skippedPlayers.add(playerIndex);
        message = `${player.name} played ${count} Ace${count > 1 ? 's' : ''} — loses their next turn!`;
      } else {
        message = `${player.name} played ${count} Ace${count > 1 ? 's' : ''} — even number, no effect!`;
      }
    }

    if (player.hand.length === 0) {
      player.handsWon++;
      roomData.lastCardDeclared = false;
      message = `🎉 ${player.name} won hand ${roomData.currentHand}!`;
      broadcastGameState(roomData, room, message);
      setTimeout(() => startNextHand(roomData, room), 2000);
      return;
    }

    if (player.hand.length === 1) {
      if (!roomData.lastCardDeclared) {
        io.to(room).emit('catchable', { playerName: player.name });
      }
      roomData.lastCardDeclared = false;
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
      const count = drawn.length;
      const countWord = count === 1 ? 'one card' : `${count} cards`;
      const msg = `${player.name} picked up ${countWord}!`;
      roomData.pendingPickup = 0;
      roomData.pendingEffect = null;
      roomData.currentRank = roomData.discardPile[roomData.discardPile.length - 1].rank;
      roomData.currentSuit = roomData.discardPile[roomData.discardPile.length - 1].suit;
      advanceTurn(roomData);
      broadcastGameState(roomData, room, msg);
      return;
    }

    if (roomData.pendingEffect === 'forceFive' || roomData.pendingEffect === 'equalRank') {
      refillDrawPile(roomData);
      const drawn = roomData.drawPile.splice(0, 1);
      player.hand.push(...drawn);
      const msg = `${player.name} couldn't respond and picked up one card!`;
      roomData.pendingEffect = null;
      advanceTurn(roomData);
      broadcastGameState(roomData, room, msg);
      return;
    }

    refillDrawPile(roomData);
    const drawn = roomData.drawPile.splice(0, 1);
    player.hand.push(...drawn);
    const msg = `${player.name} picked up one card.`;
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

  socket.on('declareLastCard', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const roomData = rooms[room];
    const playerIndex = roomData.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== roomData.currentPlayerIndex) return;
    roomData.lastCardDeclared = true;
    const player = roomData.players[playerIndex];
    io.to(room).emit('lastCardDeclared', { playerName: player.name });
  });

  socket.on('catchLastCard', ({ caughtPlayerName }) => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const roomData = rooms[room];
    const caughtPlayer = roomData.players.find(p => p.name === caughtPlayerName);
    if (!caughtPlayer) return;
    refillDrawPile(roomData);
    const drawn = roomData.drawPile.splice(0, 1);
    caughtPlayer.hand.push(...drawn);
    const catcher = roomData.players.find(p => p.id === socket.id);
    const msg = `⚠️ ${catcher.name} caught ${caughtPlayerName}! They pick up one card!`;
    io.to(room).emit('caughtLastCard', { caughtPlayerName, msg });
    broadcastGameState(roomData, room, msg);
  });

  socket.on('nextRound', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    if (rooms[room].host !== socket.id) return;

    rooms[room].players.forEach(p => { p.handsWon = 0; });
    rooms[room].dealerIndex = (rooms[room].dealerIndex + 1) % rooms[room].players.length;
    rooms[room].currentPlayerIndex = (rooms[room].dealerIndex + 1) % rooms[room].players.length;
    rooms[room].currentHand = 1;

    dealHand(rooms[room]);

    const topCard = rooms[room].discardPile[rooms[room].discardPile.length - 1];

    if (rooms[room].flippedCardEffect === 'jack') {
      if (rooms[room].players.length === 2) {
        rooms[room].currentPlayerIndex = rooms[room].dealerIndex;
      } else {
        rooms[room].skippedPlayers.add(rooms[room].currentPlayerIndex);
      }
    }

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
          pendingPickup: rooms[room].pendingPickup,
          pendingEffect: rooms[room].pendingEffect,
          myName: player.name,
          flippedCardEffect: rooms[room].flippedCardEffect,
          dealerIndex: rooms[room].dealerIndex
        });
      }
    });
  });

  socket.on('disconnect', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    rooms[room].players = rooms[room].players.filter(p => p.id !== socket.id);
    if (rooms[room].players.length === 0) { delete rooms[room]; return; }
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