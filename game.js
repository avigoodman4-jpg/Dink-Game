const socket = io();

// Screens
const lobbyScreen = document.getElementById('lobby-screen');
const waitingScreen = document.getElementById('waiting-screen');
const gameScreen = document.getElementById('game-screen');

// Lobby elements
const joinBtn = document.getElementById('join-btn');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const lobbyError = document.getElementById('lobby-error');

// Waiting room elements
const waitingRoomCode = document.getElementById('waiting-room-code');
const waitingPlayersList = document.getElementById('waiting-players-list');
const pickDealerBtn = document.getElementById('pick-dealer-btn');
const startBtn = document.getElementById('start-btn');
const waitingMsg = document.getElementById('waiting-msg');
const waitingMsg2 = document.getElementById('waiting-msg-2');

// Game state
let myName = '';
let myRoom = '';
let isHost = false;
let myHand = [];
let currentPlayerIndex = 0;
let players = [];
let dealerIndex = 0;
let direction = 1;
let pendingEffect = null;
let selectedCardIndices = [];
let lastCardDeclared = false;

const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

// --- LOBBY ---

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  const room = roomInput.value.trim().toUpperCase();
  if (!name || !room) { showLobbyError('Please enter both a name and a room code!'); return; }
  myName = name;
  myRoom = room;
  socket.emit('joinRoom', { name, room });
});

function showLobbyError(msg) {
  lobbyError.textContent = msg;
  lobbyError.classList.remove('hidden');
}

// --- WAITING ROOM ---

function showWaitingRoom(playerList, host) {
  lobbyScreen.classList.add('hidden');
  waitingScreen.classList.remove('hidden');
  waitingRoomCode.textContent = `Room Code: ${myRoom}`;
  updateWaitingPlayers(playerList);
  if (host) {
    pickDealerBtn.classList.remove('hidden');
    waitingMsg.textContent = 'Flip cards to pick a dealer when everyone has joined!';
  } else {
    waitingMsg.textContent = 'Waiting for the host to flip cards for a dealer...';
  }
}

function updateWaitingPlayers(playerList) {
  waitingPlayersList.innerHTML = '';
  playerList.forEach(p => {
    const div = document.createElement('div');
    div.classList.add('waiting-player');
    div.textContent = p.isHost ? `👑 ${p.name} (Host)` : `🃏 ${p.name}`;
    waitingPlayersList.appendChild(div);
  });
}

pickDealerBtn.addEventListener('click', () => socket.emit('pickDealer'));

// --- CARD FLIP ---

function showCardFlipStage(playerList) {
  document.getElementById('waiting-stage-1').classList.add('hidden');
  document.getElementById('waiting-stage-2').classList.remove('hidden');
  const container = document.getElementById('flip-cards-container');
  container.innerHTML = '';
  playerList.forEach((p) => {
    const wrapper = document.createElement('div');
    wrapper.classList.add('flip-card-wrapper');
    wrapper.id = `flip-wrapper-${p.name}`;
    const label = document.createElement('div');
    label.classList.add('player-label');
    label.textContent = p.name;
    const card = document.createElement('div');
    card.classList.add('flip-card');
    card.id = `flip-card-${p.name}`;
    card.innerHTML = `
      <div class="flip-card-inner">
        <div class="flip-card-front">🂠</div>
        <div class="flip-card-back" id="flip-card-back-${p.name}"></div>
      </div>
    `;
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
          const winnerWrapper = document.getElementById(`flip-wrapper-${winnerName}`);
          if (winnerWrapper) winnerWrapper.classList.add('winner-card');
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
    startBtn.classList.remove('hidden');
    waitingMsg2.textContent = 'Everyone ready? Start the game!';
  } else {
    waitingMsg2.textContent = 'Waiting for the host to start the game...';
  }
}

startBtn.addEventListener('click', () => socket.emit('startGame'));

// --- CARD SORTING ---

function sortHand(hand) {
  return [...hand].sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank));
}

// --- GAME RENDERING ---

