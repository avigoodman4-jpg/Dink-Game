const socket = io();

// ─── SCREENS ─────────────────────────────────────────────────────────────────

const lobbyScreen    = document.getElementById('lobby-screen');
const waitingScreen  = document.getElementById('waiting-screen');
const gameScreen     = document.getElementById('game-screen');

// ─── STATE ───────────────────────────────────────────────────────────────────

let myName = '';
let myRoom = '';
let isHost = false;
let myHand = [];
let players = [];
let currentPlayerIndex = 0;
let dealerIndex = 0;
let direction = 1;
let pendingEffect = null;
let selectedCardIndices = [];
let lastCardDeclared = false;

const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const RANK_ORDER   = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

// ─── LOBBY ───────────────────────────────────────────────────────────────────

document.getElementById('join-btn').addEventListener('click', () => {
  const name = document.getElementById('name-input').value.trim();
  const room = document.getElementById('room-input').value.trim().toUpperCase();
  if (!name || !room) { showLobbyError('Please enter both a name and a room code!'); return; }
  myName = name;
  myRoom = room;
  socket.emit('joinRoom', { name, room });
});

function showLobbyError(msg) {
  const el = document.getElementById('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ─── WAITING ROOM ─────────────────────────────────────────────────────────────

function showWaitingRoom(playerList, host) {
  lobbyScreen.classList.add('hidden');
  waitingScreen.classList.remove('hidden');
  document.getElementById('waiting-room-code').textContent = `Room Code: ${myRoom}`;
  updateWaitingPlayers(playerList);
  if (host) {
    document.getElementById('pick-dealer-btn').classList.remove('hidden');
    document.getElementById('waiting-msg').textContent = 'Flip cards to pick a dealer when everyone has joined!';
  } else {
    document.getElementById('waiting-msg').textContent = 'Waiting for the host to start...';
  }
}

function updateWaitingPlayers(playerList) {
  const el = document.getElementById('waiting-players-list');
  el.innerHTML = '';
  playerList.forEach(p => {
    const div = document.createElement('div');
    div.classList.add('waiting-player');
    div.textContent = p.isHost ? `👑 ${p.name} (Host)` : `🃏 ${p.name}`;
    el.appendChild(div);
  });
}

document.getElementById('pick-dealer-btn').addEventListener('click', () => socket.emit('pickDealer'));
document.getElementById('start-btn').addEventListener('click', () => socket.emit('startGame'));

// ─── CARD FLIP ───────────────────────────────────────────────────────────────

function showCardFlipStage(playerList) {
  document.getElementById('waiting-stage-1').classList.add('hidden');
  document.getElementById('waiting-stage-2').classList.remove('hidden');
  const container = document.getElementById('flip-cards-container');
  container.innerHTML = '';
  playerList.forEach(p => {
    const wrapper = document.createElement('div');
    wrapper.classList.add('flip-card-wrapper');
    wrapper.id = `flip-wrapper-${p.name}`;
    const label = document.createElement('div');
    label.classList.add('player-label');
    label.textContent = p.name;
    const card = document.createElement('div');
    card.classList.add('flip-card');
    card.id = `flip-card-${p.name}`;
    card.innerHTML = `<div class="flip-card-inner"><div class="flip-card-front">🂠</div><div class="flip-card-back" id="flip-card-back-${p.name}"></div></div>`;
    wrapper.appendChild(label);
    wrapper.appendChild(card);
    container.appendChild(wrapper);
  });
}

function revealFlippedCards(flippedCards, winnerName) {
  const flipMsg = document.getElementById('flip-msg');
  flipMsg.textContent = 'Flipping...';
  flippedCards.forEach((f, i) => {
    setTimeout(() => {
      const cardEl = document.getElementById(`flip-card-${f.name}`);
      const backEl = document.getElementById(`flip-card-back-${f.name}`);
      if (!cardEl || !backEl) return;
      const isRed = f.card.suit === 'hearts' || f.card.suit === 'diamonds';
      backEl.classList.add(isRed ? 'red-card' : 'black-card');
      backEl.innerHTML = `<span>${f.card.rank}</span><span>${SUIT_SYMBOLS[f.card.suit]}</span>`;
      cardEl.classList.add('flipped');
      if (i === flippedCards.length - 1) {
        setTimeout(() => {
          const w = document.getElementById(`flip-wrapper-${winnerName}`);
          if (w) w.classList.add('winner-card');
          flipMsg.textContent = `🏆 ${winnerName} has the highest card and is the dealer!`;
        }, 800);
      }
    }, i * 400);
  });
}

function showDealerReveal(playerList, winnerIndex) {
  document.getElementById('waiting-stage-2').classList.add('hidden');
  document.getElementById('waiting-stage-3').classList.remove('hidden');
  document.getElementById('dealer-name').textContent = playerList[winnerIndex].name;
  const list2 = document.getElementById('waiting-players-list-2');
  list2.innerHTML = '';
  playerList.forEach((p, i) => {
    const div = document.createElement('div');
    div.classList.add('waiting-player');
    if (i === winnerIndex) { div.classList.add('dealer-badge'); div.textContent = `🃏 ${p.name} (Dealer)`; }
    else div.textContent = p.isHost ? `👑 ${p.name} (Host)` : `🎴 ${p.name}`;
    list2.appendChild(div);
  });
  if (isHost) {
    document.getElementById('start-btn').classList.remove('hidden');
    document.getElementById('waiting-msg-2').textContent = 'Everyone ready? Start the game!';
  } else {
    document.getElementById('waiting-msg-2').textContent = 'Waiting for the host to start the game...';
  }
}

// ─── GAME STATE ───────────────────────────────────────────────────────────────

function updateGameState(data) {
  myHand = data.hand;
  players = data.players;
  currentPlayerIndex = data.currentPlayerIndex;
  dealerIndex = data.dealerIndex;
  direction = data.direction || 1;
  pendingEffect = data.pendingEffect;
  selectedCardIndices = [];
  lastCardDeclared = false;

  document.getElementById('hand-display').textContent = `Hand ${data.currentHand} of 7`;
  document.getElementById('score-display').textContent = players.map(p => `${p.name}: ${p.score || 0}pts`).join(' | ');

  renderHand();
  renderDiscardPile(data.topCard, data.currentSuit);
  renderPlayers(data.players, data.direction);
  updateTurnDisplay(data);

  if (data.message) logMessage(data.message);

  // Hide dealer panels by default
  document.getElementById('dealer-penalty-prompt').classList.add('hidden');
  document.getElementById('suit-picker').classList.add('hidden');

  // Show dealer suit prompt if waiting
  if (data.waitingForDealerSuit) {
    const isDealer = players[dealerIndex] && players[dealerIndex].name === myName;
    if (!isDealer) {
      const dName = players[dealerIndex] ? players[dealerIndex].name : 'Dealer';
      logMessage(`⏳ Waiting for ${dName} to call a suit...`);
    }
  }

  // Show dealer penalty prompt
  if (data.flippedCardEffect === 'ace' || data.flippedCardEffect === 'four') {
    const isDealer = players[dealerIndex] && players[dealerIndex].name === myName;
    if (isDealer) {
      showDealerPenaltyPrompt(data.flippedCardEffect);
    } else {
      const dName = players[dealerIndex] ? players[dealerIndex].name : 'Dealer';
      logMessage(`⏳ Waiting for ${dName} to decide on the flipped card penalty...`);
    }
  }
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function renderHand() {
  const handDiv = document.getElementById('player-hand');
  handDiv.innerHTML = '';
  myHand.forEach((card, index) => {
    const div = document.createElement('div');
    div.classList.add('card');
    if (card.suit === 'hearts' || card.suit === 'diamonds') div.classList.add('red');
    if (selectedCardIndices.includes(index)) div.classList.add('selected');
    div.innerHTML = `<span>${card.rank}</span><span>${SUIT_SYMBOLS[card.suit]}</span>`;
    div.addEventListener('click', () => onCardClick(index));
    handDiv.appendChild(div);
  });
}

function renderDiscardPile(top, currentSuit) {
  const el = document.getElementById('discard-pile');
  const isRed = top.suit === 'hearts' || top.suit === 'diamonds';
  el.innerHTML = `<span>${top.rank}</span><span>${SUIT_SYMBOLS[top.suit]}</span>`;
  el.style.color = isRed ? '#cc2200' : '#111';

  const suitEl = document.getElementById('suit-indicator');
  if (currentSuit && currentSuit !== top.suit) {
    const suitIsRed = currentSuit === 'hearts' || currentSuit === 'diamonds';
    suitEl.textContent = `Active suit: ${SUIT_SYMBOLS[currentSuit]}`;
    suitEl.style.color = suitIsRed ? '#ff6644' : 'white';
  } else {
    suitEl.textContent = '';
  }
}

function renderPlayers(playerList, dir) {
  const container = document.getElementById('other-players');
  container.innerHTML = '';
  const total = playerList.length;
  const cx = 160, cy = 160, radius = 120;
  const myIndex = playerList.findIndex(p => p.name === myName);

  // SVG for circle and arrow
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '320');
  svg.setAttribute('height', '320');
  svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';

  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', radius - 20);
  circle.setAttribute('fill', 'rgba(255,255,255,0.05)');
  circle.setAttribute('stroke', 'rgba(255,255,255,0.15)');
  circle.setAttribute('stroke-width', '2');
  svg.appendChild(circle);

  // Direction arrow
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arr'); marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6');
  marker.setAttribute('refX', '3'); marker.setAttribute('refY', '3'); marker.setAttribute('orient', 'auto');
  const mp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  mp.setAttribute('d', 'M 0 0 L 6 3 L 0 6 Z'); mp.setAttribute('fill', 'rgba(240,192,64,0.6)');
  marker.appendChild(mp); defs.appendChild(marker); svg.appendChild(defs);

  const ar = radius - 30;
  const sa = (dir === 1 ? -60 : 240) * Math.PI / 180;
  const ea = (dir === 1 ? 60 : 120) * Math.PI / 180;
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arc.setAttribute('d', `M ${cx + ar * Math.cos(sa)} ${cy + ar * Math.sin(sa)} A ${ar} ${ar} 0 0 ${dir === 1 ? 1 : 0} ${cx + ar * Math.cos(ea)} ${cy + ar * Math.sin(ea)}`);
  arc.setAttribute('fill', 'none'); arc.setAttribute('stroke', 'rgba(240,192,64,0.4)');
  arc.setAttribute('stroke-width', '2'); arc.setAttribute('marker-end', 'url(#arr)');
  svg.appendChild(arc);
  container.appendChild(svg);

  // Player tokens
  playerList.forEach((p, i) => {
    const offset = myIndex >= 0 ? i - myIndex : i;
    const angle = (offset / total) * 360 - 90;
    const rad = angle * Math.PI / 180;
    const x = cx + radius * Math.cos(rad);
    const y = cy + radius * Math.sin(rad);

    const div = document.createElement('div');
    div.classList.add('circle-player');
    if (i === currentPlayerIndex) div.classList.add('circle-player-active');
    if (p.name === myName) div.classList.add('circle-player-me');
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;

    const isDealer = i === dealerIndex;
    div.innerHTML = `
      <div class="circle-player-avatar">
        ${p.name.charAt(0).toUpperCase()}
        ${isDealer ? '<span class="dealer-indicator">D</span>' : ''}
      </div>
      <div class="circle-player-name">${p.name === myName ? 'You' : p.name}</div>
      <div class="circle-player-cards">${p.cardCount} 🃏</div>
      <div class="circle-player-hands">🏆 ${p.handsWon || 0}</div>
    `;
    container.appendChild(div);
  });
}

// ─── TURN ─────────────────────────────────────────────────────────────────────

function isMyTurn() {
  return players[currentPlayerIndex] && players[currentPlayerIndex].name === myName;
}

function updateTurnDisplay(data) {
  const banner = document.getElementById('turn-banner');
  const drawBtn = document.getElementById('draw-btn');
  const playBtn = document.getElementById('play-btn');
  const lastCardBtn = document.getElementById('last-card-btn');

  // Don't show action buttons if waiting for dealer
  const blocked = data.waitingForDealerSuit || data.flippedCardEffect === 'ace' || data.flippedCardEffect === 'four';

  if (isMyTurn() && !blocked) {
    let text = '🟡 YOUR TURN!';
    if (data.pendingPickup > 0) text = `🟡 YOUR TURN — Stack a 2 or pick up ${data.pendingPickup}!`;
    if (data.pendingEffect === 'forceFive') text = '🟡 YOUR TURN — Play a 5 or pick up!';
    if (data.pendingEffect === 'equalRank') text = '🟡 YOUR TURN — Play 2+ of the same rank or pick up!';
    banner.textContent = text;
    banner.classList.add('my-turn');
    banner.classList.remove('other-turn');
    drawBtn.classList.remove('hidden');
    lastCardBtn.classList.toggle('hidden', myHand.length !== 2);
  } else {
    const cp = players[currentPlayerIndex];
    banner.textContent = blocked ? '⏳ Waiting for dealer...' : (cp ? `⏳ ${cp.name}'s turn...` : '');
    banner.classList.add('other-turn');
    banner.classList.remove('my-turn');
    drawBtn.classList.add('hidden');
    playBtn.classList.add('hidden');
    lastCardBtn.classList.add('hidden');
  }
}

// ─── CARD CLICK ───────────────────────────────────────────────────────────────

function onCardClick(index) {
  if (!isMyTurn()) { logMessage("It's not your turn!"); return; }
  if (selectedCardIndices.includes(index)) {
    selectedCardIndices = selectedCardIndices.filter(i => i !== index);
  } else {
    selectedCardIndices.push(index);
  }
  renderHand();
  document.getElementById('play-btn').classList.toggle('hidden', selectedCardIndices.length === 0);
}

// ─── LOG ─────────────────────────────────────────────────────────────────────

function logMessage(msg) {
  document.getElementById('game-log').textContent = msg;
}

// ─── SUIT PICKER ─────────────────────────────────────────────────────────────

function showSuitPicker(eventName) {
  const picker = document.getElementById('suit-picker');
  picker.classList.remove('hidden');
  // Store which event to emit when suit is chosen
  picker.dataset.eventName = eventName || 'suitChosen';
}

document.querySelectorAll('.suit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const suit = btn.dataset.suit;
    const eventName = document.getElementById('suit-picker').dataset.eventName || 'suitChosen';
    socket.emit(eventName, { suit });
    document.getElementById('suit-picker').classList.add('hidden');
  });
});

