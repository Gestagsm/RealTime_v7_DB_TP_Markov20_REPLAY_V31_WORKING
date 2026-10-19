
const S={bars:[],signals:[],sessions:[],mode:"history",theme:"graphite",source:null,sourceRowsRef:null,lastSigFingerprint:"",lastRowCount:-1,lastLastMs:0};
const $=id=>document.getElementById(id);

function n(v,d=0){v=Number(v);return Number.isFinite(v)?v:d}
function first(obj,names){
  if(!obj)return undefined;
  for(const k of names){ if(obj[k]!==undefined && obj[k]!==null && obj[k]!=="") return obj[k]; }
  const keys=Object.keys(obj), lower={};keys.forEach(k=>lower[k.toLowerCase().trim()]=k);
  for(const k of names){let q=lower[String(k).toLowerCase().trim()];if(q!==undefined)return obj[q]}
}
function rowMs(r){
  let v=first(r,["_tsMs","tsMs","timestampMs","timeMs"]);
  if(Number.isFinite(Number(v))&&Number(v)>0)return Number(v);
  v=first(r,["Timestamp","TIMESTAMP","Date_Time","DATETIME","DATE_TIME","date","Date","time","Time"]);
  if(v instanceof Date)return +v;
  let d=new Date(v);return isNaN(+d)?0:+d
}
function priceOf(r){return n(first(r,["last","Last","TRDPRC_1","Close","CLOSE","Price","Trade Price","VWAP","bid","BID","CF BID"]),0)}
function volOf(r){return n(first(r,["trdVol","TRDVOL_1","Volume","VOLUME","CF VOLUME","ELIGBL TRD ACVOL"]),0)}
function sourceLabel(id){return({"pro-single-display":"Pro · Single Display","taq-pro":"TAQ Pro","tas-regime":"TAS Regime AutoFix"})[id]||id}

function findSource(){
  if(!window.parent || window.parent===window)return null;
  try{
    const w=window.parent;
    if(typeof w.getV86PriceSummaryDataset==="function"){
      const data=w.getV86PriceSummaryDataset();
      if(data && Array.isArray(data.bars) && data.bars.length){
        let id="orderflow-module";
        try{const path=String(w.location.pathname||"");if(path.includes("pro-single-display"))id="pro-single-display";else if(path.includes("taq-pro"))id="taq-pro";else if(path.includes("tas-regime"))id="tas-regime";}catch(e){}
        return {id,w,rows:[],priceSummary:data,score:1e20};
      }
    }
  }catch(e){console.warn("[V8.6] Price Summary API unavailable",e)}
  return null;
}

function currentSourceRows(src){
  const w=src.w;
  try{
    if(w._dtActive && Array.isArray(w._dtFilteredRows) && w._dtFilteredRows.length)return w._dtFilteredRows;
  }catch(e){}
  try{
    if(typeof w._ofManualVisibleRows==="function"){
      const a=w._ofManualVisibleRows(); if(Array.isArray(a)&&a.length)return a;
    }
  }catch(e){}
  return src.rows;
}

function sourceInterval(src){
  try{
    const v=Number(src.w.CFG&&src.w.CFG.intervalSec);
    if(Number.isFinite(v)&&v>0)return v;
  }catch(e){}
  return Number($("timeframe").value||1)*60;
}

