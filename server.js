const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

// ─── DECK ────────────────────────────────────────────────────────────────────

function buildDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ suit, rank });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ─── DEAL ────────────────────────────────────────────────────────────────────

function dealHand(room) {
  const cardsPerPlayer = 8 - room.currentHand;
  const deck = shuffle(buildDeck());

  room.players.forEach(p => { p.hand = deck.splice(0, cardsPerPlayer); });
  room.drawPile = deck;

  // Reset all state
  room.pendingPickup = 0;
  room.pendingEffect = null;
  room.currentSuit = null;
  room.currentRank = null;
  room.skippedPlayers = new Set();
  room.direction = 1;
  room.lastCardDeclared = false;
  room.flippedCardEffect = null;
  room.flippedAceCount = 0;
  room.waitingForDealerSuit = false;

  // Flip top card
  const topCard = deck.splice(0, 1)[0];
  room.discardPile = [topCard];
  room.currentSuit = topCard.suit;
  room.currentRank = topCard.rank;

  // Apply flipped card effect
  const r = topCard.rank;
  if (r === '2') {
    room.pendingPickup = 2;
    room.pendingEffect = 'dink';
  } else if (r === '5') {
    room.pendingEffect = 'forceFive';
  } else if (r === '6') {
    room.pendingEffect = 'equalRank';
  } else if (r === '9') {
    if (room.players.length > 2) room.direction = -1;
  } else if (r === '10') {
    const swap = { hearts:'diamonds', diamonds:'hearts', clubs:'spades', spades:'clubs' };
    room.currentSuit = swap[topCard.suit];
  } else if (r === 'J') {
    // Skip player left of dealer — handled after dealHand call
    room.flippedCardEffect = 'jack';
  } else if (r === 'A') {
    room.flippedCardEffect = 'ace';
    room.flippedAceCount = 1;
  } else if (r === '4') {
    room.flippedCardEffect = 'four';
  } else if (r === '8' || r === '3') {
    // Dealer must call suit before play begins
    room.flippedCardEffect = r === '8' ? 'eight' : 'three';
    room.waitingForDealerSuit = true;
  }
  // 7, Q, K — no effect at all
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function refillDraw(room) {
  if (room.drawPile.length === 0 && room.discardPile.length > 1) {
    const top = room.discardPile.pop();
    room.drawPile = shuffle(room.discardPile);
    room.discardPile = [top];
  }
}

function nextIndex(room, from, steps = 1) {
  const total = room.players.length;
  let idx = from;
  for (let i = 0; i < steps; i++)
    idx = ((idx + room.direction) % total + total) % total;
  return idx;
}

function advanceTurn(room) {
  let idx = nextIndex(room, room.currentPlayerIndex);
  while (room.skippedPlayers.has(idx)) {
    room.skippedPlayers.delete(idx);
    idx = nextIndex(room, idx);
  }
  room.currentPlayerIndex = idx;
}

function topCard(room) {
  return room.discardPile[room.discardPile.length - 1];
}

// After any draw, completely reset effects to top card
function clearEffects(room) {
  const top = topCard(room);
  room.currentSuit = top.suit;
  room.currentRank = top.rank;
  room.pendingEffect = null;
  room.pendingPickup = 0;
  room.flippedCardEffect = null;
  room.waitingForDealerSuit = false;
}

// ─── BROADCAST ───────────────────────────────────────────────────────────────

function broadcast(room, roomCode, message) {
  const top = topCard(room);
  room.players.forEach(player => {
    const s = io.sockets.sockets.get(player.id);
    if (!s) return;
    s.emit('gameState', {
      hand: player.hand,
      topCard: top,
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
      flippedCardEffect: room.flippedCardEffect,
      waitingForDealerSuit: room.waitingForDealerSuit,
      dealerIndex: room.dealerIndex,
      myName: player.name,
      message
    });
  });
}

// ─── VALIDITY ────────────────────────────────────────────────────────────────

function isValidPlay(cards, room) {
  if (room.waitingForDealerSuit) return false;
  if (room.waitingForDealerPenalty) return false;

  const { currentSuit, currentRank, pendingEffect } = room;

  if (pendingEffect === 'dink')
    return cards.every(c => c.rank === '2');
  if (pendingEffect === 'forceFive')
    return cards.every(c => c.rank === '5');
  if (pendingEffect === 'equalRank')
    return cards.length >= 2 && cards.every(c => c.rank === cards[0].rank);

  if (!cards.every(c => c.rank === cards[0].rank)) return false;

  const rank = cards[0].rank;
  const suit = cards[0].suit;

  if (rank === '8') return true;
  if (rank === '3') return suit === currentSuit || currentRank === '3';

  return suit === currentSuit || rank === currentRank;
}

// ─── NEXT HAND / ROUND ───────────────────────────────────────────────────────

function emitHandState(room, roomCode, eventName) {
  const top = topCard(room);
  room.players.forEach(player => {
    const s = io.sockets.sockets.get(player.id);
    if (!s) return;
    s.emit(eventName, {
      hand: player.hand,
      topCard: top,
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
      flippedCardEffect: room.flippedCardEffect,
      waitingForDealerSuit: room.waitingForDealerSuit,
      dealerIndex: room.dealerIndex,
      myName: player.name,
      message: `Hand ${room.currentHand} begins!`
    });
  });

  // If flipped card is 8 or 3, ask dealer to pick suit
  if (room.waitingForDealerSuit) {
    const dealerSocket = io.sockets.sockets.get(room.players[room.dealerIndex].id);
    if (dealerSocket) dealerSocket.emit('chooseSuit');
    // Tell everyone else to wait
    io.to(roomCode).emit('waitingForDealerSuit', {
      dealerName: room.players[room.dealerIndex].name,
      flippedCard: topCard(room)
    });
  }

  // If flipped card is ace or 4, ask dealer to accept/reject
  if (room.flippedCardEffect === 'ace' || room.flippedCardEffect === 'four') {
    const dealerSocket = io.sockets.sockets.get(room.players[room.dealerIndex].id);
    if (dealerSocket) dealerSocket.emit('dealerPenaltyPrompt', { effect: room.flippedCardEffect });
  }
}

function startNextHand(roomData, roomCode) {
  if (roomData.currentHand >= 7) {
    // Round over
    const maxHands = Math.max(...roomData.players.map(p => p.handsWon));
    const winners = roomData.players.filter(p => p.handsWon === maxHands);
    winners.forEach(w => w.score++);
    io.to(roomCode).emit('roundOver', {
      players: roomData.players.map(p => ({ name: p.name, handsWon: p.handsWon, score: p.score })),
      winner: winners.map(w => w.name).join(' & '),
      message: `🏆 ${winners.map(w => w.name).join(' & ')} wins the round!`
    });
    return;
  }

  roomData.currentHand++;
  roomData.dealerIndex = (roomData.dealerIndex + 1) % roomData.players.length;
  roomData.currentPlayerIndex = (roomData.dealerIndex + 1) % roomData.players.length;

  dealHand(roomData);
  applyFlippedCardTurnEffects(roomData);
  emitHandState(roomData, roomCode, 'nextHand');
}

// Apply turn-order effects from flipped card (jack skip, etc.)
function applyFlippedCardTurnEffects(room) {
  if (room.flippedCardEffect === 'jack') {
    // Skip player left of dealer (first player), second player goes first
    const skipped = (room.dealerIndex + 1) % room.players.length;
    room.skippedPlayers.add(skipped);
    // currentPlayerIndex is already set to first player left of dealer
    // advanceTurn will skip them automatically on first move
    // But we need to advance NOW so the right player starts
    let idx = nextIndex(room, room.dealerIndex);
    while (room.skippedPlayers.has(idx)) {
      room.skippedPlayers.delete(idx);
      idx = nextIndex(room, idx);
    }
    room.currentPlayerIndex = idx;
  }
}

// ─── SOCKET ──────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('joinRoom', ({ name, room }) => {
    if (rooms[room] && rooms[room].gameStarted) { socket.emit('gameInProgress'); return; }
    if (rooms[room] && rooms[room].players.length >= 5) { socket.emit('roomFull'); return; }
    if (rooms[room] && rooms[room].players.find(p => p.name === name)) { socket.emit('nameTaken'); return; }

    if (!rooms[room]) {
      rooms[room] = {
        players: [], gameStarted: false, host: socket.id,
        currentHand: 1, dealerIndex: 0, currentPlayerIndex: 0,
        direction: 1, drawPile: [], discardPile: [],
        currentSuit: null, currentRank: null,
        pendingPickup: 0, pendingEffect: null,
        skippedPlayers: new Set(),
        lastCardDeclared: false, flippedCardEffect: null,
        flippedAceCount: 0, waitingForDealerSuit: false
      };
    }

    const player = { id: socket.id, name, isHost: rooms[room].host === socket.id, hand: [], handsWon: 0, score: 0 };
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

  // ── PICK DEALER ──

  socket.on('pickDealer', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room] || rooms[room].host !== socket.id) return;

    const FLIP_SUITS = ['hearts','diamonds','clubs','spades'];
    const FLIP_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

    function flipCards(playerList) {
      const flipped = playerList.map(p => ({
        name: p.name,
        card: { rank: FLIP_RANKS[Math.floor(Math.random() * 13)], suit: FLIP_SUITS[Math.floor(Math.random() * 4)] }
      }));
      const max = Math.max(...flipped.map(f => RANK_VALUES[f.card.rank]));
      return { flippedCards: flipped, winners: flipped.filter(f => RANK_VALUES[f.card.rank] === max) };
    }

    let { flippedCards, winners } = flipCards(rooms[room].players);
    while (winners.length > 1) {
      const tied = flipCards(winners.map(w => ({ name: w.name })));
      flippedCards = flippedCards.map(f => tied.flippedCards.find(t => t.name === f.name) || f);
      winners = tied.winners;
    }

    const winnerName = winners[0].name;
    const dealerIndex = rooms[room].players.findIndex(p => p.name === winnerName);
    rooms[room].dealerIndex = dealerIndex;

    io.to(room).emit('cardFlipResult', {
      players: rooms[room].players.map(p => ({ name: p.name, isHost: p.isHost })),
      flippedCards, dealerIndex, winnerName
    });
  });

  // ── START GAME ──

  socket.on('startGame', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    if (rooms[room].players.length < 2) { socket.emit('notEnoughPlayers'); return; }

    const r = rooms[room];
    r.gameStarted = true;
    r.currentHand = 1;
    r.players.forEach(p => { p.handsWon = 0; p.score = 0; });
    r.currentPlayerIndex = (r.dealerIndex + 1) % r.players.length;

    dealHand(r);
    applyFlippedCardTurnEffects(r);
    emitHandState(r, room, 'gameStarted');
  });

  // ── DEALER SUIT CHOICE (flipped 8 or 3) ──

  socket.on('dealerSuitChoice', ({ suit }) => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    if (!r.waitingForDealerSuit) return;
    const dealer = r.players[r.dealerIndex];
    if (!dealer || dealer.id !== socket.id) return;

    r.currentSuit = suit;
    r.waitingForDealerSuit = false;
    r.flippedCardEffect = null;

    broadcast(r, room, `${dealer.name} called ${suit} from the flipped card!`);
  });

  // ── DEALER PENALTY CHOICE (flipped A or 4) ──

  socket.on('dealerPenaltyChoice', ({ accept, cardIndex }) => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    const dealer = r.players[r.dealerIndex];
    if (!dealer || dealer.id !== socket.id) return;

    if (accept) {
      if (r.flippedCardEffect === 'ace') {
        r.skippedPlayers.add(r.dealerIndex);
        r.flippedCardEffect = null;
        broadcast(r, room, `${dealer.name} accepted the Ace penalty — loses first turn!`);
      } else if (r.flippedCardEffect === 'four') {
        refillDraw(r);
        dealer.hand.push(...r.drawPile.splice(0, 1));
        r.flippedCardEffect = null;
        broadcast(r, room, `${dealer.name} accepted the 4 penalty — picked up one card!`);
      }
    } else {
      // Reject — must play a matching card immediately
      const card = dealer.hand[cardIndex];
      if (!card) { socket.emit('invalidPlay', 'No card to reject with!'); return; }
      if (r.flippedCardEffect === 'ace' && card.rank !== 'A') { socket.emit('invalidPlay', 'You can only reject with an Ace!'); return; }
      if (r.flippedCardEffect === 'four' && card.rank !== '4') { socket.emit('invalidPlay', 'You can only reject with a 4!'); return; }

      dealer.hand = dealer.hand.filter((_, i) => i !== cardIndex);
      r.discardPile.push(card);
      // The suit is now determined by the card played
      r.currentSuit = card.suit;
      r.currentRank = card.rank;
      r.flippedCardEffect = null;

      broadcast(r, room, `${dealer.name} played their own ${card.rank} — penalty cancelled!`);
    }
  });

  // ── PLAY CARDS ──

  socket.on('playCards', ({ cardIndices }) => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const r = rooms[room];

    // Block play if waiting for dealer suit
    if (r.waitingForDealerSuit) { socket.emit('invalidPlay', 'Waiting for dealer to call a suit!'); return; }
    // Block play if waiting for dealer penalty choice
    if (r.flippedCardEffect === 'ace' || r.flippedCardEffect === 'four') { socket.emit('invalidPlay', 'Waiting for dealer to resolve the flipped card!'); return; }

    const playerIndex = r.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== r.currentPlayerIndex) { socket.emit('invalidPlay', 'It is not your turn!'); return; }

    const player = r.players[playerIndex];
    const cards = cardIndices.map(i => player.hand[i]);

    if (!isValidPlay(cards, r)) {
      socket.emit('invalidPlay', `Cannot play: suit=${r.currentSuit} rank=${r.currentRank} pending=${r.pendingEffect} pickup=${r.pendingPickup} waitSuit=${r.waitingForDealerSuit} waitPenalty=${r.waitingForDealerPenalty} | tried: ${cards.map(c=>c.rank+c.suit).join(',')}`);
      return;
    }
    
    // Remove played cards from hand
    player.hand = player.hand.filter((_, i) => !cardIndices.includes(i));
    cards.forEach(c => r.discardPile.push(c));

    // The LAST card played determines suit and rank
    const last = cards[cards.length - 1];
    const rank = last.rank;
    const suit = last.suit;
    const count = cards.length;

    // Reset pending state — effects below may set new ones
    r.pendingEffect = null;
    r.pendingPickup = 0;
    r.currentRank = rank;
    r.currentSuit = suit;
    r.flippedCardEffect = null;
    r.waitingForDealerSuit = false;

    let message = `${player.name} played ${count > 1 ? count + 'x ' : ''}${rank}`;
    let extraTurn = false;

    // ── CARD EFFECTS ──

    if (rank === '2') {
      // Stackable dink — max 8 pickup
      r.pendingPickup = Math.min((r.pendingPickup || 0) + count * 2, 8);
      r.pendingEffect = 'dink';
      message = `${player.name} played ${count > 1 ? count + 'x Dinks' : 'a Dink'}! Next player picks up ${r.pendingPickup}!`;
    }

    else if (rank === '3') {
      // Half wild — player picks suit
      r.pendingEffect = null;
      message = `${player.name} played a 3! Choosing suit...`;
      broadcast(r, room, message);
      socket.emit('chooseSuit');
      return; // Wait for suit choice before advancing turn
    }

    else if (rank === '4') {
      if (count % 2 !== 0) {
        // Odd 4s — player picks up 1 immediately
        refillDraw(r);
        player.hand.push(...r.drawPile.splice(0, 1));
        message = `${player.name} played ${count} Four${count > 1 ? 's' : ''} — picks up one card!`;
      } else {
        message = `${player.name} played ${count} Fours — even, no penalty!`;
      }
    }

    else if (rank === '5') {
      r.pendingEffect = 'forceFive';
      message = `${player.name} played a 5! Next player must play a 5 or pick up!`;
    }

    else if (rank === '6') {
      r.pendingEffect = 'equalRank';
      message = `${player.name} played a 6! Next player must play 2+ of the same rank!`;
    }

    else if (rank === '8') {
      // Full wild — player picks suit
      message = `${player.name} played a wild 8! Choosing suit...`;
      broadcast(r, room, message);
      socket.emit('chooseSuit');
      return; // Wait for suit choice before advancing turn
    }

    else if (rank === '9') {
      if (r.players.length > 2) {
        r.direction *= -1;
        message = `${player.name} reversed direction!`;
      } else {
        message = `${player.name} played a 9 — no effect in 2-player!`;
      }
    }

    else if (rank === '10') {
      const swap = { hearts:'diamonds', diamonds:'hearts', clubs:'spades', spades:'clubs' };
      r.currentSuit = swap[suit];
      message = `${player.name} played a 10! Suit swapped to ${r.currentSuit}!`;
    }

    else if (rank === 'J') {
      if (r.players.length === 2) {
        extraTurn = true;
        message = `${player.name} played a Jack — plays again!`;
      } else {
        const skipped = nextIndex(r, playerIndex);
        r.skippedPlayers.add(skipped);
        message = `${player.name} played a Jack! ${r.players[skipped].name} is skipped!`;
      }
    }

    else if (rank === 'K') {
      if (count % 2 === 0) {
        extraTurn = true;
        message = `${player.name} played ${count} Kings — gets another turn!`;
      } else {
        message = `${player.name} played ${count} King${count > 1 ? 's' : ''} — odd count, no extra turn!`;
      }
    }

    else if (rank === 'A') {
      const totalAces = count + (r.flippedAceCount || 0);
      r.flippedAceCount = 0;
      if (totalAces % 2 !== 0) {
        r.skippedPlayers.add(playerIndex);
        message = `${player.name} played ${count} Ace${count > 1 ? 's' : ''} — loses next turn!`;
      } else {
        message = `${player.name} played ${count} Ace${count > 1 ? 's' : ''} — even number, no effect!`;
      }
    }

    // ── CHECK WIN ──

    if (player.hand.length === 0) {
      player.handsWon++;
      message = `🎉 ${player.name} won hand ${r.currentHand}!`;
      broadcast(r, room, message);
      setTimeout(() => startNextHand(r, room), 2000);
      return;
    }

    // ── LAST CARD CHECK ──

    if (player.hand.length === 1 && !r.lastCardDeclared) {
      io.to(room).emit('catchable', { playerName: player.name });
    }
    r.lastCardDeclared = false;

    // ── ADVANCE TURN ──

    if (!extraTurn) advanceTurn(r);

    broadcast(r, room, message);
  });

  // ── DRAW CARD ──

  socket.on('drawCard', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const r = rooms[room];

    if (r.waitingForDealerSuit || r.waitingForDealerPenalty) return;

    const playerIndex = r.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== r.currentPlayerIndex) return;
    const player = r.players[playerIndex];

    refillDraw(r);

    // Figure out how many cards to draw and what message to show
    let drawCount = 1;
    let msg = `${player.name} picked up one card.`;

    if (r.pendingPickup > 0) {
      drawCount = r.pendingPickup;
      msg = `${player.name} picked up ${drawCount} card${drawCount > 1 ? 's' : ''}!`;
    } else if (r.pendingEffect === 'forceFive') {
      msg = `${player.name} couldn't play a 5 — picked up one card!`;
    } else if (r.pendingEffect === 'equalRank') {
      msg = `${player.name} couldn't match the rank — picked up one card!`;
    } else if (r.pendingEffect === 'dink') {
      drawCount = r.pendingPickup || 2;
      msg = `${player.name} picked up ${drawCount} card${drawCount > 1 ? 's' : ''}!`;
    }

    // Draw the cards
    const drawn = r.drawPile.splice(0, drawCount);
    player.hand.push(...drawn);

    // ALWAYS fully wipe ALL effects after any draw — no exceptions
    r.pendingEffect = null;
    r.pendingPickup = 0;
    r.flippedCardEffect = null;
    r.waitingForDealerSuit = false;
    r.waitingForDealerPenalty = false;

    // Reset suit and rank to actual top of discard pile
    const top = topCard(r);
    r.currentSuit = top.suit;
    r.currentRank = top.rank;

    advanceTurn(r);
    broadcast(r, room, msg);
  });

  // ── SUIT CHOSEN (after 8 or 3 played, or dealer suit for flipped 8/3) ──

  socket.on('suitChosen', ({ suit }) => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const r = rooms[room];

    // If waiting for dealer suit (flipped 8 or 3)
    if (r.waitingForDealerSuit) {
      const dealer = r.players[r.dealerIndex];
      if (!dealer || dealer.id !== socket.id) return;
      r.currentSuit = suit;
      r.waitingForDealerSuit = false;
      r.flippedCardEffect = null;
      broadcast(r, room, `${dealer.name} called ${suit}! Game begins!`);
      return;
    }

    // Normal suit choice after playing 8 or 3
    const player = r.players.find(p => p.id === socket.id);
    if (!player) return;
    r.pendingEffect = null;
    r.pendingPickup = 0;
    advanceTurn(r);
    // Set suit AFTER advancing so it is not overwritten
    r.currentSuit = suit;
    broadcast(r, room, `${player.name} chose ${suit}!`);
  });

  // ── LAST CARD ──

  socket.on('declareLastCard', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    const playerIndex = r.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== r.currentPlayerIndex) return;
    r.lastCardDeclared = true;
    io.to(room).emit('lastCardDeclared', { playerName: r.players[playerIndex].name });
  });

  socket.on('catchLastCard', ({ caughtPlayerName }) => {
    const room = socket.roomCode;
    if (!room || !rooms[room]) return;
    const r = rooms[room];
    const caught = r.players.find(p => p.name === caughtPlayerName);
    if (!caught) return;
    refillDraw(r);
    caught.hand.push(...r.drawPile.splice(0, 1));
    const catcher = r.players.find(p => p.id === socket.id);
    const msg = `⚠️ ${catcher.name} caught ${caughtPlayerName}! They pick up one card!`;
    io.to(room).emit('caughtLastCard', { caughtPlayerName, msg });
    broadcast(r, room, msg);
  });

  // ── NEXT ROUND ──

  socket.on('nextRound', () => {
    const room = socket.roomCode;
    if (!room || !rooms[room] || rooms[room].host !== socket.id) return;
    const r = rooms[room];
    r.players.forEach(p => { p.handsWon = 0; });
    r.dealerIndex = (r.dealerIndex + 1) % r.players.length;
    r.currentPlayerIndex = (r.dealerIndex + 1) % r.players.length;
    r.currentHand = 1;
    dealHand(r);
    applyFlippedCardTurnEffects(r);
    emitHandState(r, room, 'nextHand');
  });

  // ── DISCONNECT ──

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
server.listen(PORT, () => console.log(`Dink running on port ${PORT}`));