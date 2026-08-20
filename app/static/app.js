const pieceAsset={K:'white-king',Q:'white-queen',R:'white-rook',B:'white-bishop',N:'white-knight',P:'white-pawn',k:'black-king',q:'black-queen',r:'black-rook',b:'black-bishop',n:'black-knight',p:'black-pawn'};
const pieceName={K:'white king',Q:'white queen',R:'white rook',B:'white bishop',N:'white knight',P:'white pawn',k:'black king',q:'black queen',r:'black rook',b:'black bishop',n:'black knight',p:'black pawn'};
let root,newId,current,state=null,headers={},flipped=false,selected=null,busy=false,analysisQueued=false,analysisToken=0;
const $=id=>document.getElementById(id);

function freshTree(){root={id:0,parent:null,children:[]};current=root;newId=1;headers={}}
freshTree();
async function api(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.detail||'Request failed');return data}
function pathTo(node){const path=[];while(node&&node!==root){path.push(node);node=node.parent}return path.reverse()}
function request(){return{moves:pathTo(current).map(node=>node.uci)}}
function pieces(fen){const out={};fen.split(' ')[0].split('/').forEach((row,ri)=>{let fi=0;for(const c of row){if(/\d/.test(c))fi+=+c;else{out['abcdefgh'[fi]+(8-ri)]=c;fi++}}});return out}

function render(){
  if(!state)return;
  const board=$('board'),map=pieces(state.fen),files=flipped?'hgfedcba':'abcdefgh',ranks=flipped?'12345678':'87654321';
  board.innerHTML='';
  for(const rank of ranks)for(const file of files){
    const sq=file+rank,b=document.createElement('button'),legal=state.legal_moves.filter(m=>m.from===selected&&m.to===sq),piece=map[sq];
    b.className=`square ${(files.indexOf(file)+ranks.indexOf(rank))%2?'dark':'light'}${selected===sq?' selected':''}${legal.length?piece?' capture':' target':''}`;
    b.dataset.square=sq;b.setAttribute('aria-label',`${sq}${piece?' '+pieceName[piece]:''}`);
    b.innerHTML=`${piece?`<img class="piece" src="/static/pieces/${pieceAsset[piece]}.svg" alt="" draggable="false">`:''}${file===files[0]?`<span class="coord rank">${rank}</span>`:''}${rank===ranks[7]?`<span class="coord file">${file}</span>`:''}`;
    b.onclick=()=>clickSquare(sq,map);board.append(b);
  }
  $('start').disabled=current===root;$('back').disabled=current===root;$('forward').disabled=!nextNode();$('end').disabled=!nextNode();renderHistory();
}

function moveLabel(node){const number=Math.ceil(node.ply/2);return node.ply%2?`${number}. ${node.san}`:`${number}… ${node.san}`}
function moveButton(node){const b=document.createElement('button');b.className=`move-chip${node===current?' current':''}`;b.textContent=moveLabel(node);b.onclick=()=>navigate(node);return b}
function appendFrom(parent,container){
  if(!parent.children.length)return;
  const primary=parent.children[0];container.append(moveButton(primary));
  for(const alternate of parent.children.slice(1)){
    const variation=document.createElement('span');variation.className='variation';variation.append('(');appendBranch(alternate,variation);variation.append(')');container.append(variation);
  }
  appendFrom(primary,container);
}
function appendBranch(node,container){container.append(moveButton(node));if(node.children.length){appendFrom(node,container)}}
function renderHistory(){
  const history=$('history');history.innerHTML='';
  const start=document.createElement('button');start.className=`move-chip start${current===root?' current':''}`;start.textContent='Start';start.onclick=()=>navigate(root);history.append(start);appendFrom(root,history);
}
function rememberPath(node){while(node&&node.parent){node.parent.preferred=node;node=node.parent}}
function nextNode(){return current.preferred||current.children[0]||null}
function endNode(){let node=current,next;while((next=node.preferred||node.children[0]||null))node=next;return node}
async function navigate(node){rememberPath(node);current=node;selected=null;renderHistory();await analyze()}