function updateGameState(data) {
  myHand = sortHand(data.hand);
  players = data.players;
  currentPlayerIndex = data.currentPlayerIndex;
  direction = data.direction || 1;
  pendingEffect = data.pendingEffect;
  dealerIndex = data.dealerIndex;
  selectedCardIndices = [];
  lastCardDeclared = false;

  document.getElementById('hand-display').textContent = `Hand: ${data.currentHand} of 7`;
  document.getElementById('score-display').textContent = players.map(p => `${p.name}: ${p.score || 0}pts`).join(' | ');

  renderHand();
  renderDiscardPile(data.topCard, data.currentSuit);
  renderOtherPlayers(data.players, data.direction);
  updateTurnDisplay(data);
  if (data.message) logMessage(data.message);

  // Handle flipped card dealer penalty
  // Handle flipped card dealer effects
  if (data.flippedCardEffect === 'ace' || data.flippedCardEffect === 'four') {
    const isDealer = players[dealerIndex] && players[dealerIndex].name === myName;
    if (isDealer) {
      showDealerPenaltyPrompt(data.flippedCardEffect);
    } else {
      const dealerName = players[dealerIndex] ? players[dealerIndex].name : 'Dealer';
      logMessage(`⏳ Waiting for ${dealerName} to decide on the flipped card penalty...`);
    }
  } else if (data.flippedCardEffect === 'eight' || data.flippedCardEffect === 'three') {
    const isDealer = players[dealerIndex] && players[dealerIndex].name === myName;
    if (!isDealer) {
      const dealerName = players[dealerIndex] ? players[dealerIndex].name : 'Dealer';
      logMessage(`⏳ Waiting for ${dealerName} to call the suit...`);
    }
  } else if (data.flippedCardEffect === 'jack') {
    logMessage(`🃏 Jack flipped! Player left of dealer is skipped!`);
  }
}

function showDealerPenaltyPrompt(effect) {
  const prompt = document.getElementById('dealer-penalty-prompt');
  const msg = document.getElementById('dealer-penalty-msg');

  // Find matching cards in hand
  const targetRank = effect === 'ace' ? 'A' : '4';
  const matchingCards = myHand
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => card.rank === targetRank);

  const effectName = effect === 'ace' ? 'Ace' : '4';

  if (matchingCards.length > 0) {
    msg.textContent = `The flipped card is a ${effectName}! You have a ${effectName} in your hand. Play it to cancel the penalty, or accept it.`;

    // Build reject buttons for each matching card
    const rejectContainer = document.getElementById('dealer-reject-container');
    rejectContainer.innerHTML = '';
    matchingCards.forEach(({ card, index }) => {
      const btn = document.createElement('button');
      btn.classList.add('gold-btn');
      btn.style.fontSize = '13px';
      btn.style.padding = '8px 14px';
      const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
      btn.innerHTML = `❌ Play ${card.rank}${SUIT_SYMBOLS[card.suit]} to Reject`;
      btn.style.color = isRed ? '#cc2200' : '#1a1a1a';
      btn.addEventListener('click', () => {
        socket.emit('dealerPenaltyChoice', { accept: false, cardIndex: index });
        prompt.classList.add('hidden');
      });
      rejectContainer.appendChild(btn);
    });
  } else {
    msg.textContent = `The flipped card is a ${effectName}! You have no ${effectName} to cancel with — you must accept the penalty.`;
    document.getElementById('dealer-reject-container').innerHTML = '';
  }

  prompt.classList.remove('hidden');
}

function renderHand() {
  const handDiv = document.getElementById('player-hand');
  handDiv.innerHTML = '';
  myHand.forEach((card, index) => {
    const cardDiv = document.createElement('div');
    cardDiv.classList.add('card');
    if (card.suit === 'hearts' || card.suit === 'diamonds') cardDiv.classList.add('red');
    if (selectedCardIndices.includes(index)) cardDiv.classList.add('selected');
    cardDiv.innerHTML = `<span>${card.rank}</span><span>${SUIT_SYMBOLS[card.suit]}</span>`;
    cardDiv.addEventListener('click', () => onCardClick(index));
    handDiv.appendChild(cardDiv);
  });
}

