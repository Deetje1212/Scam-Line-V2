const express=require('express');
const http=require('http');
const WebSocket=require('ws');
const crypto=require('crypto');
const path=require('path');
const app=express();
const server=http.createServer(app);
const wss=new WebSocket.Server({server});
app.use(express.static(path.join(__dirname,'public')));

const rooms=new Map();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'slaapzuinig';
const CHALLENGE_INTERVAL_MIN=28000;
const CHALLENGE_INTERVAL_MAX=48000;
const EAVESDROP_DURATION=10000;

function send(ws,o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));}
function broadcast(room,o,except){for(const p of room.players)if(p.ws!==except)send(p.ws,o);}
function publicPlayers(room){return room.players.map(p=>({id:p.id,name:p.name,connected:p.ws.readyState===1}));}
function roomState(room){return {type:'roomState',players:publicPlayers(room),started:room.started,host:room.host};}
function playerById(r,id){return r.players.find(x=>x.id===id);}
function roleFor(r,p){return r.roles.find(x=>x.id===p.id)?.role||'operator';}
function saboteur(r){return r.players.find(p=>roleFor(r,p)==='saboteur');}
function randomBetween(a,b){return Math.floor(a+Math.random()*(b-a+1));}
function adminState(r){return {type:'adminState',players:publicPlayers(r),started:r.started,call:r.call?{a:r.call.a,b:r.call.b}:null,eavesdropUsed:r.eavesdropUsed,eavesdropPending:r.eavesdropPending?{player:r.eavesdropPending.player,endsAt:r.eavesdropPending.endsAt}:null,eavesdropper:r.eavesdropper,timerEndsAt:r.timerEndsAt,challenge:r.challenge?{id:r.challenge.id,type:r.challenge.type,player:r.challenge.player,target:r.challenge.data?.target,endsAt:r.challenge.endsAt}:null};}
function sendAdminState(r){for(const p of r.players)if(p.admin)send(p.ws,adminState(r));}
function sendClue(r,p,reason){
  if(!p||!p.secretCode)return null;
  const available=p.secretCode.split('').map((d,i)=>({d,i})).filter(x=>!p.revealedDigits.has(x.i)&&!p.blockedDigits.has(x.i));
  if(!available.length)return null;
  const pick=available[Math.floor(Math.random()*available.length)];
  p.revealedDigits.add(pick.i);
  send(p.ws,{type:'clue',digit:pick.d,index:pick.i,reason});
  send(p.ws,{type:'codeState',revealed:[...p.revealedDigits].sort((a,b)=>a-b).map(i=>({index:i,digit:p.secretCode[i]})),blocked:[...p.blockedDigits].sort((a,b)=>a-b)});
  return pick;
}
function challengePayload(c){if(!c)return null;const d={...c.data};delete d.answer;return {id:c.id,type:c.type,player:c.player,endsAt:c.endsAt,data:d};}
function makeChallenge(r,p,typeOverride=null){
  const others=r.players.filter(x=>x.id!==p.id);
  const other=others[Math.floor(Math.random()*Math.max(1,others.length))];
  const type=typeOverride===null?randomBetween(0,4):Number(typeOverride);
  const c={id:crypto.randomUUID(),type,player:p.id,endsAt:Date.now()+60000,completed:false};
  if(type===0){
    const statements=[
      'De verdachte draagt een rode jas. Je krijgt één deel van een getuigenis. Bel iemand en vraag door: ontdek of het verhaal klopt.',
      'Een getuige beweert dat de onderhoudsdeur code 7 gebruikt. Bel een speler en controleer de bewering zonder meteen te vertellen wat jij weet.',
      'Er wordt beweerd dat de saboteur als eerste heeft gebeld. Zoek via een gesprek uit of die bewering betrouwbaar is.'
    ];
    c.data={target:other?.id||null,prompt:statements[randomBetween(0,statements.length-1)],task:'Voer een echt telefoongesprek met de doelspeler en stel minstens één gerichte vraag. Daarna kun je bevestigen.'};
  }
  if(type===1){
    const a=randomBetween(11,24),b=randomBetween(7,16),c1=randomBetween(8,19),answer=(a*b)+c1;
    c.data={a,b,c1,answer,prompt:`Kraak de sleutel: (${a} × ${b}) + ${c1} = ?`,task:'60 seconden. Gebruik hoofdrekenen, kladpapier of overleg via de telefoon. Een goed antwoord geeft slechts één codecijfer.'};
  }
  if(type===2)c.data={prompt:'Bel de GEHEIME FREQUENTIE voor één extra cijfer. De saboteur krijgt direct een stille waarschuwing.',task:'Klik pas als je bewust kiest voor de risico/beloning.'};
  if(type===3)c.data={target:other?.id||null,phrase:'DE LIJN IS VEILIG',prompt:'Jij en één andere speler moeten dezelfde geheime zin binnen 3 seconden bevestigen.',task:'Bel elkaar eerst. Wanneer jullie klaar zijn, drukken jullie zo dicht mogelijk tegelijk op de knop.'};
  if(type===4)c.data={target:other?.id||null,prompt:`Saboteur-opdracht: zorg dat ${other?.name||'je doelspeler'} tijdens een telefoongesprek binnen 2 minuten ophangt.`,task:'De server beoordeelt dit automatisch zodra het doelwit ophangt.'};
  r.challenge=c;return c;
}
function scheduleNextChallenge(r,initial=false){if(r.challengeTimer)clearTimeout(r.challengeTimer);const delay=initial?randomBetween(12000,22000):randomBetween(CHALLENGE_INTERVAL_MIN,CHALLENGE_INTERVAL_MAX);r.challengeTimer=setTimeout(()=>spawnRandomChallenge(r),delay);}
function spawnRandomChallenge(r,typeOverride=null,targetOverride=null){
  if(!r.started||r.players.length<2)return false;
  if(r.challenge&&!r.challenge.completed&&r.challenge.endsAt>Date.now())return false;
  const candidates=r.players.filter(p=>p.ws.readyState===1 && (!targetOverride||p.id===targetOverride));
  if(!candidates.length)return false;
  const p=candidates[Math.floor(Math.random()*candidates.length)];
  const c=makeChallenge(r,p,typeOverride);
  send(p.ws,{type:'challenge',challenge:challengePayload(c),popup:true});
  if(c.type===3 && c.data.target){const partner=playerById(r,c.data.target);if(partner)send(partner.ws,{type:'coChallenge',phrase:c.data.phrase,from:p.name});}
  sendAdminState(r);
  return c;
}
function startGame(r){
  r.started=true;r.roles=[];r.challenge=null;r.eavesdropUsed=false;r.eavesdropper=null;r.eavesdropPending=null;r.eavesdropUntil=0;r.timerEndsAt=Date.now()+180000;
  const secret=r.players[Math.floor(Math.random()*r.players.length)];
  r.players.forEach((pl,i)=>{
    const role=pl===secret?'saboteur':'operator';
    r.roles.push({id:pl.id,role});
    pl.secretCode=String(randomBetween(1000,9999));pl.revealedDigits=new Set();pl.blockedDigits=new Set();pl.claimed=false;
    const goal=role==='saboteur'?'Verzamel codecijfers, manipuleer de anderen en voltooi je geheime sabotage-opdracht.':'Verzamel je vier codecijfers, controleer informatie via telefoongesprekken en bepaal wie je vertrouwt.';
    send(pl.ws,{type:'gameStart',goal,role,codeMasked:'----',timerEndsAt:r.timerEndsAt});
    const startingIndex=i%4;pl.revealedDigits.add(startingIndex);
    send(pl.ws,{type:'codeState',revealed:[{index:startingIndex,digit:pl.secretCode[startingIndex]}],blocked:[]});
  });
  const infos=[
    'De onderhoudsdeur gebruikt één van de cijfers 4, 7 of 9.',
    'De rode indicator kan een misleiding zijn.',
    'Een telefoongesprek kan belangrijke informatie bevestigen, maar niet alles wat je hoort is waar.',
    'De saboteur weet dat haast en verwarring in zijn voordeel zijn.',
    'Een deel van de case file ontbreekt bewust; challenges kunnen stukjes teruggeven.'
  ];
  r.players.forEach((pl,i)=>send(pl.ws,{type:'privateInfo',text:infos[i%infos.length]}));
  sendClue(r,secret,'Startinformatie voor de saboteur');
  broadcast(r,{type:'gameNotice',text:'Het spel is gestart. Challenges verschijnen automatisch op willekeurige momenten.'});
  broadcast(r,roomState(r));scheduleNextChallenge(r,true);sendAdminState(r);
}
function notifySaboteur(r,text){const s=saboteur(r);if(s)send(s.ws,{type:'saboteurAlert',text});}
function endEavesdrop(r){
  if(!r.eavesdropper)return;
  const id=r.eavesdropper;r.eavesdropper=null;r.eavesdropUntil=0;
  for(const p of r.players)send(p.ws,{type:'eavesdropEnded'});
  send(playerById(r,id)?.ws,{type:'toast',text:'Afluisteren is voorbij.'});sendAdminState(r);
}
function startEavesdrop(r,p){
  if(r.eavesdropUsed||!r.call||!p||p.id===r.call.a||p.id===r.call.b)return false;
  r.eavesdropUsed=true;r.eavesdropper=p.id;r.eavesdropUntil=Date.now()+EAVESDROP_DURATION;r.eavesdropPending=null;
  const call={...r.call};
  send(p.ws,{type:'eavesdropGranted',until:r.eavesdropUntil});
  for(const id of [call.a,call.b]){const target=playerById(r,id);if(target)send(target.ws,{type:'eavesdropJoin',eavesdropper:p.id,until:r.eavesdropUntil});}
  r.eavesdropTimer=setTimeout(()=>endEavesdrop(r),EAVESDROP_DURATION);sendAdminState(r);return true;
}
function forceEavesdropChallenge(r,targetId){
  if(r.eavesdropUsed||r.eavesdropPending||!r.call)return false;
  const candidates=r.players.filter(p=>p.ws.readyState===1&&p.id!==r.call.a&&p.id!==r.call.b&&(!targetId||p.id===targetId));
  if(!candidates.length)return false;
  const p=candidates[0];const a=randomBetween(12,27),b=randomBetween(8,19),c=randomBetween(9,23),answer=a*b+c;
  r.eavesdropPending={player:p.id,endsAt:Date.now()+20000,answer};
  send(p.ws,{type:'eavesdropChallenge',endsAt:r.eavesdropPending.endsAt,question:`(${a} × ${b}) + ${c} = ?`});sendAdminState(r);return true;
}
function adminCommand(r,action,targetId,value){
  const target=playerById(r,targetId);
  if(action==='start'){if(r.players.length>=2)startGame(r);return 'Game gestart.';}
  if(action==='reset'){
    if(r.challengeTimer)clearTimeout(r.challengeTimer);if(r.eavesdropTimer)clearTimeout(r.eavesdropTimer);
    r.started=false;r.roles=[];r.challenge=null;r.eavesdropUsed=false;r.eavesdropper=null;r.eavesdropPending=null;r.eavesdropUntil=0;r.timerEndsAt=0;r.call=null;
    r.players.forEach(p=>{p.claimed=false;p.revealedDigits=new Set();p.blockedDigits=new Set();});broadcast(r,roomState(r));return 'Beta room gereset.';
  }
  if(action==='spawnChallenge'){if(!target)return 'Kies een speler.';return spawnRandomChallenge(r,value===undefined?null:Number(value),targetId)?'Challenge getriggerd.':'Kon challenge niet starten.';}
  if(action==='clearChallenge'){r.challenge=null;sendAdminState(r);return 'Challenge verwijderd.';}
  if(action==='eavesChallenge')return forceEavesdropChallenge(r,targetId)?'Afluister-challenge getriggerd.':'Geen geschikte speler of geen actief gesprek.';
  if(action==='eavesGrant')return startEavesdrop(r,target)?'10 seconden afluisteren gestart.':'Afluisteren kon niet starten.';
  if(action==='frequency'){if(!target)return 'Kies een speler.';sendClue(r,target,'Admin beta: geheime frequentie');notifySaboteur(r,`${target.name} verzamelt stiekem informatie via de geheime frequentie.`);return 'Frequentie uitgevoerd.';}
  if(action==='giveClue'){if(!target)return 'Kies een speler.';return sendClue(r,target,'Admin beta: codecijfer vrijgegeven')?'Codecijfer vrijgegeven.':'Geen vrij codecijfer meer.';}
  if(action==='blockDigit'){if(!target)return 'Kies een speler.';const idx=Math.max(0,Math.min(3,Number(value)||0));target.blockedDigits.add(idx);send(target.ws,{type:'digitBlocked'});send(target.ws,{type:'codeState',revealed:[...target.revealedDigits].map(i=>({index:i,digit:target.secretCode?.[i]||'?'})),blocked:[...target.blockedDigits]});return `Cijfer ${idx+1} geblokkeerd.`;}
  if(action==='setTimer'){const seconds=Math.max(0,Math.min(180,Number(value)||0));r.timerEndsAt=Date.now()+seconds*1000;broadcast(r,{type:'timerSet',timerEndsAt:r.timerEndsAt});sendAdminState(r);return `Timer ingesteld op ${seconds} seconden.`;}
  if(action==='claim'){if(!target)return 'Kies een speler.';target.revealedDigits=new Set([0,1,2,3]);send(target.ws,{type:'codeState',revealed:[0,1,2,3].map(i=>({index:i,digit:target.secretCode?.[i]||'?'})),blocked:[...target.blockedDigits]});return 'Alle codecijfers vrijgegeven.';}
  if(action==='saboteur'){if(!target)return 'Kies een speler.';r.roles=r.players.map(p=>({id:p.id,role:p.id===target.id?'saboteur':'operator'}));r.players.forEach(p=>send(p.ws,{type:'roleUpdate',role:roleFor(r,p)}));return `${target.name} is nu saboteur voor de beta-test.`;}
  return 'Onbekende adminactie.';
}

