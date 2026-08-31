let ws,me,room,host,players=[],currentCaller=null,currentPeer=null,pc=null,localStream=null,remoteAudio=null,ringTimer=null,audioCtx=null,processedStream=null,pendingCandidates=[];
let eavesdropPCs=new Map(),gameTimerEnds=0,lastTimerSec=-1,challenge=null,eavesEnd=0;
const $=id=>document.getElementById(id);
function send(o){ws?.send(JSON.stringify(o))}
function ctx(){if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume();return audioCtx}
function beep(freq=700,dur=.12,type='square',gain=.035){try{const a=ctx(),o=a.createOscillator(),g=a.createGain();o.type=type;o.frequency.value=freq;g.gain.value=gain;o.connect(g).connect(a.destination);o.start();setTimeout(()=>{try{o.stop()}catch{}},dur*1000)}catch{}}
function oldPhoneRing(){beep(900,.16,'square',.045);setTimeout(()=>beep(650,.16,'square',.045),190)}
function ring(){stopRing();oldPhoneRing();ringTimer=setInterval(oldPhoneRing,950)}
function stopRing(){if(ringTimer)clearInterval(ringTimer);ringTimer=null}
function phonePickUp(){beep(420,.08,'sine',.05);setTimeout(()=>beep(620,.13,'sine',.045),80)}
function phoneHangUp(){beep(300,.08,'sine',.045);setTimeout(()=>beep(190,.18,'sine',.035),90)}
function timerTick(){beep(850,.035,'square',.025)}
function timerEnd(){beep(220,.25,'sawtooth',.05);setTimeout(()=>beep(160,.45,'sawtooth',.045),250)}
function toast(t){$('toast').textContent=t;$('toast').classList.remove('hidden');setTimeout(()=>$('toast').classList.add('hidden'),3200)}
function escape(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
$('join').onclick=()=>{let n=$('name').value.trim()||'Player';room=$('room').value.trim().toUpperCase()||Math.random().toString(36).slice(2,7).toUpperCase();ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);ws.onopen=()=>{send({type:'join',name:n,room});$('status').textContent='CONNECTED'};ws.onmessage=e=>handle(JSON.parse(e.data));ws.onclose=()=>{$('status').textContent='OFFLINE'}};
function handle(m){
 if(m.type==='hello')me=m.id;
 if(m.type==='error')toast(m.text);
 if(m.type==='joined'){room=m.room;$('roomLabel').textContent=room;showGame();}
 if(m.type==='roomState'){players=m.players;host=m.host;renderPlayers();}
 if(m.type==='gameStart'){$('goal').textContent=m.goal;$('code').textContent=m.codeMasked;$('roleBadge').textContent=m.role==='saboteur'?'ROLE: SABOTEUR':'ROLE: OPERATOR';gameTimerEnds=m.timerEndsAt;startTimer();$('complete').disabled=false;}
 if(m.type==='privateInfo')$('info').textContent=m.text;
 if(m.type==='clue'){updateCodeDigit(m.index,m.digit);toast(`Nieuwe informatie: codecijfer ${m.index+1} vrijgegeven.`)}
 if(m.type==='codeState')updateCodeState(m.revealed||[],m.blocked||[]);
 if(m.type==='claimFailed')toast(m.text);
 if(m.type==='objectiveClaimed'){toast(m.text);$('complete').disabled=true;}
 if(m.type==='gameNotice')toast(m.text);
 if(m.type==='callInvite'){currentCaller=m.from;showCall(m.fromName,true);ring()}
 if(m.type==='callWaiting')$('callStatus').textContent='WAITING FOR ANSWER…';
 if(m.type==='callAccepted'){startCaller(m.from)}
 if(m.type==='signal')onSignal(m);
 if(m.type==='callEnded')endCall(false);
 if(m.type==='challenge')showChallenge(m.challenge,true);
 if(m.type==='challengeComplete'){toast(m.reward);challenge=null;renderChallenge();}
 if(m.type==='challengeFailed'){toast(m.text);}
 if(m.type==='saboteurAlert')toast('⚠️ '+m.text);
 if(m.type==='frequencyDigit')toast('De geheime frequentie is verbonden.');
 if(m.type==='coChallenge')showCoChallenge(m.phrase,m.from);
 if(m.type==='coChallengeReady')toast('Je partner is klaar. Druk nu!');
 if(m.type==='digitBlocked')toast('Een codecijfer is tijdelijk geblokkeerd.');
 if(m.type==='eavesdropChallenge')showEavesdropChallenge(m.question,m.endsAt);
 if(m.type==='eavesdropGranted')startEavesTimer(m.until);
 if(m.type==='eavesdropJoin')joinEavesdrop(m.eavesdropper);
 if(m.type==='eavesdropEnded')endEavesLocal();
 if(m.type==='toast')toast(m.text);
}
function showGame(){$('lobby').classList.add('hidden');$('game').classList.remove('hidden')}
function renderPlayers(){let el=$('players');el.innerHTML='';players.forEach(p=>{if(p.id===me)return;let d=document.createElement('div');d.className='player';d.innerHTML=`<span>${escape(p.name)}</span><button>CALL</button>`;d.querySelector('button').onclick=()=>call(p);el.appendChild(d)});if(host===me&&!document.getElementById('start')){let b=document.createElement('button');b.id='start';b.textContent='START GAME';b.style.width='100%';b.style.marginTop='10px';b.onclick=()=>send({type:'start'});el.parentNode.appendChild(b)}if(host!==me)$('start')?.remove()}
function call(p){currentPeer=p.id;send({type:'callInvite',to:p.id});showCall(p.name,false);preparePeer(true,p.id);phonePickUp()}
function showCall(name,incoming){$('call').classList.remove('hidden');$('callTitle').textContent=incoming?'INCOMING CALL':'CALLING';$('callFrom').textContent=name;$('accept').style.display=incoming?'inline-block':'none';$('callStatus').textContent=incoming?'RINGING…':'WAITING FOR ANSWER…'}
$('accept').onclick=()=>{stopRing();phonePickUp();send({type:'callAccept',to:currentCaller});currentPeer=currentCaller;preparePeer(false,currentPeer);$('callStatus').textContent='CONNECTED — VOICE LINE OPEN'};
$('hang').onclick=()=>{if(currentPeer)send({type:'callEnd',to:currentPeer});phoneHangUp();endCall(true)};
async function makeProcessedStream(){const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});const a=ctx(),src=a.createMediaStreamSource(stream),band=a.createBiquadFilter(),high=a.createBiquadFilter(),comp=a.createDynamicsCompressor(),dest=a.createMediaStreamDestination();band.type='bandpass';band.frequency.value=1450;band.Q.value=.8;high.type='highpass';high.frequency.value=280;comp.threshold.value=-22;comp.knee.value=16;comp.ratio.value=4;comp.attack.value=.003;comp.release.value=.12;src.connect(band).connect(high).connect(comp).connect(dest);processedStream=dest.stream;localStream=stream;return processedStream}
async function preparePeer(initiator,id){try{if(pc)return;const outgoing=await makeProcessedStream();pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});outgoing.getTracks().forEach(t=>pc.addTrack(t,outgoing));pc.ontrack=e=>{if(!remoteAudio){remoteAudio=new Audio();remoteAudio.autoplay=true}remoteAudio.srcObject=e.streams[0]};pc.onicecandidate=e=>{if(e.candidate)send({type:'signal',to:id,signal:{candidate:e.candidate},channel:'call'})};pc.onconnectionstatechange=()=>{if(pc?.connectionState==='connected')$('callStatus').textContent='CONNECTED — VOICE LINE OPEN'};if(initiator){let offer=await pc.createOffer();await pc.setLocalDescription(offer);send({type:'signal',to:id,signal:{sdp:pc.localDescription},channel:'call'})}}catch(e){console.error(e);$('callStatus').textContent='Microphone permission required.'}}
async function onSignal(m){if(m.channel==='eavesdrop')return onEavesdropSignal(m);if(!pc){currentPeer=m.from;await preparePeer(false,m.from)}try{if(m.signal.sdp){await pc.setRemoteDescription(m.signal.sdp);for(const c of pendingCandidates.splice(0))await pc.addIceCandidate(c);if(m.signal.sdp.type==='offer'){let a=await pc.createAnswer();await pc.setLocalDescription(a);send({type:'signal',to:m.from,signal:{sdp:pc.localDescription},channel:'call'})}}else if(m.signal.candidate){if(pc.remoteDescription)await pc.addIceCandidate(m.signal.candidate);else pendingCandidates.push(m.signal.candidate)}}catch(e){console.warn(e)}}
function endCall(local){stopRing();if(local)phoneHangUp();if(pc){pc.close();pc=null}if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}processedStream=null;if(remoteAudio){remoteAudio.srcObject=null;remoteAudio=null}$('call').classList.add('hidden');currentPeer=null;currentCaller=null;pendingCandidates=[]}
$('complete').onclick=()=>send({type:'complete'});
function showChallenge(c,popup=false){challenge=c;renderChallenge();if(popup){$('challengeBox').classList.add('challengePop');setTimeout(()=>$('challengeBox').classList.remove('challengePop'),700);toast('NIEUWE CHALLENGE — los hem op voor informatie.')}}
function renderChallenge(){const box=$('challengeBox');if(!challenge){box.classList.add('hidden');box.innerHTML='';return}box.classList.remove('hidden');let title=['Getuigenis-Verificatie','Code-Kraak','Het Geheim van de Lijn','Wederzijdse Bekentenis','Saboteur’s Sabotage'][challenge.type];let html=`<b>${title}</b><p>${escape(challenge.data.prompt)}</p><small>${escape(challenge.data.task||'')}</small><div class="challengeTime" id="challengeTime">--s</div>`;
 if(challenge.type===1)html+=`<input id="challengeAnswer" type="text" inputmode="numeric" autocomplete="off" placeholder="Typ je antwoord"><button id="challengeSubmit">KRAAK CODE</button>`;
 else if(challenge.type===2)html+=`<button id="frequencyBtn">BEL GEHEIME FREQUENTIE</button>`;
 else if(challenge.type===0)html+=`<button id="testimonyBtn">IK HEB HET GESPREK GEVOERD</button>`;
 else if(challenge.type===3)html+=`<button id="coBtn">IK SPREEK DE ZIN NU UIT</button>`;
 else html+=`<small>Wacht op een telefoongesprek; de server controleert deze opdracht automatisch.</small>`;
 box.innerHTML=html;
 if(challenge.type===1){$('challengeSubmit').onclick=()=>submitChallenge();$('challengeAnswer').focus();$('challengeAnswer').addEventListener('keydown',e=>{if(e.key==='Enter')submitChallenge()})}
 if(challenge.type===2)$('frequencyBtn').onclick=()=>{send({type:'secretFrequency'});};
 if(challenge.type===0)$('testimonyBtn').onclick=()=>submitChallenge(true);
 if(challenge.type===3)$('coBtn').onclick=()=>submitCoChallenge();
 updateChallengeClock();
}
function updateChallengeClock(){if(!challenge)return;const left=Math.max(0,Math.ceil((challenge.endsAt-Date.now())/1000));const el=$('challengeTime');if(el)el.textContent=`${left}s`;if(left>0)setTimeout(updateChallengeClock,250);else if(challenge){toast('Challenge verlopen.');}}
function submitChallenge(){const a=$('challengeAnswer')?.value||'';send({type:'challengeAnswer',answer:a})}
function showCoChallenge(phrase,from){challenge={id:'co',type:3,endsAt:Date.now()+60000,data:{phrase,prompt:`${escape(from)} zegt dat jullie tegelijk moeten zeggen: ${escape(phrase)}`,task:'Druk op de knop wanneer jullie de zin tegelijk uitspreken.'}};renderChallenge()}
function submitCoChallenge(){send({type:'coChallengeAnswer'})}
function showEavesdropChallenge(question,endsAt){const box=$('challengeBox');challenge=null;box.classList.remove('hidden');box.classList.add('challengePop');box.innerHTML=`<b>AFSTAND-AFLUISTERING</b><p>Dit is eenmalig in de hele game.</p><p>Los op: <strong>${escape(question)}</strong></p><small>Juist? Dan hoor je maximaal 10 seconden één actief telefoongesprek. De twee bellers horen jou niet.</small><div class="challengeTime" id="eavesTime"></div><input id="eavesAns" type="text" inputmode="numeric" autocomplete="off" placeholder="Typ je antwoord"><button id="eavesBtn">LUISTER MEE</button>`;setTimeout(()=>$('challengeBox').classList.remove('challengePop'),700);eavesEnd=endsAt;updateEavesClock();$('eavesBtn').onclick=submitEaves;$('eavesAns').focus();$('eavesAns').addEventListener('keydown',e=>{if(e.key==='Enter')submitEaves()})}
function updateEavesClock(){if(!eavesEnd)return;const left=Math.max(0,Math.ceil((eavesEnd-Date.now())/1000));if($('eavesTime'))$('eavesTime').textContent=`Challenge tijd: ${left}s`;if(left>0)setTimeout(updateEavesClock,250)}
function submitEaves(){send({type:'eavesdropAnswer',answer:$('eavesAns')?.value||''})}
function startEavesTimer(until){toast('AFSTAND-AFLUISTERING ACTIEF — maximaal 10 seconden');eavesEnd=until;const tick=setInterval(()=>{const left=Math.max(0,Math.ceil((until-Date.now())/1000));$('eavesStatus')&&($('eavesStatus').textContent=`Afluisteren: ${left}s`);if(left<=0)clearInterval(tick)},200)}
function endEavesLocal(){for(const [k,p] of eavesdropPCs){try{p.close()}catch{}}eavesdropPCs.clear();toast('Afluisteren gestopt.');}
async function joinEavesdrop(eavesId){if(eavesId===me||!currentPeer)return;try{const outgoing=processedStream||await makeProcessedStream();const epc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});eavesdropPCs.set(eavesId,epc);outgoing.getTracks().forEach(t=>epc.addTrack(t,outgoing));epc.onicecandidate=e=>{if(e.candidate)send({type:'signal',to:eavesId,signal:{candidate:e.candidate},channel:'eavesdrop'})};let offer=await epc.createOffer();await epc.setLocalDescription(offer);send({type:'signal',to:eavesId,signal:{sdp:epc.localDescription},channel:'eavesdrop'});}catch(e){console.warn(e)}}
async function onEavesdropSignal(m){let epc=eavesdropPCs.get(m.from);if(!epc){epc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});eavesdropPCs.set(m.from,epc);epc.ontrack=e=>{const a=new Audio();a.autoplay=true;a.srcObject=e.streams[0]};epc.onicecandidate=e=>{if(e.candidate)send({type:'signal',to:m.from,signal:{candidate:e.candidate},channel:'eavesdrop'})}}try{if(m.signal.sdp){await epc.setRemoteDescription(m.signal.sdp);if(m.signal.sdp.type==='offer'){let a=await epc.createAnswer();await epc.setLocalDescription(a);send({type:'signal',to:m.from,signal:{sdp:epc.localDescription},channel:'eavesdrop'})}}else if(m.signal.candidate)await epc.addIceCandidate(m.signal.candidate)}catch(e){console.warn(e)}}
function updateCodeDigit(index,digit){const chars=$('code').textContent.split('');if(index>=0&&index<4){chars[index]=digit;$('code').textContent=chars.join('')}}
function updateCodeState(revealed,blocked){const chars=['-','-','-','-'];revealed.forEach(item=>{const i=typeof item==='number'?item:item.index;const d=typeof item==='number'?'?':item.digit;if(i>=0&&i<4)chars[i]=d});blocked.forEach(i=>{if(i>=0&&i<4)chars[i]='X'});$('code').textContent=chars.join('')}
function startTimer(){lastTimerSec=-1;requestAnimationFrame(timerLoop)}
function timerLoop(){if(!gameTimerEnds)return;let left=Math.max(0,Math.ceil((gameTimerEnds-Date.now())/1000));let min=Math.floor(left/60),sec=left%60;$('timer').textContent=`${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;$('timerBar').style.width=Math.max(0,left/180*100)+'%';if(left<=10&&left>0&&left!==lastTimerSec){timerTick();$('timer').classList.add('tick');setTimeout(()=>$('timer').classList.remove('tick'),130)}$('timer').classList.toggle('danger',left<=10);if(left===0&&lastTimerSec!==0){timerEnd();toast('TIJD IS OM!')}lastTimerSec=left;if(left>0)requestAnimationFrame(timerLoop)}

// ===== BETA ADMIN PANEL =====
let adminToken=null;
function adminSend(action,targetId,value){if(!adminToken)return toast('Open eerst het beta-admin panel.');send({type:'adminCommand',token:adminToken,action,targetId,value});}
function openAdminLogin(){
  if(!room)return toast('Join eerst een room voordat je BETA ADMIN opent.');
  $('adminLogin').classList.remove('hidden');$('adminPassword').value='';setTimeout(()=>$('adminPassword').focus(),50);
}
function closeAdminLogin(){$('adminLogin').classList.add('hidden')}
function openAdminPanel(){$('adminLogin').classList.add('hidden');$('adminPanel').classList.remove('hidden');updateAdminTargets()}
function closeAdminPanel(){$('adminPanel').classList.add('hidden')}
function updateAdminTargets(){
  const sel=$('adminTarget');if(!sel)return;const old=sel.value;sel.innerHTML='';
  players.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.id===me?`${p.name} (JIJ)` : p.name;sel.appendChild(o)});
  if([...sel.options].some(o=>o.value===old))sel.value=old;
}
function adminStatus(t){if($('adminStatus'))$('adminStatus').textContent=t}
function renderAdminState(s){
  updateAdminTargets();
  if($('adminDebug'))$('adminDebug').textContent=JSON.stringify(s,null,2);
}
$('betaAdminBtn').onclick=openAdminLogin;
$('adminCloseBtn').onclick=closeAdminLogin;
$('adminLoginBtn').onclick=()=>{
  const password=$('adminPassword').value;
  if(!password)return toast('Vul het wachtwoord in.');
  send({type:'adminAuth',password,room});
};
$('adminPassword').addEventListener('keydown',e=>{if(e.key==='Enter')$('adminLoginBtn').click()});
$('adminLogout').onclick=()=>{adminToken=null;closeAdminPanel();adminStatus('Admin-sessie gesloten.')};
$('adminStart').onclick=()=>adminSend('start');
$('adminReset').onclick=()=>{if(confirm('Beta room resetten? Dit wist de huidige game-status.'))adminSend('reset')};
$('adminSpawn').onclick=()=>adminSend('spawnChallenge',$('adminTarget').value,Number($('adminChallenge').value));
$('adminEavesChallenge').onclick=()=>adminSend('eavesChallenge',$('adminTarget').value);
$('adminEavesGrant').onclick=()=>adminSend('eavesGrant',$('adminTarget').value);
$('adminFrequency').onclick=()=>adminSend('frequency',$('adminTarget').value);
$('adminClue').onclick=()=>adminSend('giveClue',$('adminTarget').value);
$('adminBlock').onclick=()=>adminSend('blockDigit',$('adminTarget').value,Number($('adminDigit').value));
$('adminClaim').onclick=()=>adminSend('claim',$('adminTarget').value);
$('adminSaboteur').onclick=()=>adminSend('saboteur',$('adminTarget').value);
$('adminTimerSet').onclick=()=>adminSend('setTimer',null,Number($('adminTimer').value));
$('adminTimer10').onclick=()=>adminSend('setTimer',null,10);
$('adminTimer0').onclick=()=>adminSend('setTimer',null,0);
$('adminClearChallenge').onclick=()=>adminSend('clearChallenge');

// Extend the normal message handler without replacing the existing gameplay handler.
const originalHandle=handle;
handle=function(m){
  originalHandle(m);
  if(m.type==='adminAuthResult'){
    if(m.ok){adminToken=m.token;openAdminPanel();adminStatus('Beta-admin actief voor room '+m.room+'.');}
    else toast(m.text);
  }
  if(m.type==='adminState')renderAdminState(m);
  if(m.type==='adminResult')adminStatus(m.text);
  if(m.type==='timerSet'){gameTimerEnds=m.timerEndsAt;lastTimerSec=-1;startTimer();}
  if(m.type==='roleUpdate')$('roleBadge').textContent=m.role==='saboteur'?'ROLE: SABOTEUR':'ROLE: OPERATOR';
};