async function refresh(){try{state=await api('/api/state',request());$('error').textContent='';render()}catch(e){$('error').textContent=e.message}}
function addMove(uci,san){let node=current.children.find(child=>child.uci===uci);if(!node){node={id:newId++,parent:current,children:[],uci,san,ply:pathTo(current).length+1};current.children.push(node)}current.preferred=node;current=node}
async function playMove(uci,san){addMove(uci,san);selected=null;renderHistory();await analyze()}
async function clickSquare(sq,map){
  if(busy)return;const choices=selected?state.legal_moves.filter(m=>m.from===selected&&m.to===sq):[];
  if(choices.length){let move=choices[0];if(choices.length>1){const p=(prompt('Promote to queen, rook, bishop, or knight','queen')||'queen')[0].toLowerCase();move=choices.find(m=>m.uci.endsWith({q:'q',r:'r',b:'b',k:'n',n:'n'}[p]))||choices[0]}await playMove(move.uci,move.san);return}
  if(map[sq]&&state.legal_moves.some(m=>m.from===sq)){selected=sq;render()}else{selected=null;render()}
}
async function analyze(){
  if(state?.game_over)return;
  if(busy){analysisQueued=true;return}
  const token=++analysisToken;busy=true;$('suggestions').innerHTML='<p class="empty">Maia is considering the position…</p>';$('stockfish').innerHTML='<p class="empty">Analyzing position…</p>';
  try{const maiaTask=api('/api/predict',{...request(),rating:+$('rating').value,opponent_rating:+$('opponent').value}).then(data=>{if(token!==analysisToken)return;state=data;render();showSuggestions(data.suggestions);$('context').textContent=`${$('rating').value} vs ${$('opponent').value}`;$('error').textContent=''},e=>{if(token===analysisToken){$('suggestions').innerHTML='<p class="empty">Prediction unavailable.</p>';$('error').textContent=e.message}});const stockfishTask=api('/api/stockfish',request()).then(data=>{if(token===analysisToken)showStockfish(data)},()=>{if(token===analysisToken)$('stockfish').innerHTML='<p class="empty">Engine analysis unavailable.</p>'});await Promise.allSettled([maiaTask,stockfishTask])}finally{busy=false;if(analysisQueued){analysisQueued=false;analyze()}}
}
function showSuggestions(items){$('suggestions').innerHTML='';items.forEach((m,i)=>{const b=document.createElement('button');b.className='suggestion';b.innerHTML=`<span>${i+1}</span><span><b>${m.san}</b><div class="bar"><div class="fill" style="width:${m.probability*100}%"></div></div></span><em>${(m.probability*100).toFixed(1)}%</em>`;b.onclick=()=>playMove(m.uci,m.san);$('suggestions').append(b)})}
function scoreText(e){if(e.type==='mate')return e.value>0?`M${e.value}`:`−M${Math.abs(e.value)}`;const pawns=e.value/100;return `${pawns>=0?'+':''}${pawns.toFixed(2)}`}
function showStockfish(data){$('stockfishDepth').textContent=`Depth ${data.depth} · + White`;$('stockfish').innerHTML='';data.lines.forEach((line,i)=>{const b=document.createElement('button');b.className='engine-line';b.innerHTML=`<span class="engine-rank">${i+1}</span><strong>${line.san}</strong><em>${scoreText(line.evaluation)}</em><small>${line.pv}</small>`;b.onclick=()=>playMove(line.uci,line.san);$('stockfish').append(b)})}

function hydrateTree(items){freshTree();const nodes=new Map();for(const item of items){nodes.set(item.id,{...item,parent:null,children:[]});newId=Math.max(newId,item.id+1)}for(const item of items){const node=nodes.get(item.id),parent=item.parent_id===null?root:nodes.get(item.parent_id);node.parent=parent;parent.children.push(node)}current=root;while(current.children.length){current.preferred=current.children[0];current=current.children[0]}}
$('loadPgn').onclick=async()=>{try{const data=await api('/api/parse-pgn',{pgn:$('pgn').value.trim()});hydrateTree(data.nodes);headers=data.headers;selected=null;renderHistory();await analyze();$('error').textContent=''}catch(e){$('error').textContent=e.message}};
$('start').onclick=()=>navigate(root);$('back').onclick=()=>navigate(current.parent||root);$('forward').onclick=()=>{const node=nextNode();if(node)navigate(node)};$('end').onclick=()=>navigate(endNode());$('flip').onclick=()=>{flipped=!flipped;render()};
$('rating').oninput=e=>$('ratingOut').value=e.target.value;$('opponent').oninput=e=>$('opponentOut').value=e.target.value;
$('rating').onchange=analyze;$('opponent').onchange=analyze;
document.addEventListener('keydown',e=>{if(e.metaKey||e.ctrlKey||e.altKey||e.target.matches('input,textarea,select')||e.target.isContentEditable)return;const action={ArrowLeft:()=>navigate(current.parent||root),ArrowRight:()=>{const node=nextNode();if(node)navigate(node)},ArrowUp:()=>navigate(root),ArrowDown:()=>navigate(endNode())}[e.key];if(action){e.preventDefault();action()}});
analyze();