wss.on('connection',ws=>{
  const p={ws,id:crypto.randomUUID(),name:'Player',room:null,admin:false,adminToken:null,revealedDigits:new Set(),blockedDigits:new Set()};
  send(ws,{type:'hello',id:p.id});
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.type==='adminAuth'){
      const code=String(m.password||'');
      if(code!==ADMIN_PASSWORD)return send(ws,{type:'adminAuthResult',ok:false,text:'Onjuist beta-admin wachtwoord.'});
      const r=rooms.get(String(m.room||'').toUpperCase());
      if(!r)return send(ws,{type:'adminAuthResult',ok:false,text:'Join eerst een room.'});
      p.admin=true;p.adminToken=crypto.randomBytes(24).toString('hex');send(ws,{type:'adminAuthResult',ok:true,token:p.adminToken,room:r.code});send(ws,adminState(r));return;
    }
    if(m.type==='adminCommand'){
      const r=rooms.get(p.room);if(!p.admin||!p.adminToken||m.token!==p.adminToken||!r)return send(ws,{type:'adminResult',ok:false,text:'Admin-sessie ongeldig.'});
      const text=adminCommand(r,String(m.action||''),m.targetId,m.value);send(ws,{type:'adminResult',ok:true,text});sendAdminState(r);return;
    }
    if(m.type==='join'){
      const code=String(m.room||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);if(!code)return send(ws,{type:'error',text:'Ongeldige roomcode.'});
      let r=rooms.get(code);if(!r){r={code,players:[],host:p.id,started:false,roles:[],call:null,eavesdropUsed:false,eavesdropper:null,eavesdropPending:null,challenge:null,challengeTimer:null,eavesdropTimer:null,timerEndsAt:0};rooms.set(code,r)}
      if(r.players.length>=5)return send(ws,{type:'error',text:'Room is vol (maximaal 5 spelers).'});if(r.started)return send(ws,{type:'error',text:'Dit spel is al gestart.'});
      p.room=code;p.name=String(m.name||'Player').slice(0,20)||'Player';r.players.push(p);send(ws,{type:'joined',room:code,id:p.id,host:r.host});send(ws,roomState(r));return;
    }
    const r=rooms.get(p.room);if(!r)return;
    if(m.type==='start'){if(p.id!==r.host)return;if(r.players.length<2)return send(ws,{type:'error',text:'Minimaal 2 spelers nodig.'});startGame(r);return;}
    if(m.type==='signal'){const to=playerById(r,m.to);if(to)send(to.ws,{type:'signal',from:p.id,fromName:p.name,signal:m.signal,channel:m.channel||'call'});return;}
    if(m.type==='callInvite'){const to=playerById(r,m.to);if(!to)return;if(r.call)return send(ws,{type:'error',text:'De telefoonlijn is bezet.'});r.call={a:p.id,b:to.id};send(to.ws,{type:'callInvite',from:p.id,fromName:p.name});send(ws,{type:'callWaiting',to:to.name});sendAdminState(r);return;}
    if(m.type==='callAccept'){const to=playerById(r,m.to);if(to)send(to.ws,{type:'callAccepted',from:p.id});return;}
    if(m.type==='callEnd'){
      const to=playerById(r,m.to);if(to)send(to.ws,{type:'callEnded',from:p.id});
      const active=r.call&&(r.call.a===p.id||r.call.b===p.id);
      if(active){r.call=null;if(r.eavesdropPending){const pending=r.eavesdropPending;r.eavesdropPending=null;const ep=playerById(r,pending.player);if(ep)send(ep.ws,{type:'challengeFailed',text:'Het telefoongesprek eindigde; de afluisterkans is vervallen.'});}}
      if(r.challenge&&r.challenge.type===4&&!r.challenge.completed&&r.challenge.player===saboteur(r)?.id){const target=r.challenge.data.target;if(target===p.id){r.challenge.completed=true;send(saboteur(r).ws,{type:'challengeComplete',reward:'Sabotage geslaagd: een codecijfer van je doelwit is tijdelijk geblokkeerd.'});const victim=playerById(r,target);if(victim&&victim.revealedDigits.size)victim.blockedDigits.add([...victim.revealedDigits][0]);send(victim?.ws,{type:'digitBlocked'});}}
      sendAdminState(r);return;
    }
    if(m.type==='complete'){const revealed=[...p.revealedDigits].filter(i=>!p.blockedDigits.has(i)).length;if(revealed<4)return send(ws,{type:'claimFailed',text:`Je kunt je objective nog niet claimen. Je hebt ${revealed}/4 beschikbare codecijfers.`});if(p.claimed)return send(ws,{type:'claimFailed',text:'Je hebt je objective al geclaimd.'});p.claimed=true;send(ws,{type:'objectiveClaimed',text:'OBJECTIVE GECLAIMD. Je hebt alle vier codecijfers verzameld.'});if(r.players.filter(x=>x.claimed).length===1)broadcast(r,{type:'gameNotice',text:'Iemand heeft zijn objective geclaimd.'});return;}
    if(m.type==='coChallengeAnswer'){const c=r.challenge;if(!c||c.type!==3||c.completed)return;if(c.player!==p.id&&c.data.target!==p.id)return;c.syncClicks=c.syncClicks||{};c.syncClicks[p.id]=Date.now();const otherId=c.data.target===p.id?c.player:c.data.target;const other=playerById(r,otherId);if(other)send(other.ws,{type:'coChallengeReady'});if(c.syncClicks[c.player]&&c.syncClicks[c.data.target]&&Math.abs(c.syncClicks[c.player]-c.syncClicks[c.data.target])<=3000){c.completed=true;const a=playerById(r,c.player),b=playerById(r,c.data.target);[a,b].forEach(q=>{if(q){send(q.ws,{type:'challengeComplete',reward:'De geheime zin werd binnen 3 seconden bevestigd.'});sendClue(r,q,'Beloning: Wederzijdse Bekentenis');}})}return;}
    if(m.type==='challengeAnswer'){
      const c=r.challenge;if(!c||c.player!==p.id||c.completed)return;if(Date.now()>c.endsAt)return send(ws,{type:'challengeFailed',text:'Te laat — deze challenge is verlopen.'});
      let ok=false,reason='Challenge voltooid.';
      if(c.type===1){ok=String(m.answer||'').trim()===String(c.data.answer);reason='Code-Kraak opgelost: een nieuw codecijfer is vrijgegeven.';}
      if(c.type===0){const activeCall=r.call&&(r.call.a===p.id||r.call.b===p.id);const target=c.data.target;const talkingTo=activeCall&&((r.call.a===p.id&&r.call.b===target)||(r.call.b===p.id&&r.call.a===target));ok=Boolean(talkingTo);reason='Getuigenis-Verificatie afgerond: een klein stukje case-informatie is verdiend.';}
      if(c.type===2)return send(ws,{type:'error',text:'Gebruik de geheime-frequentieknop om deze challenge te voltooien.'});
      if(c.type===4)return send(ws,{type:'error',text:'Deze sabotage-opdracht wordt automatisch beoordeeld tijdens een telefoongesprek.'});
      if(ok){c.completed=true;send(ws,{type:'challengeComplete',reward:reason});sendClue(r,p,reason);scheduleNextChallenge(r);sendAdminState(r);}else send(ws,{type:'challengeFailed',text:'Dat antwoord klopt niet. Je krijgt geen codecijfer.'});return;
    }
    if(m.type==='secretFrequency'){const c=r.challenge;if(!c||c.player!==p.id||c.type!==2||c.completed)return send(ws,{type:'error',text:'De geheime frequentie is niet beschikbaar.'});notifySaboteur(r,`${p.name} verzamelt stiekem informatie via de geheime frequentie.`);sendClue(r,p,'Geheime frequentie');c.completed=true;send(ws,{type:'challengeComplete',reward:'De geheime frequentie gaf je één codecijfer. De saboteur is gewaarschuwd.'});scheduleNextChallenge(r);return;}
    if(m.type==='eavesdropAnswer'){const ep=r.eavesdropPending;if(!ep||ep.player!==p.id)return;if(Date.now()>ep.endsAt){r.eavesdropPending=null;return send(ws,{type:'challengeFailed',text:'De afluister-challenge is verlopen.'});}if(String(m.answer||'').trim()!==String(ep.answer)){r.eavesdropPending=null;return send(ws,{type:'challengeFailed',text:'Fout antwoord. De eenmalige afluisterkans is verloren.'});}startEavesdrop(r,p);return;}
  });
  ws.on('close',()=>{if(!p.room)return;const r=rooms.get(p.room);if(!r)return;r.players=r.players.filter(x=>x!==p);if(r.host===p.id)r.host=r.players[0]?.id;if(r.call&&(r.call.a===p.id||r.call.b===p.id)){const other=playerById(r,r.call.a===p.id?r.call.b:r.call.a);if(other)send(other.ws,{type:'callEnded'});r.call=null;}if(r.eavesdropper===p.id)endEavesdrop(r);if(!r.players.length){if(r.challengeTimer)clearTimeout(r.challengeTimer);if(r.eavesdropTimer)clearTimeout(r.eavesdropTimer);rooms.delete(p.room);}else{broadcast(r,roomState(r));sendAdminState(r);}});
});

setInterval(()=>{
  for(const r of rooms.values()){
    if(!r.started||r.eavesdropUsed||r.eavesdropPending||r.eavesdropper||!r.call)continue;
    const candidates=r.players.filter(p=>p.id!==r.call.a&&p.id!==r.call.b&&p.ws.readyState===1);if(!candidates.length)continue;
    if(Math.random()<0.22)forceEavesdropChallenge(r);
  }
},5000);

const port=process.env.PORT||3000;server.listen(port,'0.0.0.0',()=>console.log(`Undercall running on port ${port}`));