// ─── DEALER PENALTY PROMPT ───────────────────────────────────────────────────

function showDealerPenaltyPrompt(effect) {
  const prompt = document.getElementById('dealer-penalty-prompt');
  const msg = document.getElementById('dealer-penalty-msg');
  const rejectContainer = document.getElementById('dealer-reject-container');
  rejectContainer.innerHTML = '';

  const targetRank = effect === 'ace' ? 'A' : '4';
  const effectName = effect === 'ace' ? 'Ace' : '4';
  const matching = myHand.map((card, index) => ({ card, index })).filter(({ card }) => card.rank === targetRank);

  if (matching.length > 0) {
    msg.textContent = `The flipped card is a ${effectName}! You have a ${effectName} — play it to cancel, or accept the penalty.`;
    matching.forEach(({ card, index }) => {
      const btn = document.createElement('button');
      btn.classList.add('gold-btn');
      btn.style.cssText = 'font-size:13px;padding:8px 14px;';
      const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
      btn.style.color = isRed ? '#cc2200' : '#1a1a1a';
      btn.textContent = `❌ Play ${card.rank}${SUIT_SYMBOLS[card.suit]} to Reject`;
      btn.addEventListener('click', () => {
        socket.emit('dealerPenaltyChoice', { accept: false, cardIndex: index });
        prompt.classList.add('hidden');
      });
      rejectContainer.appendChild(btn);
    });
  } else {
    msg.textContent = `The flipped card is a ${effectName}! You have no ${effectName} to cancel — you must accept.`;
  }

  prompt.classList.remove('hidden');
}