function bucketRows(rows,sec,src){
  // Prefer the exact OrderFlow bar builder used by the loaded source.
  try{
    if(src && typeof src.w._bucketByInterval==="function"){
      const raw=src.w._bucketByInterval(rows,sec)||[];
      if(raw.length){
        return raw.map((b,i)=>({
          t:new Date(n(b.startMs||b.tsMs||b.timeMs||rowMs((b.ticks||b.rows||[])[0]),Date.now()+i*sec*1000)),
          o:n(b.open,b.close||0),h:n(b.high,b.close||0),l:n(b.low,b.close||0),c:n(b.close,b.open||0),
          v:n(b.totalVol||b.volume||b.trdVol||b.buyVol+b.sellVol,0),
          session:sessionOfBar(b)
        })).filter(b=>b.c>0)
      }
    }
  }catch(e){console.warn("[RL V8.6] source bucket failed",e)}

  let map=new Map();
  for(const r of rows){
    let ms=rowMs(r),p=priceOf(r); if(!ms||!p)continue;
    let k=Math.floor(ms/(sec*1000))*sec*1000,b=map.get(k),v=volOf(r);
    if(!b){b={t:new Date(k),o:p,h:p,l:p,c:p,v:0,session:new Date(ms).toISOString().slice(0,10)};map.set(k,b)}
    b.h=Math.max(b.h,p);b.l=Math.min(b.l,p);b.c=p;b.v+=v;
  }
  return [...map.values()].sort((a,b)=>+a.t-+b.t)
}
function sessionOfBar(b){
  try{
    const r=(b.ticks||b.rows||[])[0];
    let s=first(r,["SOURCE_DATE","source_date","Date","DATE"]);
    if(s)return String(s).slice(0,10)
  }catch(e){}
  let ms=n(b.startMs||b.tsMs,0);return ms?new Date(ms).toISOString().slice(0,10):"Session"
}

function normalizeSignal(v){
  let s=String(v||"").trim().toUpperCase().replace(/[\s\-]+/g,"_");
  if(["BUY","LONG","BUY_ENTRY","LONG_ENTRY"].includes(s))return"BUY_ENTRY";
  if(["BUY_EXIT","LONG_EXIT","EXIT_BUY","CLOSE_LONG"].includes(s))return"BUY_EXIT";
  if(["SELL","SHORT","SELL_ENTRY","SHORT_ENTRY"].includes(s))return"SELL_ENTRY";
  if(["SELL_EXIT","SHORT_EXIT","EXIT_SELL","CLOSE_SHORT"].includes(s))return"SELL_EXIT";
  return null
}
function signalsFromRows(rows,bars){
  const sigs=[];
  if(!bars.length)return sigs;
  const times=bars.map(b=>+b.t);
  function nearest(ms){
    let lo=0,hi=times.length-1;
    while(lo<hi){let m=(lo+hi+1)>>1;if(times[m]<=ms)lo=m;else hi=m-1}
    return lo
  }
  for(const r of rows){
    const raw=first(r,["Signal","SIGNAL","Action","ACTION","Action_Name","ACTION_NAME","Marker","MARKER","marker","Teacher_Action","teacher_action","MANUAL_MARKER"]);
    const typ=normalizeSignal(raw); if(!typ)continue;
    let ms=rowMs(r);if(!ms)continue;let i=nearest(ms);
    sigs.push({i,type:typ,price:priceOf(r)||bars[i].c,prob:n(first(r,["Probability","PROBABILITY","Prob","prob","policy_probability","confidence"]),0),regime:String(first(r,["Regime","REGIME","regime"])||""),t:new Date(ms)})
  }
  // de-duplicate same action on same candle
  const seen=new Set();return sigs.filter(s=>{let k=s.i+"|"+s.type;if(seen.has(k))return false;seen.add(k);return true})
}

