// server.js (Deno Deploy 稳定版)
const rooms = new Map();

const CARD_POOL = [
  "百合","厕纸","超能力","超自然","穿越","催泪","答辩","党争","电波","动作",
  "恶魔","犯罪","芳文社","废萌","搞笑","公路片","和风","黑帮","黑化","后宫",
  "画面崩坏","京阿尼","竞技","剧场版","科幻","科普","恐怖","烂尾","历史","励志",
  "恋爱","猎奇","龙傲天","轮回","萝卜","萝莉","卖肉","漫画改","美食","妹系",
  "魔法","魔法少女","末世","拟人","偶像","泡面番","轻百合","群像","热血","日常",
  "推理","吸血鬼","小说改","校园","心理","性转","悬疑","血腥","颜艺","妖怪","乙女"
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function broadcast(room, msg) {
  for (const p of room.players.values()) {
    try { p.ws.send(JSON.stringify(msg)); } catch (_) {}
  }
}

function getPlayerIndex(room, userId) { return [...room.players.keys()].indexOf(userId); }
function getPlayer(room, idx) { return [...room.players.values()][idx]; }
function getPlayerName(room, userId) { const p = room.players.get(userId); return p ? p.name : '?'; }

function broadcastRoom(room) {
  const arr = [...room.players.values()];
  broadcast(room, {
    type: 'roomData',
    room: {
      roomName: room.name,
      players: arr.map(p => ({
        id: [...room.players.keys()].find(k => room.players.get(k) === p),
        name: p.name, ready: p.ready, isHost: p.isHost, handCards: p.handCards
      })),
      gameStarted: !!room.gameData,
      gameData: room.gameData ? { ...room.gameData } : null
    }
  });
}

function leaveRoom(ws, userId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.players.delete(userId);
  if (room.players.size === 0) {
    if (room.timer) clearInterval(room.timer);
    rooms.delete(roomId);
  } else {
    [...room.players.values()][0].isHost = true;
    broadcastRoom(room);
  }
}

function advanceFollow(room) {
  const gd = room.gameData;
  const total = room.players.size;
  do { gd.followIdx = (gd.followIdx + 1) % total; } while (gd.followIdx === gd.roundInitiator && total > 1);
  if (gd.followIdx === gd.roundInitiator) {
    const initiator = getPlayer(room, gd.roundInitiator);
    if (initiator.handCards.length === 0) {
      gd.stage = 'yijin'; gd.yijinCard = null;
      broadcast(room, { type: 'log', text: '跟牌结束，出牌者手牌为0，进入一斤压力阶段' });
    } else {
      gd.currentPlayerIdx = (gd.roundInitiator + 1) % total;
      gd.stage = 'draw'; gd.playedCards = []; gd.roundInitiator = gd.currentPlayerIdx;
    }
  }
  broadcastRoom(room); resetCountdown(room);
}

function startVote(room, ctx) {
  room.gameData.stage = 'vote'; room.gameData.voteContext = ctx;
  room.gameData.voteAgree = 0; room.gameData.voteDeny = 0; room.gameData.votedPlayers = [];
  broadcastRoom(room); resetCountdown(room);
}

function resolveVote(room) {
  const gd = room.gameData;
  broadcast(room, { type: 'log', text: `投票结果：✅${gd.voteAgree} ❌${gd.voteDeny}` });
  if (gd.voteAgree > gd.voteDeny) {
    if (gd.voteContext === '跟牌') advanceFollow(room);
    else if (gd.voteContext === '一斤压力') {
      broadcast(room, { type: 'win', winner: getPlayer(room, gd.roundInitiator).name });
      resetRoom(room); broadcastRoom(room);
    }
  } else {
    if (gd.voteContext === '跟牌') { gd.stage='play'; gd.selectedHand=[]; gd.selectedPublic=null; gd.followCard=null; broadcastRoom(room); }
    else if (gd.voteContext === '一斤压力') { gd.currentPlayerIdx=(gd.currentPlayerIdx+1)%room.players.size; gd.stage='draw'; gd.playedCards=[]; gd.yijinCard=null; broadcastRoom(room); }
    resetCountdown(room);
  }
}

function resetRoom(room) { if (room.timer) clearInterval(room.timer); room.gameData=null; for (const p of room.players.values()) { p.handCards=[]; p.ready=false; } }
function resetCountdown(room) { if (room.timer) clearInterval(room.timer); startCountdown(room); }

function startCountdown(room) {
  if (room.timer) clearInterval(room.timer);
  room.countdown = 60;
  broadcast(room, { type: 'timer', seconds: 60 });
  room.timer = setInterval(() => {
    if (!room.gameData) { clearInterval(room.timer); return; }
    room.countdown--;
    broadcast(room, { type: 'timer', seconds: room.countdown });
    if (room.countdown <= 0) { clearInterval(room.timer); handleTimeout(room); }
  }, 1000);
}

function handleTimeout(room) {
  const gd = room.gameData;
  if (!gd) return;
  if (gd.stage === 'draw') { if (gd.deck.length) getPlayer(room,gd.currentPlayerIdx).handCards.push(gd.deck.pop()); gd.stage='play'; gd.selectedHand=[]; gd.selectedPublic=null; }
  else if (gd.stage === 'play') { gd.currentPlayerIdx=(gd.currentPlayerIdx+1)%room.players.size; gd.stage='draw'; gd.playedCards=[]; }
  else if (gd.stage === 'follow') { gd.followCard=null; advanceFollow(room); }
  else if (gd.stage === 'vote') resolveVote(room);
  broadcastRoom(room);
  if (room.gameData) resetCountdown(room);
}

function handleMessage(ws, msg) {
  const userId = msg.userId;
  const roomId = msg.roomId;
  switch (msg.type) {
    case 'getRooms': {
      const list = [];
      rooms.forEach((r, id) => { if (r.players.size) list.push({ id, name: r.name, playerCount: r.players.size, gameStarted: !!r.gameData }); });
      ws.send(JSON.stringify({ type: 'roomList', rooms: list }));
      break;
    }
    case 'joinRoom': {
      let room = rooms.get(roomId);
      if (!room) { room = { id: roomId, name: msg.roomName || '默认房间', players: new Map(), gameData: null, timer: null, countdown: 60 }; rooms.set(roomId, room); }
      if (room.gameData) { ws.send(JSON.stringify({ type: 'error', text: '游戏已开始' })); return; }
      leaveRoom(ws, userId, ws._roomId);
      ws._roomId = roomId; ws._userId = userId;
      const isHost = room.players.size === 0;
      room.players.set(userId, { ws, name: msg.nickname, ready: false, handCards: [], isHost });
      broadcastRoom(room);
      break;
    }
    case 'leaveRoom': leaveRoom(ws, userId, ws._roomId); break;
    case 'ready': {
      const room = rooms.get(ws._roomId); if (!room) return;
      const p = room.players.get(userId); if (p) { p.ready = true; broadcastRoom(room); }
      break;
    }
    case 'startGame': {
      const room = rooms.get(ws._roomId); if (!room) return;
      const player = room.players.get(userId);
      if (!player?.isHost || ![...room.players.values()].every(p => p.ready)) return;
      const deck = shuffle([...CARD_POOL]);
      const publicCards = []; for (let i=0; i<5; i++) publicCards.push(deck.pop());
      for (const p of room.players.values()) { p.handCards = []; for (let i=0; i<5; i++) p.handCards.push(deck.pop()); p.ready = false; }
      room.gameData = { publicCards, deck, discardPile:[], playedCards:[], followCard:null, yijinCard:null, currentPlayerIdx:0, roundInitiator:0, followIdx:0, stage:'draw', selectedHand:[], selectedPublic:null, voteAgree:0, voteDeny:0, votedPlayers:[], voteContext:'' };
      broadcast(room, { type: 'gameStart' }); broadcastRoom(room); startCountdown(room);
      break;
    }
    case 'selectHand': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='play') return;
      const gd = room.gameData; if (gd.currentPlayerIdx !== getPlayerIndex(room, userId)) return;
      const arr = gd.selectedHand; const i = arr.indexOf(msg.card);
      if (i > -1) arr.splice(i,1); else if (arr.length < 3) arr.push(msg.card);
      broadcastRoom(room); break;
    }
    case 'selectPublic': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='play') return;
      const gd = room.gameData; if (gd.currentPlayerIdx !== getPlayerIndex(room, userId)) return;
      gd.selectedPublic = (gd.selectedPublic === msg.card) ? null : msg.card;
      broadcastRoom(room); break;
    }
    case 'drawCard': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='draw') return;
      const gd = room.gameData; if (gd.currentPlayerIdx !== getPlayerIndex(room, userId)) return;
      if (!gd.deck.length && gd.discardPile.length) { gd.deck = shuffle([...gd.discardPile]); gd.discardPile = []; }
      if (!gd.deck.length) return;
      getPlayer(room, gd.currentPlayerIdx).handCards.push(gd.deck.pop());
      gd.stage = 'play'; gd.roundInitiator = gd.currentPlayerIdx; gd.selectedHand = []; gd.selectedPublic = null;
      broadcastRoom(room); resetCountdown(room); break;
    }
    case 'playCard': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='play') return;
      const gd = room.gameData; const idx = getPlayerIndex(room, userId);
      if (gd.currentPlayerIdx !== idx) return;
      const sel = gd.selectedHand;
      if (sel.length<1||sel.length>3||!gd.selectedPublic) return;
      const player = getPlayer(room, idx);
      player.handCards = player.handCards.filter(c => !sel.includes(c));
      gd.publicCards = gd.publicCards.filter(c => c !== gd.selectedPublic);
      gd.playedCards = [...sel, gd.selectedPublic];
      gd.discardPile.push(...sel, gd.selectedPublic);
      while (gd.publicCards.length < 5 && gd.deck.length) gd.publicCards.push(gd.deck.pop());
      gd.selectedHand = []; gd.selectedPublic = null;
      gd.stage = 'follow'; gd.followIdx = (idx+1)%room.players.size; gd.followCard = null;
      broadcastRoom(room); resetCountdown(room); break;
    }
    case 'selectFollowCard': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='follow') return;
      const gd = room.gameData; if (gd.followIdx !== getPlayerIndex(room, userId)) return;
      const player = getPlayer(room, gd.followIdx);
      if (player.handCards.length <= 1 || !player.handCards.includes(msg.card)) return;
      gd.followCard = msg.card; gd.selectedHand = [msg.card];
      broadcastRoom(room); break;
    }
    case 'followCard': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='follow') return;
      const gd = room.gameData; if (gd.followIdx !== getPlayerIndex(room, userId)) return;
      const player = getPlayer(room, gd.followIdx);
      if (!gd.followCard || player.handCards.length <= 1) return;
      player.handCards = player.handCards.filter(c => c !== gd.followCard);
      gd.discardPile.push(gd.followCard);
      startVote(room, '跟牌'); break;
    }
    case 'skipFollow': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='follow') return;
      const gd = room.gameData; if (gd.followIdx !== getPlayerIndex(room, userId)) return;
      broadcast(room, { type: 'log', text: `${getPlayerName(room, userId)} 跳过跟牌` });
      gd.followCard = null; advanceFollow(room); break;
    }
    case 'vote': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='vote') return;
      const gd = room.gameData; if (gd.votedPlayers.includes(userId)) return;
      gd.votedPlayers.push(userId); msg.agree ? gd.voteAgree++ : gd.voteDeny++;
      broadcastRoom(room);
      if (gd.votedPlayers.length >= room.players.size) resolveVote(room);
      break;
    }
    case 'selectYijin': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='yijin') return;
      room.gameData.yijinCard = msg.card; broadcastRoom(room); break;
    }
    case 'confirmYijin': {
      const room = rooms.get(ws._roomId); if (!room?.gameData || room.gameData.stage!=='yijin') return;
      if (!room.gameData.yijinCard) return;
      startVote(room, '一斤压力'); break;
    }
    case 'resetGame': {
      const room = rooms.get(ws._roomId); if (!room) return;
      if (room.players.get(userId)?.isHost) { resetRoom(room); broadcastRoom(room); }
      break;
    }
  }
}

Deno.serve((req) => {
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.onopen = () => { socket._roomId = null; socket._userId = null; };
  socket.onmessage = (e) => { try { handleMessage(socket, JSON.parse(e.data)); } catch (_) {} };
  socket.onclose = () => { leaveRoom(socket, socket._userId, socket._roomId); };
  return response;
});