document.getElementById('dealer-accept-btn').addEventListener('click', () => {
  socket.emit('dealerPenaltyChoice', { accept: true });
  document.getElementById('dealer-penalty-prompt').classList.add('hidden');
});

// ─── BUTTONS ─────────────────────────────────────────────────────────────────

document.getElementById('draw-btn').addEventListener('click', () => {
  if (!isMyTurn()) return;
  socket.emit('drawCard');
});

document.getElementById('play-btn').addEventListener('click', () => {
  if (!isMyTurn() || selectedCardIndices.length === 0) return;
  socket.emit('playCards', { cardIndices: selectedCardIndices });
  selectedCardIndices = [];
  document.getElementById('play-btn').classList.add('hidden');
});

document.getElementById('last-card-btn').addEventListener('click', () => {
  if (!isMyTurn()) return;
  lastCardDeclared = true;
  socket.emit('declareLastCard');
  document.getElementById('last-card-btn').classList.add('hidden');
  logMessage('You declared Last Card! Now play your card.');
});

document.getElementById('catch-btn').addEventListener('click', () => {
  const btn = document.getElementById('catch-btn');
  if (btn.dataset.target) {
    socket.emit('catchLastCard', { caughtPlayerName: btn.dataset.target });
    btn.classList.add('hidden');
  }
});

