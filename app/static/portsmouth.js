const pieceAsset={K:'white-king',Q:'white-queen',R:'white-rook',B:'white-bishop',N:'white-knight',P:'white-pawn',k:'black-king',q:'black-queen',r:'black-rook',b:'black-bishop',n:'black-knight',p:'black-pawn'};
const pieceName={K:'white king',Q:'white queen',R:'white rook',B:'white bishop',N:'white knight',P:'white pawn',k:'black king',q:'black queen',r:'black rook',b:'black bishop',n:'black knight',p:'black pawn'};
let state=null,moves=[],selected=null,flipped=false,busy=false,complete=false,suppressClick=false,pendingDragFrom=null;
const $=id=>document.getElementById(id);
async function api(path,body){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.detail||'Request failed');return data}
function pieces(fen){const out={};fen.split(' ')[0].split('/').forEach((row,ri)=>{let fi=0;for(const c of row){if(/\d/.test(c))fi+=+c;else{out['abcdefgh'[fi]+(8-ri)]=c;fi++}}});return out}
function clearDragArtifacts(){document.querySelectorAll('.drag-piece').forEach(piece=>piece.remove())}
function render(){if(!state)return;clearDragArtifacts();const board=$('board'),map=pieces(state.fen),files=flipped?'hgfedcba':'abcdefgh',ranks=flipped?'12345678':'87654321';board.innerHTML='';for(const rank of ranks)for(const file of files){const sq=file+rank,b=document.createElement('button'),targets=state.legal_moves.filter(m=>m.from===selected&&m.to===sq),piece=map[sq];b.className=`square ${(files.indexOf(file)+ranks.indexOf(rank))%2?'dark':'light'}${selected===sq?' selected':''}${pendingDragFrom===sq?' drag-origin':''}${targets.length?piece?' capture':' target':''}`;b.dataset.square=sq;b.disabled=busy||complete;b.setAttribute('aria-label',`${sq}${piece?' '+pieceName[piece]:''}`);b.innerHTML=`${piece?`<img class="piece" src="/static/pieces/${pieceAsset[piece]}.svg" alt="" draggable="false">`:''}${file===files[0]?`<span class="coord rank">${rank}</span>`:''}${rank===ranks[7]?`<span class="coord file">${file}</span>`:''}`;b.onclick=()=>{if(!suppressClick)clickSquare(sq,map)};b.onpointerdown=event=>startDrag(event,sq,piece);board.append(b)}}
function renderHistory(){if(!state)return;const history=$('history');history.innerHTML='';state.san_history.forEach((san,i)=>{const span=document.createElement('span');span.className=i%2?'black-move':'white-move';span.textContent=`${i%2?'':`${Math.floor(i/2)+1}. `}${san}`;history.append(span)});if(!state.san_history.length)history.innerHTML='<span class="empty">Your first move is waiting.</span>';$('moveCount').textContent=state.san_history.length?`${state.san_history.length} ply`:'Start'}
function animationMoves(uci){const moves=[[uci.slice(0,2),uci.slice(2,4)]];if(uci==='e1g1')moves.push(['h1','f1']);if(uci==='e1c1')moves.push(['a1','d1']);if(uci==='e8g8')moves.push(['h8','f8']);if(uci==='e8c8')moves.push(['a8','d8']);return moves}
async function animateMove(nextState,uci){if(matchMedia('(prefers-reduced-motion: reduce)').matches){state=nextState;render();return}const board=$('board'),rects=animationMoves(uci).map(([from,to])=>{const source=board.querySelector(`[data-square="${from}"] .piece`);return{to,rect:source?.getBoundingClientRect()}});state=nextState;render();const animations=rects.map(({to,rect})=>{const target=board.querySelector(`[data-square="${to}"] .piece`);if(!target||!rect)return null;const end=target.getBoundingClientRect();return target.animate([{transform:`translate(${rect.left-end.left}px,${rect.top-end.top}px)`,zIndex:5},{transform:'translate(0,0)',zIndex:5}],{duration:260,easing:'cubic-bezier(.2,.75,.25,1)',fill:'both'})}).filter(Boolean);await Promise.all(animations.map(animation=>animation.finished.catch(()=>{})))}
function startDrag(event,sq,piece){
  if(busy||complete||event.button!==0||!piece)return;
  const legal=state.legal_moves.filter(move=>move.from===sq);
  if(!legal.length)return;
  clearDragArtifacts();
  const source=event.currentTarget,startX=event.clientX,startY=event.clientY;
  const img=source.querySelector('.piece'),ghost=img.cloneNode(),pointerId=event.pointerId;
  let moved=false,finished=false;
  const rect=img.getBoundingClientRect();
  ghost.classList.add('drag-piece');
  ghost.style.width=`${rect.width}px`;
  ghost.style.height=`${rect.height}px`;
  ghost.style.left=`${rect.left}px`;
  ghost.style.top=`${rect.top}px`;
  document.body.append(ghost);
  const cleanup=()=>{
    if(finished)return false;
    finished=true;
    document.removeEventListener('pointermove',move,true);
    document.removeEventListener('pointerup',finish,true);
    document.removeEventListener('pointercancel',cancel,true);
    source.removeEventListener('lostpointercapture',cancel);
    window.removeEventListener('blur',cancel);
    source.classList.remove('dragging');
    ghost.remove();
    return true;
  };
  const position=e=>{ghost.style.transform=`translate(${e.clientX-startX}px,${e.clientY-startY}px)`};
  const move=e=>{
    if(e.pointerId!==pointerId)return;
    if(!moved&&Math.hypot(e.clientX-startX,e.clientY-startY)>5){
      moved=true;
      source.classList.add('dragging');
      for(const item of legal){
        const target=$('board').querySelector(`[data-square="${item.to}"]`);
        target?.classList.add(target.querySelector('.piece')?'capture':'target');
      }
    }
    if(moved){e.preventDefault();position(e)}
  };
  const finish=async e=>{
    if(finished||e.pointerId!==pointerId)return;
    const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.square');
    const choice=moved&&legal.find(item=>item.to===target?.dataset.square);
    cleanup();
    if(!moved)return;
    suppressClick=true;
    setTimeout(()=>{suppressClick=false},0);
    selected=null;
    if(!choice){render();return}
    await play(choice.uci,{dragged:true,dragFrom:sq});
  };
  const cancel=()=>{if(!cleanup())return;selected=null;render()};
  document.addEventListener('pointermove',move,true);
  document.addEventListener('pointerup',finish,true);
  document.addEventListener('pointercancel',cancel,true);
  source.addEventListener('lostpointercapture',cancel);
  window.addEventListener('blur',cancel);
  try{source.setPointerCapture(pointerId)}catch{}
}
async function clickSquare(sq,map){if(busy||complete)return;const choices=selected?state.legal_moves.filter(m=>m.from===selected&&m.to===sq):[];if(choices.length){let move=choices[0];if(choices.length>1)move=choices.find(m=>m.uci.endsWith('q'))||choices[0];selected=null;await play(move.uci);return}if(map[sq]&&state.legal_moves.some(m=>m.from===sq)){selected=sq}else{selected=null}render()}
async function play(uci,{dragged=false,dragFrom=null}={}){busy=true;pendingDragFrom=dragFrom;render();$('thinking').classList.remove('hidden');$('prompt').textContent='Checking your move…';try{const data=await api('/api/portsmouth/play',{moves,uci,opponent_rating:+$('opponentRating').value});if(!data.correct){$('prompt').textContent='Try again';$('feedback').textContent=data.feedback;return}if(dragged){state=data.white_state;pendingDragFrom=null;render()}else{await animateMove(data.white_state,uci)}if(data.opponent_move)await animateMove(data,data.opponent_move.uci);else{state=data;render()}moves=data.moves;renderHistory();$('feedback').textContent=data.feedback;if(data.complete){complete=true;showFinish(data.stockfish);$('prompt').textContent='Line complete'}else{$('prompt').textContent='Find the repertoire move';if(data.opponent_move)$('feedback').textContent=`${data.opponent_move.san} — Maia has replied. ${data.feedback}`}}catch(error){$('prompt').textContent='Something went wrong';$('feedback').textContent=error.message}finally{clearDragArtifacts();pendingDragFrom=null;busy=false;$('thinking').classList.add('hidden');render()}}
function scoreText(evaluation){if(evaluation.type==='mate')return evaluation.value>0?`White mates in ${evaluation.value}`:`Black mates in ${Math.abs(evaluation.value)}`;const pawns=evaluation.value/100;return `${pawns>=0?'+':''}${pawns.toFixed(2)}`}
function showFinish(analysis){const line=analysis.lines[0];$('finish').classList.remove('hidden');$('evaluation').textContent=scoreText(line.evaluation);$('depth').textContent=`Depth ${analysis.depth} · positive favors White`;$('principalVariation').textContent=line.pv?`Best continuation: ${line.pv}`:'';$('finish').scrollIntoView({behavior:'smooth',block:'nearest'})}
async function start(){moves=[];selected=null;complete=false;$('finish').classList.add('hidden');$('prompt').textContent='Find the repertoire move';$('feedback').textContent='Start the Portsmouth Gambit as White.';state=await api('/api/state',{moves:[]});render();renderHistory()}
$('flip').onclick=()=>{flipped=!flipped;render()};$('restart').onclick=start;$('opponentRating').oninput=event=>$('opponentRatingOut').value=event.target.value;start();
