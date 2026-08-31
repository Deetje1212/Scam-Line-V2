const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const CHALLENGE_INTERVAL_MIN = 28000;
const CHALLENGE_INTERVAL_MAX = 48000;
const EAVESDROP_DURATION = 10000;
const GAME_DURATION = 180000;
const VOTE_DURATION = 30000;

function send(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(room, o, except) { for (const p of room.players) if (p.ws !== except) send(p.ws, o); }
function publicPlayers(room) { return room.players.map(p => ({ id: p.id, name: p.name, connected: p.ws.readyState === 1 })); }
function roomState(room) { return { type: 'roomState', players: publicPlayers(room), started: room.started, host: room.host }; }
function playerById(r, id) { return r.players.find(x => x.id === id); }
function roleFor(r, p) { return r.roles.find(x => x.id === p.id)?.role || 'operator'; }
function saboteur(r) { return r.players.find(p => roleFor(r, p) === 'saboteur'); }
function randomBetween(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

function sendClue(r, p, reason) {
  if (!p || !p.secretCode) return null;
  const hidden = p.secretCode.split('');
  const available = hidden.map((d, i) => ({ d, i })).filter(x => !p.revealedDigits.has(x.i) && !p.blockedDigits.has(x.i));
  if (!available.length) return null;
  const pick = available[Math.floor(Math.random() * available.length)];
  p.revealedDigits.add(pick.i);
  send(p.ws, { type: 'clue', digit: pick.d, index: pick.i, reason });
  send(p.ws, { type: 'codeState', revealed: [...p.revealedDigits].sort((a, b) => a - b).map(i => ({ index: i, digit: p.secretCode[i] })), blocked: [...p.blockedDigits].sort((a, b) => a - b) });
  return pick;
}

function challengePayload(c) {
  if (!c) return null;
  const d = { ...c.data };
  delete d.solution; delete d.answer; delete d.answers;
  return { id: c.id, type: c.type, player: c.player, endsAt: c.endsAt, data: d };
}

// ---- Creative, non-arithmetic challenge content ----

const CIPHER_WORDS = ['GEHEIM', 'SLEUTEL', 'SCHADUW', 'VERRADER', 'ALIBI', 'BEWIJS', 'MASKER', 'SIGNAAL', 'KLUIS', 'DOSSIER', 'SABOTAGE', 'TELEFOON', 'ONDERZOEK', 'SPOOR'];
function caesarEncode(word, shift) {
  return word.split('').map(ch => {
    const code = ch.charCodeAt(0) - 65;
    if (code < 0 || code > 25) return ch;
    return String.fromCharCode(((code + shift) % 26) + 65);
  }).join('');
}
function makeCipherData() {
  const word = CIPHER_WORDS[randomBetween(0, CIPHER_WORDS.length - 1)];
  const shift = randomBetween(1, 9);
  const cipher = caesarEncode(word, shift);
  return {
    solution: word,
    prompt: `Ontcijfer de code (elke letter is ${shift} plekken opgeschoven in het alfabet): "${cipher}"`,
    task: 'Typ het ontcijferde woord voordat de tijd verloopt.'
  };
}

function makeMemoryData() {
  const len = randomBetween(4, 6);
  const pattern = Array.from({ length: len }, () => randomBetween(0, 3));
  return {
    pattern,
    prompt: 'Onthoud het lichtpatroon dat door de hoorn knippert.',
    task: 'Klik de kleuren in exact dezelfde volgorde na.'
  };
}

const TRUE_FACTS = [
  'Iedereen in de kamer heeft informatie die de anderen nodig hebben.',
  'De saboteur zit letterlijk tussen de operators in en probeert onopgemerkt te blijven.',
  'Een telefoongesprek kan gebruikt worden om een bewering te controleren.',
  'Er is precies één afluisterkans per potje beschikbaar.',
  'Elke speler begint met slechts één cijfer van zijn eigen code.',
  'Om je objective te claimen heb je alle vier codecijfers nodig.'
];
const FALSE_FACTS = [
  'De afluisterkans kan onbeperkt vaak per potje gebruikt worden.',
  'De saboteur wordt met een rode badge op het scherm van iedereen getoond.',
  'Alle spelers krijgen precies dezelfde geheime code.',
  'De telefoonverbinding werkt ook zonder microfoontoestemming.',
  'Een geblokkeerd codecijfer wordt automatisch na tien seconden weer vrijgegeven.',
  'Je kunt zien wie er momenteel met wie belt, ook als je zelf niet meebelt.'
];
function makeTwoTruthsOneLie() {
  const trues = shuffle(TRUE_FACTS).slice(0, 2);
  const lie = FALSE_FACTS[randomBetween(0, FALSE_FACTS.length - 1)];
  const order = shuffle([{ t: trues[0], lie: false }, { t: trues[1], lie: false }, { t: lie, lie: true }]);
  const lieIndex = order.findIndex(x => x.lie);
  return { statements: order.map(x => x.t), lieIndex };
}

function makeChallenge(r, p) {
  const others = r.players.filter(x => x.id !== p.id);
  const other = others[Math.floor(Math.random() * Math.max(1, others.length))];
  const isSaboteur = roleFor(r, p) === 'saboteur';
  const pool = isSaboteur ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 5];
  const type = pool[randomBetween(0, pool.length - 1)];
  const c = { id: crypto.randomUUID(), type, player: p.id, endsAt: Date.now() + 60000, completed: false };

  if (type === 0) {
    const statements = [
      'De verdachte draagt een rode jas. Je krijgt één deel van een getuigenis. Bel iemand en vraag door: ontdek of het verhaal klopt.',
      'Een getuige beweert dat de onderhoudsdeur code 7 gebruikt. Bel een speler en controleer de bewering zonder meteen te vertellen wat jij weet.',
      'Er wordt beweerd dat de saboteur als eerste heeft gebeld. Zoek via een gesprek uit of die bewering betrouwbaar is.'
    ];
    c.data = { target: other?.id || null, prompt: statements[randomBetween(0, statements.length - 1)], task: 'Voer een echt telefoongesprek en stel minstens één gerichte vraag. Daarna bevestig je de challenge.' };
  }
  if (type === 1) {
    c.data = makeCipherData();
  }
  if (type === 2) {
    c.data = { prompt: 'Bel de GEHEIME FREQUENTIE voor één extra cijfer. De saboteur krijgt direct een stille waarschuwing dat iemand informatie verzamelt.', task: 'Klik op de knop om de frequentie te gebruiken.' };
  }
  if (type === 3) {
    c.data = { target: other?.id || null, phrase: 'DE LIJN IS VEILIG', prompt: `Jij en ${other?.name || 'een andere speler'} moeten dezelfde geheime zin binnen 3 seconden bevestigen.`, task: 'Bel elkaar eerst en spreek af wanneer. Druk daarna zo dicht mogelijk tegelijk op de knop.' };
  }
  if (type === 4) {
    c.data = { target: other?.id || null, prompt: `Saboteur-opdracht: zorg dat ${other?.name || 'een gekozen speler'} tijdens een telefoongesprek binnen 2 minuten ophangt.`, task: 'Deze opdracht wordt automatisch beoordeeld door de server.' };
  }
  if (type === 5) {
    c.data = makeMemoryData();
  }
  r.challenge = c;
  return c;
}

function scheduleNextChallenge(r, initial = false) {
  if (r.challengeTimer) clearTimeout(r.challengeTimer);
  const delay = initial ? randomBetween(12000, 22000) : randomBetween(CHALLENGE_INTERVAL_MIN, CHALLENGE_INTERVAL_MAX);
  r.challengeTimer = setTimeout(() => spawnRandomChallenge(r), delay);
}

function spawnRandomChallenge(r) {
  if (!r.started || r.players.length < 2) return;
  if (r.challenge && !r.challenge.completed && r.challenge.endsAt > Date.now()) { scheduleNextChallenge(r); return; }
  const candidates = r.players.filter(p => p.ws.readyState === 1);
  if (!candidates.length) return;
  const p = candidates[Math.floor(Math.random() * candidates.length)];
  const c = makeChallenge(r, p);
  send(p.ws, { type: 'challenge', challenge: challengePayload(c), popup: true });
  if (c.type === 3 && c.data.target) {
    const target = playerById(r, c.data.target);
    if (target) send(target.ws, { type: 'coChallenge', phrase: c.data.phrase, from: p.name });
  }
  scheduleNextChallenge(r);
}

function startGame(r) {
  r.started = true; r.voting = false; r.votes = {}; r.roles = []; r.challenge = null;
  r.eavesdropUsed = false; r.eavesdropper = null; r.eavesdropPending = null; r.eavesdropUntil = 0;
  const secret = r.players[Math.floor(Math.random() * r.players.length)];
  r.players.forEach((pl, i) => {
    const role = pl === secret ? 'saboteur' : 'operator';
    r.roles.push({ id: pl.id, role });
    pl.secretCode = String(randomBetween(1000, 9999));
    pl.revealedDigits = new Set(); pl.blockedDigits = new Set(); pl.claimed = false;
    const goal = role === 'saboteur' ? 'Verzamel genoeg codecijfers, manipuleer de anderen en voltooi je geheime sabotage-opdracht.' : 'Verzamel je vier codecijfers, controleer informatie via telefoongesprekken en bepaal wie je vertrouwt.';
    send(pl.ws, { type: 'gameStart', goal, role, codeMasked: '----', timerEndsAt: Date.now() + GAME_DURATION });
    // Everyone starts with one small code fragment; the remaining digits must be earned.
    const startingIndex = i % 4;
    pl.revealedDigits.add(startingIndex);
    send(pl.ws, { type: 'codeState', revealed: [{ index: startingIndex, digit: pl.secretCode[startingIndex] }], blocked: [] });
  });
  // Give each player only a small, useful starting clue.
  r.players.forEach((pl, i) => send(pl.ws, {
    type: 'privateInfo', text: [
      'De onderhoudsdeur gebruikt één van de cijfers 4, 7 of 9.',
      'De rode indicator kan een misleiding zijn.',
      'Een telefoongesprek kan belangrijke informatie bevestigen, maar niet alles wat je hoort is waar.',
      'De saboteur weet dat haast en verwarring in zijn voordeel zijn.',
      'Een deel van de case file ontbreekt bewust; challenges kunnen stukjes teruggeven.'
    ][i % 5]
  }));
  sendClue(r, secret, 'Startinformatie voor de saboteur');
  broadcast(r, { type: 'gameNotice', text: 'Het spel is gestart. Challenges verschijnen automatisch op willekeurige momenten bij willekeurige spelers.' });
  broadcast(r, roomState(r));
  scheduleNextChallenge(r, true);
  if (r.gameTimer) clearTimeout(r.gameTimer);
  r.gameTimer = setTimeout(() => startVote(r), GAME_DURATION);
}

function notifySaboteur(r, text) { const s = saboteur(r); if (s) send(s.ws, { type: 'saboteurAlert', text }); }

function endEavesdrop(r) {
  if (!r.eavesdropper) return;
  const id = r.eavesdropper; r.eavesdropper = null; r.eavesdropUntil = 0;
  for (const p of r.players) send(p.ws, { type: 'eavesdropEnded' });
  send(playerById(r, id)?.ws, { type: 'toast', text: 'Afluisteren is voorbij.' });
}

function startEavesdrop(r, p) {
  if (r.eavesdropUsed || !r.call) return false;
  r.eavesdropUsed = true; r.eavesdropper = p.id; r.eavesdropUntil = Date.now() + EAVESDROP_DURATION; r.eavesdropPending = null;
  const call = { ...r.call };
  send(p.ws, { type: 'eavesdropGranted', until: r.eavesdropUntil });
  for (const id of [call.a, call.b]) { const target = playerById(r, id); if (target) send(target.ws, { type: 'eavesdropJoin', eavesdropper: p.id, until: r.eavesdropUntil }); }
  r.eavesdropTimer = setTimeout(() => endEavesdrop(r), EAVESDROP_DURATION);
  return true;
}

// ---- Endgame: accuse the saboteur ----

function startVote(r) {
  if (!r.started || r.voting) return;
  r.voting = true; r.votes = {};
  if (r.challengeTimer) clearTimeout(r.challengeTimer);
  if (r.eavesdropTimer) clearTimeout(r.eavesdropTimer);
  broadcast(r, { type: 'voteStart', players: publicPlayers(r) });
  r.voteTimer = setTimeout(() => revealVote(r), VOTE_DURATION);
}

function revealVote(r) {
  if (!r.voting) return;
  r.voting = false;
  if (r.voteTimer) clearTimeout(r.voteTimer);
  const tally = {};
  for (const to of Object.values(r.votes)) tally[to] = (tally[to] || 0) + 1;
  let accused = null, best = -1;
  for (const [id, n] of Object.entries(tally)) if (n > best) { best = n; accused = id; }
  const s = saboteur(r);
  broadcast(r, {
    type: 'voteResult',
    tally,
    accused,
    accusedName: accused ? playerById(r, accused)?.name : null,
    correct: !!(s && accused === s.id),
    saboteur: s?.id || null,
    saboteurName: s?.name || null
  });
  r.started = false;
  setTimeout(() => {
    if (r.players.length) { broadcast(r, { type: 'returnToLobby' }); broadcast(r, roomState(r)); }
  }, 8000);
}

wss.on('connection', ws => {
  const p = { ws, id: crypto.randomUUID(), name: 'Player', room: null, revealedDigits: new Set(), blockedDigits: new Set() };
  send(ws, { type: 'hello', id: p.id });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      const code = String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!code) return send(ws, { type: 'error', text: 'Ongeldige roomcode.' });
      let r = rooms.get(code);
      if (!r) { r = { code, players: [], host: p.id, started: false, voting: false, votes: {}, roles: [], call: null, eavesdropUsed: false, eavesdropper: null, eavesdropPending: null, challenge: null, challengeTimer: null, eavesdropTimer: null, gameTimer: null, voteTimer: null }; rooms.set(code, r); }
      if (r.players.length >= 5) return send(ws, { type: 'error', text: 'Room is vol (maximaal 5 spelers).' });
      if (r.started) return send(ws, { type: 'error', text: 'Dit spel is al gestart.' });
      p.room = code; p.name = String(m.name || 'Player').slice(0, 20) || 'Player'; r.players.push(p);
      send(ws, { type: 'joined', room: code, id: p.id, host: r.host }); broadcast(r, roomState(r)); return;
    }
    const r = rooms.get(p.room); if (!r) return;
    if (m.type === 'start') {
      if (p.id !== r.host) return;
      if (r.players.length < 2) return send(ws, { type: 'error', text: 'Minimaal 2 spelers nodig.' });
      startGame(r); return;
    }
    if (m.type === 'signal') {
      const to = playerById(r, m.to); if (to) send(to.ws, { type: 'signal', from: p.id, fromName: p.name, signal: m.signal, channel: m.channel || 'call' }); return;
    }
    if (m.type === 'callInvite') {
      const to = playerById(r, m.to); if (!to) return;
      if (r.call) return send(ws, { type: 'error', text: 'De telefoonlijn is bezet.' });
      r.call = { a: p.id, b: to.id }; send(to.ws, { type: 'callInvite', from: p.id, fromName: p.name }); send(ws, { type: 'callWaiting', to: to.name }); return;
    }
    if (m.type === 'callAccept') {
      const to = playerById(r, m.to); if (to) send(to.ws, { type: 'callAccepted', from: p.id }); return;
    }
    if (m.type === 'callEnd') {
      const to = playerById(r, m.to); if (to) send(to.ws, { type: 'callEnded', from: p.id });
      const active = r.call && (r.call.a === p.id || r.call.b === p.id);
      if (active) {
        r.call = null;
        if (r.eavesdropPending) { const pending = r.eavesdropPending; r.eavesdropPending = null; const ep = playerById(r, pending.player); if (ep) send(ep.ws, { type: 'challengeFailed', text: 'Het telefoongesprek eindigde; de afluisterkans is vervallen.' }); }
      }
      if (r.challenge && r.challenge.type === 4 && !r.challenge.completed && r.challenge.player === saboteur(r)?.id) {
        const target = r.challenge.data.target;
        if (target === p.id) {
          r.challenge.completed = true;
          send(saboteur(r).ws, { type: 'challengeComplete', reward: 'Sabotage geslaagd: een codecijfer van je doelwit is tijdelijk geblokkeerd.' });
          const victim = playerById(r, target);
          if (victim && victim.revealedDigits.size) victim.blockedDigits.add([...victim.revealedDigits][0]);
          send(victim?.ws, { type: 'digitBlocked' });
          scheduleNextChallenge(r);
        }
      }
      return;
    }
    if (m.type === 'complete') {
      const revealed = p.revealedDigits.size;
      if (revealed < 4) return send(ws, { type: 'claimFailed', text: `Je kunt je objective nog niet claimen. Je hebt ${revealed}/4 codecijfers.` });
      if (p.claimed) return send(ws, { type: 'claimFailed', text: 'Je hebt je objective al geclaimd.' });
      p.claimed = true; send(ws, { type: 'objectiveClaimed', text: 'OBJECTIVE GECLAIMD. Je hebt alle vier codecijfers verzameld.' });
      const claimed = r.players.filter(x => x.claimed).length;
      if (claimed === 1) broadcast(r, { type: 'gameNotice', text: 'Iemand heeft zijn objective geclaimd.' });
      return;
    }
    if (m.type === 'coChallengeAnswer') {
      const c = r.challenge; if (!c || c.type !== 3 || c.completed) return;
      if (c.player !== p.id && c.data.target !== p.id) return;
      c.syncClicks = c.syncClicks || {}; c.syncClicks[p.id] = Date.now();
      const otherId = c.data.target === p.id ? c.player : c.data.target; const other = playerById(r, otherId); if (other) send(other.ws, { type: 'coChallengeReady' });
      if (c.syncClicks[c.player] && c.syncClicks[c.data.target] && Math.abs(c.syncClicks[c.player] - c.syncClicks[c.data.target]) <= 3000) {
        c.completed = true; const a = playerById(r, c.player), b = playerById(r, c.data.target);
        [a, b].forEach(q => { if (q) { send(q.ws, { type: 'challengeComplete', reward: 'De geheime zin werd binnen 3 seconden bevestigd.' }); sendClue(r, q, 'Beloning: Wederzijdse Bekentenis'); } });
        scheduleNextChallenge(r);
      } return;
    }
    if (m.type === 'challengeAnswer') {
      const c = r.challenge; if (!c || c.player !== p.id || c.completed) return;
      if (Date.now() > c.endsAt) return send(ws, { type: 'challengeFailed', text: 'Te laat — deze challenge is verlopen.' });
      let ok = false, reason = 'Challenge voltooid.';
      if (c.type === 1) { ok = String(m.answer || '').trim().toUpperCase() === c.data.solution; reason = 'Code-Kraak opgelost: de code is ontcijferd en een nieuw codecijfer is vrijgegeven.'; }
      if (c.type === 0) { const activeCall = r.call && (r.call.a === p.id || r.call.b === p.id); const target = c.data.target; const talkingTo = activeCall && ((r.call.a === p.id && r.call.b === target) || (r.call.b === p.id && r.call.a === target)); ok = Boolean(talkingTo && m.calledTarget); reason = 'Getuigenis-Verificatie afgerond: je hebt een klein stukje case-informatie verdiend.'; }
      if (c.type === 5) { ok = Array.isArray(m.answer) ? m.answer.join('') === c.data.pattern.join('') : String(m.answer || '') === c.data.pattern.join(''); reason = 'Geheugentest geslaagd: je onthield het patroon perfect en verdient een codecijfer.'; }
      if (c.type === 4) return send(ws, { type: 'error', text: 'Deze sabotage-opdracht wordt automatisch beoordeeld tijdens een telefoongesprek.' });
      if (ok) { c.completed = true; send(ws, { type: 'challengeComplete', reward: reason }); sendClue(r, p, reason); scheduleNextChallenge(r); }
      else send(ws, { type: 'challengeFailed', text: 'Dat antwoord klopt niet. Je krijgt geen codecijfer.' }); return;
    }
    if (m.type === 'secretFrequency') {
      const c = r.challenge; if (!c || c.player !== p.id || c.type !== 2 || c.completed) return send(ws, { type: 'error', text: 'De geheime frequentie is niet beschikbaar.' });
      send(ws, { type: 'frequencyDigit', digit: '?' }); notifySaboteur(r, `${p.name} verzamelt stiekem informatie via de geheime frequentie.`); sendClue(r, p, 'Geheime frequentie'); c.completed = true; send(ws, { type: 'challengeComplete', reward: 'De geheime frequentie gaf je een codecijfer. De saboteur is gewaarschuwd.' }); scheduleNextChallenge(r); return;
    }
    if (m.type === 'requestEavesdrop') return send(ws, { type: 'error', text: 'De afluisterkans verschijnt automatisch op een willekeurig moment. Je kunt hem niet zelf aanvragen.' });
    if (m.type === 'eavesdropAnswer') {
      const ep = r.eavesdropPending; if (!ep || ep.player !== p.id) return;
      if (Date.now() > ep.endsAt) { r.eavesdropPending = null; return send(ws, { type: 'challengeFailed', text: 'De afluister-challenge is verlopen.' }); }
      if (String(m.answer) !== String(ep.lieIndex)) { r.eavesdropPending = null; return send(ws, { type: 'challengeFailed', text: 'Fout antwoord — dat was niet de leugen. De eenmalige afluisterkans is verloren.' }); }
      startEavesdrop(r, p); return;
    }
    if (m.type === 'castVote') {
      if (!r.voting) return;
      const to = playerById(r, m.to); if (!to) return;
      r.votes[p.id] = m.to;
      broadcast(r, { type: 'voteTally', tally: (() => { const t = {}; for (const v of Object.values(r.votes)) t[v] = (t[v] || 0) + 1; return t; })() });
      const connected = r.players.filter(x => x.ws.readyState === 1).length;
      if (Object.keys(r.votes).length >= connected) revealVote(r);
      return;
    }
  });
  ws.on('close', () => {
    if (!p.room) return;
    const r = rooms.get(p.room); if (!r) return;
    r.players = r.players.filter(x => x !== p);
    if (r.host === p.id) r.host = r.players[0]?.id;
    if (r.call && (r.call.a === p.id || r.call.b === p.id)) { const other = playerById(r, r.call.a === p.id ? r.call.b : r.call.a); if (other) send(other.ws, { type: 'callEnded' }); r.call = null; }
    if (r.eavesdropper === p.id) endEavesdrop(r);
    if (!r.players.length) {
      if (r.challengeTimer) clearTimeout(r.challengeTimer);
      if (r.eavesdropTimer) clearTimeout(r.eavesdropTimer);
      if (r.gameTimer) clearTimeout(r.gameTimer);
      if (r.voteTimer) clearTimeout(r.voteTimer);
      rooms.delete(p.room);
    } else broadcast(r, roomState(r));
  });
});

// A special one-time eavesdrop challenge (two-truths-and-a-lie) offered at a random moment after the game starts.
setInterval(() => {
  for (const r of rooms.values()) {
    if (!r.started || r.eavesdropUsed || r.eavesdropPending || r.eavesdropper || !r.call) continue;
    const candidates = r.players.filter(p => p.id !== r.call.a && p.id !== r.call.b && p.ws.readyState === 1);
    if (!candidates.length) continue;
    if (Math.random() < 0.22) {
      const p = candidates[Math.floor(Math.random() * candidates.length)];
      const { statements, lieIndex } = makeTwoTruthsOneLie();
      r.eavesdropPending = { player: p.id, endsAt: Date.now() + 25000, lieIndex };
      send(p.ws, { type: 'eavesdropChallenge', endsAt: r.eavesdropPending.endsAt, statements });
    }
  }
}, 5000);

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => console.log(`Undercall running on port ${port}`));