document.getElementById('next-round-btn').addEventListener('click', () => {
  if (isHost) socket.emit('nextRound');
});

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────

socket.on('joinedRoom', ({ room, players: pl, isHost: host }) => {
  isHost = host;
  showWaitingRoom(pl, host);
});

socket.on('playerJoined', ({ players: pl }) => updateWaitingPlayers(pl));

socket.on('playerLeft', ({ players: pl, name }) => {
  updateWaitingPlayers(pl);
  logMessage(`${name} left the room.`);
});

socket.on('roomFull',      () => showLobbyError('That room is full! (Max 5 players)'));
socket.on('nameTaken',     () => showLobbyError('That name is already taken in this room!'));
socket.on('gameInProgress',() => showLobbyError("This room's game has already started! Try a different room code."));
socket.on('notEnoughPlayers', () => {
  document.getElementById('waiting-msg-2').textContent = 'You need at least 2 players to start!';
});

socket.on('cardFlipResult', ({ players: pl, flippedCards, dealerIndex: di, winnerName }) => {
  dealerIndex = di;
  showCardFlipStage(pl);
  setTimeout(() => {
    revealFlippedCards(flippedCards, winnerName);
    setTimeout(() => showDealerReveal(pl, di), flippedCards.length * 400 + 2500);
  }, 500);
});