function buildSessions(){
  const m={};S.bars.forEach((b,i)=>{let k=b.session||b.t.toISOString().slice(0,10);(m[k]??=[]).push(i)});
  S.sessions=Object.entries(m).map(([id,ids])=>{
    const sig=S.signals.filter(s=>ids.includes(s.i));
    let ret=S.bars[ids.at(-1)].c/S.bars[ids[0]].c-1;
    return{id,ids,ret,pf:0,dd:0,trades:sig.length}
  });
  $("sessionFilter").innerHTML='<option value="all">All Sessions ('+S.sessions.length+')</option>'+S.sessions.map(x=>`<option>${x.id}</option>`).join("")
}
function syncCurrentData(force=false){
  const src=findSource();
  if(!src){
    $("sourceTab").textContent="Waiting for full Price Summary history…";$("fileName").textContent="Load a file in this module. V8 Agent will read the complete Price Summary history automatically.";$("sourceDot").className="sourceDot";$("conn").textContent="NO DATA";$("conn").className="chip warn";return false
  }
  const d=src.priceSummary;
  const last=(d.bars&&d.bars.length)?d.bars[d.bars.length-1]:null;
  const fp=[d.rowCount,d.intervalSec,d.bars.length,last?last.t:""].join("|");
  if(!force && S._psFp===fp)return true;
  S._psFp=fp;S.source=src;
  S.bars=(d.bars||[]).map(b=>({...b,t:new Date(b.t)}));
  S.signals=(d.signals||[]).map(x=>({...x,t:new Date(x.t)}));
  buildSessions();
  $("timeframe").value=String(Math.max(1,Math.round(Number(d.intervalSec||60)/60)));
  $("sourceTab").textContent=sourceLabel(src.id)+" · Price Summary";
  $("fileName").textContent=(d.file?d.file+" · ":"")+Number(d.rowCount||0).toLocaleString()+" full-history Price Summary ticks";
  $("linkedRows").textContent=Number(d.rowCount||0).toLocaleString();$("linkedBars").textContent=S.bars.length.toLocaleString();
  $("linkedLast").textContent=last?new Date(last.t).toLocaleString():"—";
  $("sourceDot").className="sourceDot on";$("conn").textContent="PRICE SUMMARY LINKED";$("conn").className="chip connected";
  refresh();return true
}
function filtered(){let sess=$("sessionFilter").value,indices=S.bars.map((_,i)=>i);if(sess!=="all"){let q=S.sessions.find(s=>s.id===sess);indices=q?q.ids:[]}return indices}
function forecast(bars){
  if(!bars.length)return null;let n0=Math.min(35,bars.length),a=bars.slice(-n0),x=a.map((_,i)=>i),y=a.map(b=>b.c),xm=x.reduce((s,v)=>s+v,0)/n0,ym=y.reduce((s,v)=>s+v,0)/n0,num=0,den=0;for(let i=0;i<n0;i++){num+=(x[i]-xm)*(y[i]-ym);den+=(x[i]-xm)**2}let slope=num/(den||1),h=+$("horizon").value,last=y.at(-1),target=last+slope*h,vol=Math.sqrt(a.reduce((s,b)=>s+(b.c-ym)**2,0)/n0);return{last,target,upper:target+vol*.8,lower:target-vol*.8,dir:target>=last?"UP":"DOWN",conf:Math.min(.82,.5+Math.abs(target-last)/(vol*5||1))}
}
function arrow(g,x,y,up,col){g.fillStyle=col;g.beginPath();if(up){g.moveTo(x,y-10);g.lineTo(x-6,y-2);g.lineTo(x-2,y-2);g.lineTo(x-2,y+8);g.lineTo(x+2,y+8);g.lineTo(x+2,y-2);g.lineTo(x+6,y-2)}else{g.moveTo(x,y+10);g.lineTo(x-6,y+2);g.lineTo(x-2,y+2);g.lineTo(x-2,y-8);g.lineTo(x+2,y-8);g.lineTo(x+2,y+2);g.lineTo(x+6,y+2)}g.closePath();g.fill()}
function draw(){
  let cv=$("chart"),r=cv.getBoundingClientRect(),dpr=devicePixelRatio||1;cv.width=r.width*dpr;cv.height=r.height*dpr;let g=cv.getContext("2d");g.scale(dpr,dpr);let W=r.width,H=r.height;g.clearRect(0,0,W,H);let ids=filtered(),bars=ids.map(i=>S.bars[i]);
  if(!bars.length){g.fillStyle="#8b969d";g.font="16px Segoe UI";g.fillText("Load data in an OrderFlow tab — this RL agent will link automatically.",50,80);return}
  let left=52,right=58,top=12,volH=$("showVolume").checked?55:0,indH=$("showIndicators").checked?90:0,bottom=26,plotH=Math.max(120,H-top-bottom-volH-indH),forecastN=$("showForecast").checked?+$("horizon").value:0;
  let lo=Math.min(...bars.map(b=>b.l)),hi=Math.max(...bars.map(b=>b.h)),pad=Math.max((hi-lo)*.08,.1);lo-=pad;hi+=pad;let xStep=(W-left-right)/(bars.length+forecastN),X=i=>left+(i+.5)*xStep,Y=p=>top+(hi-p)/(hi-lo)*plotH;
  g.strokeStyle=getComputedStyle(document.body).getPropertyValue("--line");g.lineWidth=.6;g.fillStyle="#aeb8be";g.font="10px Segoe UI";
  for(let j=0;j<6;j++){let y=top+j*plotH/5,p=hi-j*(hi-lo)/5;g.beginPath();g.moveTo(left,y);g.lineTo(W-right,y);g.stroke();g.fillText(p.toFixed(1),W-right+5,y+3)}
  bars.forEach((b,k)=>{let up=b.c>=b.o,col=up?"#24c874":"#e74b3c",x=X(k);g.strokeStyle=col;g.beginPath();g.moveTo(x,Y(b.h));g.lineTo(x,Y(b.l));g.stroke();let y1=Y(Math.max(b.o,b.c)),y2=Y(Math.min(b.o,b.c));g.fillStyle=col;g.fillRect(x-Math.max(1,xStep*.3),y1,Math.max(2,xStep*.6),Math.max(1,y2-y1))});
  if($("showSignals").checked){let enabled={};document.querySelectorAll("[data-sig]").forEach(x=>enabled[x.dataset.sig]=x.checked);let idmap=new Map(ids.map((id,k)=>[id,k]));S.signals.forEach(s=>{if(!enabled[s.type]||!idmap.has(s.i))return;let k=idmap.get(s.i),b=S.bars[s.i],x=X(k),up=s.type==="BUY_ENTRY"||s.type==="SELL_EXIT",col=up?"#2fd651":"#ff493b",y=up?Y(b.l)-12:Y(b.h)+12;arrow(g,x,y,up,col)})}
  let fc=forecast(bars);if(fc&&forecastN){let start=X(bars.length-.5),end=X(bars.length+forecastN-.5);g.fillStyle="rgba(30,125,225,.13)";g.fillRect(start,top,end-start,plotH);g.setLineDash([5,4]);g.strokeStyle="#b5d9ff";g.beginPath();g.moveTo(start,Y(fc.last));g.lineTo(end,Y(fc.target));g.stroke();g.setLineDash([]);$("fTarget").textContent=fc.target.toFixed(1);$("fUpper").textContent=fc.upper.toFixed(1);$("fLower").textContent=fc.lower.toFixed(1);$("fDir").textContent=fc.dir;$("fDir").className=fc.dir==="UP"?"pos":"neg";$("fConf").textContent=fc.conf.toFixed(2)}
  if(volH){let y0=top+plotH+8,maxV=Math.max(...bars.map(b=>b.v),1);bars.forEach((b,k)=>{g.fillStyle=b.c>=b.o?"#237b51":"#853b35";let h=b.v/maxV*(volH-12);g.fillRect(X(k)-xStep*.28,y0+volH-h,xStep*.56,h)});g.fillStyle="#c8d0d4";g.fillText("Volume",left,y0+10)}
  if(indH){let y0=top+plotH+volH+7;g.strokeStyle="#a060ff";g.beginPath();bars.forEach((b,k)=>{let q=50+30*Math.sin(k/13)+10*Math.sin(k/4.8),y=y0+(80-q)/80*(indH-18);k?g.lineTo(X(k),y):g.moveTo(X(k),y)});g.stroke();g.fillStyle="#c8d0d4";g.fillText("RSI / V8.6 Agent Panel",left,y0+10)}
}
function drawEquity(){
  let cv=$("equity"),r=cv.getBoundingClientRect(),dpr=devicePixelRatio||1;cv.width=r.width*dpr;cv.height=r.height*dpr;let g=cv.getContext("2d");g.scale(dpr,dpr),W=r.width,H=r.height;g.clearRect(0,0,W,H);
  if(!S.bars.length)return;let vals=[10000],eq=10000;for(let i=1;i<S.bars.length;i++){let ret=S.bars[i].c/S.bars[i-1].c-1;eq*=1+ret;vals.push(eq)}let lo=Math.min(...vals),hi=Math.max(...vals),X=i=>8+i/(vals.length-1||1)*(W-18),Y=v=>8+(hi-v)/(hi-lo||1)*(H-18);g.strokeStyle="#2d9dff";g.lineWidth=2;g.beginPath();vals.forEach((v,i)=>i?g.lineTo(X(i),Y(v)):g.moveTo(X(i),Y(v)));g.stroke()
}
function refresh(){
  draw();drawEquity();let counts=t=>S.signals.filter(s=>s.type===t).length;$("nBuy").textContent=counts("BUY_ENTRY");$("nBuyExit").textContent=counts("BUY_EXIT");$("nSell").textContent=counts("SELL_ENTRY");$("nSellExit").textContent=counts("SELL_EXIT");
  let last=S.signals.at(-1);if(last){$("lastSignal").textContent=last.type.replace("_"," ");$("lastSignal").className=(last.type==="BUY_ENTRY"||last.type==="SELL_EXIT")?"pos":"neg";$("lastTime").textContent=last.t.toLocaleString();$("lastPrice").textContent=last.price.toFixed(1);$("lastProb").textContent=last.prob?last.prob.toFixed(3):"—";$("lastRegime").textContent=last.regime||"—"}else{$("lastSignal").textContent="No signal column";$("lastTime").textContent="—";$("lastPrice").textContent="—";$("lastProb").textContent="—";$("lastRegime").textContent="—"}
  $("signalsBody").innerHTML=S.signals.slice(-12).reverse().map(s=>`<tr><td>${s.t.toLocaleTimeString()}</td><td class="${(s.type==="BUY_ENTRY"||s.type==="SELL_EXIT")?"pos":"neg"}">${s.type.replace("_"," ")}</td><td>${s.price.toFixed(1)}</td><td>${s.prob?s.prob.toFixed(3):"—"}</td><td>${s.regime||"—"}</td></tr>`).join("")||'<tr><td colspan="5">No Buy/Sell/Exit marker column detected in current data.</td></tr>';
  $("sessionBody").innerHTML=S.sessions.slice(-9).reverse().map(s=>`<tr><td>${s.id}</td><td class="${s.ret>=0?"pos":"neg"}">${(100*s.ret).toFixed(2)}%</td><td>—</td><td>—</td><td>${s.trades}</td></tr>`).join("")
}
$("syncDataBtn").onclick=()=>syncCurrentData(true);$("syncBtn").onclick=()=>syncCurrentData(true);
$("themeBtn").onclick=()=>{document.body.classList.toggle("theme-blue");document.body.classList.toggle("theme-graphite");refresh()};
$("historyBtn").onclick=()=>{S.mode="history";$("historyBtn").classList.add("on");$("forecastBtn").classList.remove("on");$("statusText").textContent="HISTORY";$("showForecast").checked=false;draw()};
$("forecastBtn").onclick=()=>{S.mode="forecast";$("forecastBtn").classList.add("on");$("historyBtn").classList.remove("on");$("statusText").textContent="FORECAST";$("showForecast").checked=true;draw()};
["sessionFilter","showSignals","showForecast","showVolume","showIndicators"].forEach(id=>$(id).onchange=draw);
$("timeframe").onchange=()=>{ $("footTf").textContent=$("timeframe").value+" MINUTE"; draw(); };
document.querySelectorAll("[data-sig]").forEach(x=>x.onchange=draw);
$("horizon").oninput=()=>{$("horizonOut").textContent=$("horizon").value;$("fHorizon").textContent=$("horizon").value+" bars";draw()};
window.onresize=refresh;
setInterval(()=>syncCurrentData(false),1000);
setTimeout(()=>syncCurrentData(true),300);