function renderDiscardPile(topCard, currentSuit) {
  const discardDiv = document.getElementById('discard-pile');
  const isRed = topCard.suit === 'hearts' || topCard.suit === 'diamonds';
  discardDiv.innerHTML = `<span>${topCard.rank}</span><span>${SUIT_SYMBOLS[topCard.suit]}</span>`;
  discardDiv.style.color = isRed ? '#cc0000' : '#1a1a1a';
  const suitIndicator = document.getElementById('suit-indicator');
  if (currentSuit && currentSuit !== topCard.suit) {
    suitIndicator.textContent = `Active suit: ${SUIT_SYMBOLS[currentSuit]}`;
    suitIndicator.style.color = (currentSuit === 'hearts' || currentSuit === 'diamonds') ? '#cc0000' : 'white';
  } else {
    suitIndicator.textContent = '';
  }
}

function renderOtherPlayers(playerList, dir = 1) {
  const otherDiv = document.getElementById('other-players');
  otherDiv.innerHTML = '';
  const total = playerList.length;
  const radius = 120;
  const centerX = 160;
  const centerY = 160;
  const myIndex = playerList.findIndex(p => p.name === myName);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '320');
  svg.setAttribute('height', '320');
  svg.style.position = 'absolute';
  svg.style.top = '0';
  svg.style.left = '0';
  svg.style.pointerEvents = 'none';

  const tableCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  tableCircle.setAttribute('cx', centerX);
  tableCircle.setAttribute('cy', centerY);
  tableCircle.setAttribute('r', radius - 20);
  tableCircle.setAttribute('fill', 'rgba(255,255,255,0.05)');
  tableCircle.setAttribute('stroke', 'rgba(255,255,255,0.15)');
  tableCircle.setAttribute('stroke-width', '2');
  svg.appendChild(tableCircle);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('refX', '3');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M 0 0 L 6 3 L 0 6 Z');
  arrowPath.setAttribute('fill', 'rgba(240,192,64,0.6)');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const arrowRadius = radius - 30;
  const arrowArc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const startAngle = dir === 1 ? -60 : 240;
  const endAngle = dir === 1 ? 60 : 120;
  const startRad = startAngle * Math.PI / 180;
  const endRad = endAngle * Math.PI / 180;
  const startX = centerX + arrowRadius * Math.cos(startRad);
  const startY = centerY + arrowRadius * Math.sin(startRad);
  const endX = centerX + arrowRadius * Math.cos(endRad);
  const endY = centerY + arrowRadius * Math.sin(endRad);
  const sweep = dir === 1 ? 1 : 0;
  arrowArc.setAttribute('d', `M ${startX} ${startY} A ${arrowRadius} ${arrowRadius} 0 0 ${sweep} ${endX} ${endY}`);
  arrowArc.setAttribute('fill', 'none');
  arrowArc.setAttribute('stroke', 'rgba(240,192,64,0.4)');
  arrowArc.setAttribute('stroke-width', '2');
  arrowArc.setAttribute('marker-end', 'url(#arrowhead)');
  svg.appendChild(arrowArc);
  otherDiv.appendChild(svg);

  playerList.forEach((p, i) => {
    const offset = myIndex >= 0 ? i - myIndex : i;
    const angle = (offset / total) * 360 - 90;
    const rad = angle * (Math.PI / 180);
    const x = centerX + radius * Math.cos(rad);
    const y = centerY + radius * Math.sin(rad);
    const playerDiv = document.createElement('div');
    playerDiv.classList.add('circle-player');
    const isActive = i === currentPlayerIndex;
    const isMe = p.name === myName;
    const isDealer = i === dealerIndex;
    if (isActive) playerDiv.classList.add('circle-player-active');
    if (isMe) playerDiv.classList.add('circle-player-me');
    playerDiv.style.left = `${x}px`;
    playerDiv.style.top = `${y}px`;
    playerDiv.innerHTML = `
      <div class="circle-player-avatar">${p.name.charAt(0).toUpperCase()}${isDealer ? '<span class="dealer-indicator">D</span>' : ''}</div>
      <div class="circle-player-name">${isMe ? 'You' : p.name}</div>
      <div class="circle-player-cards" style="font-size:14px;font-weight:bold;">${p.cardCount} 🃏</div>
      <div class="circle-player-hands">🏆 ${p.handsWon || 0}</div>
    `;
    otherDiv.appendChild(playerDiv);
  });
}