socket.on('gameStarted', (data) => {
  waitingScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  document.getElementById('room-display').textContent = `Room: ${myRoom}`;
  updateGameState(data);
});

socket.on('gameState', (data) => updateGameState(data));

socket.on('nextHand', (data) => {
  document.getElementById('round-over-overlay').classList.add('hidden');
  updateGameState(data);
});

socket.on('roundOver', ({ players: pl, winner, message }) => {
  const overlay = document.getElementById('round-over-overlay');
  const scoresList = document.getElementById('round-scores-list');
  const nextBtn = document.getElementById('next-round-btn');

  document.getElementById('round-over-msg').textContent = `🏆 ${winner} wins the round!`;
  scoresList.innerHTML = '';
  pl.forEach(p => {
    const div = document.createElement('div');
    div.classList.add('score-row');
    div.textContent = `${p.name}: ${p.score} point${p.score !== 1 ? 's' : ''} (${p.handsWon} hands won this round)`;
    scoresList.appendChild(div);
  });

  if (isHost) {
    nextBtn.textContent = 'Start Next Round';
    nextBtn.disabled = false;
    nextBtn.classList.remove('hidden');
  } else {
    nextBtn.textContent = 'Waiting for host...';
    nextBtn.disabled = true;
    nextBtn.classList.remove('hidden');
  }

  overlay.classList.remove('hidden');
  logMessage(message);
});

socket.on('chooseSuit', () => showSuitPicker('suitChosen'));

socket.on('waitingForDealerSuit', ({ dealerName, flippedCard }) => {
  logMessage(`⏳ ${dealerName} is calling a suit for the flipped ${flippedCard.rank}...`);
});

socket.on('dealerPenaltyPrompt', ({ effect }) => {
  showDealerPenaltyPrompt(effect);
});

socket.on('invalidPlay', (msg) => logMessage(`❌ ${msg}`));

socket.on('catchable', ({ playerName }) => {
  if (playerName === myName) return;
  const btn = document.getElementById('catch-btn');
  btn.dataset.target = playerName;
  btn.classList.remove('hidden');
  setTimeout(() => btn.classList.add('hidden'), 3000);
});

socket.on('caughtLastCard', ({ msg }) => {
  document.getElementById('catch-btn').classList.add('hidden');
  logMessage(msg);
});

socket.on('lastCardDeclared', ({ playerName }) => {
  logMessage(`🔔 ${playerName} said Last Card!`);
});