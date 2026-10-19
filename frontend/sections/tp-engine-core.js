(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.OrderFlowTPEngineCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const VERSION='1.0.0-deterministic';
  const DEFAULT_WEIGHTS={liquidity:1.15,volume:1.0,poc:0.9,imbalance:1.1,absorption:1.0,activity:0.9,vwap:0.85,structure:1.05,volatility:1.0};
  const n=v=>Number.isFinite(Number(v))?Number(v):0;
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
  const sum=(a,f=x=>x)=>a.reduce((s,x)=>s+n(f(x)),0);
  const q=(a,p)=>{const x=a.map(n).sort((u,v)=>u-v);if(!x.length)return 0;return x[Math.min(x.length-1,Math.max(0,Math.round((x.length-1)*p)))];};
  const norm=(v,a)=>{const lo=q(a,.1),hi=q(a,.9);return hi>lo?clamp((n(v)-lo)/(hi-lo)):n(v)>0?0.5:0;};
  const roundTick=(v,t)=>Math.round(v/t)*t;
  function atr(bars,period=14){const a=bars.slice(-period);if(!a.length)return 0;return sum(a,(b,i)=>Math.max(n(b.high)-n(b.low),Math.abs(n(b.high)-n((a[i-1]||b).close)),Math.abs(n(b.low)-n((a[i-1]||b).close))))/a.length;}
  function rowMetrics(row){
    const bid=n(row.bid||row.bSize),ask=n(row.ask||row.aSize),vol=n(row.trdVol||row.volume||row.vol),delta=n(row.delta)||(ask-bid);
    const hit=n(row.hitTrdVol)+n(row.hitBid)+n(row.hitAsk),lift=n(row.liftTrdVol)+n(row.liftBid)+n(row.liftAsk);
    const rt=n(row.hitRTL)+n(row.liftRTL)+n(row.rtlX),seq=n(row.hitSEQ)+n(row.liftSEQ)+n(row.seqNumDiff),orders=n(row.numOrders)+n(row.numBid)+n(row.numAsk)+n(row.trdCnt);
    const ratio=Math.max(bid,ask)/Math.max(1,Math.min(bid,ask));
    return {bid,ask,vol,delta,liquidity:bid+ask,imbUp:ask>bid&&ratio>=2.5?1:0,imbDown:bid>ask&&ratio>=2.5?1:0,absorption:ratio>=4&&Math.max(bid,ask)>=20?Math.min(bid,ask):0,activity:hit+lift+rt+seq+orders};
  }
  function autoDirection(bars){const b=bars[bars.length-1]||{},fp=b.footprint||[];let s=n(b.delta);fp.forEach(r=>{const m=rowMetrics(r);s+=(m.imbUp-m.imbDown)*Math.max(1,m.vol);});s+=(n(b.close)-n(b.avgVwap))*Math.max(1,n(b.totalVol));return s>=0?'LONG':'SHORT';}
  function evaluate(input){
    const bars=(input.bars||[]).filter(Boolean),bar=input.bar||bars[bars.length-1];
    if(!bar) return null;
    const direction=(input.direction&&input.direction!=='AUTO'?input.direction:autoDirection(bars)).toUpperCase(),sign=direction==='SHORT'?-1:1;
    const tick=Math.max(.000001,n(input.tickSize)||n(typeof globalThis!=='undefined'&&globalThis.CFG&&globalThis.CFG.tickSize)||.1),entry=n(input.entry)||n(bar.close),a=Math.max(tick*4,atr(bars));
    const recent=bars.slice(-30),allRows=recent.flatMap(b=>b.footprint||[]),metrics=allRows.map(rowMetrics);
    const arrays={liquidity:metrics.map(x=>x.liquidity),volume:metrics.map(x=>x.vol),absorption:metrics.map(x=>x.absorption),activity:metrics.map(x=>x.activity)};
    const sessionHi=Math.max(...recent.map(b=>n(b.high)).filter(Boolean),entry),sessionLo=Math.min(...recent.map(b=>n(b.low)).filter(Boolean),entry);
    const candidates=[];
    allRows.forEach(r=>{const p=n(r.price);if(sign*(p-entry)>tick*.5)candidates.push({price:p,row:r});});
    recent.forEach(b=>[b.pocPrice,b.vah,b.val,b.high,b.low,b.avgVwap].forEach(p=>{p=n(p);if(sign*(p-entry)>tick*.5)candidates.push({price:p,row:null});}));
    [.45,.7,1,1.25,1.6,2,2.6].forEach(k=>candidates.push({price:roundTick(entry+sign*a*k,tick),row:null}));
    const uniq=new Map();candidates.forEach(c=>uniq.set(roundTick(c.price,tick).toFixed(8),c));
    const weights=Object.assign({},DEFAULT_WEIGHTS,input.weights||{}),wSum=sum(Object.values(weights));
    const scored=[...uniq.values()].map(c=>{
      const near=allRows.filter(r=>Math.abs(n(r.price)-c.price)<=tick*.51),mm=near.map(rowMetrics),m={liquidity:sum(mm,x=>x.liquidity),vol:sum(mm,x=>x.vol),absorption:sum(mm,x=>x.absorption),activity:sum(mm,x=>x.activity),imbUp:sum(mm,x=>x.imbUp),imbDown:sum(mm,x=>x.imbDown)};
      const d=Math.abs(c.price-entry),reach=Math.exp(-d/(a*2.2));
      const comps={
        liquidity:norm(m.liquidity,arrays.liquidity),volume:norm(m.vol,arrays.volume),
        poc:clamp(Math.max(...recent.map(b=>1-Math.abs(c.price-n(b.pocPrice))/(a*1.2)),0)),
        imbalance:clamp(.5+(sign*(m.imbUp-m.imbDown))/Math.max(2,m.imbUp+m.imbDown)),
        absorption:norm(m.absorption,arrays.absorption),activity:norm(m.activity,arrays.activity),
        vwap:clamp(1-Math.min(...recent.map(b=>Math.abs(c.price-n(b.avgVwap))).filter(Number.isFinite),a*2)/(a*1.5)),
        structure:clamp(Math.max(1-Math.abs(c.price-sessionHi)/a,1-Math.abs(c.price-sessionLo)/a)),volatility:reach
      };
      const raw=sum(Object.keys(weights),k=>weights[k]*comps[k])/wSum;
      return {price:roundTick(c.price,tick),distance:d,ticks:Math.round(d/tick),score:Math.round(100*clamp(raw)),components:comps};
    }).sort((x,y)=>x.distance-y.distance);
    function pick(lo,hi,after){let pool=scored.filter(x=>x.distance>=a*lo&&x.distance<=a*hi&&(!after||x.price*sign>after.price*sign+tick*.5));if(!pool.length)pool=scored.filter(x=>(!after||x.price*sign>after.price*sign+tick*.5));return pool.sort((x,y)=>(y.score+.08*y.components.volatility*100)-(x.score+.08*x.components.volatility*100))[0]||null;}
    const t1=pick(.25,.85),t2=pick(.75,1.65,t1),t3=pick(1.35,3.0,t2);
    const targets=[t1,t2,t3].map((t,i)=>{if(!t)return null;const top=Object.entries(t.components).sort((a,b)=>b[1]-a[1]).slice(0,3).map(x=>x[0]);return Object.assign(t,{name:'TP'+(i+1),confidenceScore:Math.round(clamp(t.score*(1-i*.08),1,99)),reason:top.join(' + ')});});
    for(let i=1;i<targets.length;i++)if(targets[i]&&targets[i-1])targets[i].confidenceScore=Math.min(targets[i].confidenceScore,Math.max(1,targets[i-1].confidenceScore-1));
    const currentScore=Math.round(sum(targets.filter(Boolean),x=>x.score)/Math.max(1,targets.filter(Boolean).length));
    const invalidation=roundTick(direction==='LONG'?Math.min(sessionLo,entry-a):Math.max(sessionHi,entry+a),tick);
    return {engineVersion:VERSION,model:'deterministic',calibrated:false,confidenceLabel:'deterministic confidence score',source:input.source||'',timestamp:bar.time||bar.timestamp||new Date().toISOString(),direction,entry,tickSize:tick,atr:a,currentScore,expectedReward:targets.filter(Boolean).reduce((s,t)=>s+t.distance*t.confidenceScore/100,0),invalidation,targets,weights};
  }
  function exportRow(r){const o={TP_Engine:r.engineVersion,TP_Calibrated:0,TP_Direction:r.direction,TP_Entry:r.entry,TP_Score:r.currentScore,TP_Expected_Reward:r.expectedReward,TP_Invalidation:r.invalidation};(r.targets||[]).forEach((t,i)=>{const k='TP'+(i+1);o[k]=t&&t.price;o[k+'_Confidence_Score']=t&&t.confidenceScore;o[k+'_Distance']=t&&t.distance;o[k+'_Ticks']=t&&t.ticks;o[k+'_Reason']=t&&t.reason;});return o;}
  return {VERSION,DEFAULT_WEIGHTS,evaluate,exportRow,atr,autoDirection};
});