function isMyTurn() {
  return players[currentPlayerIndex] && players[currentPlayerIndex].name === myName;
}

function onCardClick(index) {
  if (!isMyTurn()) { logMessage("It's not your turn!"); return; }
  if (selectedCardIndices.includes(index)) {
    selectedCardIndices = selectedCardIndices.filter(i => i !== index);
  } else {
    selectedCardIndices.push(index);
  }
  renderHand();
  const playBtn = document.getElementById('play-btn');
  if (selectedCardIndices.length > 0) {
    playBtn.classList.remove('hidden');
  } else {
    playBtn.classList.add('hidden');
  }
}

function logMessage(msg) {
  const log = document.getElementById('game-log');
  log.textContent = msg;
}

function updateTurnDisplay(data) {
  const turnBanner = document.getElementById('turn-banner');
  const drawBtn = document.getElementById('draw-btn');
  const playBtn = document.getElementById('play-btn');
  const lastCardBtn = document.getElementById('last-card-btn');

  if (isMyTurn()) {
    let bannerText = '🟡 YOUR TURN!';
    if (data && data.pendingPickup > 0) bannerText = `🟡 YOUR TURN — Stack a 2 or pick up ${data.pendingPickup}!`;
    if (data && data.pendingEffect === 'forceFive') bannerText = '🟡 YOUR TURN — Play a 5 or pick up!';
    if (data && data.pendingEffect === 'equalRank') bannerText = '🟡 YOUR TURN — Play 2+ cards of same rank or pick up!';
    turnBanner.textContent = bannerText;
    turnBanner.classList.add('my-turn');
    turnBanner.classList.remove('other-turn');
    drawBtn.classList.remove('hidden');

    // Show last card button if I have exactly 2 cards (about to drop to 1)
    if (myHand.length === 2) {
      lastCardBtn.classList.remove('hidden');
    } else {
      lastCardBtn.classList.add('hidden');
    }
  } else {
    const currentPlayer = players[currentPlayerIndex];
    turnBanner.textContent = currentPlayer ? `⏳ ${currentPlayer.name}'s turn...` : '';
    turnBanner.classList.add('other-turn');
    turnBanner.classList.remove('my-turn');
    drawBtn.classList.add('hidden');
    playBtn.classList.add('hidden');
    lastCardBtn.classList.add('hidden');
  }
}

// --- SUIT PICKER ---

function showSuitPicker() {
  document.getElementById('suit-picker').classList.remove('hidden');
}

document.querySelectorAll('.suit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const suit = btn.dataset.suit;
    socket.emit('suitChosen', { suit });
    document.getElementById('suit-picker').classList.add('hidden');
  });
});

// --- BUTTONS ---

document.getElementById('draw-btn').addEventListener('click', () => {
  if (!isMyTurn()) return;
  socket.emit('drawCard');
});

document.getElementById('play-btn').addEventListener('click', () => {
  if (!isMyTurn() || selectedCardIndices.length === 0) return;
  socket.emit('playCards', { cardIndices: selectedCardIndices });
  selectedCardIndices = [];
  lastCardDeclared = false;
});

document.getElementById('last-card-btn').addEventListener('click', () => {
  if (!isMyTurn()) return;
  lastCardDeclared = true;
  socket.emit('declareLastCard');
  document.getElementById('last-card-btn').classList.add('hidden');
  logMessage('You declared Last Card! Now play your card.');
});

document.getElementById('catch-btn').addEventListener('click', () => {
  const target = document.getElementById('catch-btn').dataset.target;
  if (target) {
    socket.emit('catchLastCard', { caughtPlayerName: target });
    document.getElementById('catch-btn').classList.add('hidden');
  }
});

document.getElementById('next-round-btn').addEventListener('click', () => {
  if (isHost) socket.emit('nextRound');
});

// Dealer penalty prompt buttons
document.getElementById('dealer-accept-btn').addEventListener('click', () => {
  socket.emit('dealerPenaltyChoice', { accept: true });
  document.getElementById('dealer-penalty-prompt').classList.add('hidden');
});

// --- SOCKET EVENTS ---

socket.on('joinedRoom', ({ room, players: playerList, isHost: host }) => {
  isHost = host;
  showWaitingRoom(playerList, host);
});

socket.on('playerJoined', ({ players: playerList }) => updateWaitingPlayers(playerList));

socket.on('playerLeft', ({ players: playerList, name }) => {
  updateWaitingPlayers(playerList);
  logMessage(`${name} left the room.`);
});

socket.on('roomFull', () => showLobbyError('That room is full! (Max 5 players)'));
socket.on('gameInProgress', () => showLobbyError('This room\'s game has already started! Try a different room code.'));
socket.on('nameTaken', () => showLobbyError('That name is already taken in this room!'));
socket.on('notEnoughPlayers', () => { waitingMsg2.textContent = 'You need at least 2 players to start!'; });

socket.on('cardFlipResult', ({ players: playerList, flippedCards, dealerIndex: di, winnerName }) => {
  dealerIndex = di;
  showCardFlipStage(playerList);
  setTimeout(() => {
    revealFlippedCards(flippedCards, winnerName);
    const totalDelay = (flippedCards.length * 400) + 2500;
    setTimeout(() => showDealerReveal(playerList, di), totalDelay);
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
  const nextRoundBtn = document.getElementById('next-round-btn');
  if (nextRoundBtn) nextRoundBtn.disabled = false;
  logMessage(`🃏 Starting Hand ${data.currentHand}!`);
  updateGameState(data);
});

socket.on('roundOver', ({ players: playerList, winner, message }) => {
  logMessage(message);
  const overlay = document.getElementById('round-over-overlay');
  const overlayMsg = document.getElementById('round-over-msg');
  const scoresList = document.getElementById('round-scores-list');
  const nextRoundBtn = document.getElementById('next-round-btn');
  overlayMsg.textContent = `🏆 ${winner} wins the round!`;
  scoresList.innerHTML = '';
  playerList.forEach(p => {
    const div = document.createElement('div');
    div.classList.add('score-row');
    div.textContent = `${p.name}: ${p.score} point${p.score !== 1 ? 's' : ''} (${p.handsWon} hands won)`;
    scoresList.appendChild(div);
  });
  if (isHost) {
    nextRoundBtn.textContent = 'Start Next Round';
    nextRoundBtn.disabled = false;
    nextRoundBtn.classList.remove('hidden');
  } else {
    nextRoundBtn.textContent = 'Waiting for host to start next round...';
    nextRoundBtn.disabled = true;
    nextRoundBtn.classList.remove('hidden');
  }
  overlay.classList.remove('hidden');
});

socket.on('invalidPlay', (msg) => logMessage(`❌ ${msg}`));
socket.on('chooseSuit', () => showSuitPicker());

socket.on('catchable', ({ playerName }) => {
  if (playerName === myName) return;
  const catchBtn = document.getElementById('catch-btn');
  catchBtn.dataset.target = playerName;
  catchBtn.classList.remove('hidden');
  setTimeout(() => catchBtn.classList.add('hidden'), 3000);
});

socket.on('caughtLastCard', ({ caughtPlayerName, msg }) => {
  document.getElementById('catch-btn').classList.add('hidden');
  logMessage(msg);
});

socket.on('lastCardDeclared', ({ playerName }) => {
  logMessage(`🔔 ${playerName} said Last Card!`);
});

socket.on('lastCardPenalty', ({ playerName }) => {
  logMessage(`⚠️ ${playerName} forgot to say Last Card and picks up one card!`);
});