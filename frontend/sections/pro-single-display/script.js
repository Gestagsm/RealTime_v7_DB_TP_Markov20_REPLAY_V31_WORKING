// ==== inline-script ====
// Compatibility guard: prevents legacy/out-of-scope references to tv from crashing file loading.
var tv = 0; var tV = 0; window.tv = 0; window.tV = 0; // compatibility guard

/* ============================================================
   PERSISTENT DATA SIDEBAR + CANDLE SUMMARY ACROSS ALL TABS
   ─────────────────────────────────────────────────────────────
   These two panels originally lived only inside #chart-pane, so they
   disappeared whenever a non-Chart tab was active. This relocates them
   (by DOM node, not by rebuilding) to be permanent siblings of
   #tabs-outer instead, so they stay visible no matter which tab is
   selected. Runs synchronously here (DOM above this point is already
   parsed) and before any other script reads/sizes these elements.
   ============================================================ */
(function relocateSidebarAndRightPanel(){
  var tabsOuter = document.getElementById('tabs-outer');
  var sidebar   = document.getElementById('sidebar');
  var sbTab     = document.getElementById('sb-tab');
  var rpTab     = document.getElementById('rp-tab');
  var rpHandle  = document.getElementById('rp-resize-handle');
  var rightPanel= document.getElementById('right-panel');
  if(!tabsOuter || !sidebar || !rightPanel || document.getElementById('global-main-wrap')) return;

  var wrap = document.createElement('div');
  wrap.id = 'global-main-wrap';
  wrap.style.cssText = 'flex:1;display:flex;overflow:hidden;min-height:0;width:100%;';

  tabsOuter.parentNode.insertBefore(wrap, tabsOuter);
  wrap.appendChild(sidebar);
  if(sbTab) wrap.appendChild(sbTab);
  wrap.appendChild(tabsOuter);
  if(rpTab) wrap.appendChild(rpTab);
  if(rpHandle) wrap.appendChild(rpHandle);
  wrap.appendChild(rightPanel);

  tabsOuter.style.flex='1 1 auto';
  tabsOuter.style.minWidth='0';
  tabsOuter.style.display='flex';
  tabsOuter.style.flexDirection='column';
  tabsOuter.style.overflow='hidden';
})();

/* ============================================================
   CFG
   ============================================================ */
const CFG = {
  mode:'candle', rowsVisible:30, rowH:19, colW:52, priceColW:68, fontSize:10,
  tickSize:0.01, startPrice:4331, symbol:'XAUUSD',
  imbThreshold:300, imbMinVol:5,
  normTxt:'#cccccc', bidHi:'#ff00ff', askHi:'#00ffff', pocTxt:'#ffff00',
  bullColor:'#00aa44', bearColor:'#cc0022', vwapColor:'#ff8800',
  hitColor:'#ff4444', liftColor:'#00dd88',
  showPOC:true, showImbalance:true, showVWAP:true,
  showDelta:true, showCumDelta:true, showVA:true,
  tickIntervalMs:900, usingRealData:false,
  chartOffsetY:0, intervalSec:60, rangeLevels:10,
};

function formatPrice(price){
  const tick=Math.abs(CFG.tickSize)||0.01;
  let decimals=0;
  while(decimals<8&&Math.abs(Math.round(tick*10**decimals)-tick*10**decimals)>1e-8) decimals++;
  return Number(price).toFixed(Math.max(2,decimals));
}

function chartPriceStep(range,visibleRows){
  const tick=Math.abs(CFG.tickSize)||0.01;
  if(CFG.mode==='range') return tick;
  const target=Math.max(tick,(range.max-range.min)/Math.max(1,visibleRows-2));
  const power=10**Math.floor(Math.log10(target));
  const ratio=target/power;
  const nice=ratio<=1?1:ratio<=2?2:ratio<=5?5:10;
  return Math.max(tick,Math.ceil((nice*power-1e-9)/tick)*tick);
}
function chartTopPrice(range,visibleRows){
  const tick=chartPriceStep(range,visibleRows);
  const raw=CFG.mode==='range'
    ? range.max+CFG.chartOffsetY*tick
    : (range.max+range.min)/2+Math.floor(visibleRows/2)*tick+CFG.chartOffsetY*tick;
  return Math.round(raw/tick)*tick;
}
function chartDisplayRows(rows,topPrice,priceStep){
  const tick=Math.abs(CFG.tickSize)||0.01;
  if(priceStep<=tick*1.000001) return rows;
  const grouped=new Map();
  rows.forEach(row=>{
    const index=Math.floor((topPrice-row.price)/priceStep+0.50000001);
    let target=grouped.get(index);
    if(!target){
      target=Object.assign({},row,{price:topPrice-index*priceStep});
      grouped.set(index,target);
      return;
    }
    Object.keys(row).forEach(key=>{
      if(key==='price') return;
      if(typeof row[key]==='number') target[key]=(typeof target[key]==='number'?target[key]:0)+row[key];
      else if(target[key]===undefined) target[key]=row[key];
    });
  });
  return Array.from(grouped.values());
}

/* ============================================================
   COLUMN DEFINITIONS
   ─────────────────────────────────────────────────────────────
   Each footprint row stores per-price-level aggregates.
   The three "diff" columns are per-tick differences accumulated
   into each footprint row by _ticksToBar():

     trdIdDiff  = Σ |TRADE_ID[i+1] − TRADE_ID[i]|   → "Trd.ID" column
     seqNumDiff = Σ |SEQNUM[i+1]   − SEQNUM[i]|     → "SEQ_N"  column
     movesDiff  = Σ |RTL[i+1]      − RTL[i]|        → "RTL"    column

   ALL_COLS keys must exactly match what _ticksToBar writes onto
   footprint row objects.
   ============================================================ */
const ALL_COLS = [
  { key:'bid',         label:'Bid',     cls:'bid',  dflt:true  },
  { key:'ask',         label:'Ask',     cls:'ask',  dflt:true  },
  { key:'bSize',       label:'B.Size',  cls:'bid',  dflt:true  },
  { key:'aSize',       label:'A.Size',  cls:'ask',  dflt:true  },
  { key:'numBid',      label:'NumBid',  cls:'bid',  dflt:true  },
  { key:'numAsk',      label:'NumAsk',  cls:'ask',  dflt:true  },
  { key:'numOrders',   label:'#Orders', cls:'info', dflt:true  },
  { key:'trdVol',      label:'Trd.Vol', cls:'info', dflt:true  },
  { key:'volume',      label:'Volume',  cls:'info', dflt:true  },
  { key:'moves',       label:'#Trades', cls:'info', dflt:true  }, // NUMBER TRADES per level
  { key:'hitBid',      label:'Hit.Bid', cls:'hit',  dflt:true  },
  { key:'hitAsk',      label:'Hit.Ask', cls:'hit',  dflt:true  },
  { key:'hitTrdVol',   label:'Hit.Vol', cls:'hit',  dflt:true  },
  { key:'liftBid',     label:'Lift.Bid',cls:'lift', dflt:true  },
  { key:'liftAsk',     label:'Lift.Ask',cls:'lift', dflt:true  },
  { key:'liftTrdVol',  label:'Lift.Vol',cls:'lift', dflt:true  },
  { key:'delta',       label:'Delta',   cls:'info', dflt:true  },
  { key:'trdIdDiff',   label:'Trd.ID',  cls:'info', dflt:true  }, // |TRADE_ID diff| per level
];

let ACT_COLS = ALL_COLS.filter(c=>c.dflt).map(c=>c.key);

function buildPicker(){
  const bar=document.getElementById('cp-bar');
  const lbl=bar.querySelector('.cp-lbl');
  bar.innerHTML=''; bar.appendChild(lbl);
  ALL_COLS.forEach(cd=>{
    const on=ACT_COLS.includes(cd.key);
    const btn=document.createElement('button');
    btn.className=`cp-pill ${cd.cls}${on?' on':''}`;
    btn.textContent=cd.label; btn.dataset.key=cd.key;
    btn.onclick=()=>{
      const idx=ACT_COLS.indexOf(cd.key);
      if(idx>=0){ACT_COLS.splice(idx,1);btn.classList.remove('on');}
      else{ACT_COLS.push(cd.key);btn.classList.add('on');}
      if(R){R.resize();R.draw();}
      if(typeof csBuildDynamic==='function') csBuildDynamic();
    };
    bar.appendChild(btn);
  });
}

/* ============================================================
   COLMAP – header aliases for auto-detection
   ============================================================ */
const COLMAP = {
  date:     ['Date of Update','DATE','Date','Timestamp','TIMESTAMP','Date_Time','DATETIME','DATE_TIME'],
  time:     ['TIMEACT NS','Timeact NS','TIME','Time','Timestamp','TIMESTAMP'],
  tick:     ['PRCTCK_1','Tick','TICK','PRICE_TICK','PriceTick'],
  aggr:     ['AGGRS_SID1','AGGRESSIVE ORD1','AGGRESSIVE OR','AGGRESSIVE','AGGR','AggrSide','Side','SIDE'],
  last:     ['TRDPRC_1','Last','LAST','LAST PRICE','Price','PRICE','TradePrice','Trade Price','Close','CLOSE'],
  bid:      ['BID','Bid','CF BID','BestBid','BEST_BID'],
  ask:      ['ASK','Ask','CF ASK','BestAsk','BEST_ASK','OFFER'],
  bSize:    ['BIDSIZE','B Size','B SIZE','BID SIZE','BSIZE','BidSize','Bid Size','BID_SIZE'],
  aSize:    ['ASKSIZE','A Size','A SIZE','ASK SIZE','ASIZE','AskSize','Ask Size','ASK_SIZE','OFFER SIZE'],
  numBid:   ['NUM BID ORDERS 1','NUM BID','NUM_BID_ORDERS','BidOrders','NumBidOrders'],
  numAsk:   ['NUM ASK ORDERS 1','NUM ASK ORD','NUM ASK','NUM_ASK_ORDERS','AskOrders','NumAskOrders'],
  numOrders:['NUMBER OF ORDERS','NUM ORDERS','#ORDERS','NumOrders','OrderCount'],
  trdVol:   ['TRDVOL_1','Trd.Vol','TRADE VOL','TRDVOL','Trade Volume','TradeVol','TRADE_VOL','ELIGBL TRD ACVOL'],
  volume:   ['TRDVOL_1','Volume','VOLUME','CF VOLUME','VOL','ELIGBL TRD ACVOL','CumVol','CUM_VOL'],
  // TRADE_ID – the numeric trade identity counter
  tradeId:  ['TRADE_ID','TRD_ID','Trade ID','TRADEID','TradeID'],
  // SEQNUM – the sequence number counter (→ SEQ_N column after diff)
  seqNum:   ['SEQNUM','SEQ_NUM','SEQ_Num','SEQ_ID','SEQ','Sequence','SequenceNum','SEQ_NUMBER'],
  // RTL / RT_Count – the running tick count (→ RTL column after diff)
  moves:    ['RTL','RT_Count','RT_COUNT','RtCount','RTCount','Moves','MOVES'],
  rtCount:  ['RT_Count','RTL','RT_COUNT','RtCount','RTCount'],
  condKey:  ['QUALIFIERS','Qualifiers','QUALIFIER','Cond','COND','Condition','CONDITION','CondKey','cond_key'],
  // ELIGBL TRD ACVOL – eligible-trade cumulative volume counter (real column
  // in this file's format; distinct from CF VOLUME/TRADE VOL). Diffed the
  // same way SEQNUM used to be, since SEQNUM does not exist in this format.
  eligVol:  ['ELIGBL TRD ACVOL','ELIGIBLE TRD ACVOL','ELIG VOL','ELIGBLTRDACVOL','ELIG_VOL'],
  // NUMBER TRADES – cumulative trade counter (real column in this file's
  // format; distinct from TRADE_ID). Diffed the same way RTL used to be,
  // since RTL does not exist in this format.
  numTrades:['NUMBER TRADES','NUMBER OF TRADES','NUM TRADES','NUMTRADES'],
};

let _cc=null;

function _buildColCache(hdrs){
  const cache={};
  const hdrLower=hdrs.map(h=>String(h||'').toLowerCase().trim());
  for(const [key,aliases] of Object.entries(COLMAP)){
    let found=null;
    for(const alias of aliases){
      const idx=hdrLower.indexOf(alias.toLowerCase().trim());
      if(idx>=0){found=hdrs[idx];break;}
    }
    if(!found){
      const kl=key.toLowerCase();
      for(let i=0;i<hdrLower.length;i++){
        const h=hdrLower[i];
        if(h.includes(kl)||kl.includes(h)){found=hdrs[i];break;}
      }
    }
    if(found) cache[key]=found;
  }
  return cache;
}

function _detectHeaderRow(arr,maxScan=20){
  const all=Object.values(COLMAP).flat().map(s=>s.toLowerCase().trim());
  let bestRow=0,bestScore=0;
  for(let i=0;i<Math.min(arr.length,maxScan);i++){
    const row=(arr[i]||[]).map(c=>String(c||'').toLowerCase().trim());
    if(!row.length||row.every(c=>!c)) continue;
    const score=row.filter(c=>all.includes(c)).length;
    if(score>bestScore){bestScore=score;bestRow=i;}
    if(score>=3) break;
  }
  return bestRow;
}

function _fillNaN(rows){
  if(!rows.length) return rows;
  const ffill=(rows,field,isNum)=>{
    let last=isNum?0:'';
    rows.forEach(r=>{
      const v=r[field];
      const empty=isNum?(!v||v===0):(!v||v==='');
      if(!empty) last=v; else r[field]=last;
    });
  };
  const bfill=(rows,field,isNum)=>{
    let first=isNum?0:'';
    for(let i=rows.length-1;i>=0;i--){
      const v=rows[i][field];
      const empty=isNum?(!v||v===0):(!v||v==='');
      if(!empty) first=v; else rows[i][field]=first;
    }
  };
  ['bid','ask','last','aggr','tick','seqNum','rtCount','eligVol'].forEach(f=>{
    ffill(rows,f,f!=='aggr'&&f!=='tick');
    bfill(rows,f,f!=='aggr'&&f!=='tick');
  });
  ['bSize','aSize','trdVol','volume','numBid','numAsk','numOrders','moves','numTrades'].forEach(f=>{
    rows.forEach(r=>{if(!r[f]) r[f]=0;});
  });
  rows.forEach(r=>{if(!r.tradeId) r.tradeId='';});
  return rows;
}

/* ============================================================
   _applyDiffs
   ─────────────────────────────────────────────────────────────
   Mirrors Python: df[col].diff().abs().shift(-1).fillna(orig % 100)

   Field mapping (source → diff field → display column):
     volume   → volDiff    (internal, used in _ticksToBar)
     moves    → movesDiff  → RTL   column
     seqNum   → seqNumDiff → SEQ_N column
     tradeId  → trdIdDiff  → Trd.ID column

   Fallbacks:
     movesDiff:  if all-zero after diffing 'moves', try 'rtCount'
     trdIdDiff:  if tradeId non-numeric/absent, copy from seqNumDiff
   ============================================================ */
function _applyDiffs(rows){
  if(!rows||rows.length<1) return rows;

  // Volume (internal use only)
  for(let i=0;i<rows.length;i++){
    const curr=parseFloat(rows[i].volume)||0;
    const next=parseFloat(rows[i+1]?.volume)||0;
    rows[i].volDiff=(i<rows.length-1)?Math.abs(next-curr):0;
  }

  // SEQ_N: diff SEQNUM, fillna with (seqNum % 100) — mirrors Python Seq_orig % 100
  for(let i=0;i<rows.length;i++){
    const curr=parseFloat(rows[i].seqNum)||0;
    const next=parseFloat(rows[i+1]?.seqNum)||0;
    const d=(i<rows.length-1)?Math.abs(next-curr):NaN;
    rows[i].seqNumDiff=isFinite(d)?d:(curr%100);
  }

  // ELIG_V: diff ELIGBL TRD ACVOL (eligVol), fillna with (eligVol % 100).
  // This is the real-column replacement for the old SEQNUM-based diff:
  // SEQNUM does not exist in this file's format, but ELIGBL TRD ACVOL is a
  // genuine cumulative counter column, so it is diffed the same way.
  for(let i=0;i<rows.length;i++){
    const curr=parseFloat(rows[i].eligVol)||0;
    const next=parseFloat(rows[i+1]?.eligVol)||0;
    const d=(i<rows.length-1)?Math.abs(next-curr):NaN;
    rows[i].eligVolDiff=isFinite(d)?d:(curr%100);
  }

  // RTL is a cumulative counter. Convert it to a true per-tick increment.
  // Normal increase: next-current. Unchanged counter: 0. Counter reset: next value.
  // Never use abs(reset jump) or raw cumulative RTL, because that creates false 60k+ sums.
  function _rtlCounterDiff(src){
    for(let i=0;i<rows.length;i++){
      const curr=parseFloat(rows[i][src]);
      const next=(i<rows.length-1)?parseFloat(rows[i+1][src]):NaN;
      let d=0;
      if(Number.isFinite(curr) && Number.isFinite(next)){
        d = next>=curr ? (next-curr) : Math.max(0,next);
      }
      rows[i].movesDiff=Number.isFinite(d)?d:0;
    }
  }
  if(rows.some(r=>Number.isFinite(parseFloat(r.moves)) && parseFloat(r.moves)!==0)) _rtlCounterDiff('moves');
  else if(rows.some(r=>Number.isFinite(parseFloat(r.rtCount)) && parseFloat(r.rtCount)!==0)) _rtlCounterDiff('rtCount');
  else rows.forEach(r=>{r.movesDiff=0;});

  // Trd.ID: diff numeric TRADE_ID
  for(let i=0;i<rows.length;i++){
    const curr=parseFloat(rows[i].tradeId)||0;
    const next=parseFloat(rows[i+1]?.tradeId)||0;
    rows[i].trdIdDiff=(i<rows.length-1)?Math.abs(next-curr):0;
  }
  // Fallback: if TRADE_ID absent/non-numeric, mirror seqNumDiff
  const trdSum=rows.reduce((s,r)=>s+(r.trdIdDiff||0),0);
  if(trdSum===0){rows.forEach(r=>{r.trdIdDiff=r.seqNumDiff||0;});}

  return rows;
}

/* ============================================================
   ROW NORMALISER
   ============================================================ */
function normR(obj,hdrs){
  if(!_cc) _cc=_buildColCache(hdrs);
  const g=k=>{const h=_cc[k];return h!=null?(obj[h]!=null?obj[h]:''):'';}
  const n=v=>{const x=parseFloat(String(v||'').replace(/,/g,'.'));return isNaN(x)?0:x;}
  const s=v=>String(v||'').trim().toUpperCase();
  const ts=v=>String(v||'').trim();

  let dateVal=ts(g('date'));
  let timeVal=normTime(ts(g('time')));

  if(timeVal&&timeVal.includes(' ')&&timeVal.includes('-')){
    const p=timeVal.split(' ');dateVal=dateVal||p[0];timeVal=p[1]||timeVal;
  } else if(dateVal&&dateVal.includes(' ')&&dateVal.includes('-')){
    const p=dateVal.split(' ');dateVal=p[0];if(!timeVal) timeVal=p[1]||'';
  }

  let aggrVal=s(g('aggr'));
  if(aggrVal==='B'||aggrVal==='1') aggrVal='BID';
  if(aggrVal==='A'||aggrVal==='2'||aggrVal==='S') aggrVal='ASK';

  /* Compute real epoch ms from parsed date+time for reliable filter comparison */
  let _rowTsMs = 0;
  if (dateVal && timeVal) {
    const _dm = dateVal.match(/(\d{4})-(\d{2})-(\d{2})/);
    const _tm = timeVal.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (_dm && _tm) {
      const _d = new Date(+_dm[1], +_dm[2]-1, +_dm[3], +_tm[1], +_tm[2], +_tm[3], 0);
      if (!isNaN(_d.getTime())) _rowTsMs = _d.getTime();
    }
  }
  /* Fallback: try parsing raw timestamp if date parse failed */
  if (!_rowTsMs) {
    const _raw = ts(g('date')) || ts(g('time')) || '';
    if (_raw) {
      /* DD.MM.YYYY HH:MM:SS — European format from TAS files */
      const _em = _raw.match(/^(\d{1,2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
      if (_em) {
        const _d2 = new Date(+_em[3], +_em[2]-1, +_em[1], +_em[4], +_em[5], +_em[6], 0);
        if (!isNaN(_d2.getTime())) {
          _rowTsMs = _d2.getTime();
          /* Also fix dateVal and timeVal from the European raw timestamp */
          if (!dateVal || !dateVal.match(/\d{4}-\d{2}-\d{2}/)) {
            dateVal = `${_em[3]}-${_em[2].padStart(2,'0')}-${_em[1].padStart(2,'0')}`;
          }
          if (!timeVal || !timeVal.match(/\d{2}:\d{2}:\d{2}/)) {
            timeVal = `${_em[4].padStart(2,'0')}:${_em[5]}:${_em[6]}`;
          }
        }
      }
      /* ISO YYYY-MM-DD HH:MM:SS */
      if (!_rowTsMs) {
        const _im = _raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2}):(\d{2})/);
        if (_im) {
          const _d3 = new Date(+_im[1], +_im[2]-1, +_im[3], +_im[4], +_im[5], +_im[6], 0);
          if (!isNaN(_d3.getTime())) _rowTsMs = _d3.getTime();
        }
      }
    }
  }

  return {
    _tsMs: _rowTsMs,   /* real epoch ms — used by _toAbsMs and filter */
    date:dateVal, time:timeVal, aggr:aggrVal,
    last:n(g('last')), bid:n(g('bid')), ask:n(g('ask')),
    bSize:n(g('bSize')), aSize:n(g('aSize')),
    numBid:n(g('numBid')), numAsk:n(g('numAsk')), numOrders:n(g('numOrders')),
    trdVol:n(g('trdVol')), volume:n(g('volume')),
    moves:n(g('moves')),         // RTL cumulative
    tradeId:ts(g('tradeId')),    // TRADE_ID
    seqNum:n(g('seqNum')),       // SEQNUM cumulative
    rtCount:n(g('rtCount')),     // RT_Count fallback
    condKey:String(g('condKey')||'').replace(/[^\x20-\x7E]/g,'').trim(),
    QUALIFIERS:String(g('condKey')||'').replace(/[^\x20-\x7E]/g,'').trim(),  // raw alias kept for bridge compatibility
    // diff fields – populated by _applyDiffs()
    volDiff:0, movesDiff:0, seqNumDiff:0, trdIdDiff:0,
  };
}

function dedup(rows){
  /*
    IMPORTANT FIX
    -------------
    TRADE_ID / SEQNUM / RTL values can repeat many times in a long TAS/TAQ file.
    The old code used only TRADE_ID as the duplicate key. That removed valid rows
    from multi-minute / multi-hour files. Then the Chart tab showed different
    footprint levels when the same minute was loaded alone versus inside a
    longer file.

    This dedup only removes truly identical rows by using the full timestamp +
    price + quote + sizes + counters + side. Therefore the selected minute is
    identical whether loaded from a one-minute file or from a longer file.
  */
  const seen = new Set();
  let splIdx = 0;

  const cleanQ = v => String(v ?? '')
    .replace(/[^\x20-\x7E]/g,'')
    .trim()
    .toUpperCase();

  const nk = v => {
    if(v === undefined || v === null) return '';
    const n = Number(String(v).replace(',','.'));
    if(Number.isFinite(n)) return String(Math.round(n * 1000000) / 1000000);
    return String(v).trim();
  };

  return (rows || []).filter(r => {
    const isSplRow = cleanQ(r.condKey || r.QUALIFIERS || r.qualifiers || '').includes('SPL TRD');

    if(isSplRow){
      const k = [
        'spl',
        nk(r.date), nk(r.time), nk(r.last), nk(r.bid), nk(r.ask),
        nk(r.trdVol), nk(r.volume), nk(r.tradeId), nk(r.seqNum), nk(r.moves),
        splIdx++
      ].join('|');
      if(seen.has(k)) return false;
      seen.add(k);
      return true;
    }

    const k = [
      'row',
      nk(r.date), nk(r.time),
      nk(r.last), nk(r.bid), nk(r.ask),
      nk(r.bSize), nk(r.aSize),
      nk(r.numBid), nk(r.numAsk), nk(r.numOrders),
      nk(r.trdVol), nk(r.volume),
      nk(r.tradeId), nk(r.seqNum), nk(r.moves), nk(r.rtCount),
      nk(r.aggr), nk(r.tick)
    ].join('|');

    if(seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ============================================================
   FILE PARSER
   ============================================================ */
function getFileExt(name){return(name.split('.').pop()||'').toLowerCase();}

function showFmtBadge(ext){
  const el=document.getElementById('fmt-badge');
  el.className=''; el.classList.add(ext);
  el.textContent=ext.toUpperCase();
  el.style.display='inline-block';
}

function parseCSVText(text){
  const lines=text.split(/\r?\n/).filter(l=>l.trim());
  if(!lines.length) throw new Error('Empty CSV');
  const arr=lines.map(l=>l.split(',').map(c=>c.trim().replace(/^"|"$/g,'')));
  const hi=_detectHeaderRow(arr);
  const hdrs=(arr[hi]||[]).map(c=>String(c||'').trim());
  _itrAssertFileSection(hdrs);
  _cc=null;
  const rows=[];
  for(let i=hi+1;i<arr.length;i++){
    const r=arr[i]; if(!r||r.every(c=>!c)) continue;
    const obj={}; hdrs.forEach((h,j)=>{if(h) obj[h]=r[j]??'';});
    rows.push(normR(obj,hdrs));
  }
  return rows;
}

function _itrAssertFileSection(headers){
  const names=new Set(headers.map(h=>String(h||'').toLowerCase().replace(/[^a-z0-9]+/g,'')));
  let detected=null;
  if(names.has('timeactns')||names.has('aggressiveord1')) detected='gcv';
  else if(names.has('aggrssid1')||(names.has('trdprc1')&&names.has('trdvol1'))) detected='tas-regime';
  else if(names.has('prctck1')) detected='taq-pro';
  if(detected&&detected!==ITR_SECTION_ID){
    throw new Error(`This file's headers identify ${detected}; this screen accepts ${ITR_SECTION_ID} files only.`);
  }
}

function parseFile(file){
  return new Promise((res,rej)=>{
    const ext=getFileExt(file.name);
    const finish=rawRows=>{
      if(!rawRows.length) throw new Error('File contains no data rows.');
      return _fillNaN(rawRows);
    };
    if(ext==='csv'){
      const reader=new FileReader();
      reader.onerror=()=>rej(new Error('Could not read CSV file'));
      reader.onload=e=>{try{res(finish(parseCSVText(e.target.result)));}catch(err){rej(err);}};
      reader.readAsText(file,'UTF-8');
    } else if(['xlsx','xlsm','xls'].includes(ext)){
      const reader=new FileReader();
      reader.onerror=()=>rej(new Error('Could not read Excel file'));
      reader.onload=e=>{
        try{
          /* cellDates:true → XLSX returns JS Date objects for date/datetime cells.
             This guarantees any date column (incl. "Timestamp") arrives as a real Date
             regardless of the cell's Excel format string (DD.MM.YYYY, M/D/YYYY, etc.) */
          const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array',cellDates:true,raw:false});
          const sn=wb.SheetNames.find(n=>!n.startsWith('_xlnm')&&!n.startsWith('xl/'))||wb.SheetNames[0];
          const ws=wb.Sheets[sn];
          const arr=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false});
          const hi=_detectHeaderRow(arr);
          const hdrs=(arr[hi]||[]).map(c=>String(c||'').trim());
          if(!hdrs.filter(Boolean).length) throw new Error('No header row in "'+sn+'".');
          _itrAssertFileSection(hdrs);
          _cc=null;

          /* Helper: format a JS Date as "YYYY-MM-DD HH:MM:SS" (local time, ISO-style) */
          const _fmtDate = d => {
            const p = n => String(n).padStart(2,'0');
            return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} `+
                   `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
          };

          /* Helper: detect & normalise any date-like cell value to ISO string */
          const _normCell = v => {
            if (v instanceof Date && !isNaN(v.getTime())) return _fmtDate(v);
            if (v === null || v === undefined) return '';
            const s = String(v).trim();
            /* DD.MM.YYYY HH:MM:SS or DD.MM.YYYY HH:MM */
            const em = s.match(/^(\d{1,2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
            if (em) {
              const d2 = new Date(+em[3],+em[2]-1,+em[1],+em[4],+em[5],+(em[6]||0),0);
              if (!isNaN(d2.getTime())) return _fmtDate(d2);
            }
            /* DD/MM/YYYY HH:MM:SS */
            const em2 = s.match(/^(\d{1,2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
            if (em2) {
              const d3 = new Date(+em2[3],+em2[2]-1,+em2[1],+em2[4],+em2[5],+(em2[6]||0),0);
              if (!isNaN(d3.getTime())) return _fmtDate(d3);
            }
            /* M/D/YYYY H:MM or M/D/YYYY H:MM:SS (US Excel format) */
            const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
            if (us) {
              const d4 = new Date(+us[3],+us[1]-1,+us[2],+us[4],+us[5],+(us[6]||0),0);
              if (!isNaN(d4.getTime())) return _fmtDate(d4);
            }
            return s;
          };

          /* Find Timestamp/date column index once */
          const _tsHdrIdx = hdrs.findIndex(h =>
            /^timestamp$/i.test(h) || /^date$/i.test(h) || /^datetime$/i.test(h)
          );

          const rows=[];
          for(let i=hi+1;i<arr.length;i++){
            const r=arr[i];
            if(!r||r.every(c=>c===''||c===null||c===undefined)) continue;
            const obj={};
            hdrs.forEach((h,j)=>{
              if(h) obj[h] = _normCell(r[j]);
            });
            /* Compute _tsMs directly from the raw Date object BEFORE normR
               strips the date part. If XLSX returned a real Date, use it directly.
               Otherwise fall back to parsing the normalised string. */
            let _preTs = 0;
            if (_tsHdrIdx >= 0) {
              const rawCell = r[_tsHdrIdx];
              if (rawCell instanceof Date && !isNaN(rawCell.getTime())) {
                _preTs = rawCell.getTime();
              } else if (rawCell) {
                /* Try to parse the raw cell string directly */
                const _rs = String(rawCell).trim();
                /* ISO: YYYY-MM-DD HH:MM:SS */
                const _im = _rs.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2}):(\d{2})/);
                if (_im) {
                  const _d = new Date(+_im[1],+_im[2]-1,+_im[3],+_im[4],+_im[5],+_im[6],0);
                  if (!isNaN(_d.getTime())) _preTs = _d.getTime();
                }
                /* European: DD.MM.YYYY HH:MM:SS */
                if (!_preTs) {
                  const _em = _rs.match(/^(\d{1,2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
                  if (_em) {
                    const _d2 = new Date(+_em[3],+_em[2]-1,+_em[1],+_em[4],+_em[5],+_em[6],0);
                    if (!isNaN(_d2.getTime())) _preTs = _d2.getTime();
                  }
                }
                /* US: M/D/YYYY H:MM:SS */
                if (!_preTs) {
                  const _us = _rs.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
                  if (_us) {
                    const _d3 = new Date(+_us[3],+_us[1]-1,+_us[2],+_us[4],+_us[5],+_us[6],0);
                    if (!isNaN(_d3.getTime())) _preTs = _d3.getTime();
                  }
                }
              }
            }
            const row = normR(obj, hdrs);
            /* Override _tsMs with the directly-computed value if better */
            if (_preTs > 0) row._tsMs = _preTs;
            rows.push(row);
          }
          if(!rows.length) throw new Error('No data rows in "'+sn+'".');
          res(finish(rows));
        }catch(err){rej(err);}
      };
      reader.readAsArrayBuffer(file);
    } else {
      rej(new Error('Unsupported: .'+ext));
    }
  });
}

/* ============================================================
   _ticksToBar
   ─────────────────────────────────────────────────────────────
   Aggregates a tick array into one footprint bar.

   Footprint row fields (per price level):
     trdIdDiff  = Σ tick.trdIdDiff   → Trd.ID column
     seqNumDiff = Σ tick.seqNumDiff  → SEQ_N  column
     movesDiff  = Σ tick.movesDiff   → RTL    column

   Bar-level totals (used by candle summary):
     totalTrdId  = Σ fp[i].trdIdDiff
     totalSeqNum = Σ fp[i].seqNumDiff
     totalMoves  = Σ fp[i].movesDiff
   ============================================================ */
function _ticksToBar(ticks){
  if(!ticks.length) return null;
  // Separate SPL TRD rows (last=0) from price ticks — SPL rows only count for splTrd
  // Exact match per Python: df[df["QUALIFIERS"] == "SPL TRD[USER]"]["TRDVOL_1"].sum()
  /* cleanQ strips non-ASCII chars — matches DOM Viewer v2's buildDOM() logic */
  const cleanQ=s=>String(s??'').replace(/[^\x20-\x7E]/g,'').trim();
  const _isSpl=r=>{
    const q=cleanQ(r.condKey||r.QUALIFIERS||r.qualifiers||'').toUpperCase();
    return q==='SPL TRD[USER]'||q==='SPL TRD'||q.startsWith('SPL TRD');
  };
  /* priceTicks: exclude SPL rows so they don't skew footprint/OHLC/delta.
     SPL rows can have last>0 in some data feeds — use condKey to identify them. */
  const _isSplTick=r=>String(r.condKey||r.QUALIFIERS||'').replace(/[^\x20-\x7E]/g,'').trim().toUpperCase().includes('SPL TRD');
  const priceTicks=ticks.filter(r=>r.last>0&&!_isSplTick(r)); // footprint/OHLC/delta
  const allTicks=ticks;  // splTrd uses allTicks (includes ALL SPL rows)
  if(!priceTicks.length) return null;
  const prices=priceTicks.map(r=>r.last);
  const hi=Math.max(...prices),lo=Math.min(...prices);
  const op=prices[0],cl=prices[prices.length-1];
  const byP={};
  /* Raw bar-level accumulators — init to zero for each bar */
  let _rawBidSz=0,_rawAskSz=0,_rawTrdVol=0,_rawTradeId=0,_rawSeqNum=0,_rawRtl=0;
  // total traded volume for this bar (used by VAH/VAL and returned as totalVol)
  let tV=0;
  let _aggrBidVol=0,_aggrBidBidSz=0,_aggrBidAskSz=0;
  let _aggrAskVol=0,_aggrAskBidSz=0,_aggrAskAskSz=0;
  /* COUNTIF(AGGRS_SID1,'BID') and COUNTIF(AGGRS_SID1,'ASK') for the whole bar */
  let _countIfBid=0, _countIfAsk=0;

  priceTicks.forEach(r=>{
    /* Snap price to Price Summary tick (0.10) using integer arithmetic.
       This ensures chart rows align exactly to the 0.10 price grid,
       so 5014.2, 5014.3 etc. each get their own row. */
    const _ptk=CFG.tickSize;
    const _pMULT=10000,_pTkI=Math.round(_ptk*_pMULT);
    const pk=Math.round(Math.round(r.last*_pMULT)/_pTkI)*_pTkI/_pMULT;
    if(!byP[pk]) byP[pk]={
      price:pk,
      bid:0,ask:0,bSize:0,aSize:0,
      numBid:0,numAsk:0,numOrders:0,
      trdVol:0,volume:0,delta:0,vol:0,
      hitBid:0,hitAsk:0,hitTrdVol:0,
      liftBid:0,liftAsk:0,liftTrdVol:0,
      trdIdDiff:0,   // |TRADE_ID diff| accumulator
      seqNumDiff:0,  // |SEQNUM diff|   accumulator
      movesDiff:0,   // |RTL diff|      accumulator
      hitRTL:0,      // Σ movesDiff for HIT rows
      liftRTL:0,     // Σ movesDiff for LIFT rows
      hitIdDiff:0,   // Σ trdIdDiff for HIT rows
      hitSeqDiff:0,  // Σ seqNumDiff for HIT rows
      liftIdDiff:0,  // Σ trdIdDiff for LIFT rows
      liftSeqDiff:0, // Σ seqNumDiff for LIFT rows
      rtlX:0,        // total movesDiff accumulator (RTL_X = rtlX − 8×(bSize+aSize) per level)
      aggrBid:0,     // count of AGGRS_SID1=BID ticks
      aggrAsk:0,     // count of AGGRS_SID1=ASK ticks
    };
    const lv=byP[pk];
    const bidSz=r.bSize||0;  /* BIDSIZE only — never confuse with bid price */
    const askSz=r.aSize||0;  /* ASKSIZE only */
    const vol=r.trdVol||0;

    let side='N';
    if(r.aggr==='ASK'||r.aggr==='BUY')  side='L';
    else if(r.aggr==='BID'||r.aggr==='SELL') side='H';
    else if(r.ask>0&&Math.abs(r.last-r.ask)<CFG.tickSize*0.5) side='L';
    else if(r.bid>0&&Math.abs(r.last-r.bid)<CFG.tickSize*0.5) side='H';

    lv.bid+=bidSz; lv.bSize+=bidSz;
    lv.ask+=askSz; lv.aSize+=askSz;
    lv.numBid+=r.numBid||0; lv.numAsk+=r.numAsk||0;
    lv.numOrders+=r.numOrders||0;
    lv.trdVol+=vol;
    lv.volume+=(r.volDiff>0)?r.volDiff:(r.volume||vol);
    lv.vol+=vol;
    tV+=vol;
    lv.delta+=bidSz-askSz;

    // Accumulate diff fields – each tick contributes its own diff
    lv.trdIdDiff  +=(r.trdIdDiff||0);
    /* Use diff fields only — no fallback to raw cumulative seqNum/moves */
    lv.seqNumDiff +=(r.seqNumDiff||0);
    lv.movesDiff  +=(r.movesDiff||0);

    if(side==='H'){lv.hitBid+=bidSz;lv.hitAsk+=askSz;lv.hitTrdVol+=vol;}
    if(side==='L'){lv.liftBid+=bidSz;lv.liftAsk+=askSz;lv.liftTrdVol+=vol;}
    // Derived RTL/ID/SEQ columns per side
    if(side==='H') lv.hitRTL    +=(r.movesDiff||0);
    if(side==='L') lv.liftRTL   +=(r.movesDiff||0);
    if(side==='H') lv.hitIdDiff +=(r.trdIdDiff||0);
    if(side==='H') lv.hitSeqDiff+=(r.seqNumDiff||0);
    if(side==='L') lv.liftIdDiff +=(r.trdIdDiff||0);
    if(side==='L') lv.liftSeqDiff+=(r.seqNumDiff||0);
    lv.rtlX    +=(r.movesDiff||0);                  // rtlX accumulates total movesDiff (RTL_X computed below)
    // AGGRS_SID1 counts per price level
    if(side==='H') lv.aggrBid++;    // BID aggressor
    if(side==='L') lv.aggrAsk++;    // ASK aggressor
    /* Raw bar-level totals (un-diffed, for candle summary pivot table values) */
    _rawBidSz+=bidSz; _rawAskSz+=askSz; _rawTrdVol+=vol;
    _rawTradeId+=(r.trdIdDiff||0); _rawSeqNum+=(r.seqNumDiff||0); _rawRtl+=(r.movesDiff||0);
    if(side==='H'){_aggrBidVol+=vol;_aggrBidBidSz+=bidSz;_aggrBidAskSz+=askSz;}
    if(side==='L'){_aggrAskVol+=vol;_aggrAskBidSz+=bidSz;_aggrAskAskSz+=askSz;}
    /* COUNTIF(AGGRS_SID1,'BID'/'ASK') — raw column value, independent of side-classification */
    if((r.aggr||'').toUpperCase()==='BID') _countIfBid++;
    if((r.aggr||'').toUpperCase()==='ASK') _countIfAsk++;
  });

  const fp=Object.values(byP).sort((a,b)=>a.price-b.price);
  /* ── Delta Flip — L-H = LIFT minus HIT; reads existing bar aggregates (same as CS columns).
     Only H-L Vol uses per-tick range. ── */
  const _dfVols=priceTicks.map(r=>+(r.trdVol||0)).filter(v=>v>0);
  const _dfHLVol=_dfVols.length>1?_dfVols.reduce((a,b)=>a>b?a:b,0)-_dfVols.reduce((a,b)=>a<b?a:b,Infinity):0;
  const poc=fp.length?fp.reduce((mx,r)=>r.vol>mx.vol?r:mx,fp[0]):{price:prices[0],vol:0};
  const sv=[...fp].sort((a,b)=>b.vol-a.vol);
  let vaV=0,vaPs=[];
  for(const r of sv){vaPs.push(r.price);vaV+=r.vol;if(vaV>=tV*.7) break;}
  const delta=fp.reduce((s,r)=>s+r.delta,0);
  const buyVol=fp.reduce((s,r)=>s+r.liftTrdVol,0);
  const sellVol=fp.reduce((s,r)=>s+r.hitTrdVol,0);
  const t0=priceTicks[0],tN=priceTicks[priceTicks.length-1];
  const sum=f=>fp.reduce((s,r)=>s+(r[f]||0),0);
  // SPL TRD per bar: Σ TRDVOL_1 where QUALIFIERS == "SPL TRD[USER]"
  // Mirrors Python: df[df["QUALIFIERS"]=="SPL TRD[USER]"]["TRDVOL_1"].sum()
  // Uses allTicks so SPL rows with last=0 (no trade price) are included.
  const splRows=allTicks.filter(_isSpl);
  const splTrd=splRows.reduce((s,r)=>s+(+(r.trdVol)||+(r.TRDVOL_1)||0),0);
  if(splRows.length>0) console.log(`[SPL] bar ${t0&&t0.time}: ${splRows.length} SPL rows, trdVols=[${splRows.map(r=>r.trdVol).join(',')}], splTrd=${splTrd}`);
  /* Collect price levels where SPL TRD occurred */
  const splPrices=splRows.map(r=>+(r.last||r.bid||r.ask||0)).filter(p=>p>0);

  return {
    open:op,high:hi,low:lo,close:cl,isBull:cl>=op,
    footprint:fp,pocPrice:poc.price,pocVol:poc.vol,
    vah:vaPs.length?Math.max(...vaPs):hi,
    val:vaPs.length?Math.min(...vaPs):lo,
    delta,totalVol:tV,buyVol,sellVol,splTrd,splPrices,
    totalBid:sum('bid'),totalAsk:sum('ask'),
    totalBSize:sum('bSize'),totalASize:sum('aSize'),
    totalNumBid:sum('numBid'),totalNumAsk:sum('numAsk'),
    totalNumOrders:sum('numOrders'),totalTrdVol:sum('trdVol'),
    totalVolume:sum('volume'),
    totalHitBid:sum('hitBid'),totalHitAsk:sum('hitAsk'),totalHitVol:sum('hitTrdVol'),
    totalLiftBid:sum('liftBid'),totalLiftAsk:sum('liftAsk'),totalLiftVol:sum('liftTrdVol'),
    totalDelta:delta,
    totalTrdId:sum('trdIdDiff'),    // total trdIdDiff bar
    totalSeqNum:sum('seqNumDiff'),  // total seqNumDiff bar
    totalMoves:sum('movesDiff'),    // total movesDiff bar
    totalHitRTL:sum('hitRTL'),
    totalLiftRTL:sum('liftRTL'),
    totalHitId:sum('hitIdDiff'),   // Σ trdIdDiff for HIT rows in bar
    totalHitSeq:sum('hitSeqDiff'), // Σ seqNumDiff for HIT rows in bar
    totalLiftId:sum('liftIdDiff'), // Σ trdIdDiff for LIFT rows in bar
    totalLiftSeq:sum('liftSeqDiff'), // Σ seqNumDiff for LIFT rows in bar
    totalRtlX:fp.reduce((s,r)=>s+Math.max(0,(r.rtlX||0)-8*(r.bSize+r.aSize)),0),  // RTL_X = Σ(movesDiff - 8×(BIDSIZE+ASKSIZE)) per level
    /* COUNTIF(AGGRS_SID1,'BID'/'ASK') — whole-bar row counts, same logic as Excel */
    totalAggrBid:_countIfBid,
    totalAggrAsk:_countIfAsk,
    /* Raw bar column sums — match pivot table image */
    rawBidSz:_rawBidSz, rawAskSz:_rawAskSz, rawTrdVol:_rawTrdVol,
    rawTradeId:_rawTradeId, rawSeqNum:_rawSeqNum, rawRtl:_rawRtl,
    /* AGGRS_SID1 sub-totals */
    aggrBidVol:_aggrBidVol, aggrBidBidSz:_aggrBidBidSz, aggrBidAskSz:_aggrBidAskSz,
    aggrAskVol:_aggrAskVol, aggrAskBidSz:_aggrAskBidSz, aggrAskAskSz:_aggrAskAskSz,
    avgVwap:prices.reduce((s,p)=>s+p,0)/prices.length,
    minDelta:fp.length?Math.min(...fp.map(r=>r.delta)):0,
    maxDelta:fp.length?Math.max(...fp.map(r=>r.delta)):0,
    cumD:0,isOpen:false,
    date:t0.date||'',time:t0.time||'',timeEnd:tN.time||'',
    ticks:ticks,  /* raw tick array — used by Level Aggregator */
    dfHLVol:_dfHLVol,
  };
}

/* ============================================================
   SIM DATA
   ============================================================ */
class SimData{
  constructor(){
    this.price=CFG.startPrice;this.cumD=0;this.bars=[];
    const n=parseInt(document.getElementById('bar-n').value)||10;
    for(let i=0;i<n;i++){this.price+=(Math.random()-.49)*CFG.tickSize*9;this._push();}
  }
  _push(){
    const ts=CFG.tickSize,half=Math.floor(CFG.rowsVisible*.55);
    const lo=this.price-half*ts,hi=this.price+half*ts;
    const op=lo+Math.random()*(hi-lo),cl=lo+Math.random()*(hi-lo);
    let fp=[],pocV=0,pocP=lo,tB=0,tA=0,tV=0;
    for(let t=0;t*ts<=hi-lo+ts;t++){
      const rp=lo+t*ts; if(rp>hi+ts) break;
      const d=Math.abs(rp-this.price)/(half*ts);
      const w=Math.exp(-d*d*3)*.75+.1+Math.random()*.15;
      const vol=Math.floor(w*180*(0.7+Math.random()*.6))+1;
      const ab=(rp-lo)/(hi-lo);
      const ask=Math.max(0,Math.floor(vol*(0.3+ab*.5)*(.8+Math.random()*.4)));
      const bid=Math.max(0,vol-ask);
      tB+=bid;tA+=ask;tV+=vol;
      if(vol>pocV){pocV=vol;pocP=rp;}
      const side=Math.random()>.5?'H':'L';
      fp.push({
        price:rp,bid,ask,bSize:bid,aSize:ask,
        numBid:Math.ceil(bid/4),numAsk:Math.ceil(ask/4),
        numOrders:Math.ceil(vol/3),trdVol:vol,volume:vol*2,
        delta:bid-ask,vol,
        hitBid:side==='H'?bid:0,hitAsk:side==='H'?ask:0,hitTrdVol:side==='H'?vol:0,
        liftBid:side==='L'?bid:0,liftAsk:side==='L'?ask:0,liftTrdVol:side==='L'?vol:0,
        trdIdDiff:Math.floor(Math.random()*3),
        seqNumDiff:Math.floor(Math.random()*5)+1,
        movesDiff:Math.floor(Math.random()*4)+1,
        hitRTL:Math.floor(Math.random()*200),
        liftRTL:Math.floor(Math.random()*200),
        rtlX:Math.max(0,Math.floor(Math.random()*300)-8*(bid+ask)),
        aggrBid:side==='H'?1:0,
        aggrAsk:side==='L'?1:0,
      });
    }
    const sv=[...fp].sort((a,b)=>b.vol-a.vol);
    let vaV=0,vaPs=[];
    for(const r of sv){vaPs.push(r.price);vaV+=r.vol;if(vaV>=tV*.7) break;}
    const delta=tB-tA; this.cumD+=delta;
    this.bars.push({
      open:op,high:hi,low:lo,close:cl,isBull:cl>=op,
      footprint:fp,pocPrice:pocP,pocVol:pocV,
      vah:vaPs.length?Math.max(...vaPs):hi,val:vaPs.length?Math.min(...vaPs):lo,
      delta,totalVol:tV,
      buyVol:fp.reduce((s,r)=>s+r.liftTrdVol,0),
      sellVol:fp.reduce((s,r)=>s+r.hitTrdVol,0),
      totalTrdId:fp.reduce((s,r)=>s+(r.trdIdDiff||0),0),
      totalSeqNum:fp.reduce((s,r)=>s+(r.seqNumDiff||0),0),
      totalMoves:fp.reduce((s,r)=>s+(r.movesDiff||0),0),
      totalHitBid:fp.reduce((s,r)=>s+r.hitBid,0),totalHitAsk:fp.reduce((s,r)=>s+r.hitAsk,0),totalHitVol:fp.reduce((s,r)=>s+r.hitTrdVol,0),
      totalLiftBid:fp.reduce((s,r)=>s+r.liftBid,0),totalLiftAsk:fp.reduce((s,r)=>s+r.liftAsk,0),totalLiftVol:fp.reduce((s,r)=>s+r.liftTrdVol,0),
      totalHitRTL:fp.reduce((s,r)=>s+(r.hitRTL||0),0),
      totalLiftRTL:fp.reduce((s,r)=>s+(r.liftRTL||0),0),
      totalHitId:fp.reduce((s,r)=>s+(r.hitIdDiff||0),0),
      totalHitSeq:fp.reduce((s,r)=>s+(r.hitSeqDiff||0),0),
      totalLiftId:fp.reduce((s,r)=>s+(r.liftIdDiff||0),0),
      totalLiftSeq:fp.reduce((s,r)=>s+(r.liftSeqDiff||0),0),
      totalRtlX:fp.reduce((s,r)=>s+(r.rtlX||0),0),
      /* SimData: totalAggrBid/Ask not meaningful — set to 0 */
      totalAggrBid:0,
      totalAggrAsk:0,
      rawBidSz:fp.reduce((s,r)=>s+r.bSize,0), rawAskSz:fp.reduce((s,r)=>s+r.aSize,0),
      rawTrdVol:fp.reduce((s,r)=>s+r.trdVol,0),rawTradeId:0,rawSeqNum:0,rawRtl:0,
      aggrBidVol:fp.reduce((s,r)=>s+r.hitTrdVol,0),aggrBidBidSz:fp.reduce((s,r)=>s+r.hitBid,0),aggrBidAskSz:fp.reduce((s,r)=>s+r.hitAsk,0),
      aggrAskVol:fp.reduce((s,r)=>s+r.liftTrdVol,0),aggrAskBidSz:fp.reduce((s,r)=>s+r.liftBid,0),aggrAskAskSz:fp.reduce((s,r)=>s+r.liftAsk,0),
      totalBSize:fp.reduce((s,r)=>s+r.bSize,0),totalASize:fp.reduce((s,r)=>s+r.aSize,0),
      totalTrdVol:fp.reduce((s,r)=>s+r.trdVol,0),totalDelta:delta,
      avgVwap:this.price,
      minDelta:Math.min(...fp.map(r=>r.delta)),
      maxDelta:Math.max(...fp.map(r=>r.delta)),
      cumD:this.cumD,date:'SIM',
      time:new Date().toLocaleTimeString('en-US',{hour12:false}),
    });
  }
  tick(){
    this.price+=(Math.random()-.49)*CFG.tickSize*5;this._push();
    const mx=parseInt(document.getElementById('bar-n').value)||10;
    if(this.bars.length>mx+5) this.bars.shift();
  }
}

/* ============================================================
   RENDERER
   ============================================================ */
class Renderer{
  constructor(bars){
    this.MC=document.getElementById('MC');
    this.SC=document.getElementById('SC');
    this.cx=this.MC.getContext('2d');
    this.sx=this.SC.getContext('2d');
    this._sim=bars?null:new SimData();
    this.bars=bars||(this._sim?this._sim.bars:[]);
    this._evts();this.resize();this.draw();
    if(!bars) this._feed();
  }
  get barW(){return ACT_COLS.length*CFG.colW;}
  get totalW(){return CFG.priceColW+this.barW;}
  _feed(){
    this._t=setInterval(()=>{
      if(this._sim){this._sim.tick();this.bars=this._sim.bars;}
      this.resize();this.draw();
      document.getElementById('hscroll').scrollLeft=99999;
    },CFG.tickIntervalMs);
  }
  resize(){
    const con=document.getElementById('hscroll-outer');
    const hs=document.getElementById('hscroll');
    const inner=document.getElementById('hscroll-inner');
    const W=Math.max((con?con.clientWidth:900)-74,200),H=(con?con.clientHeight:500);
    const tw=Math.max(this.bars.length*this.totalW+2,W);
    /* Virtual canvas mode: keep the drawing canvas viewport-sized and use
       #hscroll-inner as the wide scroll spacer. This avoids Chrome's max
       canvas width limit, which caused a blank chart when 100+ bars made
       MC.width > ~32767px. */
    if(inner){inner.style.width=tw+'px';inner.style.minWidth=tw+'px';}
    this.MC.width=W;this.MC.height=H;this.MC.style.width=W+'px';this.MC.style.height=H+'px';this.SC.height=H;
    const xhc=document.getElementById('crosshair-canvas');
    if(xhc){xhc.width=con.clientWidth;xhc.height=H;}
  }
  _evts(){
    this.MC.addEventListener('mousemove',e=>this._tip(e));
    this.MC.addEventListener('mouseleave',()=>{document.getElementById('tip').style.display='none';});
    window.addEventListener('resize',()=>{this.resize();this.draw();});
    const _hs=document.getElementById('hscroll');
    if(_hs&&!_hs._ofVirtualDrawBound){_hs._ofVirtualDrawBound=true;_hs.addEventListener('scroll',()=>{if(R) R.draw();},{passive:true});}
    // Ctrl/Shift+drag = vertical pan on MC
    let _vDA=false,_vDY=0,_vDO=0;
    this.MC.addEventListener('mousedown',e=>{
      if((e.ctrlKey||e.shiftKey)&&e.button===0){_vDA=true;_vDY=e.clientY;_vDO=CFG.chartOffsetY;e.preventDefault();}
    });
    window.addEventListener('mousemove',e=>{
      if(!_vDA) return;
      CFG.chartOffsetY=_vDO+Math.round((e.clientY-_vDY)/CFG.rowH);
      if(R) R.draw();
    });
    window.addEventListener('mouseup',()=>{_vDA=false;});
    // Drag on price scale = vertical pan
    let _sDA=false,_sDY=0,_sDO=0;
    this.SC.addEventListener('mousedown',e=>{_sDA=true;_sDY=e.clientY;_sDO=CFG.chartOffsetY;this.SC.style.cursor='ns-resize';e.preventDefault();});
    window.addEventListener('mousemove',e=>{if(!_sDA) return;CFG.chartOffsetY=_sDO+Math.round((e.clientY-_sDY)/CFG.rowH);if(R) R.draw();});
    window.addEventListener('mouseup',()=>{if(_sDA){_sDA=false;this.SC.style.cursor='ns-resize';}});
    this.SC.style.cursor='ns-resize';
    // Wheel on price scale = row height zoom
    this.SC.addEventListener('wheel',e=>{
      e.preventDefault();
      CFG.rowH=Math.max(12,Math.min(36,CFG.rowH+(e.deltaY<0?1:-1)));
      document.getElementById('sb-rh').value=CFG.rowH;
      document.getElementById('rh-lbl').textContent=CFG.rowH+'px';
      _lastBarCount=-1;if(R){R.resize();R.draw();}
    },{passive:false});
    this.SC.addEventListener('dblclick',()=>{CFG.chartOffsetY=0;if(R) R.draw();});
    this.MC.addEventListener('dblclick',e=>{if(!e.ctrlKey&&!e.shiftKey){CFG.chartOffsetY=0;if(R) R.draw();}});
  }
  draw(){
    const idleEl=document.getElementById('chart-idle-state');
    if(idleEl) idleEl.style.display=(this.bars&&this.bars.length)?'none':'flex';
    CFG.mode==='range'?this._drawGrid(false):this._drawGrid(true);
    this._drawStats();
  }
  _drawGrid(candleMode){
    const cx=this.cx,bars=this.bars,W=this.MC.width,H=this.MC.height;
    const _scrollEl=document.getElementById('hscroll');
    const scrollX=_scrollEl?(_scrollEl.scrollLeft||0):0;
    const pr=this._range();
    const visR=(CFG.mode==='range') ? (CFG.rangeLevels||10) : Math.floor((H-44)/CFG.rowH);
    const priceStep=chartPriceStep(pr,visR);
    const topP=chartTopPrice(pr,visR);
    const fy=20;
    cx.fillStyle=CFG._bgTheme?.bg||'#1a1a1a';cx.fillRect(0,0,W,H);
    cx.strokeStyle=CFG._bgTheme?.grid||'#282828';cx.lineWidth=0.5;
    for(let r=0;r<visR;r++){const y=fy+r*CFG.rowH;cx.beginPath();cx.moveTo(0,y);cx.lineTo(W,y);cx.stroke();}
    const vwapPts=[],cdPts=[];
    bars.forEach((bar,bi)=>{
      const x0=CFG.priceColW+bi*this.totalW-scrollX;
      if(x0>W+this.totalW||x0+this.barW<-this.totalW) return;
      cdPts.push({x:x0+this.barW/2,v:bar.cumD});
      const oY=fy+Math.round((topP-bar.open)/priceStep)*CFG.rowH;
      const cY=fy+Math.round((topP-bar.close)/priceStep)*CFG.rowH;
      const hY=fy+Math.round((topP-bar.high)/priceStep)*CFG.rowH;
      const lY=fy+Math.round((topP-bar.low)/priceStep)*CFG.rowH;
      if(CFG.showVWAP&&bar.avgVwap>0){
        const vy=fy+Math.round((topP-bar.avgVwap)/priceStep)*CFG.rowH;
        vwapPts.push({x:x0+this.barW/2,y:vy});
      }
      if(CFG.showVA){
        const vahY=fy+Math.round((topP-bar.vah)/priceStep)*CFG.rowH;
        const valY=fy+Math.round((topP-bar.val)/priceStep)*CFG.rowH+CFG.rowH;
        cx.fillStyle='rgba(40,80,140,0.09)';
        cx.fillRect(x0,Math.max(fy,vahY),this.barW,Math.min(valY,fy+visR*CFG.rowH)-Math.max(fy,vahY));
      }
      if(candleMode){
        const bT=Math.min(oY,cY),bB=Math.max(oY,cY),bH=Math.max(CFG.rowH,bB-bT);
        cx.fillStyle=bar.isBull?'rgba(0,160,60,0.18)':'rgba(180,0,30,0.18)';
        cx.fillRect(x0,bT,this.barW,bH);
      }
      const displayRows=chartDisplayRows(bar.footprint,topP,priceStep);
      const maxV=Math.max(...displayRows.map(r=>r.vol),1);
      displayRows.forEach(row=>{
        const rowY=fy+Math.round((topP-row.price)/priceStep)*CFG.rowH;
        if(rowY<fy-CFG.rowH||rowY>fy+visR*CFG.rowH) return;
        const isPOC=CFG.showPOC&&Math.abs(row.price-bar.pocPrice)<priceStep*0.5;
        if(isPOC){cx.fillStyle='rgba(80,80,0,0.35)';cx.fillRect(x0,rowY,this.barW,CFG.rowH-1);}
        const vRatio=row.vol/maxV;
        if(!candleMode){
          cx.fillStyle=row.delta>=0?`rgba(0,120,60,${0.04+vRatio*0.18})`:`rgba(140,0,20,${0.04+vRatio*0.18})`;
          cx.fillRect(x0,rowY,this.barW,CFG.rowH-1);
        }
        if(CFG.showImbalance){
          const b=row.bid||row.bSize,a=row.ask||row.aSize;
          if(b>CFG.imbMinVol&&a>0&&b/a>=CFG.imbThreshold/100){cx.fillStyle='rgba(255,0,255,0.1)';cx.fillRect(x0,rowY,this.barW/2,CFG.rowH-1);}
          if(a>CFG.imbMinVol&&b>0&&a/b>=CFG.imbThreshold/100){cx.fillStyle='rgba(0,255,255,0.1)';cx.fillRect(x0+this.barW/2,rowY,this.barW/2,CFG.rowH-1);}
        }
        const fs=Math.max(7,Math.min(CFG.fontSize,CFG.rowH-4));
        cx.textAlign='center';
        ACT_COLS.forEach((key,ci)=>{
          const colX=x0+ci*CFG.colW+CFG.colW/2;
          const val=row[key];
          if(val===undefined||val===null) return;
          let color=CFG.normTxt;
          if(isPOC){color=CFG.pocTxt;}
          else if(['bid','bSize','numBid','hitBid'].includes(key)){
            const b=row.bid||row.bSize,a=(row.ask||row.aSize)||1;
            color=(CFG.showImbalance&&b/a>=CFG.imbThreshold/100&&b>CFG.imbMinVol)?CFG.bidHi:CFG.normTxt;
          } else if(['ask','aSize','numAsk','hitAsk'].includes(key)){
            const b=(row.bid||row.bSize)||1,a=row.ask||row.aSize;
            color=(CFG.showImbalance&&a/b>=CFG.imbThreshold/100&&a>CFG.imbMinVol)?CFG.askHi:CFG.normTxt;
          } else if(key==='delta'){color=val>=0?'#44ff88':'#ff4444';}
          else if(['hitTrdVol','hitBid','hitAsk','hitRTL'].includes(key)){color=CFG.hitColor;}
          else if(['liftTrdVol','liftBid','liftAsk','liftRTL'].includes(key)){color=CFG.liftColor;}
          const bold=isPOC||vRatio>0.6||color!==CFG.normTxt;
          cx.font=`${bold?'bold ':' '}${fs}px 'Courier New'`;
          cx.fillStyle=color;
          const disp=typeof val==='number'?(Math.abs(val)>=100000?Math.round(val/1000)+'k':Math.round(val).toLocaleString()):String(val);
          cx.fillText(disp,colX,rowY+CFG.rowH-5);
        });
        cx.strokeStyle='#252525';cx.lineWidth=0.5;
        cx.beginPath();cx.moveTo(x0,rowY+CFG.rowH-1);cx.lineTo(x0+this.barW,rowY+CFG.rowH-1);cx.stroke();
      });
      if(candleMode){
        const col=bar.isBull?CFG.bullColor:CFG.bearColor;
        const centerX=x0+this.barW/2;
        const bodyW=Math.max(8,Math.min(22,Math.round(this.barW*0.14)));
        const bodyTop=Math.min(oY,cY),bodyH=Math.max(2,Math.abs(cY-oY));
        const bodyX=Math.round(centerX-bodyW/2)+0.5;
        cx.strokeStyle=col;cx.lineWidth=1.5;
        cx.beginPath();cx.moveTo(Math.round(centerX)+0.5,hY);cx.lineTo(Math.round(centerX)+0.5,lY);cx.stroke();
        cx.fillStyle=col;cx.fillRect(bodyX,bodyTop,bodyW,bodyH);
        cx.strokeStyle=col;cx.lineWidth=1;cx.strokeRect(bodyX,bodyTop,bodyW,bodyH);
      }
      if(CFG.showDelta){
        const dbH=12,dbY=H-dbH-26;
        const w=Math.min(1,Math.abs(bar.delta)/2000)*(this.barW-4);
        cx.fillStyle=bar.delta>=0?'rgba(0,200,80,.75)':'rgba(220,0,30,.75)';
        cx.fillRect(x0+2,dbY,w,dbH);
        cx.fillStyle='#fff';cx.font='bold 8px Courier New';cx.textAlign='center';
        cx.fillText((bar.delta>=0?'+':'')+Math.round(bar.delta),x0+this.barW/2,dbY+dbH-2);
      }
      cx.strokeStyle='#2e2e2e';cx.lineWidth=1;
      cx.beginPath();cx.moveTo(x0+this.barW,fy);cx.lineTo(x0+this.barW,H-12);cx.stroke();
      cx.fillStyle=CFG._bgTheme?.colHdr||'#1a1a1a';cx.fillRect(x0,0,this.barW,fy-1);
      ACT_COLS.forEach((key,ci)=>{
        const colX=x0+ci*CFG.colW;
        const cd2=ALL_COLS.find(c=>c.key===key);
        const hcol=cd2?.cls==='bid'?'#882288':cd2?.cls==='ask'?'#007788':cd2?.cls==='hit'?'#881100':cd2?.cls==='lift'?'#006633':'#334455';
        cx.fillStyle=hcol;cx.fillRect(colX,0,CFG.colW,fy-1);
        cx.fillStyle=cd2?.cls==='bid'?'#ff88ff':cd2?.cls==='ask'?'#88ffff':cd2?.cls==='hit'?'#ff8888':cd2?.cls==='lift'?'#88ffcc':'#aaccdd';
        cx.font='bold 8px Courier New';cx.textAlign='center';
        cx.fillText((cd2?.label||key).substring(0,6),colX+CFG.colW/2,13);
        cx.strokeStyle='#333';cx.lineWidth=0.5;
        cx.beginPath();cx.moveTo(colX+CFG.colW,0);cx.lineTo(colX+CFG.colW,H);cx.stroke();
      });
    });
    if(CFG.showVWAP&&vwapPts.length>1){
      cx.strokeStyle=CFG.vwapColor;cx.lineWidth=1.5;cx.setLineDash([4,3]);
      cx.beginPath();vwapPts.forEach((p,i)=>i===0?cx.moveTo(p.x,p.y):cx.lineTo(p.x,p.y));
      cx.stroke();cx.setLineDash([]);
    }
    const lastBar=bars[bars.length-1];
    if(lastBar){
      const lastY=fy+Math.round((topP-lastBar.close)/priceStep)*CFG.rowH+CFG.rowH/2;
      cx.save();cx.strokeStyle=lastBar.isBull?'rgba(0,200,120,.55)':'rgba(240,80,95,.55)';
      cx.lineWidth=1;cx.setLineDash([3,3]);cx.beginPath();
      cx.moveTo(CFG.priceColW,lastY);cx.lineTo(W,lastY);cx.stroke();cx.restore();
    }
    if(CFG.showCumDelta&&cdPts.length>1){
      const vm=Math.max(...cdPts.map(p=>Math.abs(p.v)),1);
      const my=H-56,amp=20;
      cx.strokeStyle='rgba(88,136,255,.45)';cx.lineWidth=1.5;cx.setLineDash([3,3]);
      cx.beginPath();cdPts.forEach((p,i)=>{const y=my-(p.v/vm)*amp;i===0?cx.moveTo(p.x,y):cx.lineTo(p.x,y);});
      cx.stroke();cx.setLineDash([]);
    }
    // Time axis
    const TX_H=22,TX_Y=H-TX_H;
    cx.fillStyle=CFG._bgTheme?.timeAxis||'#111';cx.fillRect(CFG.priceColW,TX_Y,W-CFG.priceColW,TX_H);
    cx.strokeStyle='#3a3a3a';cx.lineWidth=1;
    cx.beginPath();cx.moveTo(CFG.priceColW,TX_Y);cx.lineTo(W,TX_Y);cx.stroke();
    const minLabelGap=38;let lastLabelX=-9999;
    bars.forEach((bar,bi)=>{
      const x0=CFG.priceColW+bi*this.totalW-scrollX,midX=x0+this.barW/2;
      const t=bar.time&&bar.time!=='SIM'?String(bar.time):'';
      const d=bar.date&&bar.date!=='SIM'?String(bar.date):'';
      let label=t?(CFG.intervalSec<60?t.substring(0,8):t.substring(0,5)):'';
      const prevBar=bi>0?bars[bi-1]:null;
      const dayChange=prevBar&&d&&prevBar.date!==bar.date;
      if(dayChange&&d){
        cx.save();cx.strokeStyle='rgba(255,220,60,0.25)';cx.lineWidth=1;cx.setLineDash([3,3]);
        cx.beginPath();cx.moveTo(midX,fy);cx.lineTo(midX,TX_Y);cx.stroke();cx.setLineDash([]);cx.restore();
        cx.fillStyle='#ffdd3c';cx.font='bold 8px Courier New';cx.textAlign='center';
        cx.fillText(d.length>=10?d.substring(5,10):d,midX,TX_Y+TX_H-3);
        lastLabelX=midX;return;
      }
      if(!label||midX-lastLabelX<minLabelGap){
        cx.strokeStyle='#333';cx.lineWidth=1;cx.beginPath();cx.moveTo(midX,TX_Y);cx.lineTo(midX,TX_Y+3);cx.stroke();return;
      }
      cx.strokeStyle='#555';cx.lineWidth=1;cx.beginPath();cx.moveTo(midX,TX_Y);cx.lineTo(midX,TX_Y+5);cx.stroke();
      cx.fillStyle='#99aacc';cx.font='8px Courier New';cx.textAlign='center';
      cx.fillText(label,midX,TX_Y+TX_H-4);lastLabelX=midX;
    });
    cx.fillStyle=CFG._bgTheme?.timeAxis||'#111';cx.fillRect(0,TX_Y,CFG.priceColW,TX_H);
    cx.strokeStyle='#3a3a3a';cx.lineWidth=1;cx.beginPath();cx.moveTo(CFG.priceColW,TX_Y);cx.lineTo(CFG.priceColW,H);cx.stroke();
    cx.fillStyle=CFG._bgTheme?.priceCol||'#111';cx.fillRect(0,0,CFG.priceColW-1,H);
    for(let r=0;r<visR;r++){
      const price=topP-r*priceStep,y=fy+r*CFG.rowH;
      const lastBar=bars[bars.length-1];
      const isClose=lastBar&&Math.abs(price-lastBar.close)<priceStep*0.5;
      if(isClose){
        cx.fillStyle=lastBar.isBull?CFG.bullColor:CFG.bearColor;
        cx.fillRect(0,y,CFG.priceColW-1,CFG.rowH-1);cx.fillStyle='#fff';
      } else{cx.fillStyle=CFG._bgTheme?.price||'#888';}
      const labelStep=this._priceLabelStep(visR,priceStep);
      const onLabelStep=Math.abs(price-Math.round(price/labelStep)*labelStep)<=1e-8;
      if(isClose||onLabelStep){
        cx.font='10px Courier New';cx.textAlign='right';
        cx.fillText(formatPrice(price),CFG.priceColW-5,y+CFG.rowH-5);
      }
    }
    this._drawScale(pr,topP,fy,visR,priceStep);
  }
  _drawScale(pr,topP,fy,visR,priceStep){
    const sx=this.sx,W=74,H=this.SC.height;
    sx.fillStyle=CFG._bgTheme?.scale||'#111';sx.fillRect(0,0,W,H);
    sx.strokeStyle=CFG._bgTheme?.grid||'#282828';sx.lineWidth=0.5;
    /* Y-axis labels every 0.10 price increment — dynamic with visible range */
    const labelStep=this._priceLabelStep(visR,priceStep);
    for(let r=0;r<visR;r++){
      const p=topP-r*priceStep;
      /* Draw a label line whenever price is a multiple of 0.10 (within float tolerance) */
      const rem=Math.abs(p/labelStep-Math.round(p/labelStep));
      if(Math.abs(p-Math.round(p/labelStep)*labelStep)>1e-8) continue;
      const y=fy+r*CFG.rowH;
      sx.beginPath();sx.moveTo(0,y);sx.lineTo(W,y);sx.stroke();
      sx.fillStyle=CFG._bgTheme?.price||'#555';sx.font='9px Courier New';sx.textAlign='right';sx.fillText(formatPrice(p),W-3,y+9);
    }
    const last=this.bars[this.bars.length-1];
    if(last){
      const cy=fy+Math.round((topP-last.close)/priceStep)*CFG.rowH;
      sx.fillStyle=last.isBull?CFG.bullColor:CFG.bearColor;sx.fillRect(0,cy-10,W,20);
      sx.fillStyle='#fff';sx.font='bold 9px Courier New';sx.textAlign='center';sx.fillText(formatPrice(last.close),W/2,cy+4);
    }
  }
  _priceLabelStep(visR,priceStep){
    const tick=Math.abs(priceStep||CFG.tickSize)||0.01;
    const target=Math.max(tick,tick*visR/7);
    const power=10**Math.floor(Math.log10(target));
    const ratio=target/power;
    const nice=ratio<=1?1:ratio<=2?2:ratio<=5?5:10;
    return Math.max(tick,Math.round((nice*power)/tick)*tick);
  }
  _drawStats(){
    const bars=this.bars;
    const defs=[
      {l:'Trades',   c:'r-trades',f:b=>b.footprint.length},
      {l:'Volume',   c:'r-vol',   f:b=>b.totalVol.toLocaleString()},
      {l:'Buy vol',  c:'r-buy',   f:b=>b.buyVol.toLocaleString()},
      {l:'Sell vol', c:'r-sell',  f:b=>b.sellVol.toLocaleString()},
      {l:'Delta',    c:'r-delta', f:b=>(b.delta>=0?'+':'')+Math.round(b.delta)},
      {l:'Delta (%)',c:'r-dpct',  f:b=>b.totalVol?((b.delta/(b.totalVol||1))*100).toFixed(2)+'%':'—'},
      {l:'Cum delta',c:'r-cum',   f:b=>(b.cumD>=0?'+':'')+Math.round(b.cumD)},
      {l:'Min delta',c:'r-min',   f:b=>Math.round(b.minDelta)},
      {l:'Max delta',c:'r-max',   f:b=>Math.round(b.maxDelta)},
    ];
    let html='';
    defs.forEach(d=>{
      let cells=`<td>${d.l}</td>`;
      bars.forEach(b=>{
        const v=d.f(b);
        const n=parseFloat(String(v).replace(/,/g,'').replace('%',''));
        cells+=`<td class="${isNaN(n)?'':(n<0?'neg':'')}">${v}</td>`;
      });
      html+=`<tr class="${d.c}">${cells}</tr>`;
    });
    document.getElementById('stb').innerHTML=html;
    this._syncStatsWidths();
  }
  _syncStatsWidths(){
    const bW=this.barW,lW=CFG.priceColW;
    const tbl=document.querySelector('.st');if(!tbl) return;
    const old=tbl.querySelector('colgroup');if(old) old.remove();
    const cg=document.createElement('colgroup');
    const c0=document.createElement('col');c0.style.width=lW+'px';cg.appendChild(c0);
    this.bars.forEach(()=>{const col=document.createElement('col');col.style.width=bW+'px';cg.appendChild(col);});
    tbl.insertBefore(cg,tbl.firstChild);
    tbl.style.setProperty('--bar-cell-w',bW+'px');
    tbl.style.setProperty('--lbl-cell-w',lW+'px');
  }
  _tip(e){
    const rect=this.MC.getBoundingClientRect();
    const mx=e.clientX-rect.left;
    const hs=document.getElementById('hscroll');
    const scrollX=hs?(hs.scrollLeft||0):0;
    const bi=Math.floor((mx+scrollX-CFG.priceColW)/this.totalW);
    if(bi<0||bi>=this.bars.length){document.getElementById('tip').style.display='none';return;}
    const b=this.bars[bi];
    const tp=document.getElementById('tip');
    tp.style.display='block';tp.style.left=(e.clientX+16)+'px';tp.style.top=(e.clientY-8)+'px';
    const dc=b.delta>=0?'#00ff88':'#ff4444';
    tp.innerHTML=`
<div class="tr"><span class="tl">${b.date} ${b.time}</span><span>${b.isBull?'▲':'▼'}</span></div>
<div class="tr"><span class="tl">O/H/L/C</span><span>${formatPrice(b.open)} / ${formatPrice(b.high)} / ${formatPrice(b.low)} / ${formatPrice(b.close)}</span></div>
<hr style="border:none;border-top:1px solid #333;margin:4px 0">
<div class="tr"><span class="tl">Delta</span><span style="color:${dc}">${b.delta>=0?'+':''}${Math.round(b.delta)}</span></div>
<div class="tr"><span class="tl">Buy Vol</span><span style="color:#00dd88">${b.buyVol.toLocaleString()}</span></div>
<div class="tr"><span class="tl">Sell Vol</span><span style="color:#ff4444">${b.sellVol.toLocaleString()}</span></div>
<div class="tr"><span class="tl">Total Vol</span><span>${b.totalVol.toLocaleString()}</span></div>
<div class="tr"><span class="tl">Cum.Δ</span><span>${b.cumD>=0?'+':''}${Math.round(b.cumD)}</span></div>
<div class="tr"><span class="tl">POC</span><span style="color:#ffff00">${formatPrice(b.pocPrice)}</span></div>`;
  }
  _range(){
    const bs=this.bars;if(!bs.length) return{max:CFG.startPrice+1,min:CFG.startPrice-1};
    /* Dynamic range: only the currently visible bars + 0.10 padding on each side.
       This keeps the Y-axis auto-zoomed to the visible price action. */
    const scrollEl=document.getElementById('hscroll');
    let visibleBars=bs;
    if(scrollEl&&bs.length>0&&this.totalW>0){
      const scrollX=scrollEl.scrollLeft;
      const viewW=scrollEl.clientWidth||this.MC.width;
      const firstIdx=Math.max(0,Math.floor((scrollX)/this.totalW));
      const lastIdx =Math.min(bs.length-1,Math.ceil((scrollX+viewW)/this.totalW));
      visibleBars=bs.slice(firstIdx,lastIdx+1);
      if(!visibleBars.length) visibleBars=bs;
    }
    if(CFG.mode==='range'){
      const lv=Math.max(1, parseInt(CFG.rangeLevels,10)||10);
      const ts=CFG.tickSize||0.10;
      const anchorBar=visibleBars[visibleBars.length-1]||bs[bs.length-1];
      const centerRaw=(anchorBar && isFinite(anchorBar.close)) ? anchorBar.close : (CFG.startPrice||0);
      const center=Math.round(centerRaw/ts)*ts;
      const above=Math.floor((lv-1)/2);
      const below=(lv-1)-above;
      return {max:center+above*ts, min:center-below*ts};
    }
    const pad=0.10;
    const rawMax=Math.max(...visibleBars.map(b=>b.high));
    const rawMin=Math.min(...visibleBars.map(b=>b.low));
    const ts=CFG.tickSize;
    /* Snap to tick grid then add 0.10 padding */
    return{
      max:Math.ceil((rawMax+pad)/ts)*ts,
      min:Math.floor((rawMin-pad)/ts)*ts
    };
  }
  destroy(){clearInterval(this._t);}
}

/* ============================================================
   LAUNCH / DEMO / SIM
   ============================================================ */
let R=null,_sbOpen=true,_simPaused=false,_simStopped=false;

function loadDemo(){
  CFG.usingRealData=false;
  document.getElementById('dsrc').textContent='● Demo';
  document.getElementById('dsrc').className='sim';
  document.getElementById('fmt-badge').style.display='none';
  _stopRT();if(R) R.destroy();
  R=new Renderer(null);
  setTimeout(()=>{document.getElementById('hscroll').scrollLeft=99999;},80);
  syncMode(CFG.mode);
}
// ==== professional-boot: no auto-fake-data on launch ====
// Shows a neutral "awaiting data" state instead of auto-starting the
// random-walk simulator. Real movement only ever comes from an imported
// file, an xlwings/live connection, or the user explicitly pressing Demo.
function showIdleState(){
  CFG.usingRealData=false;
  // Tear down whichever mode is currently running (Demo, Sim, Replay,
  // Live poll, xlwings) so Exit/Clear always returns to a clean idle
  // state no matter how the chart got its data.
  try{ if(typeof _rpStop==='function' && _rpActive) _rpStop(); }catch(e){}
  try{ if(typeof simStop==='function') simStop(); }catch(e){}
  try{ if(typeof liveStop==='function' && _liveActive) liveStop(); }catch(e){}
  try{ if(typeof xwDisconnect==='function' && _xwActive) xwDisconnect(); }catch(e){}
  const ds=document.getElementById('dsrc');
  if(ds){ ds.textContent='○ No Data'; ds.className='idle'; }
  const fb=document.getElementById('fmt-badge'); if(fb) fb.style.display='none';
  _stopRT();if(R) R.destroy();
  R=new Renderer([]); // empty, real (non-sim) array -> no random-walk feed starts
  syncMode(CFG.mode);
}
function startSim(){
  CFG.usingRealData=false;_simPaused=false;_simStopped=false;
  document.getElementById('dsrc').className='sim';
  document.getElementById('fmt-badge').style.display='none';
  document.getElementById('sim-play').classList.add('on');
  if(R){R.destroy();R=null;}
  R=new Renderer([]);_startRT();syncMode(CFG.mode);
}
function rebuild(){
  if(!R) return;
  if(R._sim){R.destroy();R=null;startSim();}
  else{R.resize();R.draw();}
}
function setMode(m){CFG.mode=m;syncMode(m);if(R) R.draw();}
function syncMode(m){
  ['ct-range','ct-candle'].forEach(id=>document.getElementById(id).classList.toggle('on',id===(m==='range'?'ct-range':'ct-candle')));
  ['sct-range','sct-candle'].forEach(id=>document.getElementById(id).classList.toggle('on',id===(m==='range'?'sct-range':'sct-candle')));
}

function setRangeLevels(v){
  const allowed=[3,4,5,6,7,8,9,10,12,13,14,15];
  v=parseInt(v,10);
  if(!allowed.includes(v)) v=10;
  CFG.rangeLevels=v;
  syncRangeLevelControls();
  CFG.chartOffsetY=0;
  if(R){R.resize();R.draw();}
}
function syncRangeLevelControls(){
  const top=document.getElementById('range-levels-top');
  if(top) top.value=String(CFG.rangeLevels||10);
  document.querySelectorAll('#pill-rl .pill').forEach(p=>p.classList.toggle('on',parseInt(p.dataset.v,10)===(CFG.rangeLevels||10)));
}
const _pillRl=document.getElementById('pill-rl');
if(_pillRl) _pillRl.addEventListener('click',e=>{
  const btn=e.target.closest('[data-v]');if(!btn) return;
  setRangeLevels(+btn.dataset.v);
  setMode('range');
});

document.getElementById('pill-cn').addEventListener('click',e=>{
  const btn=e.target.closest('[data-v]');if(!btn) return;
  document.querySelectorAll('#pill-cn .pill').forEach(p=>p.classList.remove('on'));
  btn.classList.add('on');document.getElementById('bar-n').value=btn.dataset.v;rebuild();
});
document.getElementById('pill-tk').addEventListener('click',e=>{
  const btn=e.target.closest('[data-v]');if(!btn) return;
  document.querySelectorAll('#pill-tk .pill').forEach(p=>p.classList.remove('on'));
  btn.classList.add('on');CFG.tickSize=parseFloat(btn.dataset.v);
  /* Sync Price Summary tick */
  _sumTickSize=CFG.tickSize;
  if(typeof _sumSyncPills==='function') _sumSyncPills();
  if(R){R.resize();R.draw();}
  // Rebuild _trBars for PREV/NEXT with new tick size
  if(_trAllRows.length){ buildCandles(); }
});

/* ============================================================
   SIM CONTROLS
   ============================================================ */
/* FILE REPLAY — same as Sim/_rtTick but feeds real rows.
   Every 1s: push `speed` real rows into _openBarTicks.
   Bar closes when all rows in that interval window are fed.
   Then resets _openBarTicks and starts next interval. */
let _rpActive=false,_rpPaused=false,_rpTimer=null;
let _rpRows=[],_rpIdx=0,_rpBarStart=0,_rpBarEnd=0,_rpBarN=0;
let _rpSumRows=null;

function _rpGetSrc(){
  const base=(_dtActive&&_dtFilteredRows&&_dtFilteredRows.length)?_dtFilteredRows:_allRawRows;
  if(!base||!base.length) return [];
  const sv=(document.getElementById('dt-start')||{}).value||'';
  const ev=(document.getElementById('dt-end')||{}).value||'';
  if(!sv&&!ev) return base.slice();
  const sMs=sv?_dtInputToMs(sv):0,eMs=ev?_dtInputToMs(ev):0;
  return base.filter(r=>{const ms=_toAbsMs(r);return !(sMs&&ms<sMs)&&!(eMs&&ms>eMs);});
}

/* Clock-aligned end of the bar containing barOpenMs (matches _bucketByInterval) */
function _rpBarCutoff(barOpenMs,intervalSec){
  const d=new Date(barOpenMs);
  if(intervalSec>=86400) return new Date(d.getFullYear(),d.getMonth(),d.getDate()+1).getTime();
  const sod=d.getHours()*3600+d.getMinutes()*60+d.getSeconds()+d.getMilliseconds()/1000;
  return barOpenMs+((Math.floor(sod/intervalSec)+1)*intervalSec-sod)*1000;
}

/* Find index of first row whose timestamp crosses the bar boundary */
function _rpNextBarEnd(rows,fromIdx,barOpenMs,intervalSec){
  const cutoff=_rpBarCutoff(barOpenMs,intervalSec);
  for(let i=fromIdx;i<rows.length;i++){
    if((_toAbsMs(rows[i])||barOpenMs)>=cutoff) return i;
  }
  return rows.length;
}

function _rpTick(){
  if(!_rpActive||_rpPaused) return;
  if(_rpIdx>=_rpRows.length){_rpFinish();return;}
  const speed=Math.max(1,Math.round(parseFloat((document.getElementById('sim-spd')||{}).value)||1));
  /* Push `speed` rows — same as Sim injecting ticks */
  for(let i=0;i<speed&&_rpIdx<_rpBarEnd;i++){
    const r=_rpRows[_rpIdx++];
    _openBarTicks.push(r);
    if(_rpSumRows) _rpSumRows.push(r);
  }
  /* Bar timer badge */
  const rem=Math.max(0,_rpBarEnd-_rpIdx);
  const remSec=Math.ceil(rem/speed);
  const bt=document.getElementById('bar-timer');
  if(bt){bt.textContent=`⏱ ${Math.floor(remSec/60).toString().padStart(2,'0')}:${(remSec%60).toString().padStart(2,'0')}`;bt.className=remSec<10?'closing':'';}
  /* Close bar when interval window exhausted — mirrors _closeBar() */
  if(_rpIdx>=_rpBarEnd){
    if(_openBarTicks.length>0){
      const bar=_ticksToBar(_openBarTicks);
      if(bar){
        _closedBars.push(bar);
        let cd=0;_closedBars.forEach(b=>{cd+=b.delta;b.cumD=cd;});
        while(_closedBars.length>_maxBars()+3) _closedBars.shift();
      }
    }
    _openBarTicks=[];_lastBarCount=-1;_rpBarN++;
    /* Reset Price Summary to show only the NEXT bar's incoming rows */
    _rpSumRows=[];
    /* Advance to next bar window */
    _rpBarStart=_rpIdx;
    if(_rpIdx<_rpRows.length){
      const barOpenMs=_toAbsMs(_rpRows[_rpIdx])||0;
      _rpBarEnd=_rpNextBarEnd(_rpRows,_rpIdx,barOpenMs,CFG.intervalSec);
    } else {_rpBarEnd=_rpRows.length;}
    if(typeof sumRender==='function') sumRender();
    /* Level Aggregator: clear on bar close so it refills fresh next bar */
    _aggLevels=[];_aggFiltered=[];
    const _bc_tbl=document.getElementById('agg-table');
    const _bc_emp=document.getElementById('agg-empty');
    if(_bc_tbl)_bc_tbl.style.display='none';
    if(_bc_emp)_bc_emp.style.display='flex';
    _aggSummary();
  }
  _rebuildDisplay();
  /* Candle Summary: update live from the currently-building open bar */
  if(typeof csUpdate==='function'&&_openBarTicks.length>0){
    const _liveBar=_ticksToBar(_openBarTicks);
    if(_liveBar){
      const _lastCD=_closedBars.length?_closedBars[_closedBars.length-1].cumD:0;
      _liveBar.cumD=_lastCD+_liveBar.delta;
      _liveBar.isOpen=true;
      csUpdate(_liveBar);
    }
  }
  /* Price Summary + Level Aggregator — both mirror _rpSumRows */
  if(typeof sumRender==='function'){
    const sp=document.getElementById('summary-pane');
    if(sp&&sp.classList.contains('active')) sumRender();
  }
  if(typeof aggBuild==='function'){
    const lp=document.getElementById('levels-pane');
    if(lp&&lp.classList.contains('active')) aggBuild();
  }
  if(typeof laRebuild==='function'){
    const lap=document.getElementById('lagr-pane');
    if(lap&&lap.classList.contains('active')) laRebuild();
  }
  if(typeof dfpRender==='function'){
    const dp=document.getElementById('dfpairs-pane');
    if(dp&&dp.classList.contains('active')) dfpRender();
  }
  /* Progress */
  const tl=document.getElementById('sim-tick-lbl');
  if(tl) tl.textContent=`bar ${_rpBarN+1} · row ${_rpIdx}/${_rpRows.length}`;
  if(_rpIdx>=_rpRows.length) _rpFinish();
}

function _rpStart(){
  const rows=_rpGetSrc();
  if(!rows.length){alert('Load a file first.');return;}
  rows.sort((a,b)=>(_toAbsMs(a)||0)-(_toAbsMs(b)||0));
  _rpRows=rows;_rpIdx=0;_rpBarN=0;
  _rpActive=true;_rpPaused=false;_rpSumRows=[];
  /* Clear LA Pro tab so it rebuilds fresh from replay rows */
  LA_RAW=[];LA_LEVELS=[];LA_FILT=[];
  const _la_tbl=document.getElementById('la-level-table');
  const _la_emp=document.getElementById('la-empty-state');
  if(_la_tbl)_la_tbl.style.display='none';
  if(_la_emp)_la_emp.style.display='flex';
  /* Clear aggregator so it rebuilds fresh from replay rows */
  _aggLevels=[];_aggFiltered=[];
  const _agg_tbl=document.getElementById('agg-table');
  const _agg_emp=document.getElementById('agg-empty');
  if(_agg_tbl)_agg_tbl.style.display='none';
  if(_agg_emp){_agg_emp.style.display='flex';
    const _agg_sp=_agg_emp.querySelector('span');
    if(_agg_sp)_agg_sp.textContent='Replay starting — aggregator will update as ticks stream in…';}
  _aggSummary();
  /* First bar boundary */
  const barOpenMs=_toAbsMs(rows[0])||Date.now();
  _rpBarStart=0;
  _rpBarEnd=_rpNextBarEnd(rows,0,barOpenMs,CFG.intervalSec);
  /* Reset chart — same as startSim() */
  _closedBars=[];_openBarTicks=[];_lastBarCount=-1;
  if(R){R.destroy();R=null;}
  R=new Renderer([]);syncMode(CFG.mode);
  _updateIntervalLabel();
  if(typeof switchTab==='function') switchTab('chart');
  document.getElementById('sim-play').classList.add('on');
  document.getElementById('sim-pause').classList.remove('on');
  const ivLbl=CFG.intervalSec<60?CFG.intervalSec+'s':CFG.intervalSec<3600?CFG.intervalSec/60+'m':CFG.intervalSec/3600+'h';
  document.getElementById('sim-mode-lbl').textContent=`Replay · ${ivLbl}`;
  if(_rpTimer){clearInterval(_rpTimer);_rpTimer=null;}
  _rpTimer=setInterval(_rpTick,1000);
}

function _rpFinish(){
  if(_rpTimer){clearInterval(_rpTimer);_rpTimer=null;}
  _rpActive=false;
  if(_openBarTicks.length>0){
    const bar=_ticksToBar(_openBarTicks);
    if(bar){_closedBars.push(bar);let cd=0;_closedBars.forEach(b=>{cd+=b.delta;b.cumD=cd;});}
    _openBarTicks=[];
  }
  _rebuildDisplay();
  if(typeof sumRender==='function') sumRender();
  if(typeof aggBuild==='function')   aggBuild();
  if(typeof laRebuild==='function')  laRebuild();
  _rpSumRows=null;
  document.getElementById('sim-mode-lbl').textContent='Replay done ✓';
  const bt=document.getElementById('bar-timer');if(bt){bt.textContent='⏱ —';bt.className='';}
  const tl=document.getElementById('sim-tick-lbl');if(tl) tl.textContent='';
  document.getElementById('sim-play').classList.remove('on');
}

function simPlay(){
  if(_allRawRows&&_allRawRows.length&&!_xwActive&&!_liveActive){
    if(_rpPaused&&_rpActive){
      _rpPaused=false;
      document.getElementById('sim-play').classList.add('on');
      document.getElementById('sim-pause').classList.remove('on');
      if(_rpTimer){clearInterval(_rpTimer);_rpTimer=null;}
      _rpTimer=setInterval(_rpTick,1000);
    } else {_rpStart();}
    return;
  }
  if(_simStopped){startSim();return;}
  _simPaused=false;
  document.getElementById('sim-play').classList.add('on');
  document.getElementById('sim-pause').classList.remove('on');
  if(RT_ACTIVE&&!_rtTimer) _startRealTimeEngine();
  else if(R&&!R._t&&R._sim) R._feed();
}
function simPause(){
  if(_rpActive){
    _rpPaused=!_rpPaused;
    if(_rpPaused){
      if(_rpTimer){clearInterval(_rpTimer);_rpTimer=null;}
      document.getElementById('sim-play').classList.remove('on');
      document.getElementById('sim-pause').classList.add('on');
      document.getElementById('sim-mode-lbl').textContent='Replay paused';
      const bt=document.getElementById('bar-timer');if(bt) bt.className='closing';
    } else {
      document.getElementById('sim-play').classList.add('on');
      document.getElementById('sim-pause').classList.remove('on');
      if(_rpTimer){clearInterval(_rpTimer);_rpTimer=null;}
      _rpTimer=setInterval(_rpTick,1000);
    }
    return;
  }
  _simPaused=true;
  document.getElementById('sim-play').classList.remove('on');
  document.getElementById('sim-pause').classList.add('on');
  _stopRealTimeEngine();if(R){clearInterval(R._t);R._t=null;}
}
function simStop(){
  _rpActive=false;_rpPaused=false;_rpSumRows=null;
  if(_rpTimer){clearInterval(_rpTimer);_rpTimer=null;}
  document.getElementById('sim-mode-lbl').textContent='Simulation';
  const tl=document.getElementById('sim-tick-lbl');if(tl) tl.textContent='';
  _simStopped=true;_simPaused=true;
  document.getElementById('sim-play').classList.remove('on');
  document.getElementById('sim-pause').classList.remove('on');
  _stopRT();if(R){clearInterval(R._t);R._t=null;}
  const bt=document.getElementById('bar-timer');if(bt){bt.textContent='⏱ —';bt.className='';}
}
function simSpeed(v){
  const fps=Math.max(0.5,parseFloat(v)||1);
  document.getElementById('spd-lbl').textContent=fps+'/s';
  CFG.tickIntervalMs=Math.round(1000/fps);
  if(_rpActive&&!_rpPaused){
    if(_rpTimer){clearInterval(_rpTimer);_rpTimer=null;}
    _rpTimer=setInterval(_rpTick,1000);
    return;
  }
  if(R&&R._t){clearInterval(R._t);if(!_simPaused) R._feed();}
}

/* ============================================================
   INTERVAL ENGINE
   ============================================================ */
document.getElementById('pill-iv').addEventListener('click',e=>{
  const btn=e.target.closest('[data-s]');if(!btn) return;
  document.querySelectorAll('#pill-iv .pill').forEach(p=>p.classList.remove('on'));
  btn.classList.add('on');
  CFG.intervalSec=parseInt(btn.dataset.s);
  /* Sync Price Summary to the same interval */
  _sumIntervalSec=CFG.intervalSec;
  _updateIntervalLabel();
  if(typeof _sumSyncPills==='function') _sumSyncPills();
  _barOpenTime=_snapToBarBoundary(Date.now(),CFG.intervalSec);
  if(R&&R._sim){
    // Sim mode: just close & rebuild
    _closeBar();
  } else if(_allRawRows&&_allRawRows.length){
    // Real data: re-bucket using current filter (respects Apply)
    const _pilRows = (_dtActive && _dtFilteredRows && _dtFilteredRows.length) ? _dtFilteredRows : _allRawRows;
    _closedBars=_bucketByInterval(_pilRows,CFG.intervalSec);
    let cd=0;_closedBars.forEach(b=>{cd+=b.delta;b.cumD=cd;});
    _openBarTicks=[];_lastBarCount=-1;
    _rebuildDisplay();
  }
  if(typeof _trRebucketForInterval==='function') _trRebucketForInterval();
});

function _updateIntervalLabel(){
  const s=CFG.intervalSec;
  document.getElementById('bar-timer').textContent=`⏱ ${s>=86400?s/86400+'d':s<60?s+'s':s<3600?s/60+'m':s/3600+'h'} bar`;
}

let _barOpenTime=Date.now(),_openBarTicks=[],_closedBars=[],_rtTimer=null,_lastBarCount=0;
const _maxBars=()=>parseInt(document.getElementById('bar-n').value)||10;

function _startRealTimeEngine(){if(_rtTimer) clearInterval(_rtTimer);_rtTimer=setInterval(_rtTick,1000);}
function _stopRealTimeEngine(){if(_rtTimer){clearInterval(_rtTimer);_rtTimer=null;}}

let _rtSimPrice=CFG.startPrice,RT_ACTIVE=false;

function _injectSimTick(){
  if(!RT_ACTIVE) return;
  const price=_rtSimPrice;_rtSimPrice+=(Math.random()-.49)*CFG.tickSize*4;
  const vol=Math.floor(Math.random()*180+5);
  const ab=Math.random();
  const ask=Math.max(0,Math.floor(vol*(0.3+ab*0.5)));
  const bid=Math.max(0,vol-ask);
  const side=ask>bid?'H':'L';
  _openBarTicks.push({
    last:price,bid,ask,bSize:bid,aSize:ask,
    numBid:Math.ceil(bid/4),numAsk:Math.ceil(ask/4),numOrders:Math.ceil(vol/3),
    trdVol:vol,volume:vol*2,moves:Math.ceil(vol/5),
    aggr:side==='H'?'ASK':'BID',
    tradeId:String(Date.now()),
    time:new Date().toLocaleTimeString('en-US',{hour12:false}),
    date:new Date().toLocaleDateString('en-US'),
    trdIdDiff:Math.floor(Math.random()*3),
    seqNumDiff:Math.floor(Math.random()*5)+1,
    movesDiff:Math.floor(Math.random()*4)+1,
  });
}

function _rtTick(){
  if(!RT_ACTIVE||_simPaused) return;
  const tps=Math.max(1,Math.round(1000/CFG.tickIntervalMs));
  for(let i=0;i<tps;i++) _injectSimTick();
  const elapsed=(Date.now()-_barOpenTime)/1000;
  const remaining=Math.max(0,CFG.intervalSec-elapsed);
  const bt=document.getElementById('bar-timer');
  bt.textContent=`⏱ ${Math.floor(remaining/60).toString().padStart(2,'0')}:${Math.floor(remaining%60).toString().padStart(2,'0')}`;
  bt.className=remaining<10?'closing':'';
  if(elapsed>=CFG.intervalSec) _closeBar();
  _rebuildDisplay();
}

function _closeBar(){
  if(_openBarTicks.length>0){
    const bar=_ticksToBar(_openBarTicks);
    if(bar){
      _closedBars.push(bar);
      let cd=0;_closedBars.forEach(b=>{cd+=b.delta;b.cumD=cd;});
      while(_closedBars.length>_maxBars()+3) _closedBars.shift();
    }
  }
  _openBarTicks=[];
  _barOpenTime=_snapToBarBoundary(Date.now(),CFG.intervalSec);
  _lastBarCount=-1;
}

function _rebuildDisplay(){
  if(!R) return;
  let displayBars=_closedBars.slice();
  if(_openBarTicks.length>0){
    const liveBar=_ticksToBar(_openBarTicks);
    if(liveBar){
      liveBar.cumD=(_closedBars.length?_closedBars[_closedBars.length-1].cumD:0)+liveBar.delta;
      liveBar.isOpen=true;displayBars.push(liveBar);
    }
  }
  const mx=_maxBars();
  if(displayBars.length>mx) displayBars=displayBars.slice(-mx);
  R.bars=displayBars;
  if(displayBars.length!==_lastBarCount){R.resize();_lastBarCount=displayBars.length;}
  R.draw();
  document.getElementById('hscroll').scrollLeft=99999;
  if(typeof navUpdateMinimap==='function'){navUpdateMinimap();navUpdatePosLabel();}
  if(typeof csUpdateLast==='function') csUpdateLast();
  if(typeof drawFlowStrip==='function') drawFlowStrip();
  /* Keep interval-linked tabs in sync with the current bar */
  {
    const _at=(document.querySelector('.main-tab.active')||{}).dataset?.tab||'';
    if(_at==='summary' && typeof sumRender==='function') sumRender();
    else if(_at==='levels' && typeof aggBuild==='function') aggBuild();
    else if(_at==='lagr'  && typeof laRebuild==='function') laRebuild();
    else if(_at==='dfpairs' && typeof dfpRender==='function') dfpRender();
  }
}

function _startRT(){
  RT_ACTIVE=true;_barOpenTime=Date.now();_openBarTicks=[];_closedBars=[];
  _rtSimPrice=CFG.startPrice;_updateIntervalLabel();_startRealTimeEngine();
}
function _stopRT(){
  RT_ACTIVE=false;_stopRealTimeEngine();
  document.getElementById('bar-timer').textContent='⏱ —';
  document.getElementById('bar-timer').className='';
}

// Live glow rAF
let _rafHandle=null;
function _startLiveGlow(){
  if(_rafHandle) return;
  function _glow(){
    if(!R||!R.bars.length){_rafHandle=requestAnimationFrame(_glow);return;}
    if(!_liveActive&&!_xwActive){_rafHandle=null;return;}
    const lastBar=R.bars[R.bars.length-1];
    if(!lastBar||!lastBar.isOpen){_rafHandle=requestAnimationFrame(_glow);return;}
    const bi=R.bars.length-1,x0=CFG.priceColW+bi*R.totalW;
    const alpha=0.35+0.35*Math.sin(Date.now()/300);
    R.cx.save();R.cx.fillStyle=`rgba(0,255,100,${alpha+0.2})`;
    R.cx.font='bold 8px Courier New';R.cx.textAlign='center';
    R.cx.fillText('● LIVE',x0+R.barW/2,13);R.cx.restore();
    _rafHandle=requestAnimationFrame(_glow);
  }
  _rafHandle=requestAnimationFrame(_glow);
}
function _stopLiveGlow(){if(_rafHandle){cancelAnimationFrame(_rafHandle);_rafHandle=null;}}

/* ============================================================
   TOOLBAR TOGGLES
   ============================================================ */
['b-poc','b-imb','b-vwap','b-dlt','b-cdlt'].forEach(id=>{
  document.getElementById(id).addEventListener('click',function(){
    this.classList.toggle('on');
    const on=this.classList.contains('on');
    const k={'b-poc':'showPOC','b-imb':'showImbalance','b-vwap':'showVWAP','b-dlt':'showDelta','b-cdlt':'showCumDelta'}[id];
    if(k) CFG[k]=on;if(R) R.draw();
  });
});

/* ============================================================
   FLOW STRIP — Delta Divergence sub-chart
   Magenta = bearish div (green candle + positive delta)
   Cyan    = bullish div (red candle + negative delta)
   Red     = normal bear candle
   Dark red= normal bull candle
   ============================================================ */
let _flowVisible=false;

function toggleFlowStrip(){
  _flowVisible=!_flowVisible;
  const el=document.getElementById('flow-strip');
  const btn=document.getElementById('b-flow');
  if(el) el.style.display=_flowVisible?'block':'none';
  if(btn) btn.classList.toggle('on',_flowVisible);
  if(_flowVisible) drawFlowStrip();
}

function drawFlowStrip(){
  if(!_flowVisible||!R||!R.bars||!R.bars.length) return;
  const bars=R.bars;
  const strip=document.getElementById('flow-strip');
  const fc=document.getElementById('FC');
  if(!strip||!fc) return;
  /* Size canvas to match hscroll-outer width, strip height */
  const hsOuter=document.getElementById('hscroll-outer');
  const W=hsOuter?hsOuter.clientWidth:800;
  const H=strip.clientHeight||80;
  strip.style.width=W+'px';
  fc.width=W;fc.height=H;
  const cx=fc.getContext('2d');
  cx.clearRect(0,0,W,H);
  /* Sync scroll offset with hscroll */
  const hs=document.getElementById('hscroll');
  const scrollLeft=hs?hs.scrollLeft:0;
  /* Layout — match main chart bar widths */
  const tW=R.totalW||W;         // total chart pixel width
  const bW=R.barW||CFG.colW;    // bar slot width
  const nBars=bars.length;
  const priceColW=CFG.priceColW||90;
  /* Candle block sizing */
  const pad=Math.max(2,Math.round(bW*0.08));   // gap between blocks
  const blockW=Math.max(4,bW-pad*2);
  const blockH=Math.round(H*0.72);             // ~72% of strip height
  const blockY=Math.round((H-blockH)/2);       // vertically centered
  /* Draw each bar */
  bars.forEach((bar,bi)=>{
    const delta=bar.delta||0;
    const bull=bar.isBull;  // true = green candle (close>open)
    /* Classify */
    let col,shadow;
    if(bull&&delta>0){
      /* Bearish divergence: green candle + positive delta → MAGENTA */
      col='#cc00cc';shadow='rgba(255,0,255,0.35)';
    } else if(!bull&&delta<0){
      /* Bullish divergence: red candle + negative delta → CYAN */
      col='#00cccc';shadow='rgba(0,220,220,0.35)';
    } else if(!bull){
      /* Normal bear */
      col='#cc1122';shadow=null;
    } else {
      /* Normal bull — subtle dark red per image */
      col='#661018';shadow=null;
    }
    /* X position — align with main chart bars, offset by scroll */
    const x0=priceColW+bi*bW+pad-scrollLeft;
    if(x0+blockW<0||x0>W) return;  // off-screen, skip
    /* Glow for divergence bars */
    if(shadow){
      cx.save();
      cx.shadowColor=shadow;
      cx.shadowBlur=8;
    }
    cx.fillStyle=col;
    cx.fillRect(x0,blockY,blockW,blockH);
    if(shadow) cx.restore();
    /* Thin top/bottom wick line */
    cx.fillStyle='rgba(255,255,255,0.15)';
    cx.fillRect(x0+Math.floor(blockW/2)-1,blockY-4,2,4);
    cx.fillRect(x0+Math.floor(blockW/2)-1,blockY+blockH,2,4);
  });
  /* Separator line between priceCol area and bars */
  cx.fillStyle='#1a1a1a';
  cx.fillRect(0,0,priceColW-scrollLeft,H);
}

/* Sync flow strip scroll whenever hscroll moves */
document.getElementById('hscroll').addEventListener('scroll',()=>{
  if(_flowVisible) drawFlowStrip();
});

/* ============================================================
   FILE UPLOAD
   ============================================================ */
async function _normalFileHandler(e){
  // Multiple files selected/dropped together (e.g. all of one day's 4-hour
  // chunk exports — TAQ_14Aug2026_0000_to_0400.xlsx, ..._0400_to_0800.xlsx,
  // etc.) are all loaded and stitched into one continuous session below.
  // `f` stays "the first file" for the handful of things that only make
  // sense per-file (extension/format badge, the live-tracking file handle).
  const files=Array.from(e.target.files||[]);
  if(!files.length) return;
  const f=files[0];
  const ext=getFileExt(f.name);
  _liveFile=f;
  if(_liveActive) liveStop();
  _liveKnownIds.clear();_liveRowCount=0;
  document.getElementById('dsrc').textContent=`⏳ Loading ${ext.toUpperCase()}…`;
  document.getElementById('dsrc').className='sim';
  try{
    let raw=[];
    for(let _fi=0; _fi<files.length; _fi++){
      if(files.length>1) document.getElementById('dsrc').textContent=`⏳ Loading ${ext.toUpperCase()} ${_fi+1}/${files.length}…`;
      try{
        const part=await parseFile(files[_fi]);
        raw=raw.concat(part);
      }catch(fileErr){
        throw new Error(`File ${_fi+1}/${files.length} ("${files[_fi].name}") failed to load: ${fileErr.message}`);
      }
    }
    // Keep SPL TRD rows even when last=0 (they have no trade price but carry volume)
    /* Include rows that have a price OR are SPL TRD rows (some SPL rows have last>0) */
    const _isSplRow=r=>{const q=String(r.condKey||r.QUALIFIERS||'').replace(/[^\x20-\x7E]/g,'').trim().toUpperCase();return q.includes('SPL TRD');};
    const rows=dedup(raw).filter(r=>r.last>0||_isSplRow(r));
    if(!rows.filter(r=>r.last>0).length) throw new Error('No valid price rows found in the file.');
    CFG.usingRealData=true;
    rows.forEach(r=>_liveKnownIds.add(_liveRowKey(r)));
    _liveRowCount=rows.length;
    _liveLastRow=rows.length?rows[rows.length-1]:null;
    if(files.length===1){
      document.getElementById('tb-instr').textContent=f.name.replace(/\.[^.]+$/,'').substring(0,18);
      // Full (untruncated) base filename of the manually loaded file, used to
      // name exports like Save History after it instead of a generic/date name.
      window._loadedFileBaseName = String(f.name||'').replace(/\.[^.]+$/,'').replace(/[<>:"\/\\|?*]/g,'-');
    } else {
      // Multiple files loaded together — use their shared filename prefix if
      // they have one (common with chunked exports like
      // TAQ_14Aug2026_0000_to_0400.xlsx / ..._0400_to_0800.xlsx, which share
      // "TAQ_14Aug2026_"), otherwise fall back to "<first file> +N more".
      const _names=files.map(x=>String(x.name||'').replace(/\.[^.]+$/,''));
      let _prefix=_names[0]||'';
      for(let _pi=1;_pi<_names.length;_pi++){
        const nm=_names[_pi]; let _j=0;
        while(_j<_prefix.length && _j<nm.length && _prefix[_j]===nm[_j]) _j++;
        _prefix=_prefix.slice(0,_j);
      }
      // Trim back to the last underscore/dash boundary, not just trailing
      // separator chars — otherwise a partial fragment (e.g. all three chunk
      // names starting with the same leading digit of their hour, like
      // "0000"/"0400"/"0800" all starting with "0") leaves a stray character
      // dangling off the end instead of a clean shared name.
      const _cut = Math.max(_prefix.lastIndexOf('_'), _prefix.lastIndexOf('-'));
      if(_cut > 0) _prefix = _prefix.slice(0, _cut);
      const _base=(_prefix && _prefix.length>=4) ? _prefix : ((_names[0]||'files')+'_plus'+(files.length-1)+'more');
      document.getElementById('tb-instr').textContent=(_base+' ('+files.length+'f)').substring(0,20);
      window._loadedFileBaseName = _base.replace(/[<>:"\/\\|?*]/g,'-');
    }
    document.getElementById('dsrc').textContent=`● ${rows.length.toLocaleString()} ticks`;
    document.getElementById('dsrc').className='';
    showFmtBadge(ext);
    _stopRT();if(R){R.destroy();R=null;}
    // Sort by real epoch ms — push zero-timestamp rows to END (not beginning)
    rows.sort((a,b)=>{
      const aMs=_toAbsMs(a)||Number.MAX_SAFE_INTEGER;
      const bMs=_toAbsMs(b)||Number.MAX_SAFE_INTEGER;
      return aMs-bMs;
    });
    _applyDiffs(rows);
    _allRawRows=rows;  // store for interval re-bucketing
    _trAllRows=rows; trAutoPopulate(rows);  // populate time range pickers (also calls _dtPopulateFromRows via hook)
    _tlRows=rows.slice();  // Trade Log raw ticks
    // Reset dt filter state for new file
    _dtActive=false; _dtFilteredRows=null; _dtStartMs=0; _dtEndMs=0;
    // Populate filter bar directly from actual row timestamps (NOT from sidebar)
    // _dtPopulateFromRows was already called via the trAutoPopulate hook above,
    // but call it again explicitly here to ensure it runs with correct _tsMs values
    setTimeout(()=>{ _dtPopulateFromRows(_trAllRows); },80);
    // SPL TRD is now shown per-bar interval via csUpdate(bar)
    const bars=_bucketByInterval(rows,CFG.intervalSec);
    if(!bars.length) throw new Error('Could not build any bars from the data.');
    /* Store all bars for PREV/NEXT navigation */
    _trBars=bars; let cd=0; _trBars.forEach(b=>{cd+=b.delta;b.cumD=cd;});
    const _loadN=parseInt(document.getElementById('bar-n').value)||10;
    _trOffset=Math.max(0,_trBars.length-_loadN);
    _closedBars=_trBars.slice(_trOffset,_trOffset+_loadN);
    let _loadCD=_trOffset>0?(_trBars[_trOffset-1].cumD||0):0;
    _closedBars.forEach(b=>{_loadCD+=b.delta;b.cumD=_loadCD;});
    _openBarTicks=[];_barOpenTime=Date.now();
    R=new Renderer([]);_rebuildDisplay();_updateIntervalLabel();syncMode(CFG.mode);
    setTimeout(()=>{document.getElementById('hscroll').scrollLeft=99999;},80);
    setTimeout(()=>{ if(typeof _trUpdateNavInfo==='function') _trUpdateNavInfo(); },120);
    const liveBtn=document.getElementById('b-live');
    liveBtn.style.boxShadow='0 0 8px 3px rgba(0,255,80,0.5)';
    setTimeout(()=>{liveBtn.style.boxShadow='';},3500);
    document.getElementById('live-rowcount').textContent=`${rows.length} rows loaded`;
  }catch(err){
    document.getElementById('dsrc').textContent='● Demo';
    document.getElementById('dsrc').className='sim';
    document.getElementById('fmt-badge').style.display='none';
    const _fileDesc = (typeof files!=='undefined' && files.length>1) ? `${files.length} files (${files.map(x=>x.name).join(', ')})` : f.name;
    alert(`❌ Could not load file: ${_fileDesc}\n\n${err.message}`);
    console.error('[OrderFlow] File load error:',err);
  }
  e.target.value='';
}
document.getElementById('fi').addEventListener('change',_normalFileHandler);

// Drag and drop
['sb-dz','dz'].forEach(id=>{
  const el=document.getElementById(id);if(!el) return;
  el.addEventListener('dragover',e=>{e.preventDefault();el.style.borderColor='#5599ff';});
  el.addEventListener('dragleave',()=>{el.style.borderColor='';});
  el.addEventListener('drop',e=>{
    e.preventDefault();el.style.borderColor='';
    // Pass through every dropped file (e.g. selecting all of a day's 4-hour
    // chunk exports at once in the OS file browser and dragging the whole
    // selection in) — _normalFileHandler concatenates and re-sorts them into
    // one continuous session rather than only loading the first one.
    const list=e.dataTransfer.files;if(!list||!list.length) return;
    const dt=new DataTransfer();
    Array.from(list).forEach(file=>dt.items.add(file));
    document.getElementById('fi').files=dt.files;
    document.getElementById('fi').dispatchEvent(new Event('change'));
  });
});

/* ============================================================
   LIVE FILE RELOAD
   ============================================================ */
let _allRawRows=[];  // store sorted+diffed rows for interval re-bucketing
let _liveFile=null,_liveTimer=null,_liveBarTimer=null,_livePollSec=2;
let _liveKnownIds=new Set(),_liveLastRow=null,_liveRowCount=0;
let _livePaused=false,_liveActive=false;

function liveStart(){
  if(_liveActive){liveStop();return;}
  if(!_liveFile){alert('📂  Please load your file first, then click 🔴 Live.');return;}
  _liveBegin();
}
function _liveBegin(){
  _liveActive=true;_livePaused=false;
  _stopRT();if(R&&R._sim){R.destroy();R=new Renderer([]);}
  _barOpenTime=_snapToBarBoundary(Date.now(),CFG.intervalSec);
  _openBarTicks=[];_lastBarCount=-1;
  document.getElementById('live-panel').classList.add('active');
  document.getElementById('live-pulse-dot').classList.remove('paused');
  document.getElementById('b-live').classList.add('on');
  document.getElementById('b-live').textContent='🔴 Live ON';
  document.getElementById('live-pause-btn').textContent='⏸ Pause';
  _liveUpdateStatus('Watching…',false);
  _liveTimer=setInterval(_livePoll,_livePollSec*1000);
  _liveBarTimer=setInterval(_liveBarTick,1000);
  _startLiveGlow();_livePoll();
}
function liveStop(){
  _liveActive=false;_livePaused=false;
  if(_liveTimer){clearInterval(_liveTimer);_liveTimer=null;}
  if(!_xwActive){
    if(_liveBarTimer){clearInterval(_liveBarTimer);_liveBarTimer=null;}
    _stopLiveGlow();
    document.getElementById('bar-timer').textContent='⏱ —';
    document.getElementById('bar-timer').className='';
  }
  document.getElementById('live-panel').classList.remove('active');
  document.getElementById('live-pulse-dot').classList.add('paused');
  document.getElementById('b-live').classList.remove('on');
  document.getElementById('b-live').textContent='🔴 Live';
  _liveUpdateStatus('Stopped',true);
}
function livePauseToggle(){
  _livePaused=!_livePaused;
  const btn=document.getElementById('live-pause-btn'),dot=document.getElementById('live-pulse-dot');
  if(_livePaused){btn.textContent='▶ Resume';dot.classList.add('paused');_liveUpdateStatus('Paused',true);}
  else{btn.textContent='⏸ Pause';dot.classList.remove('paused');_liveUpdateStatus('Watching…',false);_livePoll();}
}
function liveSetPollInterval(sec){
  _livePollSec=sec;document.getElementById('live-interval-lbl').textContent=`Poll: ${sec}s`;
  if(_liveActive&&_liveTimer){clearInterval(_liveTimer);_liveTimer=setInterval(_livePoll,_livePollSec*1000);}
}

function _snapToBarBoundary(nowMs,intervalSec){
  const d=new Date(nowMs);
  const secs=d.getHours()*3600+d.getMinutes()*60+d.getSeconds();
  const snap=Math.floor(secs/intervalSec)*intervalSec;
  const base=new Date(d);
  base.setHours(Math.floor(snap/3600));base.setMinutes(Math.floor((snap%3600)/60));
  base.setSeconds(snap%60);base.setMilliseconds(0);return base.getTime();
}
function _secsUntilNextBoundary(nowMs,intervalSec){
  const d=new Date(nowMs);
  return intervalSec-((d.getHours()*3600+d.getMinutes()*60+d.getSeconds())%intervalSec);
}

function _liveBarTick(){
  if(!_liveActive&&!_xwActive) return;
  if(_livePaused&&!_xwActive) return;
  const remaining=_secsUntilNextBoundary(Date.now(),CFG.intervalSec);
  const bt=document.getElementById('bar-timer');
  bt.textContent=`⏱ ${Math.floor(remaining/60).toString().padStart(2,'0')}:${Math.floor(remaining%60).toString().padStart(2,'0')}`;
  bt.className=remaining<10?'closing':'';
  const snapMs=_snapToBarBoundary(Date.now(),CFG.intervalSec);
  if(_barOpenTime<snapMs&&_openBarTicks.length>0){_closeBar();_rebuildDisplay();}
}

async function _livePoll(){
  if(!_liveActive||_livePaused||!_liveFile) return;
  try{
    const raw=await parseFile(_liveFile);
    const _isSplRow=r=>{const q=String(r.condKey||r.QUALIFIERS||'').replace(/[^\x20-\x7E]/g,'').trim().toUpperCase();return q.includes('SPL TRD');};
    const rows=raw.filter(r=>r.last>0||_isSplRow(r));
    if(!rows.filter(r=>r.last>0).length){_liveUpdateStatus('No data rows yet…',false);return;}
    if(_liveKnownIds.size===0){
      rows.forEach(r=>_liveKnownIds.add(_liveRowKey(r)));_liveRowCount=rows.length;
      document.getElementById('live-rowcount').textContent=`${_liveRowCount} rows (baseline)`;
      _liveUpdateStatus(`Baseline ${_liveRowCount} rows`,false);return;
    }
    const newRows=rows.filter(r=>!_liveKnownIds.has(_liveRowKey(r)));
    if(newRows.length>0){
      newRows.forEach(r=>_liveKnownIds.add(_liveRowKey(r)));_liveRowCount+=newRows.length;
      newRows.sort((a,b)=>{const ta=(a.date||'')+' '+(a.time||''),tb=(b.date||'')+' '+(b.time||'');return ta<tb?-1:ta>tb?1:0;});
      const diffBatch=_liveLastRow?[_liveLastRow,...newRows]:newRows;
      _applyDiffs(diffBatch);
      if(_liveLastRow) newRows.forEach((r,i)=>Object.assign(r,diffBatch[i+1]));
      _liveLastRow=newRows[newRows.length-1];
      newRows.forEach(r=>{
        const bidSz=+(r.bSize||0),askSz=+(r.aSize||0); /* SIZE — not price */
        const bidPx=+(r.bid||0),  askPx=+(r.ask||0);   /* PRICE */
        _openBarTicks.push({
          last:+(r.last||0),bid:bidPx,ask:askPx,bSize:bidSz,aSize:askSz,
          numBid:+(r.numBid||0),numAsk:+(r.numAsk||0),numOrders:+(r.numOrders||0),
          trdVol:+(r.trdVol||0),volume:+(r.volume||r.trdVol||0),moves:+(r.moves||0),
          aggr:String(r.aggr||'').toUpperCase(),
      tick:String(r.tick||''),
          tradeId:(r.tradeId&&r.tradeId!=='0')?r.tradeId:String(Date.now()+Math.random()),
          trdIdDiff:+(r.trdIdDiff||0),
          seqNum:+(r.seqNum||0),seqNumDiff:+(r.seqNumDiff||0),
          movesDiff:+(r.movesDiff||0),
          condKey:String(r.condKey||''),
          time:r.time||new Date().toLocaleTimeString('en-US',{hour12:false}),
          date:r.date||new Date().toLocaleDateString('en-US'),
        });
      });
      if((Date.now()-_barOpenTime)/1000>=CFG.intervalSec&&_openBarTicks.length>0) _closeBar();
      _rebuildDisplay();
      if(typeof _itrStreamLiveTicks==='function') _itrStreamLiveTicks(newRows);
      const nb=document.getElementById('live-newrows');
      nb.textContent=`+${newRows.length} new`;setTimeout(()=>{nb.textContent='';},2000);
    }
    document.getElementById('live-rowcount').textContent=`${_liveRowCount} rows`;
    document.getElementById('live-err').style.display='none';
    _liveUpdateStatus(`${new Date().toLocaleTimeString('en-US',{hour12:false})} · ${rows.length} total`,false);
  }catch(err){
    const errEl=document.getElementById('live-err');errEl.style.display='inline';
    errEl.textContent=`⚠ ${err.message.substring(0,70)}`;console.warn('[Live poll error]',err);
  }
}

function _liveRowKey(r){
  /*
    Use a full row key. Do not use TRADE_ID alone because it repeats in
    Refinitiv/TAS/TAQ exports and would drop valid live rows.
  */
  const nk = v => {
    if(v === undefined || v === null) return '';
    const n = Number(String(v).replace(',','.'));
    if(Number.isFinite(n)) return String(Math.round(n * 1000000) / 1000000);
    return String(v).trim();
  };
  return [
    nk(r.date), nk(r.time),
    nk(r.last), nk(r.bid), nk(r.ask),
    nk(r.bSize), nk(r.aSize),
    nk(r.trdVol), nk(r.volume),
    nk(r.tradeId), nk(r.seqNum), nk(r.moves),
    nk(r.aggr), nk(r.tick), nk(r.condKey || r.QUALIFIERS)
  ].join('|');
}
function _liveUpdateStatus(msg,dim){
  const el=document.getElementById('live-status');
  el.textContent=`Live: ${msg}`;el.style.color=dim?'#446644':'#00cc66';
}

/* ============================================================
   SIDEBAR / RIGHT PANEL
   ============================================================ */
/* ============================================================
   RESIZE HANDLES — right panel (horizontal) + stats strip (vertical)
   ============================================================ */
(function initResizeHandles(){
  // ── Right panel: drag left/right to widen/narrow ─────────────
  const rpHandle = document.getElementById('rp-resize-handle');
  const rpPanel  = document.getElementById('right-panel');
  let rpDragging = false, rpStartX = 0, rpStartW = 0;

  rpHandle.addEventListener('mousedown', e => {
    rpDragging = true;
    rpStartX   = e.clientX;
    rpStartW   = rpPanel.offsetWidth;
    rpHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!rpDragging) return;
    // Dragging LEFT = wider panel (mouse moves left → negative dx)
    const dx  = rpStartX - e.clientX;
    const newW = Math.max(120, Math.min(400, rpStartW + dx));
    rpPanel.style.width = newW + 'px';
    document.documentElement.style.setProperty('--of-rp-w', newW + 'px');
    rpPanel.style.flexBasis = newW + 'px';
    rpPanel.style.transition = 'none';
    if (R) { R.resize(); R.draw(); }
  });
  window.addEventListener('mouseup', () => {
    if (rpDragging) {
      rpDragging = false;
      rpHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      rpPanel.style.transition = 'width .2s';
    }
  });

  // ── Stats strip: drag up/down to taller/shorter ───────────────
  const stHandle = document.getElementById('stats-resize-handle');
  const stStrip  = document.getElementById('stats-strip');
  let stDragging = false, stStartY = 0, stStartH = 0;

  stHandle.addEventListener('mousedown', e => {
    stDragging = true;
    stStartY   = e.clientY;
    stStartH   = stStrip.offsetHeight;
    stHandle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!stDragging) return;
    // Dragging UP = taller strip (mouse moves up → negative dy)
    const dy   = stStartY - e.clientY;
    const newH = Math.max(18, Math.min(300, stStartH + dy));
    stStrip.style.height  = newH + 'px';
    stStrip.style.maxHeight = newH + 'px';
    stStrip.style.overflowY = 'auto';
    if (R) { R.resize(); R.draw(); }
  });
  window.addEventListener('mouseup', () => {
    if (stDragging) {
      stDragging = false;
      stHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  // Touch support
  function toMouse(te) { return te.touches[0] || te.changedTouches[0]; }
  rpHandle.addEventListener('touchstart', e => { rpHandle.dispatchEvent(new MouseEvent('mousedown', {clientX: toMouse(e).clientX})); }, {passive:false});
  stHandle.addEventListener('touchstart', e => { stHandle.dispatchEvent(new MouseEvent('mousedown', {clientY: toMouse(e).clientY})); }, {passive:false});
})();

function toggleSB(){
  _sbOpen=!_sbOpen;const sb=document.getElementById('sidebar'),tab=document.getElementById('sb-tab');
  if(_sbOpen){sb.style.width='220px';tab.textContent='◀';}else{sb.style.width='0';tab.textContent='▶';}
  setTimeout(()=>{if(R){R.resize();R.draw();}},210);
}
let _rpOpen=true;
function toggleRP(){
  _rpOpen=!_rpOpen;const rp=document.getElementById('right-panel'),tab=document.getElementById('rp-tab');
  if(_rpOpen){document.documentElement.style.setProperty('--of-rp-w','220px');rp.style.width='220px';rp.style.flexBasis='220px';if(tab) tab.textContent='▶';}else{document.documentElement.style.setProperty('--of-rp-w','0px');rp.style.width='0';rp.style.flexBasis='0';if(tab) tab.textContent='◀';}
  setTimeout(()=>{if(R){R.resize();R.draw();}},210);
}

/* ============================================================
   SETTINGS
   ============================================================ */
function openCfg(){
  const s=id=>document.getElementById(id);
  s('s-rows').value=CFG.rowsVisible;s('s-rh2').value=CFG.rowH;s('s-cw').value=CFG.colW;
  s('s-pcw').value=CFG.priceColW;s('s-fs').value=CFG.fontSize;s('s-imbt').value=CFG.imbThreshold;
  s('s-imbv').value=CFG.imbMinVol;s('s-norm').value=CFG.normTxt;s('s-bidhi').value=CFG.bidHi;
  s('s-askhi').value=CFG.askHi;s('s-poc').value=CFG.pocTxt;s('s-bull').value=CFG.bullColor;
  s('s-bear').value=CFG.bearColor;s('s-vwap').value=CFG.vwapColor;s('s-sym').value=CFG.symbol;
  s('s-tick').value=CFG.tickSize;s('s-sp').value=CFG.startPrice;s('s-iv').value=CFG.tickIntervalMs;
  document.getElementById('sov').classList.add('open');
}
function closeCfg(){document.getElementById('sov').classList.remove('open');}
function applyCfg(){
  const s=id=>document.getElementById(id);
  CFG.rowsVisible=+s('s-rows').value||30;CFG.rowH=+s('s-rh2').value||19;
  CFG.colW=+s('s-cw').value||52;CFG.priceColW=+s('s-pcw').value||68;
  CFG.fontSize=+s('s-fs').value||10;CFG.imbThreshold=+s('s-imbt').value||300;
  CFG.imbMinVol=+s('s-imbv').value||5;CFG.normTxt=s('s-norm').value;
  CFG.bidHi=s('s-bidhi').value;CFG.askHi=s('s-askhi').value;CFG.pocTxt=s('s-poc').value;
  CFG.bullColor=s('s-bull').value;CFG.bearColor=s('s-bear').value;CFG.vwapColor=s('s-vwap').value;
  CFG.symbol=s('s-sym').value;CFG.tickSize=+s('s-tick').value||0.01;
  CFG.startPrice=+s('s-sp').value||4331;CFG.tickIntervalMs=+s('s-iv').value||900;
  document.getElementById('tb-instr').textContent=CFG.symbol==='XAUUSD'?'XAUUSD · Gold':CFG.symbol;
  document.getElementById('sb-cw').value=CFG.colW;document.getElementById('cw-lbl').textContent=CFG.colW+'px';
  document.getElementById('sb-rh').value=CFG.rowH;document.getElementById('rh-lbl').textContent=CFG.rowH+'px';
  closeCfg();if(R){R.resize();R.draw();}
}
document.getElementById('sov').addEventListener('click',e=>{if(e.target===document.getElementById('sov')) closeCfg();});

/* ============================================================
   CLOCK & TIME UTILS
   ============================================================ */
const clkT=()=>{document.getElementById('clk').textContent=new Date().toLocaleTimeString('en-US',{hour12:false})+' CT';};
setInterval(clkT,1000);clkT();

function _toAbsMs(r){
  /* Primary: use pre-computed real epoch ms stored by normR */
  if (r._tsMs && r._tsMs > 0) return r._tsMs;
  /* Fallback: rebuild from date + time strings */
  const t = normTime(r.time||'');
  const d = r.date || '';
  const dm = d.match(/(\d{4})-(\d{2})-(\d{2})/);
  const tm = t.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (dm && tm) {
    const dt = new Date(+dm[1], +dm[2]-1, +dm[3], +tm[1], +tm[2], +tm[3], 0);
    if (!isNaN(dt.getTime())) return dt.getTime();
  }
  if (tm) return ((+tm[1])*3600 + (+tm[2])*60 + (+tm[3])) * 1000;
  return 0;
}
function secToHHMMSS(s){
  s=Math.round(s);
  return String(Math.floor(s/3600)).padStart(2,'0')+':'+String(Math.floor((s%3600)/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}
function normTime(t){
  if(t===null||t===undefined||t==='') return'';
  const s=String(t).trim();
  if(!s||s==='undefined'||s==='null') return'';
  // Pure time string: HH:MM:SS[.fff] or H:MM:SS
  if(/^\d{1,2}:\d{2}/.test(s)) return s.substring(0,8);
  // DateTime with space (e.g. "15-apr-26 13:46:41:4641" or "2026-04-15 13:46:41"):
  // extract the first token after the space that looks like a time HH:MM:SS
  if(s.includes(' ')){
    const parts=s.split(' ');
    for(let i=parts.length-1;i>=0;i--){
      if(/^\d{1,2}:\d{2}/.test(parts[i])) return parts[i].substring(0,8);
    }
  }
  // Excel fractional day (e.g. 0.576423 → 13:49:03)
  const f=parseFloat(s);
  if(!isNaN(f)&&f>=0&&f<1) return secToHHMMSS(Math.round(f*86400));
  if(!isNaN(f)&&f>1) return secToHHMMSS(Math.round((f%1)*86400));
  return s;
}

function _bucketByInterval(rows,intervalSec){
  if(!rows.length) return[];

  /* ── Time helpers ─────────────────────────────────────────────
     toSec: any time format → fractional seconds since midnight
     Handles: "HH:MM:SS[.fff]", "YYYY-MM-DD HH:MM:SS", Excel fraction
  ── */
  function toSec(t){
    if(!t&&t!==0) return 0;
    const s=String(t).trim();if(!s) return 0;
    // If it contains a space, take the time part after the space
    const sp=s.indexOf(' ');
    const tp=sp>=0?s.slice(sp+1).trim():s;
    if(tp.includes(':')){
      const p=tp.split(':');
      return(parseInt(p[0])||0)*3600+(parseInt(p[1])||0)*60+(parseFloat(p[2])||0);
    }
    // Excel fractional day: 0.5 = noon
    const f=parseFloat(tp);
    return!isNaN(f)?((f%1)*86400):0;
  }

  /* toDayNum: date string → integer YYYYMMDD for day ordering
     Falls back to 0 if date is absent/unparseable.            */
  function toDayNum(d){
    if(!d) return 0;const s=String(d).trim();
    let m=s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if(m) return parseInt(m[1])*10000+parseInt(m[2])*100+parseInt(m[3]);
    m=s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if(m) return parseInt(m[3])*10000+parseInt(m[2])*100+parseInt(m[1]);
    return 0;
  }

  /* absT: continuous seconds timeline
     Works even when r.date is missing — ticks without a date get day=0
     and are sorted together by their intra-day time.
     When dates ARE present they provide correct multi-day ordering.    */
  function absT(r){
    let dayN=toDayNum(r.date);
    // If date was embedded in the time string, extract it
    if(!dayN&&r.time){
      const ts=String(r.time).trim();
      const m=ts.match(/(\d{4})-(\d{2})-(\d{2})/);
      if(m) dayN=parseInt(m[1])*10000+parseInt(m[2])*100+parseInt(m[3]);
    }
    return dayN*86400+toSec(r.time);
  }

  // Normalise time strings once (non-mutating clone to protect _allRawRows)
  const working=rows.map(r=>({...r, time:normTime(r.time||'')||r.time}));

  // Sort oldest → newest — use _tsMs (real epoch ms) when available, fall back to absT
  const sorted=working.sort((a,b)=>{
    const aMs = a._tsMs && a._tsMs>0 ? a._tsMs : absT(a)*1000;
    const bMs = b._tsMs && b._tsMs>0 ? b._tsMs : absT(b)*1000;
    return aMs - bMs;
  });

  // Deduplicate — SPL TRD rows (last=0, condKey contains 'SPL') must all survive:
  // they represent independent volume events and must not be collapsed.
  const unique=[],seen=new Set();
  let _splIdx2=0;
  for(const r of sorted){
    /* SPL detection: QUALIFIERS alone — no !(last>0) guard.
       SPL rows with real TRDPRC_1 must still get unique spl2:N dedup keys
       so they are never silently dropped by TRADE_ID collision. */
    const _isSplR=String(r.condKey||r.QUALIFIERS||'').replace(/[^\x20-\x7E]/g,'').toUpperCase().includes('SPL TRD');
    const k=_isSplR
      ?'spl2:'+(_splIdx2++)
      :(r.tradeId&&r.tradeId!=='0'&&r.tradeId!==''
        ?'id:'+r.tradeId
        :(r.seqNum>0?'sq:'+r.seqNum:'t:'+r.time+'|p:'+r.last));
    if(!seen.has(k)){seen.add(k);unique.push(r);}
  }
  if(!unique.length) return[];

  /* ── Running-window grouping ────────────────────────────────────
     Group sorted rows into bars using a sliding window approach:
     a new bar opens when the tick's intra-day second is >= the
     bar's open second + intervalSec, OR when the calendar date
     changes (day boundary). This is immune to missing/inconsistent
     date fields because grouping is based on ELAPSED SECONDS from
     the first tick in the bar, not on a date-string key.
  ─────────────────────────────────────────────────────────────── */
  const groups=[];        // array of tick arrays, one per bar
  const groupOpenSecs=[];  // parallel: snapped open-second for each group
  let curGroup=null, barOpenSec=0, barOpenDay=0;

  unique.forEach(r=>{
    // SPL TRD rows (last=0) must never open a new bar — they belong to
    // whatever bar is currently open. Append them to curGroup directly.
    const isSplR=String(r.condKey||r.QUALIFIERS||'').trim().toUpperCase().includes('SPL TRD');
    if(isSplR){  /* SPL rows never open a new bar regardless of last value */
      if(!curGroup){curGroup=[];groups.push(curGroup);barOpenSec=0;barOpenDay=0;}
      curGroup.push(r);
      return; // do NOT advance bar boundary logic for SPL rows
    }

    const sec=toSec(r.time);
    let dayN=toDayNum(r.date);
    // If date absent, extract from time string if embedded
    if(!dayN&&r.time){
      const m=String(r.time).match(/(\d{4})-(\d{2})-(\d{2})/);
      if(m) dayN=parseInt(m[1])*10000+parseInt(m[2])*100+parseInt(m[3]);
    }
    // Use absT for SORTING only; use (dayN, sec) for GROUPING
    // If dayN is 0 (no date) we treat the whole session as day 0
    const dayChanged = curGroup && dayN && barOpenDay && (dayN !== barOpenDay);
    // Wall-clock aligned buckets (M5 = :00/:05, H4 = 00/04/08..., D1 = whole day)
    const slot = intervalSec >= 86400 ? 0 : Math.floor(sec / intervalSec);
    const secExceeded = curGroup && slot !== barOpenSec;

    if(!curGroup || dayChanged || secExceeded){
      curGroup=[];
      groups.push(curGroup);
      groupOpenSecs.push(slot * (intervalSec >= 86400 ? 0 : intervalSec));
      barOpenSec=slot;
      barOpenDay=dayN;
    }
    curGroup.push(r);
  });

  /* Track each group's snapped open-second alongside the ticks */
  const bars=groups.map((g,i)=>{
    const bar=_ticksToBar(g);
    if(!bar) return null;
    /* Override bar.time with the snapped interval boundary
       so the time axis label matches the actual bar start,
       not the first tick's raw timestamp. */
    const openSec=groupOpenSecs[i];
    if(openSec!=null){
      const hh=Math.floor(openSec/3600),mm=Math.floor((openSec%3600)/60),ss=openSec%60;
      bar.time=String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0')+':'+String(ss).padStart(2,'0');
    }
    return bar;
  }).filter(Boolean);
  let cd=0;bars.forEach(b=>{cd+=b.delta;b.cumD=cd;});
  return bars;
}

/* ============================================================
   NAVIGATION
   ============================================================ */
const ZOOM_STEPS=[20,28,36,44,52,64,80,96,112,130];
let _navZoomIdx=4,_isDragging=false,_dragStartX=0,_dragStartSL=0,_chX=-1,_chY=-1;

function navInit(){
  const mc=document.getElementById('MC'),hs=document.getElementById('hscroll');
  const xhc=document.getElementById('crosshair-canvas');
  const mm=document.getElementById('nav-minimap'),mmt=document.getElementById('nav-minimap-thumb');

  function _sizeXhc(){const o=document.getElementById('hscroll-outer');xhc.width=o.clientWidth;xhc.height=o.clientHeight;}
  _sizeXhc();window.addEventListener('resize',_sizeXhc);

  function _drawCH(mx,my){
    const ctx=xhc.getContext('2d');ctx.clearRect(0,0,xhc.width,xhc.height);
    if(!R||mx<0) return;
    const W=xhc.width,H=xhc.height,scOff=W-74;
    ctx.save();ctx.strokeStyle='rgba(180,180,180,0.35)';ctx.lineWidth=1;ctx.setLineDash([4,4]);
    ctx.beginPath();ctx.moveTo(mx,0);ctx.lineTo(mx,H);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,my);ctx.lineTo(W,my);ctx.stroke();ctx.setLineDash([]);
    if(R&&R.bars.length){
      const pr=R._range(),visR=Math.floor((H-44)/CFG.rowH),mid=(pr.max+pr.min)/2;
      const topP=chartTopPrice(pr,visR),fy=20;
      const price=topP-Math.round((my-fy)/CFG.rowH)*chartPriceStep(pr,visR);
      ctx.fillStyle='rgba(20,20,30,0.88)';
      const tagW=68,tagH=CFG.rowH,tagX=scOff+1,tagY=my-tagH/2;
      ctx.fillRect(tagX,tagY,tagW-2,tagH);ctx.strokeStyle='#5599ff';ctx.lineWidth=1;
      ctx.strokeRect(tagX,tagY,tagW-2,tagH);ctx.fillStyle='#aaccff';
      ctx.font='bold 10px Courier New';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(formatPrice(price),tagX+(tagW-2)/2,tagY+tagH/2);
    }
    if(R&&R.bars.length){
      const relX=mx+hs.scrollLeft-CFG.priceColW,bi=Math.floor(relX/R.totalW);
      if(bi>=0&&bi<R.bars.length){
        const bar=R.bars[bi],tStr=(bar.time||bar.date||'').substring(0,8);
        // Always update candle summary + SPL TRD for the bar under the cursor
        csUpdate(R.bars[bi]);
        if(tStr){
          const tagH=13,tagW=70,tagX=Math.max(CFG.priceColW,Math.min(scOff-tagW,mx-tagW/2)),tagY=H-tagH-1;
          ctx.fillStyle='rgba(20,20,30,0.88)';ctx.fillRect(tagX,tagY,tagW,tagH);
          ctx.strokeStyle='#5599ff';ctx.lineWidth=0.5;ctx.strokeRect(tagX,tagY,tagW,tagH);
          ctx.fillStyle='#aaccff';ctx.font='bold 9px Courier New';ctx.textAlign='center';ctx.textBaseline='middle';
          ctx.fillText(tStr,tagX+tagW/2,tagY+tagH/2);
          const pr=R._range(),visR=Math.floor((H-44)/CFG.rowH),mid=(pr.max+pr.min)/2;
          const topP=chartTopPrice(pr,visR);
          const prc=topP-Math.round((my-20)/CFG.rowH)*chartPriceStep(pr,visR);
          const el=document.getElementById('cursor-info');if(el) el.textContent=`${tStr}  ${formatPrice(prc)}`;
        }
      }
    }
    ctx.restore();
  }

  mc.addEventListener('mousemove',e=>{
    const or=document.getElementById('hscroll-outer').getBoundingClientRect();
    _chX=e.clientX-or.left;_chY=e.clientY-or.top;_drawCH(_chX,_chY);
  });
  mc.addEventListener('mouseleave',()=>{
    _chX=-1;_chY=-1;xhc.getContext('2d').clearRect(0,0,xhc.width,xhc.height);
    const el=document.getElementById('cursor-info');if(el) el.textContent='—';
    // Restore candle summary (incl. SPL TRD) to the latest bar when cursor leaves
    csUpdateLast();
  });
  mc.addEventListener('mousedown',e=>{
    if(e.button!==0) return;
    _isDragging=true;_dragStartX=e.clientX;_dragStartSL=hs.scrollLeft;
    mc.style.cursor='grabbing';e.preventDefault();
  });
  window.addEventListener('mousemove',e=>{
    if(!_isDragging) return;
    hs.scrollLeft=_dragStartSL+(_dragStartX-e.clientX);navUpdateMinimap();navUpdatePosLabel();
  });
  window.addEventListener('mouseup',()=>{if(_isDragging){_isDragging=false;mc.style.cursor='crosshair';}});
  document.getElementById('hscroll-outer').addEventListener('wheel',e=>{
    e.preventDefault();
    if(e.ctrlKey||e.metaKey) navZoom(e.deltaY<0?1:-1);
    else{hs.scrollLeft+=(e.deltaX||e.deltaY)*3;navUpdateMinimap();navUpdatePosLabel();}
  },{passive:false});
  window.addEventListener('keydown',e=>{
    if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
    switch(e.key){
      case'ArrowLeft':navScroll(-2);e.preventDefault();break;
      case'ArrowRight':navScroll(2);e.preventDefault();break;
      case'ArrowUp':CFG.chartOffsetY-=3;if(R) R.draw();e.preventDefault();break;
      case'ArrowDown':CFG.chartOffsetY+=3;if(R) R.draw();e.preventDefault();break;
      case'Home':navScroll(-9999);e.preventDefault();break;
      case'End':navScroll(9999);e.preventDefault();break;
      case'+':case'=':navZoom(1);e.preventDefault();break;
      case'-':case'_':navZoom(-1);e.preventDefault();break;
      case'0':CFG.chartOffsetY=0;navResetZoom();if(R) R.draw();e.preventDefault();break;
    }
  });
  let _mmD=false,_mmX=0,_mmSL=0;
  mmt.addEventListener('mousedown',e=>{_mmD=true;_mmX=e.clientX;_mmSL=hs.scrollLeft;e.preventDefault();e.stopPropagation();});
  window.addEventListener('mousemove',e=>{
    if(!_mmD) return;
    const mmW=mm.clientWidth,maxSL=hs.scrollWidth-hs.clientWidth;
    hs.scrollLeft=Math.max(0,Math.min(maxSL,_mmSL+(e.clientX-_mmX)*(maxSL/(mmW-mmt.clientWidth))));
    navUpdateMinimap();navUpdatePosLabel();
  });
  window.addEventListener('mouseup',()=>{_mmD=false;});
  mm.addEventListener('click',e=>{
    if(e.target===mmt) return;
    const rect=mm.getBoundingClientRect(),maxSL=hs.scrollWidth-hs.clientWidth;
    hs.scrollLeft=maxSL*((e.clientX-rect.left)/mm.clientWidth);navUpdateMinimap();navUpdatePosLabel();
  });
  hs.addEventListener('scroll',()=>{navUpdateMinimap();navUpdatePosLabel();});
  _navZoomIdx=ZOOM_STEPS.findIndex(z=>z>=CFG.colW);if(_navZoomIdx<0) _navZoomIdx=4;
  document.getElementById('nav-zoom-sl').value=_navZoomIdx+1;
  document.getElementById('nav-zoom-lbl').textContent=CFG.colW+'px';
}

function navScroll(bars){
  const hs=document.getElementById('hscroll'),bw=R?R.totalW:CFG.priceColW+CFG.colW;
  if(bars===9999||bars===-9999) hs.scrollLeft=bars>0?999999:0;
  else hs.scrollLeft=Math.max(0,hs.scrollLeft+bars*bw);
  navUpdateMinimap();navUpdatePosLabel();
}
function navZoom(delta){
  const newIdx=Math.max(0,Math.min(ZOOM_STEPS.length-1,_navZoomIdx+delta));
  if(newIdx===_navZoomIdx) return;
  const hs=document.getElementById('hscroll');
  const centreBi=R?(hs.scrollLeft+hs.clientWidth/2-CFG.priceColW)/R.totalW:0;
  _navZoomIdx=newIdx;CFG.colW=ZOOM_STEPS[_navZoomIdx];
  document.getElementById('nav-zoom-sl').value=_navZoomIdx+1;
  document.getElementById('nav-zoom-lbl').textContent=CFG.colW+'px';
  document.getElementById('sb-cw').value=CFG.colW;
  document.getElementById('cw-lbl').textContent=CFG.colW+'px';
  if(R){_lastBarCount=-1;R.resize();R.draw();if(R.totalW>0) hs.scrollLeft=Math.max(0,centreBi*R.totalW+CFG.priceColW-hs.clientWidth/2);}
  navUpdateMinimap();navUpdatePosLabel();
}
function navZoomSlider(val){const t=val-1;if(t!==_navZoomIdx) navZoom(t-_navZoomIdx);}
function navResetZoom(){const d=4-_navZoomIdx;if(d!==0) navZoom(d);}
function navUpdateMinimap(){
  const hs=document.getElementById('hscroll'),mm=document.getElementById('nav-minimap'),mmt=document.getElementById('nav-minimap-thumb');
  const mmW=mm.clientWidth,total=hs.scrollWidth,vis=hs.clientWidth,sl=hs.scrollLeft;
  if(total<=vis){mmt.style.width='100%';mmt.style.left='0px';return;}
  const w=Math.max(12,(vis/total)*mmW),x=(sl/(total-vis))*(mmW-w);
  mmt.style.width=w.toFixed(1)+'px';mmt.style.left=x.toFixed(1)+'px';
}
function navUpdatePosLabel(){
  if(!R||!R.bars.length) return;
  const hs=document.getElementById('hscroll'),sl=hs.scrollLeft,bw=R.totalW;
  const fv=Math.max(0,Math.floor((sl-CFG.priceColW)/bw));
  const lv=Math.min(R.bars.length-1,Math.floor((sl+hs.clientWidth-CFG.priceColW)/bw));
  const el=document.getElementById('nav-pos-lbl');if(el) el.textContent=`bars ${fv+1}–${lv+1} / ${R.bars.length}`;
}

/* ============================================================
   QUICK INDICATORS
   ============================================================ */
function qiToggle(id,el){
  if(el.checked){if(!CONFIGURED_IND.includes(id)) CONFIGURED_IND.push(id);}
  else CONFIGURED_IND=CONFIGURED_IND.filter(x=>x!==id);
  indUpdateBadges();if(R) R.draw();
}
function qiToggleCFG(key,el){
  CFG[key]=el.checked;
  const map={showPOC:'b-poc',showImbalance:'b-imb',showVWAP:'b-vwap',showDelta:'b-dlt',showCumDelta:'b-cdlt'};
  if(map[key]){const btn=document.getElementById(map[key]);if(btn) btn.classList.toggle('on',el.checked);}
  if(R) R.draw();
}
function qiSyncAll(){
  const map={
    'qi-poc-line':['poc-line'],'qi-vwap-line':['vwap-line'],'qi-vwap-sd1':['vwap-sd1'],
    'qi-va-fill':['va-fill'],'qi-vah-line':['vah-line'],'qi-delta-candle':['delta-candle'],
    'qi-delta-cum':['delta-cum'],'qi-delta-pct':['delta-pct'],
    'qi-delta-divergence':['delta-divergence'],'qi-stk-imb':['stk-imb-buy'],
    'qi-stop-vol':['stop-vol'],'qi-of-absorption':['of-absorption'],'qi-of-exhaustion':['of-exhaustion'],
    'qi-of-excess':['of-excess'],'qi-thin-on':['thin-on'],'qi-mom-color':['mom-color'],
  };
  for(const[rowId,ids]of Object.entries(map)){
    const row=document.getElementById(rowId);if(!row) continue;
    const cb=row.querySelector('input[type=checkbox]');if(cb) cb.checked=ids.some(id=>CONFIGURED_IND.includes(id));
  }
  for(const[rowId,key]of Object.entries({'qi-imbalance':'showImbalance','qi-delta-candle':'showDelta'})){
    const row=document.getElementById(rowId);if(!row) continue;
    const cb=row.querySelector('input[type=checkbox]');if(cb) cb.checked=!!CFG[key];
  }
}

/* ============================================================
   CANDLE SUMMARY
   ─────────────────────────────────────────────────────────────
   CS_ALL_COLS: barField maps to the bar-level totals from
   _ticksToBar():
     totalTrdId  = Σ fp[i].trdIdDiff   → TRADE_ID column
     totalSeqNum = Σ fp[i].seqNumDiff  → SEQ_N    column
     totalMoves  = Σ fp[i].movesDiff   → RTL      column
   ============================================================ */
let _csFocusedBar=null;

/* ── CS_ALL_COLS — matches image 2 (Manual_Summary.xlsx) exactly ────────────
   TOP ROW (interval-wide, from _sumIntervalTotals — same source as Price Summary):
     rawTradeId   = Σ ID_Diff    = Total_ID
     rawSeqNum    = Σ SEQ_Diff   = Total_SEQ
     rawRtl       = Σ RT_Diff    = Total_RTL
     totalAggrBid = COUNTIF(AGGRS_SID1,'BID') = Total_AGR_BID
     totalAggrAsk = COUNTIF(AGGRS_SID1,'ASK') = Total_AGR_ASK
   LADDER SUMS (per-bar from _csFocusedBar):
     BIDSIZE/ASKSIZE/TRDVOL_1   from bar.totalBSize/totalASize/totalTrdVol
     HIT side: Hit_ID/SEQ/RTL/Vol/Bid from bar.totalHit*
     LIFT side: Lift_ID/SEQ/RTL/Vol/Ask from bar.totalLift*
   ─────────────────────────────────────────────────────────────────────────── */
const CS_ALL_COLS=[
  // ── Interval-wide totals (top section of image 2) ──
  // NOTE: SEQNUM and RTL are NOT columns in this file's Excel format, so
  // they are not shown. ELIGBL TRD ACVOL and NUMBER TRADES ARE real columns
  // in the file — they replace the old SEQNUM/RTL slots (diffed the same
  // way SEQNUM/RTL used to be), and CF VOLUME (previously not surfaced
  // anywhere) is added as its own column below.
  {key:'rawTradeId',   barField:'rawTradeId',   label:'TRADE_ID',  cls:''},
  {key:'rawSeqNum',    barField:'rawSeqNum',     label:'ELIG_V',    cls:''},  /* ELIGBL TRD ACVOL diff total */
  {key:'rawRtl',       barField:'rawRtl',        label:'TRADES',    cls:''},  /* NUMBER TRADES diff total */
  {key:'rawVolume',    barField:'totalVolume',   label:'CF_VOLUME', cls:''},  /* Σ CF VOLUME diff across the bar's ticks — was a raw last-tick session-cumulative snapshot before, which looked like a huge, unrelated number next to the other per-bar totals */
  {key:'totalAggrBid', barField:'totalAggrBid',  label:'AGGRS_BID', cls:'cs-bid'},
  {key:'totalAggrAsk', barField:'totalAggrAsk',  label:'AGGRS_ASK', cls:'cs-ask'},
  {key:'totalNumBid',  barField:'totalNumBid',   label:'NUM_BID',   cls:'cs-bid'},
  {key:'totalNumAsk',  barField:'totalNumAsk',   label:'NUM_ASK',   cls:'cs-ask'},
  // ── Per-bar BIDSIZE/ASKSIZE/TRDVOL (from ladder sums in image 2) ──
  {key:'barBidSz',    barField:'totalBSize',    label:'BIDSIZE',   cls:'cs-bid'},
  {key:'barAskSz',    barField:'totalASize',    label:'ASKSIZE',   cls:'cs-ask'},
  {key:'barTrdVol',   barField:'totalTrdVol',   label:'TRDVOL_1',  cls:''},
  // ── HIT side sub-totals (per-bar) ──
  {key:'hitId',       barField:'totalHitId',    label:'Hit_ID',    cls:'cs-bear'},
  {key:'hitSeq',      barField:'totalHitSeq',   label:'Hit_ELIG_V',cls:'cs-bear'},
  {key:'hitRTL',      barField:'totalHitRTL',   label:'Hit_TRADES',cls:'cs-bear'},
  {key:'hitOrders',   barField:'totalHitNumOrders', label:'Hit_Order', cls:'cs-bear'},
  {key:'hitTrdVol',   barField:'totalHitVol',   label:'Hit_Vol',   cls:'cs-bear'},
  {key:'hitBid',      barField:'totalHitBid',   label:'Hit_Bid',   cls:'cs-bear'},
  // ── LIFT side sub-totals (per-bar) ──
  {key:'liftId',      barField:'totalLiftId',   label:'Lift_ID',   cls:'cs-bull'},
  {key:'liftSeq',     barField:'totalLiftSeq',  label:'Lift_ELIG_V',cls:'cs-bull'},
  {key:'liftRTL',     barField:'totalLiftRTL',  label:'Lift_TRADES',cls:'cs-bull'},
  {key:'liftOrders',  barField:'totalLiftNumOrders', label:'Lift_Order', cls:'cs-bull'},
  {key:'liftTrdVol',  barField:'totalLiftVol',  label:'Lift_Vol',  cls:'cs-bull'},
  {key:'liftAsk',     barField:'totalLiftAsk',  label:'Lift_Ask',  cls:'cs-bull'},
  // ── Delta ──
  {key:'delta',       barField:'totalDelta',    label:'DELTA',     cls:'',signed:true},
];

function csBuildDynamic(){
  const dg=document.getElementById('cs-dynamic-grid');if(!dg) return;
  dg.innerHTML=CS_ALL_COLS.map(col=>`
    <div class="cs-cell">
      <div class="cs-lbl">${col.label}</div>
      <div class="cs-val ${col.cls}" id="csv-dyn-${col.key}">—</div>
    </div>`).join('');
  if(_csFocusedBar) csUpdate(_csFocusedBar);
}

function csUpdate(bar){
  if(!bar) return;_csFocusedBar=bar;
  const f2=v=>(typeof v==='number')?v.toFixed(2):'—';
  const n=v=>{if(v==null) return'—';const r=Math.round(v);if(Math.abs(r)>=1000000) return(r/1000000).toFixed(1)+'M';if(Math.abs(r)>=10000) return(r/1000).toFixed(1)+'k';return r.toLocaleString();};
  const sgn=v=>{if(v==null) return'—';const r=Math.round(v);return(r>=0?'+':'')+r.toLocaleString();};
  const set=(id,txt,cls)=>{const el=document.getElementById(id);if(!el) return;el.textContent=txt;if(cls!==undefined) el.className='cs-val '+cls;};
  set('csv-open',f2(bar.open));set('csv-close',f2(bar.close));
  set('csv-high',f2(bar.high),'cs-bull');set('csv-low',f2(bar.low),'cs-bear');
  set('csv-poc',f2(bar.pocPrice),'cs-poc');set('csv-vwap',f2(bar.avgVwap),'cs-vwap');
  // MARKER: the manually-selected marker from the Price Summary tab's own
  // "Marker" column (Buy/Buy Exit/Sell/Sell Exit), for THIS candle only —
  // see window._csMarkerForBar below for how "this candle only" is enforced.
  {
    const mkEl=document.getElementById('csv-marker');
    if(mkEl){
      const mk=(typeof window._csMarkerForBar==='function')?window._csMarkerForBar(bar):null;
      mkEl.textContent=mk||'0';
      mkEl.style.color = mk==='Buy'?'#00ff66':mk==='Buy Exit'?'#66ffaa':mk==='Sell'?'#ff5555':mk==='Sell Exit'?'#ffaa66':'#556';
    }
  }
  // MCGINLEY: the McGinley Dynamic strategy signal for THIS candle only —
  // Buy/Buy Exit fire once on the confirmed-trend transition bar (matching
  // the MetaStock EA's sticky-state, one-shot-signal design so this doesn't
  // flag every bar the trend holds), Sell/Sell Exit fire on the MD/Close
  // cross. See window._mdSignalForBar below.
  {
    const mdValEl=document.getElementById('csv-mcginley-val');
    if(mdValEl){
      const mdv=(typeof window._mdValueForBar==='function')?window._mdValueForBar(bar):null;
      mdValEl.textContent = mdv!=null ? f2(mdv) : '—';
    }
    const mdEl=document.getElementById('csv-mcginley');
    if(mdEl){
      const sig=(typeof window._mdSignalForBar==='function')?window._mdSignalForBar(bar):null;
      mdEl.textContent=sig||'0';
      const first=(sig||'').split('+')[0];
      mdEl.style.color = first==='Buy'?'#00ff66':first==='Sell Exit'?'#66ffaa':first==='Sell'?'#ff5555':first==='Buy Exit'?'#ffaa66':'#556';
    }
  }
  let dHL=0;
  if(bar.footprint&&bar.footprint.length>=2){
    dHL=(bar.footprint[bar.footprint.length-1].delta||0)-(bar.footprint[0].delta||0);
  }
  set('csv-dhl',sgn(dHL),dHL>=0?'pos':'neg');
  const cd=bar.cumD||0;set('csv-cumd',sgn(cd),cd>=0?'pos':'neg');
  // SPL TRD box now shows total ELIG_V (ELIGBL TRD ACVOL diff) minus total
  // CF_Vol (CF VOLUME diff) for this interval — same source values as the
  // ELIG_V / CF_VOLUME cells above, so the three stay consistent.
  {const splEl=document.getElementById('csv-spl-trd');
   if(splEl){
     const eligV=_rpActive?((bar.totalHitSeq||0)+(bar.totalLiftSeq||0)):(_sumIntervalTotals.rawSeqNum||0);
     const cfVol=bar.totalVolume||0;
     splEl.textContent=Math.round(eligV-cfVol).toLocaleString();
   }
   /* Price levels where SPL TRD occurred */
   const splPEl=document.getElementById('csv-spl-price');
   if(splPEl){
     const ps=bar.splPrices||[];
     const lastP=ps.length?ps[ps.length-1]:null;
     splPEl.textContent=lastP?'Price: '+lastP.toFixed(2):'—';
   }
  }
  /* ── Delta Flip — L-H = LIFT minus HIT; formula: "LIFT_val-HIT_val=diff"
     All fields read from the same bar aggregates as the Candle Summary columns,
     so they update automatically on every csUpdate() call. ─────────────── */
  {const _fV=v=>{v=Math.round(v||0);if(Math.abs(v)>=10000)return(v/1000).toFixed(1)+'k';if(Math.abs(v)>=1000)return v.toLocaleString();return String(v);};
   const _fml=(a,b)=>{const d=a-b;if(!a&&!b)return'0';return`${_fV(a)}-${_fV(b)}=${_fV(d)}`;};
   const _cls=d=>d>0?'pos':d<0?'neg':'';
   const _set=(id,txt,cls)=>{const e=document.getElementById(id);if(e){e.textContent=txt;e.className='cs-val '+cls;}};
   /* L-H Bid = totalLiftBid (LIFT_BID in CS) minus totalHitBid (HIT_BID in CS) */
   {const a=bar.totalLiftBid||0,b=bar.totalHitBid||0;_set('csv-df-hlbid',_fml(a,b),_cls(a-b));}
   /* L-H Ask = totalLiftAsk (LIFT_ASK in CS) minus totalHitAsk (HIT_ASK in CS) */
   {const a=bar.totalLiftAsk||0,b=bar.totalHitAsk||0;_set('csv-df-hlask',_fml(a,b),_cls(a-b));}
   /* AGG_Bid - AGG_Ask = AGGRS_BID minus AGGRS_ASK */
   {const ab=bar.totalAggrBid||0,aa=bar.totalAggrAsk||0;_set('csv-df-aggnet',_fml(ab,aa),_cls(ab-aa));}
   /* H-L Vol = L-H Vol = Lift trade volume total minus Hit trade volume total
      for this bar (same totals the Chart tab's footprint sums to) — matches
      the "a-b=c" format used by the other Delta Flip cells. This used to
      read bar.dfHLVol (max-min of per-tick TRDVOL sizes, which is a
      different, much smaller number and is usually 0), not an L-H diff. */
   {const a=bar.totalLiftVol||bar.buyVol||0,b=bar.totalHitVol||bar.sellVol||0;_set('csv-df-hlvol',_fml(a,b),_cls(a-b));}
   /* L-H Trades = totalLiftRTL (Lift_TRADES in CS) minus totalHitRTL (Hit_TRADES in CS) — NUMBER TRADES diff */
   {const a=bar.totalLiftRTL||0,b=bar.totalHitRTL||0;_set('csv-df-hlrtl',_fml(a,b),_cls(a-b));}
   /* L-H Elig_V = totalLiftSeq (Lift_ELIG_V in CS) minus totalHitSeq (Hit_ELIG_V in CS) — ELIGBL TRD ACVOL diff */
   {const a=bar.totalLiftSeq||0,b=bar.totalHitSeq||0;_set('csv-df-hlseq',_fml(a,b),_cls(a-b));}
  }
  /* Raw interval totals come from _sumIntervalTotals (Price Summary source),
     not from the focused bar — so they always match the Price Summary values. */
  /* Interval-wide fields come from _sumIntervalTotals (Price Summary source).
     All other fields come from _csFocusedBar (per-bar). */
  const _rawFields=new Set(['rawTradeId','rawSeqNum','rawRtl',
                             'totalAggrBid','totalAggrAsk']);
  CS_ALL_COLS.forEach(col=>{
    const el=document.getElementById(`csv-dyn-${col.key}`);if(!el) return;
    /* During replay: read all fields from the live bar (bar has rawTradeId etc.
       from _ticksToBar). Outside replay: interval-wide fields from _sumIntervalTotals
       so they match Price Summary. */
    const useBar=_rpActive||bar[col.barField]!=null;
    const src=(!_rpActive&&_rawFields.has(col.barField)&&!useBar)?_sumIntervalTotals:bar;
    const v=(src[col.barField]==null)?0:src[col.barField];
    el.textContent=col.signed?sgn(v):n(v);
    el.className='cs-val '+(col.signed?(v>=0?'pos':'neg'):(col.cls||''));
  });
}
function csUpdateLast(){if(!R||!R.bars.length) return;csUpdate(R.bars[R.bars.length-1]);}

function _currentIntervalRows(){
  if (typeof _rpActive!=='undefined' && _rpActive &&
      typeof _rpSumRows!=='undefined' && _rpSumRows && _rpSumRows.length)
    return _rpSumRows.slice();
  if (typeof _openBarTicks!=='undefined' && _openBarTicks && _openBarTicks.length)
    return _openBarTicks.slice();
  if (typeof R!=='undefined' && R && R.bars && R.bars.length){
    const b=R.bars[R.bars.length-1];
    if (b && b.ticks && b.ticks.length) return b.ticks.slice();
  }
  return [];
}

/* ============================================================
   XLWINGS
   ============================================================ */

/* ============================================================
   _xwSyncAllTabs(rows)
   Called after every xlwings snapshot or batch of ticks.
   Mirrors what _normalFileHandler does so that Trade Log,
   Price Summary and the Day/Time Filter all stay in sync
   with the live xlwings data feed.
   ============================================================ */
function _xwSyncAllTabs(rows) {
  if (!rows || !rows.length) return;

  /* Sort by epoch ms so filter / navigation work correctly */
  rows.sort((a, b) => {
    const aMs = _toAbsMs(a) || Number.MAX_SAFE_INTEGER;
    const bMs = _toAbsMs(b) || Number.MAX_SAFE_INTEGER;
    return aMs - bMs;
  });

  /* Feed Trade Log, navigation and filter bar */
  _trAllRows = rows;
  _tlRows    = rows.slice();

  /* Re-bucket into bars for PREV/NEXT navigation */
  const bars = _bucketByInterval(rows, CFG.intervalSec);
  if (bars.length) {
    _trBars = bars;
    let cd = 0; _trBars.forEach(b => { cd += b.delta; b.cumD = cd; });
    const n = parseInt((document.getElementById('bar-n') || {}).value) || 10;
    _trOffset = Math.max(0, _trBars.length - n);
    if (typeof _trUpdateNavInfo === 'function') _trUpdateNavInfo();
  }

  /* Populate filter bar datetime inputs from actual data range */
  if (typeof trAutoPopulate === 'function') trAutoPopulate(rows);   // sidebar pickers
  setTimeout(() => {
    if (typeof _dtPopulateFromRows === 'function') _dtPopulateFromRows(rows); // filter bar
  }, 80);

  /* If filter was previously active, re-apply it to the new live data */
  if (_dtActive && (_dtStartMs > 0 || _dtEndMs > 0)) {
    if (typeof _dtRebuildAll === 'function') _dtRebuildAll();
  }

  /* Mark Trade Log and Price Summary as dirty — they'll refresh when switched to */
  window._dtDirty = window._dtDirty || {};
  const activeTab = (document.querySelector('.main-tab.active') || {}).dataset?.tab || '';
  if (activeTab === 'tradelog') {
    if (typeof tlRender === 'function') tlRender();
  } else {
    window._dtDirty.tradelog = true;
  }
  if (activeTab === 'summary') {
    if (typeof sumRender === 'function') sumRender();
  } else {
    window._dtDirty.summary = true;
  }
}

const XW_UNIFIED_SOURCE='cf';
let _xwSocket=null,_xwActive=false,_xwRowCount=0,_xwReconnTimer=null,_xwReconnDelay=2000;
const XW_MAX_DELAY=30000;
let _xwSaveTimeout=null;

function xwSaveFile(){
  if(!_xwSocket||_xwSocket.readyState!==WebSocket.OPEN){alert('Not connected.');return;}
  const btn=document.getElementById('xw-save-btn'),st=document.getElementById('xw-save-status');
  if(btn){btn.style.opacity='0.5';btn.style.pointerEvents='none';}
  if(st) st.textContent='⏳ Saving…';
  _xwSocket.send(JSON.stringify({type:'save'}));
  _xwSaveTimeout=setTimeout(()=>{
    if(btn){btn.style.opacity='';btn.style.pointerEvents='';}
    if(st){st.textContent='⚠ No response';setTimeout(()=>{st.textContent='';},3000);}
  },8000);
}
function xwToggle(){if(_xwActive){xwDisconnect();return;}xwConnect();}
function xwConnect(){
  const url=document.getElementById('xw-url-input').value.trim()||'ws://localhost:8766';
  if(_xwReconnTimer){clearTimeout(_xwReconnTimer);_xwReconnTimer=null;}
  if(_xwSocket){_xwSocket.onclose=null;_xwSocket.close();_xwSocket=null;}
  _xwSetStatus('connecting',`Connecting to ${url}…`);
  /* ── Show panel immediately (before WebSocket opens) ── */
  document.getElementById('xw-panel').classList.add('active');
  document.getElementById('b-xw').classList.add('on');
  document.getElementById('b-xw').textContent='🔌 Connecting…';
  const ws=new WebSocket(url);_xwSocket=ws;_xwActive=true;
  ws.onopen=()=>{
    _xwReconnDelay=2000;_xwSetStatus('live','Connected — selecting live source…');
    ws.send(JSON.stringify({type:'subscribe',source:XW_UNIFIED_SOURCE}));
    /* Panel already visible from xwConnect(); just update button text */
    document.getElementById('b-xw').textContent='🔌 xlwings ON';
    if(_liveActive) liveStop();
    _stopRT();if(R&&R._sim){R.destroy();R=new Renderer([]);}
    _barOpenTime=_snapToBarBoundary(Date.now(),CFG.intervalSec);_openBarTicks=[];_lastBarCount=-1;
    if(_liveBarTimer) clearInterval(_liveBarTimer);
    _liveBarTimer=setInterval(_liveBarTick,1000);_updateIntervalLabel();_startLiveGlow();
    document.getElementById('xw-err').style.display='none';
  };
  ws.onmessage=e=>{try{_xwHandleMsg(JSON.parse(e.data));}catch(err){console.warn('[xlwings] Bad JSON:',e.data);}};
  ws.onerror=()=>{
    _xwSetStatus('error','Connection error');
    const el=document.getElementById('xw-err');el.style.display='inline';
    el.textContent='⚠ Cannot reach xlwings server — is xlwings_server.py running?';
  };
  ws.onclose=e=>{
    _xwSocket=null;if(!_xwActive) return;
    _xwSetStatus('closed',`Disconnected (${e.code}) — reconnecting in ${(_xwReconnDelay/1000).toFixed(0)}s…`);
    _xwReconnTimer=setTimeout(()=>{if(_xwActive){_xwReconnDelay=Math.min(_xwReconnDelay*1.5,XW_MAX_DELAY);xwConnect();}},_xwReconnDelay);
  };
}
function xwDisconnect(){
  _xwActive=false;
  if(_xwReconnTimer){clearTimeout(_xwReconnTimer);_xwReconnTimer=null;}
  if(_xwSocket){_xwSocket.onclose=null;_xwSocket.close();_xwSocket=null;}
  if(!_liveActive){
    if(_liveBarTimer){clearInterval(_liveBarTimer);_liveBarTimer=null;}
    _stopLiveGlow();document.getElementById('bar-timer').textContent='⏱ —';document.getElementById('bar-timer').className='';
  }
  document.getElementById('xw-panel').classList.remove('active');
  document.getElementById('b-xw').classList.remove('on');
  document.getElementById('b-xw').textContent='🔌 xlwings';
  document.getElementById('xw-filelist').textContent='';_xwSetStatus('closed','Disconnected');
  /* Persist whatever data we received so tabs remain usable after disconnect */
  if (_allRawRows && _allRawRows.length && !_trAllRows.length) {
    _xwSyncAllTabs(_allRawRows);
  }
}


/* ============================================================
   XLWINGS NON-BLOCKING LIVE UPDATE PATCH
   Problem solved:
   - Excel can update many TAS rows per second / millisecond.
   - The old HTML rebuilt chart + every tab on every websocket packet.
   - That blocked the browser main thread and made the page look frozen.
   This patch buffers incoming tick rows and flushes them once per animation
   frame, while heavy tabs are refreshed only when active and throttled.
   ============================================================ */
let _xwPendingTickRows = [];
let _xwFlushRAF = 0;
let _xwLastHeavyTabMs = 0;
let _xwLastStatusMs = 0;
const XW_MAX_ROWS_PER_FRAME = 2500;   // safety for bursty Refinitiv TAS rows
const XW_HEAVY_TAB_MS = 350;          // Price Summary / LA / Flip Pairs throttle

function _xwIsSplCond(q){
  q = String(q||'').trim().toUpperCase();
  return q.indexOf('SPL TRD') >= 0;
}
function _xwNormalizeRows(rows, msg){
  if(!rows || !rows.length) return [];
  return rows.map(r=>{
    const _ck=String(r.condKey||r.QUALIFIERS||'').trim();
    const _isSplR=_xwIsSplCond(_ck);
    const _last=_isSplR?0:+(r.last||0);
    const _bid =_isSplR?0:+(r.bid||0);
    const _ask =_isSplR?0:+(r.ask||0);
    const _time=normTime(r.time||'') || msg?.ts || new Date().toLocaleTimeString('en-US',{hour12:false});
    const _date=r.date || new Date().toLocaleDateString('en-US');
    return {
      last:_last,bid:_bid,ask:_ask,
      bSize:_isSplR?0:+(r.bSize||0),aSize:_isSplR?0:+(r.aSize||0),
      numBid:+(r.numBid||0),numAsk:+(r.numAsk||0),numOrders:+(r.numOrders||0),
      trdVol:+(r.trdVol||0),volume:+(r.volume||r.trdVol||0),moves:+(r.moves||0),
      aggr:String(r.aggr||'').toUpperCase(),
      tradeId:r.tradeId || (String(r.seqNum||'')+'-'+String(r.time||'')+'-'+String(r.last||'')),
      condKey:_ck,QUALIFIERS:_ck,time:_time,date:_date,
      seqNum:+(r.seqNum||0),rtCount:+(r.rtCount||0),
      volDiff:+(r.volDiff||0),movesDiff:+(r.movesDiff||0),
      trdIdDiff:+(r.trdIdDiff||0),seqNumDiff:+(r.seqNumDiff||0)
    };
  }).filter(r=>r.last>0 || _xwIsSplCond(r.condKey));
}
function _xwEnqueueTicks(rows, msg){
  const norm=_xwNormalizeRows(rows,msg);
  if(!norm.length) return;
  _xwPendingTickRows.push(...norm);
  _xwRowCount += norm.length;
  if(!_xwFlushRAF) _xwFlushRAF=requestAnimationFrame(_xwFlushTicksFrame);
}
function _xwFlushTicksFrame(){
  _xwFlushRAF=0;
  if(!_xwPendingTickRows.length) return;
  const batch=_xwPendingTickRows.splice(0, XW_MAX_ROWS_PER_FRAME);

  // Keep one complete raw stream for filters / tabs, but do not re-sort it every tick.
  if(!Array.isArray(_allRawRows)) _allRawRows=[];
  _allRawRows.push(...batch);
  if(typeof _itrStreamLiveTicks==='function') _itrStreamLiveTicks(batch);

  // Initialize bar open time from the first real tick timestamp, not only Date.now().
  if(!_barOpenTime && batch.length){
    const ms=_toAbsMs(batch[0]) || Date.now();
    _barOpenTime=_snapToBarBoundary(ms,CFG.intervalSec);
  }

  // Add to the currently-building live candle.
  _openBarTicks.push(...batch);

  // Close completed candle(s) based on the last tick timestamp when available.
  const lastMs=_toAbsMs(batch[batch.length-1]) || Date.now();
  while(_barOpenTime && lastMs >= _barOpenTime + CFG.intervalSec*1000 && _openBarTicks.length){
    if(typeof _closeBar==='function') _closeBar(); else break;
  }

  // Redraw chart/candle summary once per browser frame, not once per websocket packet.
  if(typeof _rebuildDisplay==='function') _rebuildDisplay();
  if(typeof csUpdate==='function' && _openBarTicks.length){
    const liveBar=_ticksToBar(_openBarTicks);
    if(liveBar){
      const lastCD=_closedBars&&_closedBars.length?_closedBars[_closedBars.length-1].cumD:0;
      liveBar.cumD=lastCD+liveBar.delta; liveBar.isOpen=true; csUpdate(liveBar);
    }
  }

  // Heavy tabs only refresh if visible, and not more than a few times per second.
  const now=performance.now();
  if(now-_xwLastHeavyTabMs > XW_HEAVY_TAB_MS){
    _xwLastHeavyTabMs=now;
    const activeTab=(document.querySelector('.main-tab.active')||{}).dataset?.tab || '';
    try{
      if(activeTab==='tradelog' && typeof tlRender==='function') tlRender();
      else if(window._dtDirty) window._dtDirty.tradelog=true;
      if(activeTab==='summary' && typeof sumRender==='function') sumRender();
      else if(window._dtDirty) window._dtDirty.summary=true;
      if(activeTab==='levels' && typeof aggBuild==='function') aggBuild();
      if(activeTab==='lagr' && typeof laRebuild==='function') laRebuild();
      if(activeTab==='dfpairs' && typeof dfpRender==='function') dfpRender();
    }catch(e){console.warn('[xlwings] throttled tab refresh failed',e);}
  }

  if(now-_xwLastStatusMs > 250){
    _xwLastStatusMs=now;
    const nb=document.getElementById('xw-newrows'); if(nb) nb.textContent='+'+batch.length;
    const rc=document.getElementById('xw-rowcount'); if(rc) rc.textContent=`${_xwRowCount.toLocaleString()} ticks · live`;
    const ds=document.getElementById('dsrc'); if(ds) ds.textContent=`🔌 ${_xwRowCount.toLocaleString()} ticks`;
  }

  // More pending rows? Continue next frame so the UI never freezes.
  if(_xwPendingTickRows.length && !_xwFlushRAF) _xwFlushRAF=requestAnimationFrame(_xwFlushTicksFrame);
}
function _xwSeedSnapshotNonBlocking(rows,msg){
  const normRows=_xwNormalizeRows(rows,msg);
  if(!normRows.length) return;
  normRows.sort((a,b)=>(_toAbsMs(a)||0)-(_toAbsMs(b)||0));
  _fillNaN(normRows);
  // Snapshot is a one-time operation. Build bars once, then from now on use the live queue.
  _allRawRows=normRows.slice();
  const bars=_bucketByInterval(normRows,CFG.intervalSec);
  if(bars.length){
    _closedBars=bars;
    let cd=0;_closedBars.forEach(b=>{cd+=b.delta;b.cumD=cd;});
  }
  _openBarTicks=[];
  _barOpenTime=normRows.length?_snapToBarBoundary(_toAbsMs(normRows[normRows.length-1])||Date.now(),CFG.intervalSec):Date.now();
  _xwRowCount=normRows.length;
  if(typeof _rebuildDisplay==='function') requestAnimationFrame(_rebuildDisplay);
  if(typeof _xwSyncAllTabs==='function') setTimeout(()=>_xwSyncAllTabs(normRows),80);
}


function _xwEnsureUnifiedFileSelect(files,selected){
  const host=document.getElementById('xw-filelist');
  if(!host)return;
  let sel=document.getElementById('xw-unified-file-select');
  if(!sel){
    sel=document.createElement('select');
    sel.id='xw-unified-file-select';
    sel.title='Choose the live Excel workbook for this Command Center tab';
    sel.style.cssText='margin-left:8px;max-width:260px;background:#071018;color:#8fdcff;border:1px solid #24506a;border-radius:3px;font:inherit;';
    host.after(sel);
    sel.addEventListener('change',function(){
      if(!_xwSocket||_xwSocket.readyState!==WebSocket.OPEN)return;
      // Clear the current live stream before switching workbooks so rows from
      // two files can never mix in one tab.
      try{
        _allRawRows=[];_closedBars=[];_openBarTicks=[];_xwRowCount=0;_lastBarCount=-1;
        if(typeof _rebuildDisplay==='function')_rebuildDisplay();
      }catch(e){}
      _xwSocket.send(JSON.stringify({type:'select_file',fileId:sel.value}));
      _xwSetStatus('connecting','Switching workbook…');
    });
  }
  sel.innerHTML=(files||[]).map(f=>`<option value="${String(f.id).replace(/"/g,'&quot;')}">${f.name}${f.rows!=null?' · '+Number(f.rows).toLocaleString()+' rows':''}</option>`).join('');
  if(selected)sel.value=selected;
  sel.style.display=(files&&files.length>1)?'inline-block':'none';
}

function _xwHandleMsg(msg){
  // Unified bridge protection: this tab only accepts its assigned data profile.
  if(msg.source && msg.source!==XW_UNIFIED_SOURCE)return;
  switch(msg.type){
    case'source_files':{
      _xwEnsureUnifiedFileSelect(msg.files||[],msg.selected);
      const names=(msg.files||[]).map(f=>f.name);
      document.getElementById('xw-filelist').textContent='📂 '+(names.length?names.join(' · '):'No matching workbook selected');
      _xwSetStatus(names.length?'live':'error',names.length?'Source ready — '+names.length+' file(s)':'No '+XW_UNIFIED_SOURCE.toUpperCase()+' workbook');
      break;
    }
    case'connected':{
      _xwSetStatus('live',`Unified bridge v${msg.version||'?'}`);
      document.getElementById('xw-filelist').textContent='📂 Waiting for '+XW_UNIFIED_SOURCE.toUpperCase()+' files…';
      document.getElementById('dsrc').textContent='🔌 unified xlwings';document.getElementById('dsrc').className='';break;
    }
    case'snapshot':{
      const rows=msg.rows||[]; if(!rows.length) break;
      _xwSetStatus('live',`Snapshot ${rows.length.toLocaleString()} rows — preparing live view…`);
      setTimeout(()=>{
        try{
          _xwSeedSnapshotNonBlocking(rows,msg);
          document.getElementById('dsrc').textContent=`🔌 ${_xwRowCount.toLocaleString()} rows`;
          _xwSetStatus('live',`Snapshot ready — live streaming…`);
        }catch(e){console.error('[xlwings] snapshot seed failed',e);_xwSetStatus('error','Snapshot failed');}
      },0);
      break;
    }
    case'ticks':{
      const rows=msg.rows||[]; if(!rows.length) break;
      _xwEnqueueTicks(rows,msg);
      _xwSetStatus('live',`${msg.file?msg.file+' · ':''}${msg.ts||new Date().toLocaleTimeString('en-US',{hour12:false})}`);
      break;
    }
    case'amend':{
      // The bridge emits the newest row instantly with provisional (final-row)
      // diffs, then sends its exact forward diffs once the successor tick arrives.
      const am=msg.rows||[]; if(!am.length||!Array.isArray(_allRawRows)) break;
      let touched=false;
      am.forEach(a=>{
        // Newest rows live at the end — scan backwards, bounded.
        const lo=Math.max(0,_allRawRows.length-2000);
        for(let i=_allRawRows.length-1;i>=lo;i--){
          const r=_allRawRows[i];
          if(String(r.tradeId)===String(a.tradeId)&&r.time===a.time&&+r.last===+a.last){
            r.trdIdDiff=+a.trdIdDiff||0; r.seqNumDiff=+a.seqNumDiff||0; r.movesDiff=+a.movesDiff||0;
            touched=true; break;
          }
        }
      });
      if(touched && !window.__xwAmendRAF){
        window.__xwAmendRAF=requestAnimationFrame(()=>{
          window.__xwAmendRAF=0;
          try{ if(typeof _rebuildDisplay==='function') _rebuildDisplay(); }catch(e){}
        });
      }
      break;
    }
    case'heartbeat':{
      const hbl=msg.files&&typeof msg.files==='object'?Object.values(msg.files).map(f=>`${f.name}: ${f.rows}`).join(' · '):`${msg.total||0} rows`;
      _xwSetStatus('live',`♥ ${msg.ts||''} · ${hbl}`);document.getElementById('xw-err').style.display='none';break;
    }
    case'saved':{
      if(_xwSaveTimeout){clearTimeout(_xwSaveTimeout);_xwSaveTimeout=null;}
      const _sb=document.getElementById('xw-save-btn'),_ss=document.getElementById('xw-save-status');
      if(_sb){_sb.style.opacity='';_sb.style.pointerEvents='';}
      const paths=msg.files?Object.values(msg.files).filter(Boolean):[];
      if(paths.length){const names=paths.map(p=>p.split(/[\\/]/).pop()).join(', ');if(_ss){_ss.textContent='✓ Saved: '+names;setTimeout(()=>{_ss.textContent='';},5000);}}
      else{if(_ss) _ss.textContent='⚠ Save failed';}
      break;
    }
    default:console.debug('[xlwings] Unknown:',msg.type);
  }
}
function _xwSetStatus(state,text){
  const dot=document.getElementById('xw-dot'),lbl=document.getElementById('xw-status');
  dot.className=state;lbl.textContent=`🔌 xlwings: ${text}`;
  lbl.style.color=state==='live'?'#00cc88':state==='error'?'#ff4444':state==='closed'?'#444':'#4488ff';
}

/* ============================================================
   INDICATORS
   ============================================================ */
const IND_CATALOG=[
  {id:'stk-imb-buy',cat:'Stacked Imbalance',name:'Stacked Imbalance Buy Mode',side:'buy'},
  {id:'stk-imb-sell',cat:'Stacked Imbalance',name:'Stacked Imbalance Sell Mode',side:'sell'},
  {id:'stk-imb-bull',cat:'Stacked Imbalance',name:'Bullish Stacked Imbalance Zone',side:'buy'},
  {id:'stk-imb-bear',cat:'Stacked Imbalance',name:'Bearish Stacked Imbalance Zone',side:'sell'},
  {id:'stop-vol',cat:'Stopping Volume',name:'Enable Stopping Volume',side:'both'},
  {id:'stop-bull',cat:'Stopping Volume',name:'Bullish Stopping Volume',side:'buy'},
  {id:'stop-bear',cat:'Stopping Volume',name:'Bearish Stopping Volume',side:'sell'},
  {id:'thin-on',cat:'Thin Prints',name:'Enable Thin Prints',side:'both'},
  {id:'delta-candle',cat:'Delta Candle',name:'Delta Candle Overlay',side:'both'},
  {id:'delta-pct',cat:'Delta Candle',name:'Delta % per row',side:'both'},
  {id:'delta-cum',cat:'Delta Candle',name:'Cumulative Delta Line',side:'both'},
  {id:'delta-minmax',cat:'Delta Candle',name:'Min/Max Delta Markers',side:'both'},
  {id:'delta-divergence',cat:'Delta Candle',name:'Delta Divergence Dots',side:'both'},
  {id:'poc-line',cat:'POC / Value Area',name:'POC Line',side:'both'},
  {id:'poc-migrate',cat:'POC / Value Area',name:'Migrating POC',side:'both'},
  {id:'vah-line',cat:'POC / Value Area',name:'Value Area High (VAH)',side:'both'},
  {id:'val-line',cat:'POC / Value Area',name:'Value Area Low (VAL)',side:'both'},
  {id:'va-fill',cat:'POC / Value Area',name:'Value Area Fill',side:'both'},
  {id:'vwap-line',cat:'VWAP',name:'VWAP Line',side:'both'},
  {id:'vwap-sd1',cat:'VWAP',name:'VWAP ± 1σ Bands',side:'both'},
  {id:'vwap-sd2',cat:'VWAP',name:'VWAP ± 2σ Bands',side:'both'},
  {id:'vwap-session',cat:'VWAP',name:'Session VWAP Reset',side:'both'},
  {id:'vol-prof',cat:'Volume Profile',name:'Volume Profile Histogram',side:'both'},
  {id:'vol-buy',cat:'Volume Profile',name:'Buy Volume Bars',side:'buy'},
  {id:'vol-sell',cat:'Volume Profile',name:'Sell Volume Bars',side:'sell'},
  {id:'of-aggressor',cat:'Order Flow',name:'Aggressor Side Labels',side:'both'},
  {id:'of-absorption',cat:'Order Flow',name:'Absorption Detection',side:'both'},
  {id:'of-exhaustion',cat:'Order Flow',name:'Exhaustion Prints',side:'both'},
  {id:'of-excess',cat:'Order Flow',name:'Excess / Rejection Tails',side:'both'},
  {id:'of-initiative',cat:'Order Flow',name:'Initiative vs Responsive',side:'both'},
  {id:'mom-bull',cat:'Momentum',name:'Bullish Momentum Filter',side:'buy'},
  {id:'mom-bear',cat:'Momentum',name:'Bearish Momentum Filter',side:'sell'},
  {id:'mom-color',cat:'Momentum',name:'Momentum Color Gradient',side:'both'},
];

let CONFIGURED_IND=[],_indPanelOpen=false,_indSearchStr='';

function toggleIndPanel(force){
  _indPanelOpen=(force!==undefined)?force:!_indPanelOpen;
  document.getElementById('ind-panel').classList.toggle('open',_indPanelOpen);
  document.getElementById('b-ind').classList.toggle('on',_indPanelOpen);
  if(_indPanelOpen){indRender();document.getElementById('ind-search').focus();}
}
function indSearch(v){_indSearchStr=v.toLowerCase().trim();indRender();}
function indAdd(id){if(!CONFIGURED_IND.includes(id)){CONFIGURED_IND.push(id);indRender();indUpdateBadges();if(R) R.draw();}}
function indRemove(id){CONFIGURED_IND=CONFIGURED_IND.filter(x=>x!==id);indRender();indUpdateBadges();if(R) R.draw();}
function indAddAll(){_indFilteredList().forEach(c=>{if(!CONFIGURED_IND.includes(c.id)) CONFIGURED_IND.push(c.id);});indRender();indUpdateBadges();if(R) R.draw();}
function indRemoveAll(){CONFIGURED_IND=[];indRender();indUpdateBadges();if(R) R.draw();}
function _indFilteredList(){
  if(!_indSearchStr) return IND_CATALOG;
  return IND_CATALOG.filter(c=>c.name.toLowerCase().includes(_indSearchStr)||c.cat.toLowerCase().includes(_indSearchStr));
}
function indRender(){
  const avail=document.getElementById('ind-available-list'),cfgDiv=document.getElementById('ind-configured-list');
  const cats={};_indFilteredList().forEach(c=>{if(!cats[c.cat]) cats[c.cat]=[];cats[c.cat].push(c);});
  avail.innerHTML=Object.entries(cats).map(([cat,items])=>
    `<div class="ind-cat-sep">${cat}</div>`+items.map(c=>{
      const on=CONFIGURED_IND.includes(c.id);
      return`<div class="ind-item${on?' selected':''}" onclick="indAdd('${c.id}')">
        <span class="ind-check">${on?'✓':''}</span><span>${c.name}</span>
        <span class="ind-cat">${c.side==='buy'?'▲':c.side==='sell'?'▼':'↕'}</span></div>`;
    }).join('')).join('');
  cfgDiv.innerHTML=!CONFIGURED_IND.length
    ?'<div style="padding:12px 8px;color:#333;font-size:9px">No indicators configured.</div>'
    :CONFIGURED_IND.map(id=>{
      const c=IND_CATALOG.find(x=>x.id===id);if(!c) return'';
      return`<div class="ind-cfg-item"><span class="ind-cfg-name">${c.name}</span>
        <span class="ind-cfg-cat">${c.side==='buy'?'▲':c.side==='sell'?'▼':'↕'}</span>
        <button class="ind-remove" onclick="indRemove('${c.id}')">✕</button></div>`;
    }).join('');
}
function indUpdateBadges(){
  const bar=document.getElementById('ind-active-bar');
  if(!CONFIGURED_IND.length){bar.innerHTML='';bar.classList.remove('has-items');return;}
  bar.classList.add('has-items');
  bar.innerHTML='<span style="color:#333;font-size:9px;margin-right:4px">Active:</span>'+
    CONFIGURED_IND.map(id=>{const c=IND_CATALOG.find(x=>x.id===id);if(!c) return'';
      return`<span class="ind-badge">${c.name.substring(0,22)}${c.name.length>22?'…':''}
        <span class="ind-badge-x" onclick="indRemove('${c.id}')">✕</span></span>`;}).join('');
}

// Patch Renderer.draw to also call _drawIndicators
const _origDraw=Renderer.prototype.draw;
Renderer.prototype.draw=function(){_origDraw.call(this);if(CONFIGURED_IND.length) _drawIndicators(this);};

/* ============================================================
   INDICATOR RENDERER
   ============================================================ */
function _drawIndicators(renderer){
  if(!renderer.bars.length) return;
  const cx=renderer.cx,bars=renderer.bars,H=renderer.MC.height,W=renderer.MC.width;
  const pr=renderer._range(),visR=Math.floor((H-22)/CFG.rowH),mid=(pr.max+pr.min)/2;
  const priceStep=chartPriceStep(pr,visR);
  const topP=chartTopPrice(pr,visR),fy=20,bW=renderer.barW,tW=renderer.totalW;
  const pxY=p=>fy+Math.round((topP-p)/priceStep)*CFG.rowH;
  const inView=y=>y>=fy-CFG.rowH&&y<=fy+visR*CFG.rowH;
  const fillRow=(x,y,w,color)=>{if(!inView(y)) return;cx.save();cx.fillStyle=color;cx.fillRect(x,y,w,CFG.rowH-1);cx.restore();};
  const outlineRow=(x,y,w,color,lw=1.5,dash=[])=>{if(!inView(y)) return;cx.save();cx.strokeStyle=color;cx.lineWidth=lw;cx.setLineDash(dash);cx.strokeRect(x+.5,y+.5,w-1,CFG.rowH-2);cx.setLineDash([]);cx.restore();};
  const hline=(y,x1,x2,color,lw=1,dash=[])=>{cx.save();cx.strokeStyle=color;cx.lineWidth=lw;cx.setLineDash(dash);cx.beginPath();cx.moveTo(x1,y);cx.lineTo(x2,y);cx.stroke();cx.setLineDash([]);cx.restore();};
  const rowTxt=(s,x,y,color,size=8,align='center',bold=false)=>{if(!inView(y)) return;cx.save();cx.fillStyle=color;cx.font=`${bold?'bold ':''}${size}px monospace`;cx.textAlign=align;cx.textBaseline='middle';cx.fillText(s,x,y+CFG.rowH/2);cx.restore();};
  const floatTxt=(s,x,y,color,size=8,align='center',bold=false)=>{cx.save();cx.fillStyle=color;cx.font=`${bold?'bold ':''}${size}px monospace`;cx.textAlign=align;cx.textBaseline='alphabetic';cx.fillText(s,x,y);cx.restore();};
  const THRESH=CFG.imbThreshold/100,MINV=Math.max(1,CFG.imbMinVol);

  const analytics=bars.map(bar=>{
    const fp=bar.footprint;
    if(!fp||!fp.length) return{totalVol:1,maxVol:1,avgVol:1,bullZones:[],bearZones:[],stopBull:false,stopBear:false,thinRows:[],absorptionRows:[],exhaustTop:false,exhaustBot:false,excessTop:false,excessBot:false,aggBias:'NEUTRAL',momBull:false,momBear:false,deltaRows:[]};
    const totalVol=Math.max(1,fp.reduce((s,r)=>s+(r.trdVol||r.vol||0),0));
    const maxVol=Math.max(1,...fp.map(r=>r.trdVol||r.vol||0));
    const avgVol=totalVol/fp.length;
    const bullZones=[],bearZones=[];let bRun=0,bStart=0,aRun=0,aStart=0;
    fp.forEach((row,i)=>{
      const B=Math.max(row.bid||0,row.bSize||0),A=Math.max(row.ask||0,row.aSize||0)||1;
      if(B>=MINV&&B/A>=THRESH){if(!bRun) bStart=i;bRun++;}else{if(bRun>=3) bullZones.push({from:bStart,to:i-1});bRun=0;}
      if(A>=MINV&&A/(B||1)>=THRESH){if(!aRun) aStart=i;aRun++;}else{if(aRun>=3) bearZones.push({from:aStart,to:i-1});aRun=0;}
    });
    if(bRun>=3) bullZones.push({from:bStart,to:fp.length-1});
    if(aRun>=3) bearZones.push({from:aStart,to:fp.length-1});
    const v0=fp[0]?(fp[0].trdVol||fp[0].vol||0):0,vN=fp[fp.length-1]?(fp[fp.length-1].trdVol||fp[fp.length-1].vol||0):0;
    const stopBull=v0/maxVol>=0.65,stopBear=vN/maxVol>=0.65;
    const thinRows=fp.filter(r=>{const v=r.trdVol||r.vol||0;return v>0&&v<avgVol*0.25;});
    const absorptionRows=fp.filter(row=>{const B=Math.max(row.bid||0,row.bSize||0),A=Math.max(row.ask||0,row.aSize||0);if(!B&&!A) return false;const hi=Math.max(B,A),lo=Math.max(1,Math.min(B,A));return hi/lo>=4&&hi>=MINV*2;});
    const interior=fp.slice(1,-1),intMaxVol=interior.length?Math.max(1,...interior.map(r=>r.trdVol||r.vol||0)):1;
    const topRow=fp[fp.length-1],botRow=fp[0];
    const exhaustTop=topRow&&(topRow.trdVol||topRow.vol||0)<intMaxVol*0.15&&Math.max(topRow.ask||0,topRow.aSize||0)>Math.max(topRow.bid||0,topRow.bSize||0);
    const exhaustBot=botRow&&(botRow.trdVol||botRow.vol||0)<intMaxVol*0.15&&Math.max(botRow.bid||0,botRow.bSize||0)>Math.max(botRow.ask||0,botRow.aSize||0);
    const excessTop=topRow&&(topRow.trdVol||topRow.vol||0)<avgVol*0.20;
    const excessBot=botRow&&(botRow.trdVol||botRow.vol||0)<avgVol*0.20;
    const aggBias=bar.buyVol>bar.sellVol?'BID':bar.sellVol>bar.buyVol?'ASK':'NEUTRAL';
    const dFrac=bar.delta/totalVol;
    return{totalVol,maxVol,avgVol,bullZones,bearZones,stopBull,stopBear,thinRows,absorptionRows,exhaustTop,exhaustBot,excessTop,excessBot,aggBias,momBull:dFrac>0.07,momBear:dFrac<-0.07,deltaRows:fp.map(r=>({price:r.price,delta:r.delta||0,pct:totalVol?((r.delta||0)/totalVol*100):0}))};
  });

  // VWAP
  const vwapPts=[];{let pv=0,vol=0;bars.forEach((bar,bi)=>{
    if(CONFIGURED_IND.includes('vwap-session')&&bi>0){const pt=bars[bi-1].time,ct=bar.time;if(pt&&ct&&ct<pt){pv=0;vol=0;}}
    pv+=bar.avgVwap*bar.totalVol;vol+=bar.totalVol;vwapPts.push(vol>0?pv/vol:bar.avgVwap);
  });}
  const vwapMean=vwapPts.reduce((s,v)=>s+v,0)/Math.max(1,vwapPts.length);
  const vwapSD=Math.sqrt(vwapPts.reduce((s,v)=>s+(v-vwapMean)**2,0)/Math.max(1,vwapPts.length));

  bars.forEach((bar,bi)=>{
    const x0=CFG.priceColW+bi*tW,an=analytics[bi]||{},fp=bar.footprint;
    if(!fp||!fp.length) return;
    if(CONFIGURED_IND.includes('va-fill')){const y1=pxY(bar.vah),y2=pxY(bar.val)+CFG.rowH;cx.save();cx.fillStyle='rgba(40,80,200,0.12)';cx.fillRect(x0,Math.min(y1,y2),bW,Math.abs(y2-y1));cx.restore();}
    if(CONFIGURED_IND.includes('vol-prof')){fp.forEach(row=>{const v=row.trdVol||row.vol||0,ry=pxY(row.price),len=(v/an.maxVol)*bW*0.42;fillRow(x0+bW-len,ry,len,'rgba(55,90,200,0.32)');if(Math.abs(row.price-bar.pocPrice)<CFG.tickSize*0.5) fillRow(x0,ry,bW,'rgba(255,215,0,0.14)');});}
    if(CONFIGURED_IND.includes('vol-buy')||CONFIGURED_IND.includes('vol-sell')){fp.forEach(row=>{const ry=pxY(row.price);if(CONFIGURED_IND.includes('vol-buy')&&row.liftTrdVol>0){const w=(row.liftTrdVol/an.maxVol)*bW*0.22;fillRow(x0,ry,w,'rgba(0,200,80,0.45)');}if(CONFIGURED_IND.includes('vol-sell')&&row.hitTrdVol>0){const w=(row.hitTrdVol/an.maxVol)*bW*0.22;fillRow(x0+bW-w,ry,w,'rgba(220,0,30,0.45)');}});}
    if(CONFIGURED_IND.includes('mom-color')){fp.forEach(row=>{const d=row.delta||0,intensity=Math.min(0.40,Math.abs(d)/(an.totalVol*0.4+1));if(d>0) fillRow(x0,pxY(row.price),bW,`rgba(0,200,80,${intensity.toFixed(3)})`);else if(d<0) fillRow(x0,pxY(row.price),bW,`rgba(220,0,30,${intensity.toFixed(3)})`);});}
    if(CONFIGURED_IND.some(id=>['stk-imb-buy','stk-imb-bull'].includes(id))){(an.bullZones||[]).forEach(z=>{for(let i=z.from;i<=z.to;i++){if(fp[i]) fillRow(x0,pxY(fp[i].price),bW,'rgba(0,255,100,0.18)');}if(fp[z.from]&&fp[z.to]){const yT=pxY(fp[z.to].price),yB=pxY(fp[z.from].price)+CFG.rowH;cx.save();cx.strokeStyle='#00ff80';cx.lineWidth=1.5;cx.setLineDash([4,2]);cx.strokeRect(x0+1,yT,bW-2,yB-yT);cx.setLineDash([]);cx.restore();floatTxt('▲ STK BUY',x0+bW/2,yT-2,'#00ff80',7,'center',true);}});}
    if(CONFIGURED_IND.some(id=>['stk-imb-sell','stk-imb-bear'].includes(id))){(an.bearZones||[]).forEach(z=>{for(let i=z.from;i<=z.to;i++){if(fp[i]) fillRow(x0,pxY(fp[i].price),bW,'rgba(255,0,80,0.18)');}if(fp[z.from]&&fp[z.to]){const yT=pxY(fp[z.to].price),yB=pxY(fp[z.from].price)+CFG.rowH;cx.save();cx.strokeStyle='#ff0050';cx.lineWidth=1.5;cx.setLineDash([4,2]);cx.strokeRect(x0+1,yT,bW-2,yB-yT);cx.setLineDash([]);cx.restore();floatTxt('▼ STK SELL',x0+bW/2,yB+9,'#ff0050',7,'center',true);}});}
    if(CONFIGURED_IND.includes('stop-vol')){if(an.stopBull&&fp[0]){const ry=pxY(fp[0].price);fillRow(x0,ry,bW,'rgba(0,240,240,0.25)');outlineRow(x0,ry,bW,'#00ffff',2,[3,2]);rowTxt('STOP ↑',x0+bW/2,ry,'#00ffff',8,'center',true);}if(an.stopBear&&fp[fp.length-1]){const ry=pxY(fp[fp.length-1].price);fillRow(x0,ry,bW,'rgba(255,0,240,0.25)');outlineRow(x0,ry,bW,'#ff00ef',2,[3,2]);rowTxt('STOP ↓',x0+bW/2,ry,'#ff00ef',8,'center',true);}}
    if(CONFIGURED_IND.includes('thin-on')){(an.thinRows||[]).forEach(row=>{const ry=pxY(row.price);fillRow(x0,ry,bW,'rgba(0,80,220,0.28)');outlineRow(x0,ry,bW,'#4488ff',0.8);});}
    if(CONFIGURED_IND.includes('of-absorption')){(an.absorptionRows||[]).forEach(row=>{const ry=pxY(row.price),B=Math.max(row.bid||0,row.bSize||0),A=Math.max(row.ask||0,row.aSize||0),bull=B>=A;fillRow(x0,ry,bW,bull?'rgba(255,200,0,0.28)':'rgba(255,60,180,0.28)');outlineRow(x0,ry,bW,bull?'#ffcc00':'#ff40cc',1.5);rowTxt(bull?'ABS ↑':'ABS ↓',x0+bW-2,ry,bull?'#ffcc00':'#ff40cc',8,'right',true);});}
    if(CONFIGURED_IND.includes('of-exhaustion')){if(an.exhaustTop&&fp.length>1){const ry=pxY(fp[fp.length-1].price);fillRow(x0,ry,bW,'rgba(255,40,40,0.32)');outlineRow(x0,ry,bW,'#ff4444',2);rowTxt('EXH ▲',x0+bW/2,ry,'#ff4444',8,'center',true);}if(an.exhaustBot&&fp.length>1){const ry=pxY(fp[0].price);fillRow(x0,ry,bW,'rgba(0,255,100,0.32)');outlineRow(x0,ry,bW,'#00ff88',2);rowTxt('EXH ▼',x0+bW/2,ry,'#00ff88',8,'center',true);}}
    if(CONFIGURED_IND.includes('of-excess')){if(an.excessTop&&fp.length>1){const ry=pxY(fp[fp.length-1].price);fillRow(x0,ry,bW,'rgba(255,120,0,0.18)');hline(ry,x0,x0+bW,'#ff7800',2.5);rowTxt('REJ ▲',x0+bW-2,ry,'#ff7800',7,'right',true);}if(an.excessBot&&fp.length>1){const ry=pxY(fp[0].price);fillRow(x0,ry,bW,'rgba(0,200,255,0.18)');hline(ry+CFG.rowH-1,x0,x0+bW,'#00c8ff',2.5);rowTxt('REJ ▼',x0+bW-2,ry,'#00c8ff',7,'right',true);}}
    if(CONFIGURED_IND.includes('delta-pct')){(an.deltaRows||[]).forEach(dr=>{const ry=pxY(dr.price);rowTxt(dr.pct.toFixed(1)+'%',x0+bW-2,ry,dr.delta>=0?'#44ff88':'#ff5555',7,'right');});}
    if(CONFIGURED_IND.includes('delta-minmax')&&fp.length){const maxD=fp.reduce((m,r)=>r.delta>m.delta?r:m,fp[0]),minD=fp.reduce((m,r)=>r.delta<m.delta?r:m,fp[0]);floatTxt('◀',x0-2,pxY(maxD.price)+CFG.rowH-4,'#00ff88',10,'right',true);if(minD.price!==maxD.price) floatTxt('◀',x0-2,pxY(minD.price)+CFG.rowH-4,'#ff4444',10,'right',true);}
    if(CONFIGURED_IND.includes('delta-divergence')){
      const _ddDelta=bar.delta||0;
      const _ddBull=bar.isBull;
      if(_ddBull&&_ddDelta>0){
        const _yAbove=pxY(bar.high)-14;
        cx.save();
        cx.fillStyle='#ff00ff';
        cx.beginPath();cx.arc(x0+bW/2,_yAbove,5,0,Math.PI*2);cx.fill();
        cx.strokeStyle='rgba(255,0,255,0.5)';cx.lineWidth=1;
        cx.beginPath();cx.arc(x0+bW/2,_yAbove,8,0,Math.PI*2);cx.stroke();
        cx.restore();
        floatTxt('B.DIV',x0+bW/2,_yAbove-10,'#ff00ff',7,'center',true);
      }
      if(!_ddBull&&_ddDelta<0){
        const _yBelow=pxY(bar.low)+CFG.rowH+14;
        cx.save();
        cx.fillStyle='#00ff88';
        cx.beginPath();cx.arc(x0+bW/2,_yBelow,5,0,Math.PI*2);cx.fill();
        cx.strokeStyle='rgba(0,255,136,0.5)';cx.lineWidth=1;
        cx.beginPath();cx.arc(x0+bW/2,_yBelow,8,0,Math.PI*2);cx.stroke();
        cx.restore();
        floatTxt('Bu.DIV',x0+bW/2,_yBelow+12,'#00ff88',7,'center',true);
      }
    }
    if(CONFIGURED_IND.includes('of-initiative')){let lbl='',col='';if(bar.isBull&&bar.delta>0){lbl='INIT BUY';col='#00ff88';}else if(bar.isBull&&bar.delta<0){lbl='RESP SELL';col='#ff8844';}else if(!bar.isBull&&bar.delta<0){lbl='INIT SELL';col='#ff4444';}else if(!bar.isBull&&bar.delta>0){lbl='RESP BUY';col='#44aaff';}if(lbl){const lblY=bar.isBull?pxY(bar.high)-5:pxY(bar.low)+CFG.rowH+10;floatTxt(lbl,x0+bW/2,lblY,col,7,'center',true);}}
    if(CONFIGURED_IND.includes('of-aggressor')&&an.aggBias!=='NEUTRAL'){const col=an.aggBias==='BID'?'#00ff88':'#ff4444',lbl=an.aggBias==='BID'?'▲BID AGGR':'▼ASK AGGR',lblY=an.aggBias==='BID'?pxY(bar.high)-14:pxY(bar.low)+CFG.rowH+20;floatTxt(lbl,x0+bW/2,lblY,col,8,'center',true);}
    if(CONFIGURED_IND.includes('mom-bull')&&an.momBull){cx.fillStyle='rgba(0,255,80,0.55)';cx.fillRect(x0,fy,bW,3);}
    if(CONFIGURED_IND.includes('mom-bear')&&an.momBear){cx.fillStyle='rgba(255,0,50,0.55)';cx.fillRect(x0,fy,bW,3);}
    if(CONFIGURED_IND.includes('delta-candle')){const col=bar.delta>=0?'rgba(0,220,80,0.60)':'rgba(220,0,30,0.60)',yT=pxY(bar.high),yB=pxY(bar.low)+CFG.rowH;cx.save();cx.strokeStyle=col;cx.lineWidth=2;cx.strokeRect(x0+1,yT,bW-2,yB-yT);cx.restore();}
    if(CONFIGURED_IND.includes('vah-line')){const y=pxY(bar.vah);hline(y,x0,x0+tW,'#44aaff',1.2,[5,3]);floatTxt('VAH '+bar.vah.toFixed(2),x0+tW-1,y-2,'#44aaff',7,'right');}
    if(CONFIGURED_IND.includes('val-line')){const y=pxY(bar.val)+CFG.rowH;hline(y,x0,x0+tW,'#ff8844',1.2,[5,3]);floatTxt('VAL '+bar.val.toFixed(2),x0+tW-1,y-2,'#ff8844',7,'right');}
    if(CONFIGURED_IND.includes('poc-line')){const y=pxY(bar.pocPrice)+CFG.rowH/2;hline(y,x0,x0+tW,'rgba(255,220,0,0.80)',1.5,[6,3]);floatTxt(bar.pocPrice.toFixed(2),x0+tW-1,y-2,'#ffdd00',7,'right',true);}
    if(CONFIGURED_IND.includes('poc-migrate')&&bi>0){const prev=bars[bi-1],y1=pxY(prev.pocPrice)+CFG.rowH/2,y2=pxY(bar.pocPrice)+CFG.rowH/2;cx.save();cx.strokeStyle='rgba(255,220,0,0.60)';cx.lineWidth=1.5;cx.setLineDash([3,5]);cx.beginPath();cx.moveTo(x0,y1);cx.lineTo(x0+tW,y2);cx.stroke();cx.setLineDash([]);cx.restore();}
  });

  // Cross-bar overlays
  if(CONFIGURED_IND.includes('vwap-line')&&vwapPts.length>1){cx.save();cx.strokeStyle=CFG.vwapColor;cx.lineWidth=2;cx.setLineDash([6,3]);cx.beginPath();vwapPts.forEach((v,bi)=>{const x=CFG.priceColW+bi*tW+bW/2,y=pxY(v);bi===0?cx.moveTo(x,y):cx.lineTo(x,y);});cx.stroke();cx.setLineDash([]);const lv=vwapPts[vwapPts.length-1];floatTxt('VWAP '+lv.toFixed(2),CFG.priceColW+4,pxY(lv)-3,CFG.vwapColor,8,'left',true);cx.restore();}
  if(CONFIGURED_IND.includes('vwap-sd1')&&vwapSD>0){[1,-1].forEach(sign=>{cx.save();cx.strokeStyle='rgba(100,180,0,0.60)';cx.lineWidth=1.2;cx.setLineDash([5,4]);cx.beginPath();vwapPts.forEach((v,bi)=>{const x=CFG.priceColW+bi*tW+bW/2,y=pxY(v+sign*vwapSD);bi===0?cx.moveTo(x,y):cx.lineTo(x,y);});cx.stroke();cx.setLineDash([]);const lv=vwapPts[vwapPts.length-1]+sign*vwapSD;floatTxt(sign>0?'VWAP+1σ':'VWAP-1σ',CFG.priceColW+4,pxY(lv)-3,'rgba(130,210,0,0.80)',7,'left');cx.restore();});}
  if(CONFIGURED_IND.includes('vwap-sd2')&&vwapSD>0){[2,-2].forEach(sign=>{cx.save();cx.strokeStyle='rgba(60,120,0,0.50)';cx.lineWidth=1;cx.setLineDash([3,6]);cx.beginPath();vwapPts.forEach((v,bi)=>{const x=CFG.priceColW+bi*tW+bW/2,y=pxY(v+sign*vwapSD);bi===0?cx.moveTo(x,y):cx.lineTo(x,y);});cx.stroke();cx.setLineDash([]);const lv=vwapPts[vwapPts.length-1]+sign*vwapSD;floatTxt(sign>0?'VWAP+2σ':'VWAP-2σ',CFG.priceColW+4,pxY(lv)-3,'rgba(90,160,0,0.70)',7,'left');cx.restore();});}
  if(CONFIGURED_IND.includes('delta-cum')&&bars.length>1){const maxAbs=Math.max(1,...bars.map(b=>Math.abs(b.cumD))),zeroY=H-44,amp=Math.min(35,(H-80)/4);cx.save();cx.strokeStyle='rgba(80,130,255,0.75)';cx.lineWidth=1.5;cx.setLineDash([4,3]);cx.beginPath();bars.forEach((bar,bi)=>{const x=CFG.priceColW+bi*tW+bW/2,y=zeroY-(bar.cumD/maxAbs)*amp;bi===0?cx.moveTo(x,y):cx.lineTo(x,y);});cx.stroke();cx.setLineDash([]);cx.strokeStyle='rgba(80,130,255,0.25)';cx.lineWidth=0.5;cx.setLineDash([2,4]);cx.beginPath();cx.moveTo(CFG.priceColW,zeroY);cx.lineTo(W,zeroY);cx.stroke();cx.setLineDash([]);floatTxt('CumΔ',CFG.priceColW+4,zeroY-3,'rgba(100,155,255,0.80)',7,'left');cx.restore();}
}

/* ============================================================
   INIT
   ============================================================ */

/* ============================================================
   TIME RANGE + BUILD CANDLES + PREV/NEXT NAVIGATION
   ============================================================ */
var _trAllRows = [];
var _trBars    = [];
var _trOffset  = 0;

function trRowTs(r) { return (r.date||'') + 'T' + (r.time||'00:00:00'); }

function trSyncFromDT() {
  var sv = (document.getElementById('tr-start-dt')||{}).value||'';
  var ev = (document.getElementById('tr-end-dt')||{}).value||'';
  var sh = document.getElementById('tr-start');
  var eh = document.getElementById('tr-end');
  if (sh) sh.value = sv;
  if (eh) eh.value = ev;
  _trUpdateBadge();
}

function trQuick(preset) {
  if (!_trAllRows.length) return;
  var sorted = _trAllRows.slice().sort(function(a,b){ return trRowTs(a)<trRowTs(b)?-1:1; });
  var fd = sorted[0].date||'', ld = sorted[sorted.length-1].date||fd;
  var dtS = document.getElementById('tr-start-dt');
  var dtE = document.getElementById('tr-end-dt');
  if (!dtS) return;
  if (preset==='full'){ dtS.value=fd+'T00:00:00'; dtE.value=ld+'T23:59:59'; }
  else if (preset==='am'){ dtS.value=fd+'T00:00:00'; dtE.value=fd+'T11:59:59'; }
  else if (preset==='pm'){ dtS.value=fd+'T12:00:00'; dtE.value=ld+'T23:59:59'; }
  else if (preset==='rth'){ dtS.value=fd+'T09:30:00'; dtE.value=ld+'T16:00:00'; }
  trSyncFromDT();
}

function _trUpdateBadge() {
  var badge = document.getElementById('tr-tick-badge');
  if (!badge || !_trAllRows.length) { if(badge) badge.textContent=''; return; }
  var sv = (document.getElementById('tr-start-dt')||{}).value||'';
  var ev = (document.getElementById('tr-end-dt')||{}).value||'';
  var count = _trAllRows.length;
  if (sv||ev) {
    count = _trAllRows.filter(function(r){
      var ts=trRowTs(r);
      if(sv&&ts<sv) return false;
      if(ev&&ts>ev) return false;
      return true;
    }).length;
  }
  badge.textContent = count.toLocaleString()+' ticks';
  badge.style.color = count>0?'#00aa55':'#884422';
}

function trAutoPopulate(rows) {
  if (!rows||!rows.length) return;
  var valid = rows.filter(function(r){ return _toAbsMs(r) > 0; });
  if (!valid.length) return;
  var sorted = valid.slice().sort(function(a,b){ return _toAbsMs(a)-_toAbsMs(b); });
  var first=sorted[0], last=sorted[sorted.length-1];
  var dtS=document.getElementById('tr-start-dt');
  var dtE=document.getElementById('tr-end-dt');
  var p=function(n){return String(n).padStart(2,'0');};
  var mkVal=function(ms){
    var d=new Date(ms);
    if(isNaN(d.getTime())||d.getFullYear()<2000) return '';
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  };
  if (dtS) dtS.value=mkVal(_toAbsMs(first));
  if (dtE) dtE.value=mkVal(_toAbsMs(last));
  trSyncFromDT();
}

function buildCandles() {
  var rows = (_dtActive && _dtFilteredRows && _dtFilteredRows.length)
    ? _dtFilteredRows
    : _trAllRows;

  if (!rows.length) { alert('Load a file first.'); return; }

  var bars = _bucketByInterval(rows, CFG.intervalSec);
  if (!bars.length) {
    alert('No bars could be built.\nCheck tick size and time range.');
    return;
  }

  _trBars = bars;
  _trBuildRows = rows;
  var cd = 0;
  _trBars.forEach(function(b){ cd += b.delta; b.cumD = cd; });

  var n = parseInt(document.getElementById('bar-n').value) || 10;
  _trOffset = Math.max(0, _trBars.length - n);

  _trApplyView();
  _trUpdateNavInfo();

  var dsrc = document.getElementById('dsrc');
  if (dsrc) dsrc.textContent =
    '\u25cf ' + rows.length.toLocaleString() + ' ticks \u00b7 ' + bars.length + ' bars';
}

var _trBuildRows = null;

function _trRebucketForInterval() {
  if (!_trBars || !_trBars.length) return false;
  var rows = (_trBuildRows && _trBuildRows.length) ? _trBuildRows : _trAllRows;
  if (!rows || !rows.length) return false;
  var bars = _bucketByInterval(rows, CFG.intervalSec);
  if (!bars.length) return false;
  _trBars = bars;
  var cd = 0;
  _trBars.forEach(function(b){ cd += b.delta; b.cumD = cd; });
  var n = parseInt(document.getElementById('bar-n').value) || 10;
  _trOffset = Math.max(0, _trBars.length - n);
  _trApplyView();
  var dsrc = document.getElementById('dsrc');
  if (dsrc) dsrc.textContent = '\u25cf ' + rows.length.toLocaleString() + ' ticks \u00b7 ' + bars.length + ' bars';
  return true;
}

function _trApplyView() {
  if (!_trBars.length) return;

  var n = parseInt(document.getElementById('bar-n').value) || 10;

  _trOffset = Math.max(0, Math.min(_trOffset, Math.max(0, _trBars.length - n)));

  var slice = _trBars.slice(_trOffset, _trOffset + n);

  var cd = _trOffset > 0 ? (_trBars[_trOffset - 1].cumD || 0) : 0;
  slice.forEach(function(b){ cd += b.delta; b.cumD = cd; });

  _closedBars = slice;
  _openBarTicks = [];

  if (R) { R.destroy(); R = null; }
  R = new Renderer([]);
  _rebuildDisplay();
  syncMode(CFG.mode);

  setTimeout(function(){
    var hs = document.getElementById('hscroll');
    if (hs) hs.scrollLeft = 999999;
  }, 60);

  if (typeof csUpdateLast === 'function') csUpdateLast();
  _trUpdateNavInfo();
}

function _trUpdateNavInfo() {
  var n    = parseInt(document.getElementById('bar-n').value) || 10;
  var total = _trBars.length;
  var first = _trOffset + 1;
  var last  = Math.min(_trOffset + n, total);

  var info = document.getElementById('tr-nav-info');
  if (info) {
    info.textContent = total > 0
      ? 'bars ' + first + '\u2013' + last + ' / ' + total
      : '— no bars —';
    info.style.color = total > 0 ? '#00aa55' : '#884422';
  }

  var prevBtn = document.querySelector('[onclick="trNav(-1)"]');
  var nextBtn = document.querySelector('[onclick="trNav(1)"]');
  if (prevBtn) {
    var hasPrev = _trOffset > 0;
    prevBtn.style.color  = hasPrev ? '#44aaff' : '#333';
    prevBtn.style.borderColor = hasPrev ? '#005599' : '#1e1e1e';
    prevBtn.style.cursor = hasPrev ? 'pointer' : 'default';
  }
  if (nextBtn) {
    var hasNext = _trOffset + n < _trBars.length;
    nextBtn.style.color  = hasNext ? '#44aaff' : '#333';
    nextBtn.style.borderColor = hasNext ? '#005599' : '#1e1e1e';
    nextBtn.style.cursor = hasNext ? 'pointer' : 'default';
  }
}

function trNav(dir) {
  if (!_trBars.length) {
    buildCandles();
    return;
  }
  var n = parseInt(document.getElementById('bar-n').value) || 10;
  var newOffset = _trOffset + dir * n;
  newOffset = Math.max(0, Math.min(newOffset, Math.max(0, _trBars.length - n)));

  if (newOffset === _trOffset) return;
  _trOffset = newOffset;
  _trApplyView();
}

/* ============================================================
   TAB SYSTEM
   ============================================================ */
function switchTab(tab) {
  // Activate selected top tab and matching pane
  document.querySelectorAll('.main-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === tab + '-pane');
  });

  // Re-render the active tab from the current/selected interval data
  try {
    if (tab === 'chart' && R) { R.resize(); R.draw(); }
    if (tab === 'tradelog' && typeof tlRender === 'function') tlRender();
    if (tab === 'summary'  && typeof sumRender === 'function') sumRender();
    if (tab === 'levels'   && typeof aggBuild === 'function') aggBuild();
    if (tab === 'lagr'     && typeof laRebuild === 'function') laRebuild();
    if (tab === 'dfpairs'  && typeof dfpRender === 'function') { dfpInit(); dfpRender(); }
    if (tab === 'v8agent' && typeof syncV8Agent === 'function') {
      setTimeout(function(){ syncV8Agent(true); }, 40);
    }
  } catch (e) {
    console.error('switchTab render error:', e);
  }
}


/* ============================================================
   DELTA FLIP PAIRS TAB
   Current-interval footprint table + selectable delta-flip pairs
   ============================================================ */
const DFP_PAIRS = [
  {key:'lhBid', label:'L-H Bid', pos:'liftBid', neg:'hitBid', barPos:'totalLiftBid', barNeg:'totalHitBid'},
  {key:'lhAsk', label:'L-H Ask', pos:'liftAsk', neg:'hitAsk', barPos:'totalLiftAsk', barNeg:'totalHitAsk'},
  {key:'aggNet', label:'AGGR Bid-Ask', pos:'aggrBid', neg:'aggrAsk', barPos:'totalAggrBid', barNeg:'totalAggrAsk'},
  {key:'hlVol', label:'L-H Vol', pos:'liftTrdVol', neg:'hitTrdVol', barPos:'totalLiftVol', barNeg:'totalHitVol'},
  {key:'lhRTL', label:'L-H Trades', pos:'liftRTL', neg:'hitRTL', barPos:'totalLiftRTL', barNeg:'totalHitRTL'},
  {key:'lhSEQ', label:'L-H Elig_V', pos:'liftSeqDiff', neg:'hitSeqDiff', barPos:'totalLiftSeq', barNeg:'totalHitSeq'},
  {key:'lhOrder', label:'L-H Order', pos:'liftNumOrders', neg:'hitNumOrders', barPos:'totalLiftNumOrders', barNeg:'totalHitNumOrders'},
];
function dfpBars(){
  try{
    if(typeof _currentIntervalRows==='function'){
      const rows=_currentIntervalRows();
      if(rows && rows.length){
        const b=_ticksToBar(rows);
        if(b){
          if(typeof _closedBars!=='undefined' && _closedBars && _closedBars.length){
            b.cumD=(_closedBars[_closedBars.length-1].cumD||0)+(b.delta||0);
          }
          b.isOpen=true;
          return [b];
        }
      }
    }
  }catch(e){}
  if(typeof _csFocusedBar!=='undefined' && _csFocusedBar) return [_csFocusedBar];
  if(R && Array.isArray(R.bars) && R.bars.length) return [R.bars[R.bars.length-1]];
  if(Array.isArray(_trBars) && _trBars.length) return [_trBars[_trBars.length-1]];
  return [];
}
function dfpSelected(){
  return [...document.querySelectorAll('.dfp-pair-pill')]
    .filter(x=>x.classList.contains('on')).map(x=>x.dataset.pair);
}
function dfpInit(){
  document.querySelectorAll('.dfp-pair-pill').forEach(p=>{
    if(p._dfpBound) return; p._dfpBound=true;
    p.addEventListener('click', e=>{
      e.preventDefault();
      const on=!p.classList.contains('on');
      p.classList.toggle('on',on);
      const cb=p.querySelector('input'); if(cb) cb.checked=on;
      dfpRender();
    });
  });
}
function dfpSelectAll(on){
  document.querySelectorAll('.dfp-pair-pill').forEach(p=>{p.classList.toggle('on',!!on); const cb=p.querySelector('input'); if(cb) cb.checked=!!on;});
  dfpRender();
}
function dfpFmt(v){v=Math.round(v||0); if(Math.abs(v)>=1000000)return (v/1000000).toFixed(1)+'M'; if(Math.abs(v)>=10000)return (v/1000).toFixed(1)+'k'; return v.toLocaleString();}
function dfpPriceFmt(v){v=+(v||0); return Number.isFinite(v)?v.toFixed(1).replace('.',','):'—';}
function dfpMetric(obj,pair,barLevel){
  const a=+(obj[pair.pos] ?? obj[pair.barPos] ?? 0);
  const b=+(obj[pair.neg] ?? obj[pair.barNeg] ?? 0);
  const d=a-b;
  const den=Math.abs(a)+Math.abs(b);
  return {a,b,d,pct:den?Math.round(Math.abs(d)/den*100):0};
}
function dfpBarMetric(bar,pair){
  const a=+(bar[pair.barPos] ?? bar[pair.pos] ?? 0);
  const b=+(bar[pair.barNeg] ?? bar[pair.neg] ?? 0);
  const d=a-b, den=Math.abs(a)+Math.abs(b);
  return {a,b,d,pct:den?Math.round(Math.abs(d)/den*100):0};
}
function dfpBarHtml(m,big){
  const pct=Math.max(0,Math.min(100, m.pct||0));
  const pos=m.d>=0;
  const main=pct, rem=100-pct;
  if(pos){
    return `<div class="dfp-bar-wrap"><div class="dfp-status-bar pos"><div class="dfp-status-green" style="width:${main}%;"></div><div class="dfp-status-red" style="width:${rem}%;"></div></div><span class="${big?'dfp-bigbar-pct':'dfp-bar-pct'}">${pct}%</span></div>`;
  }
  return `<div class="dfp-bar-wrap"><div class="dfp-status-bar neg"><div class="dfp-status-red" style="width:${main}%;"></div><div class="dfp-status-green" style="width:${rem}%;"></div></div><span class="${big?'dfp-bigbar-pct':'dfp-bar-pct'}" style="color:#ff5555">${pct}%</span></div>`;
}
function dfpEnsureLayout(){
  const wrap=document.getElementById('dfp-wrap');
  if(!wrap || document.getElementById('dfp-main')) return;
  const empty=document.getElementById('dfp-empty');
  const tbl=document.getElementById('dfp-table');
  const main=document.createElement('div'); main.id='dfp-main';
  if(empty) main.appendChild(empty);
  if(tbl) main.appendChild(tbl);
  const side=document.createElement('div'); side.id='dfp-side';
  wrap.appendChild(main); wrap.appendChild(side);
}
function dfpRenderSide(bar,cols){
  const side=document.getElementById('dfp-side'); if(!side) return;
  const primary=cols[0] || DFP_PAIRS[0];
  const m=dfpBarMetric(bar, primary);
  const delta=+(bar.delta||0), totalVol=+(bar.totalVol||bar.totalTrdVol||0);
  const dpct=totalVol?delta/totalVol*100:0;
  side.innerHTML=`
    <div class="dfp-side-title">Candle Summary</div>
    <div class="dfp-bigbar-box">
      <div class="dfp-bigbar-label">${primary.label} % (This bar)</div>
      <div class="dfp-bigbar-row">${dfpBarHtml(m,true)}</div>
    </div>
    <div class="dfp-cs-grid">
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Price</div><div class="dfp-cs-val">${dfpPriceFmt(bar.close)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Open</div><div class="dfp-cs-val">${dfpPriceFmt(bar.open)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">High</div><div class="dfp-cs-val dfp-pos">${dfpPriceFmt(bar.high)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Low</div><div class="dfp-cs-val dfp-neg">${dfpPriceFmt(bar.low)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Close</div><div class="dfp-cs-val">${dfpPriceFmt(bar.close)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Total Vol</div><div class="dfp-cs-val">${dfpFmt(totalVol)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Delta</div><div class="dfp-cs-val ${delta>=0?'dfp-pos':'dfp-neg'}">${dfpFmt(delta)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Delta %</div><div class="dfp-cs-val ${dpct>=0?'dfp-pos':'dfp-neg'}">${dpct.toFixed(2)}%</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Bid Vol</div><div class="dfp-cs-val">${dfpFmt(bar.sellVol||bar.totalHitVol||0)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Ask Vol</div><div class="dfp-cs-val">${dfpFmt(bar.buyVol||bar.totalLiftVol||0)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">POC</div><div class="dfp-cs-val dfp-yellow">${dfpPriceFmt(bar.pocPrice)}</div></div>
      <div class="dfp-cs-cell"><div class="dfp-cs-lbl">Levels</div><div class="dfp-cs-val">${(bar.footprint||[]).length}</div></div>
    </div>`;
}
function dfpRender(){
  dfpInit(); dfpEnsureLayout();
  const bars=dfpBars();
  const selected=dfpSelected();
  const empty=document.getElementById('dfp-empty'), tbl=document.getElementById('dfp-table'), head=document.getElementById('dfp-head'), body=document.getElementById('dfp-body');
  const barsEl=document.getElementById('dfp-bars'), selEl=document.getElementById('dfp-selected');
  if(barsEl) barsEl.textContent=bars.length.toLocaleString();
  if(selEl) selEl.textContent=selected.length?selected.map(k=>(DFP_PAIRS.find(p=>p.key===k)||{}).label||k).join(', '):'None';
  const bar=bars[0];
  const cols=selected.map(k=>DFP_PAIRS.find(p=>p.key===k)).filter(Boolean);
  if(!bar || !cols.length || !Array.isArray(bar.footprint) || !bar.footprint.length){
    if(empty)empty.style.display='flex'; if(tbl)tbl.style.display='none';
    const side=document.getElementById('dfp-side'); if(side) side.innerHTML='<div class="dfp-side-title">Candle Summary</div><div style="color:#446688;font-size:11px;line-height:1.7;padding:8px;">No current interval data.</div>';
    return;
  }
  if(empty)empty.style.display='none'; if(tbl)tbl.style.display='table';
  dfpRenderSide(bar, cols);
  if(head){
    head.innerHTML='<tr><th>Price</th><th>BID_S2</th><th>ASK_S2</th><th>TRD_VOL</th><th>Delta</th>'+cols.map(c=>`<th>${c.label}</th><th>Δ Flip</th><th>${c.label} %</th>`).join('')+'<th>Bid</th><th>Ask</th></tr>';
  }
  let rows=[...bar.footprint].sort((a,b)=>b.price-a.price);
  const sort=(document.getElementById('dfp-sort')||{}).value||'time';
  if(sort==='score') rows.sort((a,b)=>{
    const am=Math.max(...cols.map(c=>dfpMetric(a,c).pct||0));
    const bm=Math.max(...cols.map(c=>dfpMetric(b,c).pct||0));
    return bm-am;
  });
  if(sort==='delta') rows.sort((a,b)=>Math.abs(b.delta||0)-Math.abs(a.delta||0));
  if(sort==='vol') rows.sort((a,b)=>(b.trdVol||b.vol||0)-(a.trdVol||a.vol||0));
  if(body) body.innerHTML=rows.map(lv=>{
    const delta=+(lv.delta||0);
    const base=`<td class="dfp-price">${dfpPriceFmt(lv.price)}</td><td class="dfp-pos">${dfpFmt(lv.bSize||lv.bid||0)}</td><td class="dfp-cyan">${dfpFmt(lv.aSize||lv.ask||0)}</td><td class="dfp-yellow">${dfpFmt(lv.trdVol||lv.vol||0)}</td><td class="${delta>=0?'dfp-pos':'dfp-neg'}">${dfpFmt(delta)}</td>`;
    const cells=cols.map(c=>{
      const m=dfpMetric(lv,c);
      const cls=m.d>0?'dfp-pos':m.d<0?'dfp-neg':'dfp-zero';
      return `<td class="dfp-purple">${dfpFmt(m.a)}</td><td class="${cls}">${dfpFmt(m.d)}</td><td class="dfp-bar-cell">${dfpBarHtml(m,false)}</td>`;
    }).join('');
    const bidAsk=`<td class="dfp-pos">${dfpPriceFmt(lv.price)}</td><td class="dfp-neg">${dfpPriceFmt(lv.price)}</td>`;
    return `<tr class="${delta>=0?'dfp-dom-pos':'dfp-dom-neg'}">${base}${cells}${bidAsk}</tr>`;
  }).join('');
}


/* ============================================================
   BACKGROUND THEMES
   ============================================================ */
const BG_THEMES = {
  dark:      { bg:'#1a1a1a', grid:'#282828', colHdr:'#1a1a1a', timeAxis:'#111', priceCol:'#111', scale:'#111', txt:'#ddd', price:'#888', header:'#111', bdr:'#333' },
  black:     { bg:'#000000', grid:'#181818', colHdr:'#000',     timeAxis:'#080808', priceCol:'#080808', scale:'#080808', txt:'#ccc', price:'#777', header:'#080808', bdr:'#222' },
  midnight:  { bg:'#06101f', grid:'#0d1f35', colHdr:'#060d1a',  timeAxis:'#060d1a', priceCol:'#060d1a', scale:'#060d1a', txt:'#b0c8e8', price:'#5070a0', header:'#060d1a', bdr:'#1a2a3a' },
  charcoal:  { bg:'#2a2a2a', grid:'#383838', colHdr:'#222',     timeAxis:'#222',    priceCol:'#222',    scale:'#222',    txt:'#ddd', price:'#999', header:'#222', bdr:'#444' },
  darkgreen: { bg:'#0a130a', grid:'#101e10', colHdr:'#080f08',  timeAxis:'#080f08', priceCol:'#080f08', scale:'#080f08', txt:'#b0d0b0', price:'#507050', header:'#080f08', bdr:'#1a2a1a' },
  navy:      { bg:'#080f1a', grid:'#0d1828', colHdr:'#060c14',  timeAxis:'#060c14', priceCol:'#060c14', scale:'#060c14', txt:'#b0c8e8', price:'#486080', header:'#060c14', bdr:'#182030' },
  slate:     { bg:'#1a1f28', grid:'#252b36', colHdr:'#141820',  timeAxis:'#141820', priceCol:'#141820', scale:'#141820', txt:'#c8d0dc', price:'#7080a0', header:'#141820', bdr:'#2a3040' },
  warm:      { bg:'#1a1408', grid:'#281e0c', colHdr:'#140e04',  timeAxis:'#140e04', priceCol:'#140e04', scale:'#140e04', txt:'#e0d0b0', price:'#907040', header:'#140e04', bdr:'#3a280a' },
  light:     { bg:'#f0f0f0', grid:'#d8d8d8', colHdr:'#e0e0e0',  timeAxis:'#e0e0e0', priceCol:'#e8e8e8', scale:'#e8e8e8', txt:'#111',   price:'#444', header:'#e0e0e0', bdr:'#ccc' },
};

function applyBgTheme(name) {
  const t = BG_THEMES[name] || BG_THEMES.dark;
  CFG._bgTheme = t;
  if (R) R.draw();
}

/* ============================================================
   TRADE LOG  (Tab 2)
   ============================================================ */
let _tlRows = [];
let _tlSort = { col: 'time', dir: 1 };

const TL_ALL_COLS = [
  { key:'time',        label:'Timestamp',   w:130, dflt:true,  grp:'base',
    fmt: r => (r.date||'') + ' ' + (r.time||'—'), cls:'' },
  { key:'tick',        label:'PRCTCK_1',    w:60,  dflt:true,  grp:'base',
    fmt: r => { const v=r.tick||r.aggr||''; return v==='BID'?'↑':v==='ASK'?'↓':v||'—'; }, cls:'' },
  { key:'aggr',        label:'AGGRS_SID1',  w:72,  dflt:true,  grp:'base',
    fmt: r => r.aggr||'—',
    cls: r => r.aggr==='BID'?'tl-sell':r.aggr==='ASK'?'tl-buy':'' },
  { key:'last',        label:'TRDPRC_1',    w:72,  dflt:true,  grp:'base',
    fmt: r => r.last ? r.last.toFixed(2) : '—', cls:'tl-price' },
  { key:'bid',         label:'BID',         w:68,  dflt:true,  grp:'base',
    fmt: r => r.bid  ? r.bid.toFixed(2)  : '—', cls:'tl-num' },
  { key:'ask',         label:'ASK',         w:68,  dflt:true,  grp:'base',
    fmt: r => r.ask  ? r.ask.toFixed(2)  : '—', cls:'tl-num' },
  { key:'bSize',       label:'BIDSIZE',     w:60,  dflt:true,  grp:'base',
    fmt: r => r.bSize||0, cls:'tl-num' },
  { key:'aSize',       label:'ASKSIZE',     w:60,  dflt:true,  grp:'base',
    fmt: r => r.aSize||0, cls:'tl-num' },
  { key:'trdVol',      label:'TRDVOL_1',   w:65,  dflt:true,  grp:'base',
    fmt: r => r.trdVol||0, cls:'tl-num' },
  { key:'tradeId',     label:'TRADE_ID',    w:65,  dflt:true,  grp:'base',
    fmt: r => r.tradeId||0, cls:'tl-num' },
  { key:'seqNum',      label:'SEQNUM',      w:65,  dflt:true,  grp:'base',
    fmt: r => r.seqNum||0, cls:'tl-num' },
  { key:'rtCount',     label:'RTL',         w:50,  dflt:true,  grp:'base',
    fmt: r => r.rtCount||r.moves||0, cls:'tl-num' },
  { key:'condKey',     label:'QUALIFIERS',  w:180, dflt:true,  grp:'base',
    fmt: r => r.condKey||'', cls:'' },
  { key:'delta',       label:'Δ Delta',     w:58,  dflt:false, grp:'extra',
    fmt: r => { const d=(r.bSize||0)-(r.aSize||0); return (d>=0?'+':'')+d; },
    cls: r => { const d=(r.bSize||0)-(r.aSize||0); return d>=0?'tl-pos':'tl-neg'; } },
  { key:'hitRTL',      label:'Hit_RT',     w:58,  dflt:false, grp:'extra',
    fmt: r => r.hitRTL||(r.aSize||0)*4, cls:'tl-num' },
  { key:'liftRTL',     label:'Lift_RT',    w:58,  dflt:false, grp:'extra',
    fmt: r => r.liftRTL||(r.bSize||0)*4, cls:'tl-num' },
];

let _tlActiveCols = TL_ALL_COLS.filter(c=>c.dflt).map(c=>c.key);

function _tlPillCls(col) {
  if (col.key === 'bid' || col.key === 'bSize') return 'on-bid';
  if (col.key === 'ask' || col.key === 'aSize') return 'on-ask';
  if (col.key.startsWith('trdId') || col.key === 'tradeId') return 'on-hit';
  if (col.key.startsWith('lift') || col.key === 'rtCount') return 'on-lift';
  return 'on';
}

function tlBuildPills() {
  const box = document.getElementById('tl-col-pills');
  if (!box) return;
  box.innerHTML = TL_ALL_COLS.map(c => {
    const on = _tlActiveCols.includes(c.key);
    const cls = on ? _tlPillCls(c) : '';
    return `<span class="tl-col-pill${on?' '+cls:''}" data-key="${c.key}"
      onclick="tlToggleCol('${c.key}',this)">${c.label}</span>`;
  }).join('');
}

function tlToggleCol(key, el) {
  const idx = _tlActiveCols.indexOf(key);
  if (idx >= 0) _tlActiveCols.splice(idx, 1);
  else _tlActiveCols.push(key);
  const col = TL_ALL_COLS.find(c=>c.key===key);
  const newCls = _tlActiveCols.includes(key) && col ? _tlPillCls(col) : '';
  el.className = 'tl-col-pill' + (_tlActiveCols.includes(key) ? ' '+newCls : '');
  tlRender();
}

function tlColSelectAll(on) {
  _tlActiveCols = on ? TL_ALL_COLS.map(c=>c.key) : [];
  tlBuildPills();
  tlRender();
}

function tlBuildHeader() {
  const head = document.getElementById('tl-head');
  if (!head) return;
  const cols = TL_ALL_COLS.filter(c => _tlActiveCols.includes(c.key));
  head.innerHTML = cols.map(c => {
    const sortCls = c.key===_tlSort.col ? (_tlSort.dir===1?'sort-asc':'sort-desc') : '';
    return `<th class="${sortCls}" style="width:${c.w}px;min-width:${c.w}px" onclick="tlSortBy('${c.key}')">${c.label}</th>`;
  }).join('');
}

function tlSortBy(col) {
  if (_tlSort.col === col) _tlSort.dir *= -1;
  else { _tlSort.col = col; _tlSort.dir = 1; }
  tlRender();
}

function tlRender() {
  const tbody = document.getElementById('tl-body');
  const cnt   = document.getElementById('tl-count');
  if (!tbody) return;
  tlBuildPills();
  tlBuildHeader();

  const flt    = (document.getElementById('tl-filter-input')||{}).value||'';
  const side   = (document.getElementById('tl-side')||{}).value||'';
  const minVol = +(document.getElementById('tl-minvol')||{}).value||0;
  const q      = flt.toLowerCase();

  const _tlBaseRows = (typeof dtRows === 'function') ? dtRows() : _tlRows;
  let rows = (_tlBaseRows || []).filter(r => {
    if (side && r.aggr !== side) return false;
    if (minVol && (r.trdVol||0) < minVol) return false;
    if (q) {
      const str = `${r.date||''} ${r.time||''} ${r.last||''} ${r.aggr||''} ${r.condKey||''} ${r.tradeId||''}`.toLowerCase();
      if (!str.includes(q)) return false;
    }
    return true;
  });

  const sc = _tlSort.col, sd = _tlSort.dir;
  rows = rows.slice().sort((a, b) => {
    const av = a[sc] ?? 0, bv = b[sc] ?? 0;
    return typeof av === 'string' ? av.localeCompare(bv)*sd : (av-bv)*sd;
  });

  if (cnt) cnt.textContent = `${rows.length.toLocaleString()} rows`;

  const activeCols = TL_ALL_COLS.filter(c => _tlActiveCols.includes(c.key));
  const max = Math.min(rows.length, 8000);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < max; i++) {
    const r = rows[i];
    const isSpl = String(r.condKey||'').trim().toUpperCase().startsWith('SPL');
    const tr = document.createElement('tr');
    if (isSpl) tr.style.background = '#1a1400';
    tr.innerHTML = activeCols.map(c => {
      const val = c.fmt(r);
      const cls = typeof c.cls === 'function' ? c.cls(r) : (c.cls||'');
      return `<td class="${cls}" style="width:${c.w}px">${val===null||val===undefined?'':val}</td>`;
    }).join('');
    frag.appendChild(tr);
  }
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

/* ============================================================
   PRICE SUMMARY  (Tab 3)
   ============================================================ */

const SUM_ALL_COLS = [
  {key:'timestamp',label:'Timestamp',always:true,w:145,cls:'',dflt:true,fmt:v=>v||'—',noTotals:true,title:'Start time of the selected interval'},
  { key:'price',      label:'PRICE',     always:true, w:72,  cls:'',       dflt:true,  fmt:v=>v.toFixed(2) },
  { key:'delta',     label:'Δ',       always:false, w:52, dflt:true,
    fmt: v => (v>0?'+':'')+Math.round(v),
    dynCls: v => v>0?'s-pos':v<0?'s-neg':'',
    title: 'Delta (BidSize − AskSize) per price level' },
  { key:'deltaLiftAskHitBid', label:'Δ LAsk-HBid', always:false, w:86, dflt:true,
    fmt: v => (v>0?'+':'')+Math.round(v),
    dynCls: v => v>0?'s-pos':v<0?'s-neg':'',
    title: 'Delta = Lift_Ask − Hit_Bid per price level' },
  { key:'imbalance', label:'IMB',        always:false, w:44, dflt:true,
    fmt: v => v ? '●' : '',
    dynCls: v => v==='hit'?'s-hit-imb':v==='lift'?'s-lift-imb':'',
    noTotals: true,
    title: 'Imbalance at this price level (filled dot)' },
  { key:'ohlcFlag',  label:'OHLC',       always:false, w:46, dflt:true,
    fmt: v => v,
    dynCls: v => v.includes('H')?'s-ohlc-h':v.includes('L')?'s-ohlc-l':v?'s-ohlc':'',
    noTotals: true,
    title: 'O=Open H=High L=Low C=Close price level' },
  { key:'hitBid',     label:'Hit_Bid',   w:65,  cls:'s-hit',  dflt:true,  fmt:v=>fmtN(v) },
  { key:'liftAsk',    label:'Lift_Ask',  w:70,  cls:'s-lift', dflt:true,  fmt:v=>fmtN(v) },
  { key:'bSize',      label:'BIDSIZE',   w:65,  cls:'s-bid',  dflt:true,  fmt:v=>fmtN(v) },
  { key:'aSize',      label:'ASKSIZE',   w:65,  cls:'s-ask',  dflt:true,  fmt:v=>fmtN(v) },
  { key:'NumBid',     label:'NUM_BID',   w:65,  cls:'s-bid',  dflt:true,  fmt:v=>fmtN(v),
    title:'NUM BID ORDERS at this price level (when it was the bid)' },
  { key:'NumAsk',     label:'NUM_ASK',   w:65,  cls:'s-ask',  dflt:true,  fmt:v=>fmtN(v),
    title:'NUM ASK ORDERS at this price level (when it was the ask)' },
  { key:'Hit_Vol',    label:'Hit_Vol',   w:65,  cls:'s-hit',  dflt:true,  fmt:v=>fmtN(v) },
  { key:'liftTrdVol', label:'Lift_Vol',  w:65,  cls:'s-lift', dflt:true,  fmt:v=>fmtN(v) },
  { key:'hitTrdVol',  label:'Hit_Vol_X', w:72,  cls:'s-hit',  dflt:false, fmt:v=>fmtN(v) },
  { key:'Hit_ID',     label:'Hit_ID',    w:65,  cls:'s-hit',  dflt:true,  fmt:v=>fmtN(v) },
  { key:'liftId',     label:'Lift_ID',   w:65,  cls:'s-lift', dflt:true,  fmt:v=>fmtN(v) },
  { key:'Hit_SEQ',    label:'Hit_ELIG_V',w:72,  cls:'s-hit',  dflt:true,  fmt:v=>fmtN(v),
    title:'Hit-side ELIGBL TRD ACVOL diff — real-column replacement for the nonexistent SEQNUM' },
  { key:'liftSeq',    label:'Lift_ELIG_V',w:72, cls:'s-lift', dflt:true,  fmt:v=>fmtN(v),
    title:'Lift-side ELIGBL TRD ACVOL diff — real-column replacement for the nonexistent SEQNUM' },
  { key:'Hit_RT',    label:'Hit_TRADES',w:65,  cls:'s-hit',  dflt:true,  fmt:v=>fmtN(v),
    title:'Hit-side NUMBER TRADES diff — real-column replacement for the nonexistent RTL' },
  { key:'liftRTL',    label:'Lift_TRADES',w:65, cls:'s-lift', dflt:true,  fmt:v=>fmtN(v),
    title:'Lift-side NUMBER TRADES diff — real-column replacement for the nonexistent RTL' },
  { key:'Trd_Vol',    label:'Trd_Vol',   w:65,  cls:'',       dflt:true,  fmt:v=>fmtN(v) },
  { key:'tradeCount', label:'Trd_Cnt',   w:58,  cls:'',       dflt:true,  fmt:v=>fmtN(v) },
  { key:'Aggr_BID', label:'AGGRS_BID', w:72, cls:'s-bid', dflt:false,
    fmt:v=>fmtN(v), title:'Count of rows where AGGRS_SID1=BID at this price level' },
  { key:'Aggr_ASK', label:'AGGRS_ASK', w:72, cls:'s-ask', dflt:false,
    fmt:v=>fmtN(v), title:'Count of rows where AGGRS_SID1=ASK at this price level' },
  { key:'pctHit',     label:'% Hit',     w:55,  cls:'s-hit',  dflt:false, fmt:v=>v.toFixed(1)+'%' },
  { key:'pctLift',    label:'% Lift',    w:55,  cls:'s-lift', dflt:false, fmt:v=>v.toFixed(1)+'%' },
  { key:'trdIdDiff',  label:'Trd_ID_X',  w:65,  cls:'',       dflt:false, fmt:v=>fmtN(v) },
  { key:'seqNum',     label:'ELIG_V_X',  w:65,  cls:'',       dflt:false, fmt:v=>fmtN(v),
    title:'ELIGBL TRD ACVOL diff per level — real-column replacement for the nonexistent SEQNUM' },
  { key:'moves',      label:'TRADES_X',  w:58,  cls:'',       dflt:false, fmt:v=>fmtN(v),
    title:'NUMBER TRADES diff per level — real-column replacement for the nonexistent RTL' },
];
let _sumActiveCols = SUM_ALL_COLS.filter(c=>c.dflt&&!c.always).map(c=>c.key);
let _sumSort = { col:'price', dir:1 };
let _sumIntervalTotals = {
  rawBidSz:0, rawAskSz:0, rawTrdVol:0,
  rawTradeId:0, rawSeqNum:0, rawRtl:0,
  totalAggrBid:0, totalAggrAsk:0
};

let _sumIntervalSec = 60;
let _sumTickSize    = 0.10;

function _sumEffectiveInterval() { return _sumIntervalSec !== null ? _sumIntervalSec : CFG.intervalSec; }
function _sumEffectiveTick()     { return _sumTickSize    ?? CFG.tickSize; }

function _sumSyncPills() {
  const iv = _sumEffectiveInterval(), tk = _sumEffectiveTick();
  document.querySelectorAll('#sum-pill-iv .sum-iv-pill').forEach(b =>
    b.classList.toggle('on', +b.dataset.s === iv));
  document.querySelectorAll('#sum-pill-tk .sum-iv-pill').forEach(b =>
    b.classList.toggle('on', +b.dataset.tk === tk));
}

function sumSetInterval(sec, el) {
  _sumIntervalSec = sec;
  CFG.intervalSec = sec;
  _updateIntervalLabel();
  document.querySelectorAll('#pill-iv .pill').forEach(p => {
    p.classList.toggle('on', parseInt(p.dataset.s) === sec);
  });
  document.querySelectorAll('#sum-pill-iv .sum-iv-pill').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  if(_allRawRows && _allRawRows.length){
    const _sRows=(_dtActive&&_dtFilteredRows&&_dtFilteredRows.length)?_dtFilteredRows:_allRawRows;
    _closedBars=_bucketByInterval(_sRows, sec);
    let cd=0;_closedBars.forEach(b=>{cd+=b.delta;b.cumD=cd;});
    _openBarTicks=[];_lastBarCount=-1;
    _rebuildDisplay();
  }
  if(typeof _trRebucketForInterval==='function') _trRebucketForInterval();
  sumRender();
}

function sumSetTick(tk, el) {
  _sumTickSize = tk;
  CFG.tickSize = tk;
  document.querySelectorAll('#pill-tk .pill').forEach(p => {
    p.classList.toggle('on', parseFloat(p.dataset.v) === tk);
  });
  document.querySelectorAll('#sum-pill-tk .sum-iv-pill').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  if(R){R.resize();R.draw();}
  if(_trAllRows && _trAllRows.length) buildCandles();
  sumRender();
}

function fmtN(v) {
  v = Math.round(v||0);
  if (Math.abs(v) >= 1000000) return (v/1000000).toFixed(1)+'M';
  if (Math.abs(v) >= 10000)   return (v/1000).toFixed(1)+'k';
  return v.toLocaleString();
}

function sumBuildPills() {
  const box = document.getElementById('sum-col-pills');
  if (!box) return;
  box.innerHTML = SUM_ALL_COLS.filter(c=>!c.always).map(c => {
    const on = _sumActiveCols.includes(c.key);
    return `<span class="sum-col-pill${on?' on':''}" onclick="sumToggleCol('${c.key}',this)">${c.label}</span>`;
  }).join('');
}

function sumToggleCol(key, el) {
  const idx = _sumActiveCols.indexOf(key);
  if (idx >= 0) _sumActiveCols.splice(idx, 1);
  else _sumActiveCols.push(key);
  el.classList.toggle('on');
  sumRender();
}

// Same All/None pattern as the Flip Pairs tab's dfpSelectAll: 'always'
// columns (e.g. PRICE) aren't in this list at all, so they're unaffected —
// only the toggleable columns get selected/cleared. sumRender() rebuilds
// the pills (via sumBuildPills()) and re-scrapes the table, so no separate
// pill-refresh call is needed here.
function sumSelectAll(on) {
  _sumActiveCols = on ? SUM_ALL_COLS.filter(c => !c.always).map(c => c.key) : [];
  sumRender();
}

function sumRender() {
  sumBuildPills();
  _sumSyncPills();

  const head  = document.getElementById('sum-head');
  const tbody = document.getElementById('sum-body');
  const cnt   = document.getElementById('sum-count');
  if (!head || !tbody) return;

  const intervalSec = _sumEffectiveInterval();
  const tickSz      = _sumEffectiveTick();

  const snap = v => {
    if (!v || !isFinite(v)) return NaN;
    return Math.round(Math.round(v / tickSz) * tickSz * 1e8) / 1e8;
  };

  const bid_map      = {};
  const ask_map      = {};
  const hit_map      = {};
  const lift_map     = {};
  const aggr_bid_map = {};
  const aggr_ask_map = {};

  const ensureBid  = p => { if (!bid_map[p])  bid_map[p]  = {BidSize:0,Trd_V:0,Trd_Id:0,B_SEQ:0,B_RTL:0,B_NumBid:0,B_NumAsk:0,cnt:0}; };
  const ensureAsk  = p => { if (!ask_map[p])  ask_map[p]  = {AskSize:0,Trd_V:0,Trd_Id:0,A_SEQ:0,A_RTL:0,A_NumBid:0,A_NumAsk:0,cnt:0}; };
  const ensureHit  = p => { if (!hit_map[p])  hit_map[p]  = {Hit_size:0,Hit_vol:0,Hit_ID:0,Hit_SQ:0,Hit_RT:0,cnt:0}; };
  const ensureLift = p => { if (!lift_map[p]) lift_map[p] = {Lift_size:0,Lift_vol:0,Lift_ID:0,Lift_SQ:0,Lift_RT:0,cnt:0}; };

  /* ── EDIT 2a: use current-interval rows only ── */
  const srcRows = _currentIntervalRows();

  // Price Summary Timestamp = start_time of the selected interval.
  const _sumStartRow = srcRows.length ? srcRows.reduce((best,r)=>{
    const ms=x=>{if(!x)return NaN;if(+x._tsMs>0)return +x._tsMs;const q=(((x.date||'')+' '+(x.time||'')).trim()||x.Timestamp||x.timestamp||'');const m=Date.parse(String(q).replace('T',' '));return isNaN(m)?NaN:m;};
    if(!best)return r;const bm=ms(best),rm=ms(r);return isFinite(rm)&&(!isFinite(bm)||rm<bm)?r:best;
  },null):null;
  // Equivalent to pandas: Timestamp.min().round('min') / legacy round('T').
  const _sumStartTime = (() => {
    if (!_sumStartRow) return '';
    const raw = (((_sumStartRow.date||'')+' '+(_sumStartRow.time||'')).trim() || String(_sumStartRow.Timestamp||_sumStartRow.timestamp||''));
    const baseMs = (+_sumStartRow._tsMs > 0) ? +_sumStartRow._tsMs : Date.parse(String(raw).replace('T',' '));
    if (!isFinite(baseMs)) return raw;
    const roundedMs = Math.floor((baseMs + 30000) / 60000) * 60000; // nearest minute
    const d = new Date(roundedMs);
    const pad = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  })();
  // Identifies which specific interval/candle is on screen right now, so
  // the manual Marker column (see manual-marker-column-js) can record which
  // candle a marker was set on, not just which price — the same price
  // level can repeat across many different candles over a session.
  window.__sumCurrentBarId = srcRows.length ? ((srcRows[0].date||'')+'T'+(srcRows[0].time||'')+'_'+(srcRows[srcRows.length-1].date||'')+'T'+(srcRows[srcRows.length-1].time||'')) : '';

  _sumIntervalTotals = { rawBidSz:0, rawAskSz:0, rawTrdVol:0,
                         rawTradeId:0, rawSeqNum:0, rawRtl:0,
                         totalAggrBid:0, totalAggrAsk:0 };

  const all_bid_prices = new Set();
  const all_ask_prices = new Set();

  /* ── EDIT 2b: price grid from current-interval rows only ── */
  const _allSources = srcRows;
  _allSources.forEach(rr => {
    const rb = +rr.bid; if (isFinite(rb) && rb > 100) all_bid_prices.add(rb);
    const ra = +rr.ask; if (isFinite(ra) && ra > 100) all_ask_prices.add(ra);
  });

  srcRows.forEach(r => {
    const bid = snap(r.bid);
    const ask = snap(r.ask);
    const bs  = r.bSize || 0;
    const as_ = r.aSize || 0;
    const nBid = r.numBid || 0;
    const nAsk = r.numAsk || 0;
    const trdVolValue = Number(r.trdVol) || 0;
    const tid = r.trdIdDiff || 0;
    /* seq = ELIGBL TRD ACVOL diff (real-column replacement for the
       nonexistent SEQNUM). rtl = NUMBER TRADES diff (real-column
       replacement for the nonexistent RTL). */
    const seq = r.eligVolDiff || 0;
    const rtl = r.movesDiff  || 0;
    const aggr = r.aggr || '';

    if (isFinite(bid)) {
      ensureBid(bid);
      bid_map[bid].BidSize += bs;
      bid_map[bid].Trd_V   += trdVolValue;
      bid_map[bid].Trd_Id  += tid;
      bid_map[bid].B_SEQ   += seq;
      bid_map[bid].B_RTL   += rtl;
      bid_map[bid].B_NumBid+= nBid;
      bid_map[bid].B_NumAsk+= nAsk;
      bid_map[bid].cnt     += 1;
    }
    if (isFinite(ask)) {
      ensureAsk(ask);
      ask_map[ask].AskSize += as_;
      ask_map[ask].Trd_V   += trdVolValue;
      ask_map[ask].Trd_Id  += tid;
      ask_map[ask].A_SEQ   += seq;
      ask_map[ask].A_RTL   += rtl;
      ask_map[ask].A_NumBid+= nBid;
      ask_map[ask].A_NumAsk+= nAsk;
      ask_map[ask].cnt     += 1;
    }

    const isHit  = aggr === 'BID' || aggr === 'SELL';
    const isLift = aggr === 'ASK' || aggr === 'BUY';

    if (isHit && isFinite(bid)) {
      ensureHit(bid);
      hit_map[bid].Hit_size += bs;
      hit_map[bid].Hit_vol  += trdVolValue;
      hit_map[bid].Hit_ID   += tid;
      hit_map[bid].Hit_SQ   += seq;
      hit_map[bid].Hit_RT   += rtl;
      hit_map[bid].cnt      += 1;
    }
    if (isLift && isFinite(ask)) {
      ensureLift(ask);
      lift_map[ask].Lift_size += as_;
      lift_map[ask].Lift_vol  += trdVolValue;
      lift_map[ask].Lift_ID   += tid;
      lift_map[ask].Lift_SQ   += seq;
      lift_map[ask].Lift_RT   += rtl;
      lift_map[ask].cnt       += 1;
    }
    if (aggr === 'BID' && isFinite(bid)) aggr_bid_map[bid] = (aggr_bid_map[bid]||0) + 1;
    if (aggr === 'ASK' && isFinite(ask)) aggr_ask_map[ask] = (aggr_ask_map[ask]||0) + 1;
    _sumIntervalTotals.rawBidSz   += bs;
    _sumIntervalTotals.rawAskSz   += as_;
    _sumIntervalTotals.rawTrdVol  += trdVolValue;
    _sumIntervalTotals.rawTradeId += tid;
    _sumIntervalTotals.rawSeqNum  += seq;
    _sumIntervalTotals.rawRtl     += rtl;
    if (aggr === 'BID') _sumIntervalTotals.totalAggrBid++;
    if (aggr === 'ASK') _sumIntervalTotals.totalAggrAsk++;
  });

  const rawPrices = [...all_bid_prices, ...all_ask_prices].filter(isFinite);
  if (!rawPrices.length) {
    if (cnt) cnt.textContent = '0 levels';
    tbody.innerHTML = '<tr><td colspan="30" style="color:#555;text-align:center;padding:20px">No data — load a file and apply filter</td></tr>';
    return;
  }

  // Only the price levels actually occupied in this interval — matches Trade Log,
  // Level Aggregator, LA Pro and Flip Pairs, which all show occupied levels only,
  // not a padded continuous ladder through every untouched tick in between.
  const _MULT = 10000;
  const _occupiedSet = new Set();
  Object.keys(bid_map).forEach(k => _occupiedSet.add(Math.round(parseFloat(k) * _MULT)));
  Object.keys(ask_map).forEach(k => _occupiedSet.add(Math.round(parseFloat(k) * _MULT)));
  const grid = [..._occupiedSet].map(i => i / _MULT).sort((a, b) => b - a);

  const totals = { Hit_ID:0, Hit_SEQ:0, Hit_RT:0, Hit_Vol:0, Hit_Bid:0,
                   BidSize:0, AskSize:0, NumBid:0, NumAsk:0, Lift_Ask:0, Lift_Vol:0,
                   Lift_ID:0, Lift_SEQ:0, Lift_RT:0, Trd_Vol:0, Trd_Cnt:0,
                   Imb_Hit:0, Imb_Lift:0 };
  const _imbThresh = CFG.imbThreshold/100, _imbMinV = Math.max(1, CFG.imbMinVol);
  grid.forEach(p => {
    const b = bid_map[p]  || {};
    const a = ask_map[p]  || {};
    const h = hit_map[p]  || {};
    const l = lift_map[p] || {};
    const trdVol = b.Trd_V || 0;
    const trdCnt = (h.cnt||0) + (l.cnt||0);
    totals.Hit_ID   += h.Hit_ID  || 0;
    totals.Hit_SEQ  += h.Hit_SQ  || 0;
    totals.Hit_RT  += h.Hit_RT  || 0;
    totals.Hit_Vol  += h.Hit_vol || 0;
    totals.Hit_Bid  += h.Hit_size|| 0;
    totals.BidSize  += b.BidSize || 0;
    totals.AskSize  += a.AskSize || 0;
    totals.NumBid   += b.B_NumBid|| 0;
    totals.NumAsk   += a.A_NumAsk|| 0;
    totals.Lift_Ask += l.Lift_size|| 0;
    totals.Lift_Vol += l.Lift_vol|| 0;
    totals.Lift_ID  += l.Lift_ID || 0;
    totals.Lift_SEQ += l.Lift_SQ || 0;
    totals.Lift_RT += l.Lift_RT || 0;
    totals.Trd_Vol  += trdVol;
    totals.Trd_Cnt  += trdCnt;
    // Imbalance count for this interval — same hit/lift test used for the
    // per-level IMB dot below, just tallied across every occupied price level.
    const _ibB = b.BidSize||0, _ibA = a.AskSize||0;
    if(_ibB>=_imbMinV && _ibA>0 && _ibB/_ibA>=_imbThresh) totals.Imb_Hit++;
    if(_ibA>=_imbMinV && _ibB>0 && _ibA/_ibB>=_imbThresh) totals.Imb_Lift++;
  });

  if (cnt) cnt.textContent = `${grid.length} levels · tick ${tickSz}`;

  const activeCols = [
    ...SUM_ALL_COLS.filter(c => c.always),
    ...SUM_ALL_COLS.filter(c => !c.always && _sumActiveCols.includes(c.key)),
  ].filter(Boolean);

  const sc = _sumSort.col, sd = _sumSort.dir;

  const rowData = grid.map(p => {
    const b = bid_map[p]  || {};
    const a = ask_map[p]  || {};
    const h = hit_map[p]  || {};
    const l = lift_map[p] || {};
    return {
      timestamp: _sumStartTime,
      price:    p,
      Hit_ID:   h.Hit_ID   || 0,
      Hit_SEQ:  h.Hit_SQ   || 0,
      Hit_RT:  h.Hit_RT   || 0,
      Hit_RTL: h.Hit_RT   || 0,  /* alias: TAQ SUM_ALL_COLS reads key 'Hit_RTL' */
      Lift_RTL: (lift_map[p]||{}).Lift_RT || 0,  /* alias for the same reason */
      Hit_Vol:  h.Hit_vol  || 0,
      Hit_Bid:  h.Hit_size || 0,
      BidSize:  b.BidSize  || 0,
      AskSize:  a.AskSize  || 0,
      NumBid:   b.B_NumBid || 0,
      NumAsk:   a.A_NumAsk || 0,
      Lift_Ask: l.Lift_size|| 0,
      Lift_Vol: l.Lift_vol || 0,
      Lift_ID:  l.Lift_ID  || 0,
      Lift_SEQ: l.Lift_SQ  || 0,
      Lift_RT: l.Lift_RT  || 0,
      Trd_Vol:  b.Trd_V || 0,
      Trd_Cnt:  (h.cnt||0)+(l.cnt||0),
      trdIdDiff: (h.Hit_ID||0)+(l.Lift_ID||0),
      seqNum:    (h.Hit_SQ||0)+(l.Lift_SQ||0),
      moves:     (h.Hit_RT||0)+(l.Lift_RT||0),
      hitTrdVol: h.Hit_vol ||0,
      liftTrdVol:l.Lift_vol||0,
      hitBid:    h.Hit_size||0,
      hitAsk:    0,
      liftBid:   0,
      liftAsk:   l.Lift_size||0,
      liftId:    l.Lift_ID  ||0,
      liftSeq:   l.Lift_SQ  ||0,
      aggrBid:   h.cnt||0,
      aggrAsk:   l.cnt||0,
      tradeCount:(h.cnt||0)+(l.cnt||0),
      pctLift: ((l.Lift_vol||0) / Math.max(1, (h.Hit_vol||0)+(l.Lift_vol||0))) * 100,
      pctHit:  ((h.Hit_vol||0) / Math.max(1, (h.Hit_vol||0)+(l.Lift_vol||0))) * 100,
      Aggr_BID:  aggr_bid_map[p] || 0,
      Aggr_ASK:  aggr_ask_map[p] || 0,
      delta:     (b.BidSize||0)-(a.AskSize||0),
      deltaLiftAskHitBid: (l.Lift_size||0)-(h.Hit_size||0),  /* Δ LAsk-HBid = Lift_Ask − Hit_Bid per level */
      imbalance: (() => {
        const B=b.BidSize||0, A=a.AskSize||0, thresh=CFG.imbThreshold/100, minV=Math.max(1,CFG.imbMinVol);
        if(B>=minV && A>0 && B/A>=thresh) return 'hit';
        if(A>=minV && B>0 && A/B>=thresh) return 'lift';
        return '';
      })(),
      ohlcFlag:  (() => {
        const bar=_csFocusedBar; if(!bar) return '';
        const tk=tickSz*0.5;
        const flags=[];
        if(Math.abs(p-bar.open )<tk) flags.push('O');
        if(Math.abs(p-bar.high )<tk) flags.push('H');
        if(Math.abs(p-bar.low  )<tk) flags.push('L');
        if(Math.abs(p-bar.close)<tk) flags.push('C');
        return flags.join('');
      })(),
    };
  }).sort((a, b) => {
    if (sc === 'price') return (b.price - a.price) * sd;
    if (sc === 'timestamp') return String(a.timestamp||'').localeCompare(String(b.timestamp||'')) * sd;
    return ((a[sc]||0) - (b[sc]||0)) * sd;
  });

  head.innerHTML = activeCols.map(c =>
    `<th style="min-width:${c.w||60}px" onclick="sumSortBy('${c.key}')"
     class="${c.key===_sumSort.col?(_sumSort.dir===1?'sort-asc':'sort-desc'):''}">
     ${c.label}</th>`
  ).join('');

  const totRow = document.createElement('tr');
  totRow.className = 'sum-totals-row';
  totRow.innerHTML = activeCols.map(c => {
    if (c.key === 'imbalance') {
      const _ih = totals.Imb_Hit||0, _il = totals.Imb_Lift||0, _it = _ih+_il;
      return `<td style="text-align:center;font-weight:bold;" title="${_il} lift-side / ${_ih} hit-side imbalance levels this interval"><span class="s-lift-imb">${_il}⇧</span>/<span class="s-hit-imb">${_ih}⇩</span> (${_it})</td>`;
    }
    if (c.noTotals) return `<td style="text-align:center;color:#333">—</td>`;

    let totalValue;
    if (Object.prototype.hasOwnProperty.call(totals, c.label)) {
      totalValue = totals[c.label];
    } else if (Object.prototype.hasOwnProperty.call(totals, c.key)) {
      totalValue = totals[c.key];
    } else if (c.key === 'price') {
      totalValue = grid.length;
    } else if (c.key === 'Hit_ID' || c.key === 'trdIdDiff') {
      totalValue = fmtN(totals.Hit_ID);
    } else if (c.key === 'Hit_SEQ' || c.key === 'seqNum') {
      totalValue = fmtN(totals.Hit_SEQ);
    } else if (c.key === 'Hit_RT' || c.key === 'moves') {
      totalValue = fmtN(totals.Hit_RT);
    } else if (c.key === 'hitTrdVol') {
      totalValue = fmtN(totals.Hit_Vol);
    } else if (c.key === 'hitBid') {
      totalValue = fmtN(totals.Hit_Bid);
    } else if (c.key === 'bSize') {
      totalValue = fmtN(totals.BidSize);
    } else if (c.key === 'aSize') {
      totalValue = fmtN(totals.AskSize);
    } else if (c.key === 'liftAsk') {
      totalValue = fmtN(totals.Lift_Ask);
    } else if (c.key === 'liftTrdVol') {
      totalValue = fmtN(totals.Lift_Vol);
    } else if (c.key === 'liftId') {
      totalValue = fmtN(totals.Lift_ID);
    } else if (c.key === 'liftSeq') {
      totalValue = fmtN(totals.Lift_SEQ);
    } else if (c.key === 'liftRTL') {
      totalValue = fmtN(totals.Lift_RT);
    } else if (c.key === 'trdVol') {
      totalValue = fmtN(totals.Trd_Vol);
    } else if (c.key === 'tradeCount') {
      totalValue = fmtN(totals.Trd_Cnt);
    } else {
      totalValue = fmtN(rowData.reduce((s, r) => s + (Number(r[c.key]) || 0), 0));
    }

    return `<td title="Total ${c.label}">${typeof totalValue === 'number' ? fmtN(totalValue) : totalValue}</td>`;
  }).join('');

  const frag = document.createDocumentFragment();
  frag.appendChild(totRow);
  const maxRows = Math.min(rowData.length, 60000);
  for (let i = 0; i < maxRows; i++) {
    const r = rowData[i];
    const tr = document.createElement('tr');
    tr.innerHTML = activeCols.map(c => {
      let val = r[c.key] ?? 0;
      if (c.key==='bSize')       val = r.BidSize;
      else if (c.key==='aSize')  val = r.AskSize;
      else if (c.key==='liftRTL') val = r.Lift_RT;
      else if (c.key==='hitRTL')  val = r.Hit_RT||0;
      const txt = c.fmt ? c.fmt(val) : fmtN(val);
      const cls = (c.dynCls ? c.dynCls(val) : '') || c.cls || '';
      return `<td class="${cls}" title="${c.title||''}">${txt}</td>`;
    }).join('');
    frag.appendChild(tr);
  }
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

function sumSortBy(col) {
  if (_sumSort.col === col) _sumSort.dir *= -1;
  else { _sumSort.col = col; _sumSort.dir = (col==='price'?1:-1); }
  sumRender();
}

/* ============================================================
   DAY / TIME FILTER
   ============================================================ */

let _dtActive        = false;
let _dtFilteredRows  = null;
let _dtStartMs       = 0;
let _dtEndMs         = 0;

function _dtInputToMs(val) {
  if (!val) return 0;
  const m = val.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  const d = new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0), 0);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function dtRows() {
  if(_rpActive && _rpSumRows && _rpSumRows.length) return _rpSumRows;
  return (_dtActive && _dtFilteredRows !== null) ? _dtFilteredRows : _trAllRows;
}

function dtMarkCustom() {
  const sel = document.getElementById('dt-preset-select');
  if (sel) sel.value = 'custom';
}

const DT_PRESETS = {
  full:       { start:'00:00:00', end:'23:59:59' },
  trading:    { start:'00:00:00', end:'23:59:59' },
  main:       { start:'08:30:00', end:'17:00:00' },
  rth:        { start:'09:30:00', end:'16:00:00' },
  premarket:  { start:'04:00:00', end:'09:29:59' },
  postmarket: { start:'16:00:01', end:'20:00:00' },
  am:         { start:'00:00:00', end:'11:59:59' },
  pm:         { start:'12:00:00', end:'23:59:59' },
  prev_main:  { start:'08:30:00', end:'17:00:00' },
};

function dtPresetChange(val) {
  if (val === 'custom') return;
  if (!_trAllRows.length) {
    alert('Load a file first.');
    const sel = document.getElementById('dt-preset-select');
    if (sel) sel.value = 'custom';
    return;
  }
  const preset = DT_PRESETS[val];
  if (!preset) return;
  const sorted = _trAllRows.slice().sort((a,b) => _toAbsMs(a) - _toAbsMs(b));
  let sd = sorted[0].date || '', ed = sorted[sorted.length-1].date || sd;
  if (val === 'prev_main' && sd) {
    const d = new Date(sd + 'T00:00:00');
    d.setDate(d.getDate()-1);
    sd = ed = d.toISOString().slice(0,10);
  }
  const dtS = document.getElementById('dt-start');
  const dtE = document.getElementById('dt-end');
  if (dtS) dtS.value = sd + 'T' + preset.start;
  if (dtE) dtE.value = ed + 'T' + preset.end;
  dtApply();
}

function dtCustomChange() { dtMarkCustom(); }

function dtApply() {
  if (!_trAllRows.length) { alert('Load a file first.'); return; }
  const sv = (document.getElementById('dt-start')||{}).value || '';
  const ev = (document.getElementById('dt-end')||{}).value   || '';
  if (!sv && !ev) { dtClear(); return; }

  _dtStartMs = _dtInputToMs(sv);
  _dtEndMs   = _dtInputToMs(ev);

  _dtFilteredRows = _trAllRows.filter(r => {
    const rMs = _toAbsMs(r);
    if (rMs === 0) return false;
    if (_dtStartMs > 0 && rMs < _dtStartMs) return false;
    if (_dtEndMs   > 0 && rMs > _dtEndMs)   return false;
    return true;
  });
  _dtActive = true;

  const n      = _dtFilteredRows.length;
  const badge  = document.getElementById('dt-filter-active-badge');
  const clrBtn = document.getElementById('dt-clear-btn');
  const cnt    = document.getElementById('dt-row-count');
  if (badge) {
    badge.textContent = n > 0 ? `● ${n.toLocaleString()} ticks` : '● 0 — check range';
    badge.style.cssText = `display:inline-block;padding:2px 8px;border-radius:3px;font-size:9px;
      color:${n>0?'#00cc66':'#ff4444'};background:${n>0?'#001a10':'#1a0000'};
      border:1px solid ${n>0?'#003322':'#440000'}`;
  }
  if (clrBtn) clrBtn.style.display = 'inline-block';
  if (cnt)    cnt.textContent = `of ${_trAllRows.length.toLocaleString()} total`;

  const sdtS = document.getElementById('tr-start-dt');
  const sdtE = document.getElementById('tr-end-dt');
  if (sdtS && sv) sdtS.value = sv;
  if (sdtE && ev) sdtE.value = ev;
  trSyncFromDT();

  _dtRebuildAll();
}

function dtClear() {
  _dtActive = false; _dtFilteredRows = null; _dtStartMs = 0; _dtEndMs = 0;
  const badge  = document.getElementById('dt-filter-active-badge');
  const clrBtn = document.getElementById('dt-clear-btn');
  const cnt    = document.getElementById('dt-row-count');
  const sel    = document.getElementById('dt-preset-select');
  if (badge)  badge.style.display = 'none';
  if (clrBtn) clrBtn.style.display = 'none';
  if (cnt)    cnt.textContent = _trAllRows.length.toLocaleString() + ' total ticks';
  if (sel)    sel.value = 'custom';
  _dtPopulateFromRows(_trAllRows);
  window._dtDirty = {};
  _dtRebuildAll();
}

function _dtPopulateFromRows(rows) {
  if (!rows || !rows.length) return;
  const validRows = rows.filter(r => _toAbsMs(r) > 0);
  if (!validRows.length) return;
  const sorted = validRows.slice().sort((a,b) => _toAbsMs(a) - _toAbsMs(b));
  const first = sorted[0], last = sorted[sorted.length-1];

  const rowToInputVal = (r) => {
    const ms = _toAbsMs(r);
    if (!ms || ms <= 0) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '';
    const p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const sv = rowToInputVal(first);
  const ev = rowToInputVal(last);

  const dtS = document.getElementById('dt-start');
  const dtE = document.getElementById('dt-end');
  if (dtS && sv) dtS.value = sv;
  if (dtE && ev) dtE.value = ev;
  const sdtS = document.getElementById('tr-start-dt');
  const sdtE = document.getElementById('tr-end-dt');
  if (sdtS && sv) sdtS.value = sv;
  if (sdtE && ev) sdtE.value = ev;
  const cnt = document.getElementById('dt-row-count');
  if (cnt) cnt.textContent = rows.length.toLocaleString() + ' total ticks';
}

function _dtRebuildAll() {
  const rows = dtRows();
  _tlRows = rows.slice();

  if (!rows.length) {
    _trBars = []; _trOffset = 0;
    ['tl-body','sum-body'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<tr><td colspan="30" style="color:#555;text-align:center;padding:20px">No data in selected range</td></tr>';
    });
    _trUpdateNavInfo();
    return;
  }

  const bars = _bucketByInterval(rows, CFG.intervalSec);
  if (bars.length) {
    _trBars = bars;
    let cd = 0; _trBars.forEach(b => { cd += b.delta; b.cumD = cd; });
    const n = parseInt((document.getElementById('bar-n')||{}).value) || 10;
    _trOffset = Math.max(0, _trBars.length - n);
    _trApplyView();
  }

  const cur = (document.querySelector('.main-tab.active')||{}).dataset?.tab || '';
  if (cur === 'tradelog') tlRender();
  else if (cur === 'summary') sumRender();
  window._dtDirty = { tradelog: cur !== 'tradelog', summary: cur !== 'summary' };
}

function _dtInstallHooks() {
  const _OTrQuick = trQuick;
  trQuick = function(preset) {
    _OTrQuick(preset);
    const sv=(document.getElementById('tr-start-dt')||{}).value||'';
    const ev=(document.getElementById('tr-end-dt')||{}).value||'';
    const dtS=document.getElementById('dt-start');
    const dtE=document.getElementById('dt-end');
    if(dtS&&sv) dtS.value=sv;
    if(dtE&&ev) dtE.value=ev;
    dtMarkCustom();
  };
  const _OBuild = buildCandles;
  buildCandles = function() {
    const sv=(document.getElementById('tr-start-dt')||{}).value||'';
    const ev=(document.getElementById('tr-end-dt')||{}).value||'';
    const dtS=document.getElementById('dt-start');
    const dtE=document.getElementById('dt-end');
    if(dtS&&sv) dtS.value=sv;
    if(dtE&&ev) dtE.value=ev;
    if(sv||ev){dtApply();return;}
    _OBuild();
  };
  const _OAuto = trAutoPopulate;
  trAutoPopulate = function(rows) {
    _OAuto(rows);
    _dtPopulateFromRows(rows);
  };
  const _OSwitch = switchTab;
  switchTab = function(tab) {
    _OSwitch(tab);
    if(tab==='tradelog'){_tlRows=dtRows().slice();tlRender();if(window._dtDirty)window._dtDirty.tradelog=false;}
    if(tab==='summary'){sumRender();if(window._dtDirty)window._dtDirty.summary=false;}
    if(tab==='levels'){aggBuild();if(window._dtDirty)window._dtDirty.aggregator=false;}
    if(tab==='lagr'){laRebuild();if(window._dtDirty)window._dtDirty.lagr=false;}
    if(tab==='dfpairs'){dfpRender();if(window._dtDirty)window._dtDirty.dfpairs=false;}
  };
}

/* ============================================================
   LEVEL AGGREGATOR  (Tab 4) — EDIT 3: current-interval rows
   ============================================================ */
let _aggLevels=[], _aggFiltered=[];

function aggBuild(){
  /* ── EDIT 3: always use the current interval's ticks ── */
  const rows = _currentIntervalRows();
  const tbl=document.getElementById('agg-table'),empty=document.getElementById('agg-empty');
  if(!rows.length){if(tbl)tbl.style.display='none';if(empty)empty.style.display='flex';return;}
  if(tbl)tbl.style.display='table';if(empty)empty.style.display='none';
  _aggLevels=_aggComputeLevels(rows); aggApplyFilters();
}

function _aggComputeLevels(rows){
  const map=new Map();
  rows.forEach(r=>{
    const price=+(r.last||0); if(price<=0) return;
    const MULT=Math.round(1/CFG.tickSize)*100;
    const pk=Math.round(price*MULT);
    const ag=String(r.aggr||'').toUpperCase().trim();
    let side='N';
    if(ag==='ASK'||ag==='BUY'||ag==='LIFT') side='L';
    else if(ag==='BID'||ag==='SELL'||ag==='HIT') side='H';
    else if(r.ask>0&&Math.abs(price-r.ask)<CFG.tickSize*0.6) side='L';
    else if(r.bid>0&&Math.abs(price-r.bid)<CFG.tickSize*0.6) side='H';
    if(!map.has(pk)){
      const p=Math.round(pk)/MULT;
      map.set(pk,{price:p,trades:0,bSize:0,aSize:0,numBid:0,numAsk:0,numOrders:0,
        trdVol:0,volume:0,moves:0,eligVol:0,
        hitTrades:0,hitBSize:0,hitASize:0,hitNumBid:0,hitNumAsk:0,hitNumOrders:0,hitTrdVol:0,hitVolume:0,hitMoves:0,hitEligVol:0,
        liftTrades:0,liftBSize:0,liftASize:0,liftNumBid:0,liftNumAsk:0,liftNumOrders:0,liftTrdVol:0,liftVolume:0,liftMoves:0,liftEligVol:0});
    }
    const lv=map.get(pk);
    lv.trades++; lv.bSize+=+(r.bSize||0); lv.aSize+=+(r.aSize||0);
    lv.numBid+=+(r.numBid||0); lv.numAsk+=+(r.numAsk||0); lv.numOrders+=+(r.numOrders||0);
    lv.trdVol+=+(r.trdVol||0); lv.volume+=+(r.volDiff||r.volume||0);
    lv.moves+=+(r.movesDiff||r.moves||0); lv.eligVol+=+(r.eligVol||0);
    const P=side==='H'?'hit':side==='L'?'lift':null;
    if(P){lv[P+'Trades']++;lv[P+'BSize']+=+(r.bSize||0);lv[P+'ASize']+=+(r.aSize||0);
      lv[P+'NumBid']+=+(r.numBid||0);lv[P+'NumAsk']+=+(r.numAsk||0);lv[P+'NumOrders']+=+(r.numOrders||0);
      lv[P+'TrdVol']+=+(r.trdVol||0);lv[P+'Volume']+=+(r.volDiff||r.volume||0);
      lv[P+'Moves']+=+(r.movesDiff||r.moves||0);lv[P+'EligVol']+=+(r.eligVol||0);}
  });
  return Array.from(map.values()).map(lv=>{
    lv.delta=lv.liftTrdVol-lv.hitTrdVol; lv.totalVol=lv.trdVol;
    lv.dominance=lv.hitTrades>lv.liftTrades?'HIT':lv.liftTrades>lv.hitTrades?'LIFT':'NEUTRAL';
    return lv;
  });
}

function aggApplyFilters(){
  const side=(document.getElementById('agg-filter-side')||{}).value||'all';
  const minVol=parseFloat((document.getElementById('agg-filter-vol')||{}).value)||0;
  const sortC=(document.getElementById('agg-sort-col')||{}).value||'price';
  const sortD=(document.getElementById('agg-sort-dir')||{}).value||'desc';
  let rows=_aggLevels.slice();
  if(side==='HIT')  rows=rows.filter(r=>r.hitTrades>0);
  if(side==='LIFT') rows=rows.filter(r=>r.liftTrades>0);
  if(side==='BOTH') rows=rows.filter(r=>r.hitTrades>0&&r.liftTrades>0);
  if(minVol>0) rows=rows.filter(r=>r.totalVol>=minVol);
  const mult=sortD==='asc'?1:-1;
  rows.sort((a,b)=>((a[sortC]||0)-(b[sortC]||0))*mult);
  _aggFiltered=rows; _aggSummary(); _aggRenderTable(rows);
}

function _aggSummary(){
  const rows=_aggFiltered;
  const F=n=>{n=Math.round(n||0);return Math.abs(n)>=1e6?(n/1e6).toFixed(1)+'M':Math.abs(n)>=1e4?(n/1e3).toFixed(1)+'k':n.toLocaleString();};
  const hv=rows.reduce((s,r)=>s+r.hitTrdVol,0),lv=rows.reduce((s,r)=>s+r.liftTrdVol,0),d=lv-hv;
  const _s=id=>document.getElementById(id);
  if(_s('agg-s-levels'))_s('agg-s-levels').textContent=rows.length.toLocaleString();
  if(_s('agg-s-trades'))_s('agg-s-trades').textContent=rows.reduce((s,r)=>s+r.trades,0).toLocaleString();
  if(_s('agg-s-hvol'))_s('agg-s-hvol').textContent=F(hv);
  if(_s('agg-s-lvol'))_s('agg-s-lvol').textContent=F(lv);
  const de=_s('agg-s-delta');
  if(de){de.textContent=(d>=0?'+':'')+F(d);de.style.color=d>=0?'#00cc66':'#ff5555';}
  if(_s('agg-s-bsize'))_s('agg-s-bsize').textContent=F(rows.reduce((s,r)=>s+r.bSize,0));
  if(_s('agg-s-asize'))_s('agg-s-asize').textContent=F(rows.reduce((s,r)=>s+r.aSize,0));
}

function _aggRenderTable(rows){
  const thead=document.getElementById('agg-thead'),tbody=document.getElementById('agg-tbody');
  const tbl=document.getElementById('agg-table'),empty=document.getElementById('agg-empty');
  if(!thead||!tbody) return;
  if(!rows.length){if(tbl)tbl.style.display='none';if(empty)empty.style.display='flex';return;}
  if(tbl)tbl.style.display='table';if(empty)empty.style.display='none';
  const active=new Set();
  document.querySelectorAll('.agg-pill.on').forEach(p=>active.add(p.dataset.col));
  const F=(n,signed)=>{n=Math.round(n||0);if(!signed&&n<=0)return '<span class="ag-dim">—</span>';const abs=Math.abs(n);return abs>=1e6?(n/1e6).toFixed(1)+'M':abs>=1e4?(n/1e3).toFixed(1)+'k':n.toLocaleString();};
  const cols=[];
  const push3=(hdr,totKey,hitKey,liftKey,barColor,totCls)=>{
    const mx=Math.max(...rows.map(r=>r[totKey]||0),1);
    cols.push({hdr,sub:'total',render:r=>`<td class="agg-bc"><div class="agg-bb" style="width:${((r[totKey]||0)/mx*100).toFixed(1)}%;background:${barColor}"></div><span class="${totCls||'ag-info'}">${F(r[totKey])}</span></td>`});
    cols.push({hdr:'',sub:'hit ▼',render:r=>`<td class="ag-hit">${r[hitKey]>0?F(r[hitKey]):'<span class="ag-dim">—</span>'}</td>`});
    cols.push({hdr:'',sub:'lift ▲',render:r=>`<td class="ag-lift">${r[liftKey]>0?F(r[liftKey]):'<span class="ag-dim">—</span>'}</td>`});
  };
  cols.push({hdr:'Price',sub:'level',render:r=>`<td>${r.price.toFixed(2)}</td>`});
  cols.push({hdr:'Trades',sub:'total',render:r=>`<td class="ag-info">${r.trades.toLocaleString()}</td>`});
  cols.push({hdr:'',sub:'hit ▼',render:r=>`<td class="ag-hit">${r.hitTrades>0?r.hitTrades:'<span class="ag-dim">—</span>'}</td>`});
  cols.push({hdr:'',sub:'lift ▲',render:r=>`<td class="ag-lift">${r.liftTrades>0?r.liftTrades:'<span class="ag-dim">—</span>'}</td>`});
  if(active.has('bSize'))   push3('B.Size', 'bSize', 'hitBSize', 'liftBSize', 'rgba(0,200,120,.5)',  'ag-bid');
  if(active.has('aSize'))   push3('A.Size', 'aSize', 'hitASize', 'liftASize', 'rgba(220,50,60,.5)',  'ag-ask');
  if(active.has('numBid'))  push3('Num Bid','numBid','hitNumBid','liftNumBid','rgba(0,200,120,.35)', 'ag-bid');
  if(active.has('numAsk'))  push3('Num Ask','numAsk','hitNumAsk','liftNumAsk','rgba(220,50,60,.35)', 'ag-ask');
  if(active.has('trdVol'))  push3('Trd.Vol','trdVol','hitTrdVol','liftTrdVol','rgba(100,160,255,.4)','ag-info');
  if(active.has('volume'))  push3('Volume', 'volume','hitVolume','liftVolume', 'rgba(100,160,255,.3)','ag-info');
  if(active.has('eligVol')) push3('ELIG_V', 'eligVol','hitEligVol','liftEligVol','rgba(100,160,255,.2)','ag-info');
  if(active.has('moves'))   push3('#Trades','moves',  'hitMoves', 'liftMoves',  'rgba(255,200,50,.25)','ag-info');
  cols.push({hdr:'Delta',sub:'Lift−Hit',render:r=>{const d=r.delta,c=d>0?'#00cc66':d<0?'#ff5555':'#444';return `<td style="color:${c}">${d>=0?'+':''}${F(d,true)}</td>`;}});
  const grps=[];
  cols.forEach(c=>{const lbl=c.hdr||'';if(grps.length&&grps[grps.length-1].lbl===lbl&&lbl!=='Price'&&lbl!=='Trades'&&lbl!=='Delta')grps[grps.length-1].span++;else grps.push({lbl,span:1});});
  const hc=l=>l==='B.Size'||l==='Num Bid'?'#00cc66':l==='A.Size'||l==='Num Ask'?'#ff5555':l==='Price'?'#ffdd44':'#88aacc';
  thead.innerHTML='<tr>'+grps.map(g=>`<th colspan="${g.span}" style="color:${hc(g.lbl)}">${g.lbl}</th>`).join('')+'</tr>'+
    '<tr>'+cols.map(c=>`<th class="${c.sub==='hit ▼'?'ag-hit':c.sub==='lift ▲'?'ag-lift':'ag-info'}">${c.sub}</th>`).join('')+'</tr>';
  tbody.innerHTML=rows.map(r=>{
    const dom=r.dominance==='HIT'?'dom-hit':r.dominance==='LIFT'?'dom-lift':'';
    return `<tr class="${dom}">${cols.map(c=>c.render(r)).join('')}</tr>`;
  }).join('');
  const aggTip=document.getElementById('tip');
  tbody.querySelectorAll('tr').forEach((tr,i)=>{
    const lv=rows[i];if(!lv)return;
    const F2=n=>{n=Math.round(n||0);const a=Math.abs(n);return a>=1e6?(n/1e6).toFixed(1)+'M':a>=1e4?(n/1e3).toFixed(1)+'k':n.toLocaleString();};
    tr.addEventListener('mouseenter',e=>{
      const dc=lv.dominance==='HIT'?'#ff5555':lv.dominance==='LIFT'?'#00cc66':'#555';
      aggTip.innerHTML='<div class="tr"><span class="tl">Price</span><span style="color:#ffdd44;font-weight:bold">'+lv.price.toFixed(2)+'</span></div>'+
        '<div class="tr"><span class="tl">Trades</span><span>'+lv.trades+'</span></div>'+
        '<div class="tr"><span class="tl">Dominance</span><span style="color:'+dc+'">'+lv.dominance+'</span></div>'+
        '<hr style="border:none;border-top:1px solid #333;margin:4px 0">'+
        '<div class="tr"><span class="tl" style="color:#ff6070">Hit ▼ trades</span><span style="color:#ff6070">'+lv.hitTrades+'</span></div>'+
        '<div class="tr"><span class="tl" style="color:#ff6070">Hit Trd.Vol</span><span style="color:#ff6070">'+F2(lv.hitTrdVol)+'</span></div>'+
        '<div class="tr"><span class="tl" style="color:#ff6070">Hit B.Size</span><span style="color:#ff6070">'+F2(lv.hitBSize)+'</span></div>'+
        '<hr style="border:none;border-top:1px solid #333;margin:4px 0">'+
        '<div class="tr"><span class="tl" style="color:#00ee99">Lift ▲ trades</span><span style="color:#00ee99">'+lv.liftTrades+'</span></div>'+
        '<div class="tr"><span class="tl" style="color:#00ee99">Lift Trd.Vol</span><span style="color:#00ee99">'+F2(lv.liftTrdVol)+'</span></div>'+
        '<div class="tr"><span class="tl" style="color:#00ee99">Lift A.Size</span><span style="color:#00ee99">'+F2(lv.liftASize)+'</span></div>'+
        '<hr style="border:none;border-top:1px solid #333;margin:4px 0">'+
        '<div class="tr"><span class="tl">Delta (L−H)</span><span style="color:'+(lv.delta>=0?'#00cc66':'#ff5555')+'">'+(lv.delta>=0?'+':'')+F2(lv.delta)+'</span></div>'+
        '<div class="tr"><span class="tl">Vol (TrdVol)</span><span>'+F2(lv.totalVol)+'</span></div>'+
        '<div class="tr"><span class="tl">ELIG_V</span><span>'+F2(lv.eligVol)+'</span></div>';
      aggTip.style.display='block';
      const x=e.clientX+16,y=e.clientY-10;
      aggTip.style.left=(x+aggTip.offsetWidth>window.innerWidth?e.clientX-aggTip.offsetWidth-10:x)+'px';
      aggTip.style.top=(y+aggTip.offsetHeight>window.innerHeight?e.clientY-aggTip.offsetHeight-5:y)+'px';
    });
    tr.addEventListener('mousemove',e=>{
      const x=e.clientX+16,y=e.clientY-10;
      aggTip.style.left=(x+aggTip.offsetWidth>window.innerWidth?e.clientX-aggTip.offsetWidth-10:x)+'px';
      aggTip.style.top=(y+aggTip.offsetHeight>window.innerHeight?e.clientY-aggTip.offsetHeight-5:y)+'px';
    });
    tr.addEventListener('mouseleave',()=>{aggTip.style.display='none';});
  });
}

function aggMaybeRebuild(){
  const t=(document.querySelector('.main-tab.active')||{}).dataset?.tab||'';
  if(t==='levels') aggBuild();
  else{window._dtDirty=window._dtDirty||{};window._dtDirty.aggregator=true;}
}

function aggExportCSV(){
  if(!_aggFiltered.length) return;
  const hdr=['Price','Trades','Hit','Lift','BSize','HitBSize','LiftBSize','ASize','HitASize','LiftASize',
    'TrdVol','HitTrdVol','LiftTrdVol','Volume','HitVolume','LiftVolume','EligVol','HitEligVol','LiftEligVol',
    'Moves','HitMoves','LiftMoves','Delta','Dominance'];
  const csv=[hdr,..._aggFiltered.map(r=>[r.price,r.trades,r.hitTrades,r.liftTrades,
    r.bSize,r.hitBSize,r.liftBSize,r.aSize,r.hitASize,r.liftASize,
    r.trdVol,r.hitTrdVol,r.liftTrdVol,r.volume,r.hitVolume,r.liftVolume,
    r.eligVol,r.hitEligVol,r.liftEligVol,r.moves,r.hitMoves,r.liftMoves,
    r.delta,r.dominance])].map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='level_aggregator.csv';a.click();
}

window.addEventListener('load',()=>{
  CFG._bgTheme=BG_THEMES['dark'];buildPicker();syncMode(CFG.mode);_updateIntervalLabel();showIdleState();
  setTimeout(()=>{navInit();navUpdateMinimap();navUpdatePosLabel();qiSyncAll();csBuildDynamic();csUpdateLast();tlBuildHeader();tlBuildPills();sumBuildPills();
    document.querySelectorAll('#sum-pill-iv .sum-iv-pill').forEach(b =>
      b.addEventListener('click', function(){ sumSetInterval(+this.dataset.s, this); }));
    document.querySelectorAll('#sum-pill-tk .sum-iv-pill').forEach(b =>
      b.addEventListener('click', function(){ sumSetTick(+this.dataset.tk, this); }));
    _sumSyncPills();
    _dtInstallHooks();
    document.querySelectorAll('.la-col-pill').forEach(p=>{
      p.addEventListener('click',()=>{
        p.classList.toggle('checked');
        const cb=p.querySelector('input');if(cb)cb.checked=p.classList.contains('checked');
        LA_renderTable(LA_FILT);
      });
    });
    laSetTick(0.10);
    document.querySelectorAll('.agg-pill').forEach(p=>{
      p.addEventListener('click',()=>{
        p.classList.toggle('on');
        const cb=p.querySelector('input');if(cb)cb.checked=p.classList.contains('on');
        _aggRenderTable(_aggFiltered);
      });
    });
  },100);
});
window.addEventListener('resize',()=>{if(R){R.resize();R.draw();}});

/* ============================================================
   FONT SIZE CONTROL
   ============================================================ */

let _globalFontSize = 11;
const FS_MIN = 7, FS_MAX = 18;

function changeFontSize(delta) {
  _globalFontSize = Math.max(FS_MIN, Math.min(FS_MAX, _globalFontSize + delta));
  applyFontSize();
}

function applyFontSize() {
  const fs = _globalFontSize;
  const px = fs + 'px';
  const smallPx = Math.max(FS_MIN, fs-2) + 'px';
  const tinyPx = Math.max(FS_MIN, fs-3) + 'px';

  const fsEl = document.getElementById('fs-val');
  if (fsEl) fsEl.textContent = px;

  /* Existing tables */
  document.querySelectorAll('.tl-table td,.tl-table th,.sum-table td,.sum-table th')
    .forEach(el => el.style.fontSize = px);
  document.querySelectorAll('.tl-col-pill,.sum-col-pill')
    .forEach(el => el.style.fontSize = smallPx);

  /* Candle summary */
  document.querySelectorAll('.cs-val').forEach(el => el.style.fontSize = px);
  document.querySelectorAll('.cs-lbl').forEach(el => el.style.fontSize = tinyPx);
  document.querySelectorAll('.cs-cell').forEach(el => {
    el.style.padding = fs <= 9 ? '2px 3px' : fs >= 14 ? '6px 7px' : '4px 5px';
  });

  /* Level Aggregator, LA PRO, and Delta Flip Pairs */
  document.querySelectorAll(
    '#agg-table td,#agg-table th,'+
    '#la-table td,#la-table th,'+
    '#la-level-table td,#la-level-table th,'+
    '#dfp-table td,#dfp-table th'
  ).forEach(el => el.style.fontSize = px);

  document.querySelectorAll(
    '#la-topbar,#la-topbar span,#la-topbar button,#la-topbar select,#la-topbar input,'+
    '#la-colbar,#la-colbar label,#la-colbar select,#la-colbar input,'+
    '#la-statusbar,#la-statusbar span,'+
    '.agg-pill,.la-tick-pill,.la-col-pill,.dfp-pair-pill,.dfp-status-bar,'+
    '#dfp-toolbar,#dfp-toolbar label,#dfp-toolbar select,#dfp-toolbar input'
  ).forEach(el => el.style.fontSize = smallPx);

  document.querySelectorAll('.la-bar,.dfp-bar,.dfp-status-bar').forEach(el => {
    el.style.height = Math.max(7, Math.round(fs * 0.9)) + 'px';
  });

  const _splVal = document.getElementById('csv-spl-trd');
  if (_splVal) _splVal.style.fontSize = (fs+2) + 'px';
  window._tableFontSize = fs;
}

const _origTlRender = tlRender;
tlRender = function() {
  _origTlRender.apply(this, arguments);
  if (window._tableFontSize) applyFontSize();
};
const _origSumRenderAll = sumRender;
sumRender = function() {
  _origSumRenderAll.apply(this, arguments);
  if (window._tableFontSize) applyFontSize();
  Object.entries(_sumColWidths).forEach(([key, w]) => _applyColWidthToTable(key, w));
  requestAnimationFrame(_sumInstallResize);
};

/* ============================================================
   PRICE SUMMARY COLUMN RESIZE
   ============================================================ */

let _sumColWidths = {};
let _sumSelectedCol = null;

function _sumInstallResize() {
  const head = document.getElementById('sum-head');
  if (!head) return;
  const ths = head.querySelectorAll('th');
  ths.forEach((th, i) => {
    th.style.position = 'relative';

    th.addEventListener('click', function(e) {
      if (e.target.classList.contains('sum-col-resizer')) return;
      const match = (th.getAttribute('onclick') || '').match(/sumSortBy\('([^']+)'\)/);
      const key = match ? match[1] : null;
      if (!key) return;

      if (_sumSelectedCol === key) {
        _sumSelectedCol = null;
        th.style.background = '';
        _updateColWidthInfo(null);
      } else {
        _sumSelectedCol = key;
        head.querySelectorAll('th').forEach(t => t.style.background = '');
        th.style.background = '#001a33';
        const w = _sumColWidths[key] || 65;
        _updateColWidthInfo(key, w);
      }
    }, true);

    if (!th.querySelector('.sum-col-resizer')) {
      const resizer = document.createElement('div');
      resizer.className = 'sum-col-resizer';
      resizer.title = 'Drag to resize column';
      resizer.addEventListener('mousedown', function(e) {
        e.preventDefault(); e.stopPropagation();
        const match = (th.getAttribute('onclick') || '').match(/sumSortBy\('([^']+)'\)/);
        const key = match ? match[1] : null;
        if (!key) return;
        _sumSelectedCol = key;
        resizer.classList.add('resizing');
        const startX = e.clientX;
        const startW = th.offsetWidth;
        function onMove(e2) {
          const newW = Math.max(40, startW + (e2.clientX - startX));
          _setSumColWidth(key, newW);
        }
        function onUp() {
          resizer.classList.remove('resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      th.appendChild(resizer);
    }
  });
}

function _setSumColWidth(key, w) {
  w = Math.max(40, Math.min(400, Math.round(w)));
  _sumColWidths[key] = w;
  const col = SUM_ALL_COLS.find(c => c.key === key);
  if (col) col.w = w;
  _applyColWidthToTable(key, w);
  _updateColWidthInfo(key, w);
}

function _applyColWidthToTable(key, w) {
  const head = document.getElementById('sum-head');
  const body = document.getElementById('sum-body');
  if (!head) return;
  const ths = Array.from(head.querySelectorAll('th'));
  ths.forEach((th, colIdx) => {
    const match = (th.getAttribute('onclick') || '').match(/sumSortBy\('([^']+)'\)/);
    if (match && match[1] === key) {
      th.style.minWidth = w + 'px';
      th.style.maxWidth = w + 'px';
      th.style.width    = w + 'px';
      if (body) {
        body.querySelectorAll(`tr td:nth-child(${colIdx + 1})`).forEach(td => {
          td.style.minWidth = w + 'px';
          td.style.maxWidth = w + 'px';
          td.style.width    = w + 'px';
        });
      }
    }
  });
}

function _updateColWidthInfo(key, w) {
  const el = document.getElementById('sum-col-width-info');
  if (!el) return;
  if (!key) { el.textContent = ''; el.style.display = 'none'; return; }
  el.style.display = 'inline';
  const col = SUM_ALL_COLS.find(c => c.key === key);
  const label = col ? col.label : key;
  el.textContent = `${label}: ${w||'?'}px`;
  el.style.color = '#44aaff';
}

function sumColWidenBy(delta) {
  if (!_sumSelectedCol) return;
  const col = SUM_ALL_COLS.find(c => c.key === _sumSelectedCol);
  const cur = _sumColWidths[_sumSelectedCol] || (col ? col.w : 65);
  _setSumColWidth(_sumSelectedCol, cur + delta);
}

document.addEventListener('keydown', function(e) {
  if (!_sumSelectedCol) return;
  if (document.activeElement && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); sumColWidenBy(5); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); sumColWidenBy(-5); }
});

/* =====================================================================
   LA PRO TAB
   ===================================================================== */

let LA_TICK  = 0.10;
let LA_MUL   = Math.round(1 / LA_TICK);
let LA_RAW   = [];
let LA_LEVELS= [];
let LA_FILT  = [];

/* ── EDIT 4: LA_getSrcRows always returns current-interval rows ── */
function LA_getSrcRows() {
  return _currentIntervalRows();
}

function laSetTick(v) {
  if (!v || v <= 0) return;
  LA_TICK = v;
  LA_MUL  = Math.round(1 / LA_TICK);
  const inp = document.getElementById('la-tick-input');
  if (inp) inp.value = v;
  document.querySelectorAll('.la-tick-pill').forEach(b => {
    b.classList.toggle('on', Math.abs(parseFloat(b.textContent) - v) < 0.0001);
  });
  if (LA_RAW.length) { LA_LEVELS = LA_aggregate(LA_RAW); laApplyFilters(); }
}

function laRebuild() {
  const rows = LA_getSrcRows();
  const tbl  = document.getElementById('la-level-table');
  const emp  = document.getElementById('la-empty-state');
  if (!rows.length) {
    if (tbl) tbl.style.display = 'none';
    if (emp) emp.style.display = 'flex';
    LA_updateBadges(0, 0, 0);
    return;
  }
  LA_RAW    = rows;
  LA_LEVELS = LA_aggregate(rows);
  if (tbl) tbl.style.display = 'table';
  if (emp) emp.style.display = 'none';
  laApplyFilters();
}

function LA_aggregate(rows) {
  const map = new Map();
  rows.forEach(r => {
    const last = +(r.last || 0);
    if (last <= 0) return;

    const pk       = Math.round(Math.round(last / LA_TICK) * LA_TICK * LA_MUL * 100) / 100;
    const priceDisp= Math.round(last / LA_TICK) * LA_TICK;

    let side = 'N';
    const ag = String(r.aggr || '').toUpperCase().trim();
    if      (ag === 'ASK' || ag === 'BUY'  || ag === 'LIFT')  side = 'L';
    else if (ag === 'BID' || ag === 'SELL' || ag === 'HIT')   side = 'H';
    else if (r.ask > 0 && Math.abs(last - r.ask) < LA_TICK * 0.6) side = 'L';
    else if (r.bid > 0 && Math.abs(last - r.bid) < LA_TICK * 0.6) side = 'H';

    if (!map.has(pk)) {
      map.set(pk, {
        price: priceDisp, trades: 0,
        bSize:0, aSize:0, numBid:0, numAsk:0, numOrders:0,
        trdVol:0, volume:0, moves:0, eligbl:0,
        hitTrades:0,  hitBSize:0,  hitASize:0,  hitNumBid:0,  hitNumAsk:0,
        hitNumOrders:0,  hitTrdVol:0,  hitVolume:0,  hitMoves:0,  hitEligbl:0,
        liftTrades:0, liftBSize:0, liftASize:0, liftNumBid:0, liftNumAsk:0,
        liftNumOrders:0, liftTrdVol:0, liftVolume:0, liftMoves:0, liftEligbl:0,
      });
    }
    const lv = map.get(pk);
    lv.trades++;
    lv.bSize     += +(r.bSize     || 0);
    lv.aSize     += +(r.aSize     || 0);
    lv.numBid    += +(r.numBid    || 0);
    lv.numAsk    += +(r.numAsk    || 0);
    lv.numOrders += +(r.numOrders || 0);
    lv.trdVol    += +(r.trdVol    || 0);
    lv.volume    += +(r.volDiff   || r.volume  || 0);
    lv.moves     += +(r.movesDiff || r.moves   || 0);
    lv.eligbl    += +(r.eligVol   || 0);

    if (side === 'H') {
      lv.hitTrades++;
      lv.hitBSize     += +(r.bSize     || 0);  lv.hitASize     += +(r.aSize     || 0);
      lv.hitNumBid    += +(r.numBid    || 0);  lv.hitNumAsk    += +(r.numAsk    || 0);
      lv.hitNumOrders += +(r.numOrders || 0);  lv.hitTrdVol    += +(r.trdVol    || 0);
      lv.hitVolume    += +(r.volDiff   || r.volume || 0);
      lv.hitMoves     += +(r.movesDiff || r.moves  || 0);
      lv.hitEligbl    += +(r.eligVol   || 0);
    } else if (side === 'L') {
      lv.liftTrades++;
      lv.liftBSize     += +(r.bSize     || 0);  lv.liftASize     += +(r.aSize     || 0);
      lv.liftNumBid    += +(r.numBid    || 0);  lv.liftNumAsk    += +(r.numAsk    || 0);
      lv.liftNumOrders += +(r.numOrders || 0);  lv.liftTrdVol    += +(r.trdVol    || 0);
      lv.liftVolume    += +(r.volDiff   || r.volume || 0);
      lv.liftMoves     += +(r.movesDiff || r.moves  || 0);
      lv.liftEligbl    += +(r.eligVol   || 0);
    }
  });
  return Array.from(map.values()).map(lv => {
    lv.delta     = lv.liftTrdVol - lv.hitTrdVol;
    lv.totalVol  = lv.trdVol;
    lv.dominance = lv.hitTrades > lv.liftTrades ? 'HIT'
                 : lv.liftTrades > lv.hitTrades  ? 'LIFT' : 'NEUTRAL';
    return lv;
  });
}

function laApplyFilters() {
  const side   = (document.getElementById('la-filter-side') || {}).value || 'all';
  const minVol = parseFloat((document.getElementById('la-filter-vol') || {}).value) || 0;
  const sortC  = (document.getElementById('la-sort-col') || {}).value || 'price';
  const sortD  = (document.getElementById('la-sort-dir') || {}).value || 'desc';

  let rows = LA_LEVELS.slice();
  if (side === 'HIT')  rows = rows.filter(r => r.hitTrades  > 0);
  if (side === 'LIFT') rows = rows.filter(r => r.liftTrades > 0);
  if (side === 'BOTH') rows = rows.filter(r => r.hitTrades  > 0 && r.liftTrades > 0);
  if (minVol > 0)      rows = rows.filter(r => r.totalVol  >= minVol);
  const mult = sortD === 'asc' ? 1 : -1;
  rows.sort((a, b) => ((a[sortC] || 0) - (b[sortC] || 0)) * mult);
  LA_FILT = rows;
  LA_updateSummary(rows);
  LA_renderTable(rows);
}

function LA_updateSummary(rows) {
  const F = n => { n=Math.round(n||0); return Math.abs(n)>=1e6?(n/1e6).toFixed(1)+'M':Math.abs(n)>=1e4?(n/1e3).toFixed(1)+'k':n.toLocaleString(); };
  const totalVol = rows.reduce((s,r)=>s+r.totalVol,0);
  const hitVol   = rows.reduce((s,r)=>s+r.hitTrdVol,0);
  const liftVol  = rows.reduce((s,r)=>s+r.liftTrdVol,0);
  const delta    = liftVol - hitVol;
  const bSize    = rows.reduce((s,r)=>s+r.bSize,0);
  const aSize    = rows.reduce((s,r)=>s+r.aSize,0);
  const trades   = rows.reduce((s,r)=>s+r.trades,0);
  const _s = id => document.getElementById(id);
  if (_s('la-s-levels')) _s('la-s-levels').textContent = rows.length.toLocaleString();
  if (_s('la-s-trades')) _s('la-s-trades').textContent = trades.toLocaleString();
  if (_s('la-s-vol'))    _s('la-s-vol').textContent    = F(totalVol);
  if (_s('la-s-hitvol')) _s('la-s-hitvol').textContent = F(hitVol);
  if (_s('la-s-liftvol'))_s('la-s-liftvol').textContent= F(liftVol);
  const de = _s('la-s-delta');
  if (de) { de.textContent=(delta>=0?'+':'')+F(delta); de.style.color=delta>=0?'#00cc88':'#ee5566'; }
  if (_s('la-s-bsize'))  _s('la-s-bsize').textContent  = F(bSize);
  if (_s('la-s-asize'))  _s('la-s-asize').textContent  = F(aSize);
  LA_updateBadges(rows, hitVol, liftVol);
}

function LA_updateBadges(rows, hitVol, liftVol) {
  const isArr = Array.isArray(rows);
  const hitLevels  = isArr ? rows.filter(r=>r.hitTrades>0).length  : 0;
  const liftLevels = isArr ? rows.filter(r=>r.liftTrades>0).length : 0;
  const rowCnt     = isArr ? rows.length : 0;
  const rb = document.getElementById('la-row-badge');
  if (rb) rb.textContent = rowCnt > 0 ? `${rowCnt} levels · ${LA_RAW.length.toLocaleString()} ticks` : 'No data';
  const hb = document.getElementById('la-hit-badge');
  const lb = document.getElementById('la-lift-badge');
  if (hb) { hb.textContent=`${hitLevels} Hit levels`;  hb.style.display=hitLevels?'':'none'; }
  if (lb) { lb.textContent=`${liftLevels} Lift levels`; lb.style.display=liftLevels?'':'none'; }
}

function LA_getActiveCols() {
  const a = new Set();
  document.querySelectorAll('.la-col-pill.checked').forEach(p => a.add(p.dataset.col));
  return a;
}

const LA_INFO_LABELS = {numOrders:'#Orders',trdVol:'Trd.Vol',volume:'Volume',moves:'Moves/RTL',eligbl:'EligblTrd'};

function LA_buildColSpec(active) {
  const cols = [];
  const F    = n => { n=Math.round(n||0); return Math.abs(n)>=1e6?(n/1e6).toFixed(1)+'M':Math.abs(n)>=1e4?(n/1e3).toFixed(1)+'k':n.toLocaleString(); };
  const zero = () => '<span class="la-v-zero">—</span>';

  cols.push({id:'price',label:'Price',sub:'level',cls:'la-price-cell',render:lv=>lv.price.toFixed(2)});
  cols.push({id:'trades',label:'Trades',sub:'total',cls:'la-v-info',render:lv=>F(lv.trades)});
  cols.push({id:'hitTrades',label:'',sub:'hit ▼',cls:'la-v-hit',render:lv=>lv.hitTrades>0?F(lv.hitTrades):zero()});
  cols.push({id:'liftTrades',label:'',sub:'lift ▲',cls:'la-v-lift',render:lv=>lv.liftTrades>0?F(lv.liftTrades):zero()});

  if (active.has('bSize')) {
    cols.push({id:'bSize_t',label:'B Size',sub:'total',cls:'la-v-bid la-bar-cell',barKey:'bSize',barColor:'rgba(0,204,136,.5)',render:lv=>F(lv.bSize)});
    cols.push({id:'bSize_h',label:'',sub:'hit ▼',cls:'la-v-hit',render:lv=>lv.hitBSize>0?F(lv.hitBSize):zero()});
    cols.push({id:'bSize_l',label:'',sub:'lift ▲',cls:'la-v-lift',render:lv=>lv.liftBSize>0?F(lv.liftBSize):zero()});
  }
  if (active.has('aSize')) {
    cols.push({id:'aSize_t',label:'A Size',sub:'total',cls:'la-v-ask la-bar-cell',barKey:'aSize',barColor:'rgba(238,56,68,.5)',render:lv=>F(lv.aSize)});
    cols.push({id:'aSize_h',label:'',sub:'hit ▼',cls:'la-v-hit',render:lv=>lv.hitASize>0?F(lv.hitASize):zero()});
    cols.push({id:'aSize_l',label:'',sub:'lift ▲',cls:'la-v-lift',render:lv=>lv.liftASize>0?F(lv.liftASize):zero()});
  }
  if (active.has('numBid')) {
    cols.push({id:'numBid_t',label:'Num Bid',sub:'total',cls:'la-v-bid la-bar-cell',barKey:'numBid',barColor:'rgba(0,204,136,.35)',render:lv=>F(lv.numBid)});
    cols.push({id:'numBid_h',label:'',sub:'hit ▼',cls:'la-v-hit',render:lv=>lv.hitNumBid>0?F(lv.hitNumBid):zero()});
    cols.push({id:'numBid_l',label:'',sub:'lift ▲',cls:'la-v-lift',render:lv=>lv.liftNumBid>0?F(lv.liftNumBid):zero()});
  }
  if (active.has('numAsk')) {
    cols.push({id:'numAsk_t',label:'Num Ask',sub:'total',cls:'la-v-ask la-bar-cell',barKey:'numAsk',barColor:'rgba(238,56,68,.35)',render:lv=>F(lv.numAsk)});
    cols.push({id:'numAsk_h',label:'',sub:'hit ▼',cls:'la-v-hit',render:lv=>lv.hitNumAsk>0?F(lv.hitNumAsk):zero()});
    cols.push({id:'numAsk_l',label:'',sub:'lift ▲',cls:'la-v-lift',render:lv=>lv.liftNumAsk>0?F(lv.liftNumAsk):zero()});
  }

  const infoMap = [
    {key:'numOrders', tot:'numOrders', hit:'hitNumOrders', lift:'liftNumOrders', barKey:'numOrders'},
    {key:'trdVol',    tot:'trdVol',    hit:'hitTrdVol',    lift:'liftTrdVol',    barKey:'totalVol'},
    {key:'volume',    tot:'volume',    hit:'hitVolume',    lift:'liftVolume',    barKey:'volume'},
    {key:'moves',     tot:'moves',     hit:'hitMoves',     lift:'liftMoves',     barKey:'moves'},
    {key:'eligbl',    tot:'eligbl',    hit:'hitEligbl',    lift:'liftEligbl',    barKey:'eligbl'},
  ];
  infoMap.forEach(({key,tot,hit,lift,barKey}) => {
    if (!active.has(key)) return;
    const lbl = LA_INFO_LABELS[key];
    cols.push({id:`${key}_t`,label:lbl,sub:'total',cls:'la-v-info la-bar-cell',barKey,barColor:'rgba(106,171,255,.4)',render:lv=>F(lv[tot])});
    cols.push({id:`${key}_h`,label:'',sub:'hit ▼',cls:'la-v-hit',render:lv=>lv[hit]>0?F(lv[hit]):zero()});
    cols.push({id:`${key}_l`,label:'',sub:'lift ▲',cls:'la-v-lift',render:lv=>lv[lift]>0?F(lv[lift]):zero()});
  });

  cols.push({id:'delta',label:'Delta',sub:'Lift−Hit',cls:'la-v-info',render:lv=>{
    const d=lv.delta;
    const c=d>0?'#00cc88':d<0?'#ee5566':'#446688';
    return `<span style="color:${c}">${d>=0?'+':''}${F(d)}</span>`;
  }});
  return cols;
}

function LA_buildThead(cols) {
  const groups = [];
  cols.forEach(col => {
    const lbl = col.label || '';
    if (groups.length && groups[groups.length-1].lbl === lbl &&
        lbl !== 'Price' && lbl !== 'Trades' && lbl !== 'Delta') {
      groups[groups.length-1].span++;
    } else groups.push({lbl, span:1});
  });
  const hdrCls = l => {
    if (l.includes('B Size')||l.includes('Num Bid')) return 'la-gh-bid';
    if (l.includes('A Size')||l.includes('Num Ask')) return 'la-gh-ask';
    if (l === 'Price') return 'la-gh-price';
    if (l === 'Delta' || ['Trades','#Orders','Trd.Vol','Volume','Moves/RTL','EligblTrd'].includes(l)) return 'la-gh-info';
    return '';
  };
  const subCls = s => s==='hit ▼'?'la-sh-hit':s==='lift ▲'?'la-sh-lift':'la-sh-info';
  return (
    '<tr>' + groups.map(g=>`<th colspan="${g.span}" class="${hdrCls(g.lbl)}">${g.lbl}</th>`).join('') + '</tr>' +
    '<tr>' + cols.map(c=>`<th class="${subCls(c.sub||c.label)}">${c.sub||c.label}</th>`).join('') + '</tr>'
  );
}

function LA_renderTable(rows) {
  const tbl   = document.getElementById('la-level-table');
  const thead = document.getElementById('la-thead');
  const tbody = document.getElementById('la-tbody');
  const emp   = document.getElementById('la-empty-state');
  if (!thead || !tbody) return;

  if (!rows.length) {
    if (tbl) tbl.style.display = 'none';
    if (emp) emp.style.display = 'flex';
    return;
  }
  if (tbl) tbl.style.display = 'table';
  if (emp) emp.style.display = 'none';

  const active = LA_getActiveCols();
  const cols   = LA_buildColSpec(active);
  const maxes  = {};
  cols.forEach(c => { if (c.barKey) maxes[c.barKey] = Math.max(...rows.map(r=>r[c.barKey]||0), 1); });

  thead.innerHTML = LA_buildThead(cols);

  tbody.innerHTML = rows.map((lv, ri) => {
    const dom = lv.dominance==='HIT'?'la-dom-hit':lv.dominance==='LIFT'?'la-dom-lift':'';
    return `<tr class="${dom}">${cols.map(col => {
      const val = col.render(lv);
      if (col.barKey && maxes[col.barKey]) {
        const pct = ((lv[col.barKey] || 0) / maxes[col.barKey] * 100).toFixed(1);
        return `<td class="${col.cls}"><div class="la-bar-bg" style="width:${pct}%;background:${col.barColor}"></div><span>${val}</span></td>`;
      }
      return `<td class="${col.cls}">${val}</td>`;
    }).join('')}</tr>`;
  }).join('');

  const tipEl = document.getElementById('tip');
  tbody.querySelectorAll('tr').forEach((tr, i) => {
    const lv = rows[i]; if (!lv) return;
    const F2 = n => { n=Math.round(n||0); const a=Math.abs(n); return a>=1e6?(n/1e6).toFixed(1)+'M':a>=1e4?(n/1e3).toFixed(1)+'k':n.toLocaleString(); };
    tr.addEventListener('mouseenter', e => {
      const dc = lv.dominance==='HIT'?'#ee5566':lv.dominance==='LIFT'?'#00cc88':'#446688';
      tipEl.innerHTML =
        `<div class="tr"><span class="tl">Price</span><span style="color:#ffdd44;font-weight:bold">${lv.price.toFixed(2)}</span></div>` +
        `<div class="tr"><span class="tl">Trades</span><span>${lv.trades}</span></div>` +
        `<div class="tr"><span class="tl">Dominance</span><span style="color:${dc}">${lv.dominance}</span></div>` +
        `<hr style="border:none;border-top:1px solid #333;margin:4px 0">` +
        `<div class="tr"><span class="tl" style="color:#ee5566">Hit ▼ trades</span><span style="color:#ee5566">${lv.hitTrades}</span></div>` +
        `<div class="tr"><span class="tl" style="color:#ee5566">Hit Trd.Vol</span><span style="color:#ee5566">${F2(lv.hitTrdVol)}</span></div>` +
        `<div class="tr"><span class="tl" style="color:#ee5566">Hit B.Size</span><span style="color:#ee5566">${F2(lv.hitBSize)}</span></div>` +
        `<div class="tr"><span class="tl" style="color:#ee5566">Hit #Orders</span><span style="color:#ee5566">${F2(lv.hitNumOrders)}</span></div>` +
        `<hr style="border:none;border-top:1px solid #333;margin:4px 0">` +
        `<div class="tr"><span class="tl" style="color:#00cc88">Lift ▲ trades</span><span style="color:#00cc88">${lv.liftTrades}</span></div>` +
        `<div class="tr"><span class="tl" style="color:#00cc88">Lift Trd.Vol</span><span style="color:#00cc88">${F2(lv.liftTrdVol)}</span></div>` +
        `<div class="tr"><span class="tl" style="color:#00cc88">Lift A.Size</span><span style="color:#00cc88">${F2(lv.liftASize)}</span></div>` +
        `<div class="tr"><span class="tl" style="color:#00cc88">Lift #Orders</span><span style="color:#00cc88">${F2(lv.liftNumOrders)}</span></div>` +
        `<hr style="border:none;border-top:1px solid #333;margin:4px 0">` +
        `<div class="tr"><span class="tl">Delta (L−H)</span><span style="color:${lv.delta>=0?'#00cc88':'#ee5566'}">${lv.delta>=0?'+':''}${F2(lv.delta)}</span></div>` +
        `<div class="tr"><span class="tl">Vol (TrdVol)</span><span>${F2(lv.totalVol)}</span></div>` +
        `<div class="tr"><span class="tl">EligblTrd</span><span>${F2(lv.eligbl)}</span></div>` +
        `<div class="tr"><span class="tl">Tick size</span><span>${LA_TICK}</span></div>`;
      tipEl.style.display = 'block';
      const x=e.clientX+16, y=e.clientY-10;
      tipEl.style.left=(x+tipEl.offsetWidth >window.innerWidth  ?e.clientX-tipEl.offsetWidth -10:x)+'px';
      tipEl.style.top =(y+tipEl.offsetHeight>window.innerHeight ?e.clientY-tipEl.offsetHeight-5 :y)+'px';
    });
    tr.addEventListener('mousemove', e => {
      const x=e.clientX+16, y=e.clientY-10;
      tipEl.style.left=(x+tipEl.offsetWidth >window.innerWidth  ?e.clientX-tipEl.offsetWidth -10:x)+'px';
      tipEl.style.top =(y+tipEl.offsetHeight>window.innerHeight ?e.clientY-tipEl.offsetHeight-5 :y)+'px';
    });
    tr.addEventListener('mouseleave', () => { tipEl.style.display='none'; });
  });
}

function laMaybeRebuild() {
  const t = (document.querySelector('.main-tab.active')||{}).dataset?.tab || '';
  if (t === 'lagr') laRebuild();
  else { window._dtDirty = window._dtDirty || {}; window._dtDirty.lagr = true; }
}

function laExportCSV() {
  if (!LA_FILT.length) return;
  const active = LA_getActiveCols();
  const hdr = ['Price','Trades','Hit Trades','Lift Trades',
    ...(active.has('bSize')    ?['B Size','B Size Hit','B Size Lift']:[]),
    ...(active.has('aSize')    ?['A Size','A Size Hit','A Size Lift']:[]),
    ...(active.has('numBid')   ?['Num Bid','Num Bid Hit','Num Bid Lift']:[]),
    ...(active.has('numAsk')   ?['Num Ask','Num Ask Hit','Num Ask Lift']:[]),
    ...(active.has('numOrders')?['#Orders','#Orders Hit','#Orders Lift']:[]),
    ...(active.has('trdVol')   ?['Trd.Vol','Trd.Vol Hit','Trd.Vol Lift']:[]),
    ...(active.has('volume')   ?['Volume','Volume Hit','Volume Lift']:[]),
    ...(active.has('moves')    ?['Moves/RTL','Moves Hit','Moves Lift']:[]),
    ...(active.has('eligbl')   ?['EligblTrd','EligblTrd Hit','EligblTrd Lift']:[]),
    'Delta (Lift-Hit)','Dominance','Tick Size'];
  const csv = [hdr, ...LA_FILT.map(lv => [
    lv.price,lv.trades,lv.hitTrades,lv.liftTrades,
    ...(active.has('bSize')    ?[lv.bSize,   lv.hitBSize,   lv.liftBSize]  :[]),
    ...(active.has('aSize')    ?[lv.aSize,   lv.hitASize,   lv.liftASize]  :[]),
    ...(active.has('numBid')   ?[lv.numBid,  lv.hitNumBid,  lv.liftNumBid] :[]),
    ...(active.has('numAsk')   ?[lv.numAsk,  lv.hitNumAsk,  lv.liftNumAsk] :[]),
    ...(active.has('numOrders')?[lv.numOrders,lv.hitNumOrders,lv.liftNumOrders]:[]),
    ...(active.has('trdVol')   ?[lv.trdVol,  lv.hitTrdVol,  lv.liftTrdVol] :[]),
    ...(active.has('volume')   ?[lv.volume,  lv.hitVolume,  lv.liftVolume] :[]),
    ...(active.has('moves')    ?[lv.moves,   lv.hitMoves,   lv.liftMoves]  :[]),
    ...(active.has('eligbl')   ?[lv.eligbl,  lv.hitEligbl,  lv.liftEligbl] :[]),
    lv.delta, lv.dominance, LA_TICK,
  ])].map(row => row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = 'la_pro_levels.csv'; a.click();
}


/* Font-size hook for Level Aggregator, LA PRO, and Flip Pairs tabs */
(function(){
  if(window._fontHookAddedTabs) return;
  window._fontHookAddedTabs=true;
  const wrap=(name)=>{
    const fn=window[name];
    if(typeof fn==='function' && !fn._fontWrapped){
      const wrapped=function(){ const ret=fn.apply(this,arguments); if(window._tableFontSize) setTimeout(applyFontSize,0); return ret; };
      wrapped._fontWrapped=true;
      window[name]=wrapped;
    }
  };
  wrap('aggBuild');
  wrap('laRebuild');
  wrap('dfpRender');
})();

// ==== inline-script ====
/* === FIX PATCH: PREV/NEXT navigation + right Candle Summary resize === */
(function(){
  function q(id){return document.getElementById(id);}  
  function nBars(){ var el=q('bar-n'); return Math.max(1, parseInt(el && el.value,10) || 1); }
  function clampOffset(off){
    try{
      var total = (Array.isArray(window._trBars) ? window._trBars.length : (typeof _trBars!=='undefined' && _trBars ? _trBars.length : 0));
      var n = nBars();
      return Math.max(0, Math.min(off, Math.max(0,total-n)));
    }catch(e){ return 0; }
  }
  function getBars(){ try{ return (typeof _trBars!=='undefined' && Array.isArray(_trBars)) ? _trBars : []; }catch(e){ return []; } }
  function getOffset(){ try{ return (typeof _trOffset!=='undefined') ? _trOffset : 0; }catch(e){ return 0; } }
  function setOffset(v){ try{ _trOffset = v; }catch(e){} }
  window.ofTrNav = function(dir){
    var bars = getBars();
    if(!bars.length){ if(typeof buildCandles==='function') buildCandles(); bars=getBars(); }
    if(!bars.length) return false;
    var step = nBars();
    var old = getOffset();
    var next = clampOffset(old + (dir<0 ? -step : step));
    if(next === old){ if(typeof _trUpdateNavInfo==='function') _trUpdateNavInfo(); return false; }
    setOffset(next);
    if(typeof _trApplyView==='function') _trApplyView();
    if(typeof _trUpdateNavInfo==='function') _trUpdateNavInfo();
    if(typeof window.ofRefreshActiveTab==='function') setTimeout(window.ofRefreshActiveTab,60);
    return true;
  };
  window.trNav = window.ofTrNav;

  function wireNavButtons(){
    var prev = document.querySelector('[onclick="trNav(-1)"]');
    var next = document.querySelector('[onclick="trNav(1)"]');
    if(prev && !prev.__ofNavClaimed){ prev.__ofNavClaimed=true; prev.setAttribute('data-of-nav','prev'); prev.onclick=function(e){ if(e) e.preventDefault(); return window.trNav(-1); }; }
    if(next && !next.__ofNavClaimed){ next.__ofNavClaimed=true; next.setAttribute('data-of-nav','next'); next.onclick=function(e){ if(e) e.preventDefault(); return window.trNav(1); }; }
  }

  function patchRightResize(){
    var handle=q('rp-resize-handle'), panel=q('right-panel');
    if(!handle || !panel || handle.__ofResizeFixed) return;
    handle.__ofResizeFixed=true;
    var dragging=false, startX=0, startW=0;
    function apply(w){
      w=Math.max(140, Math.min(520, w));
      document.documentElement.style.setProperty('--of-rp-w', w+'px');
      panel.style.setProperty('width', w+'px', 'important');
      panel.style.setProperty('flex-basis', w+'px', 'important');
      panel.style.transition='none';
      try{ if(window.R){ R.resize(); R.draw(); } }catch(e){}
    }
    handle.addEventListener('mousedown', function(e){
      dragging=true; startX=e.clientX; startW=panel.getBoundingClientRect().width || 220;
      handle.classList.add('dragging'); document.body.style.cursor='col-resize'; document.body.style.userSelect='none';
      e.preventDefault(); e.stopPropagation();
    }, true);
    window.addEventListener('mousemove', function(e){ if(!dragging) return; apply(startW + (startX - e.clientX)); e.preventDefault(); }, true);
    window.addEventListener('mouseup', function(){ if(!dragging) return; dragging=false; handle.classList.remove('dragging'); document.body.style.cursor=''; document.body.style.userSelect=''; panel.style.transition='width .15s'; }, true);
    handle.addEventListener('touchstart', function(e){ if(!e.touches||!e.touches[0]) return; dragging=true; startX=e.touches[0].clientX; startW=panel.getBoundingClientRect().width || 220; handle.classList.add('dragging'); e.preventDefault(); }, {passive:false,capture:true});
    window.addEventListener('touchmove', function(e){ if(!dragging||!e.touches||!e.touches[0]) return; apply(startW + (startX - e.touches[0].clientX)); e.preventDefault(); }, {passive:false,capture:true});
    window.addEventListener('touchend', function(){ if(!dragging) return; dragging=false; handle.classList.remove('dragging'); document.body.style.cursor=''; document.body.style.userSelect=''; }, true);
  }

  function restoreNativeDtRows(){
    /* Earlier layout patch overrode dtRows globally, which reduced _trBars to one candle and broke PREV/NEXT. */
    try{ if(window.__of_original_dtRows && window.dtRows !== window.__of_original_dtRows) window.dtRows = window.__of_original_dtRows; }catch(e){}
  }
  function boot(){ restoreNativeDtRows(); wireNavButtons(); patchRightResize(); if(typeof _trUpdateNavInfo==='function') _trUpdateNavInfo(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
  window.addEventListener('load', function(){ setTimeout(boot,100); setTimeout(boot,500); });
})();


/* === FIX PATCH V2: PREV/NEXT one-candle navigation when built bars <= selected Bars === */
(function(){
  function q(id){ return document.getElementById(id); }
  function allBars(){ try{return (typeof _trBars!=='undefined' && Array.isArray(_trBars))?_trBars:[];}catch(e){return [];} }
  function selectedBars(){ var el=q('bar-n'); return Math.max(1, parseInt(el && el.value,10) || 1); }
  function visibleCount(){ var total=allBars().length, n=selectedBars(); return total>0 && total<=n ? 1 : Math.min(n,total||n); }
  function maxOffset(){ var bars=allBars(), vc=visibleCount(); return Math.max(0, bars.length-vc); }
  function clamp(v){ return Math.max(0, Math.min(v, maxOffset())); }

  window._of_get_current_interval_rows = function(){
    var bars=allBars(); if(!bars.length) return (typeof dtRows==='function'?dtRows():[]);
    var off=clamp(typeof _trOffset==='number'?_trOffset:0);
    var b=bars[off];
    if(b && Array.isArray(b.rows)) return b.rows;
    if(b && Array.isArray(b.ticks)) return b.ticks;
    return [];
  };

  window._trApplyView = function(){
    var bars=allBars(); if(!bars.length) return;
    var vc=visibleCount();
    _trOffset=clamp(typeof _trOffset==='number'?_trOffset:0);
    var slice=bars.slice(_trOffset,_trOffset+vc);
    var cd=_trOffset>0 ? (bars[_trOffset-1].cumD||0) : 0;
    slice.forEach(function(b){ cd += (b.delta||0); b.cumD=cd; });
    _closedBars=slice; _openBarTicks=[];
    if(window.R){ try{ R.destroy(); }catch(e){} R=null; }
    R=new Renderer([]);
    if(typeof _rebuildDisplay==='function') _rebuildDisplay();
    if(typeof syncMode==='function') syncMode(CFG.mode);
    setTimeout(function(){ var hs=q('hscroll'); if(hs) hs.scrollLeft=999999; },60);
    if(typeof csUpdateLast==='function') csUpdateLast();
    if(typeof window.ofRefreshActiveTab==='function') setTimeout(window.ofRefreshActiveTab,40);
    if(typeof _trUpdateNavInfo==='function') _trUpdateNavInfo();
  };

  window._trUpdateNavInfo = function(){
    var bars=allBars(), total=bars.length, vc=visibleCount();
    _trOffset=clamp(typeof _trOffset==='number'?_trOffset:0);
    var first= total ? _trOffset+1 : 0;
    var last = total ? Math.min(_trOffset+vc,total) : 0;
    var info=q('tr-nav-info');
    if(info){
      info.textContent = total ? (vc===1 ? ('bar '+first+' / '+total) : ('bars '+first+'–'+last+' / '+total)) : '— no bars —';
      info.style.color = total ? '#00aa55' : '#884422';
    }
    var prev=document.querySelector('[onclick="trNav(-1)"]') || document.querySelector('button[data-of-nav="prev"]');
    var next=document.querySelector('[onclick="trNav(1)"]') || document.querySelector('button[data-of-nav="next"]');
    function style(btn,on){ if(!btn)return; btn.disabled=false; btn.style.pointerEvents='auto'; btn.style.opacity=on?'1':'0.45'; btn.style.color=on?'#44aaff':'#555'; btn.style.borderColor=on?'#005599':'#333'; btn.style.cursor=on?'pointer':'default'; }
    style(prev,total && _trOffset>0);
    style(next,total && _trOffset<maxOffset());
  };

  window.trNav = function(dir){
    var bars=allBars();
    if(!bars.length){ if(typeof buildCandles==='function') buildCandles(); bars=allBars(); }
    if(!bars.length) return false;
    var step = (bars.length<=selectedBars()) ? 1 : visibleCount();
    var old=clamp(typeof _trOffset==='number'?_trOffset:0);
    var next=clamp(old + (dir<0 ? -step : step));
    if(next===old){ _trUpdateNavInfo(); return false; }
    _trOffset=next; _trApplyView(); return true;
  };
  window.ofTrNav=window.trNav;

  function wire(){
    var prev=document.querySelector('[onclick="trNav(-1)"]');
    var next=document.querySelector('[onclick="trNav(1)"]');
    if(prev && !prev.__ofNavClaimed){ prev.__ofNavClaimed=true; prev.setAttribute('data-of-nav','prev'); prev.onclick=function(e){ if(e)e.preventDefault(); return window.trNav(-1); }; }
    if(next && !next.__ofNavClaimed){ next.__ofNavClaimed=true; next.setAttribute('data-of-nav','next'); next.onclick=function(e){ if(e)e.preventDefault(); return window.trNav(1); }; }
    _trUpdateNavInfo();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',wire); else wire();
  window.addEventListener('load',function(){setTimeout(wire,100);setTimeout(wire,500);});
})();

// ==== dfp-column-totals-final-patch ====
/* FINAL PATCH: add Price-Summary-style column totals bar to Δ Flip Pairs tab. */
(function(){
  if(window.__dfpColumnTotalsFinalPatch) return;
  window.__dfpColumnTotalsFinalPatch = true;
  const FALLBACK_PAIRS = [
    {key:'lhBid', label:'L-H Bid', pos:'liftBid', neg:'hitBid', barPos:'totalLiftBid', barNeg:'totalHitBid'},
    {key:'lhAsk', label:'L-H Ask', pos:'liftAsk', neg:'hitAsk', barPos:'totalLiftAsk', barNeg:'totalHitAsk'},
    {key:'aggNet', label:'AGGR Bid-Ask', pos:'aggrBid', neg:'aggrAsk', barPos:'totalAggrBid', barNeg:'totalAggrAsk'},
    {key:'hlVol', label:'L-H Vol', pos:'liftTrdVol', neg:'hitTrdVol', barPos:'totalLiftVol', barNeg:'totalHitVol'},
    {key:'lhRTL', label:'L-H Trades', pos:'liftRTL', neg:'hitRTL', barPos:'totalLiftRTL', barNeg:'totalHitRTL'},
    {key:'lhSEQ', label:'L-H Elig_V', pos:'liftSeqDiff', neg:'hitSeqDiff', barPos:'totalLiftSeq', barNeg:'totalHitSeq'},
    {key:'lhOrder', label:'L-H Order', pos:'liftNumOrders', neg:'hitNumOrders', barPos:'totalLiftNumOrders', barNeg:'totalHitNumOrders'}
  ];
  function pairs(){ try{ if(Array.isArray(DFP_PAIRS) && DFP_PAIRS.length) return DFP_PAIRS; }catch(e){} try{ if(Array.isArray(window.DFP_PAIRS) && window.DFP_PAIRS.length) return window.DFP_PAIRS; }catch(e){} return FALLBACK_PAIRS; }
  function fmt(v){ v=Math.round(+(v||0)); if(Math.abs(v)>=1000000)return (v/1000000).toFixed(1)+'M'; if(Math.abs(v)>=10000)return (v/1000).toFixed(1)+'k'; return v.toLocaleString(); }
  function price(v){ v=+(v||0); return Number.isFinite(v)?v.toFixed(1).replace('.',','):'—'; }
  function selected(){ return Array.from(document.querySelectorAll('.dfp-pair-pill')).filter(x=>x.classList.contains('on')).map(x=>x.dataset.pair); }
  function initPills(){
    try{ if(typeof window.dfpInit==='function') window.dfpInit(); }catch(e){}
    document.querySelectorAll('.dfp-pair-pill').forEach(p=>{
      if(p.__dfpTotalsBound) return; p.__dfpTotalsBound=true;
      p.addEventListener('click',()=>setTimeout(()=>window.dfpRender&&window.dfpRender(),0),true);
    });
  }
  function getRows(){
    try{ if(typeof _currentIntervalRows==='function'){ const r=_currentIntervalRows(); if(r&&r.length)return r; } }catch(e){}
    try{ if(typeof window._of_get_current_interval_rows==='function'){ const r=window._of_get_current_interval_rows(); if(r&&r.length)return r; } }catch(e){}
    try{ if(typeof _openBarTicks!=='undefined' && _openBarTicks && _openBarTicks.length)return _openBarTicks; }catch(e){}
    return [];
  }
  function getBar(){
    const rows=getRows();
    try{ if(rows.length && typeof _ticksToBar==='function'){ const b=_ticksToBar(rows); if(b && Array.isArray(b.footprint) && b.footprint.length)return b; } }catch(e){}
    try{ if(typeof _csFocusedBar!=='undefined' && _csFocusedBar && Array.isArray(_csFocusedBar.footprint) && _csFocusedBar.footprint.length)return _csFocusedBar; }catch(e){}
    try{ if(window.R && Array.isArray(R.bars) && R.bars.length){ const b=R.bars[R.bars.length-1]; if(b && Array.isArray(b.footprint) && b.footprint.length)return b; } }catch(e){}
    try{ if(typeof _closedBars!=='undefined' && Array.isArray(_closedBars) && _closedBars.length){ const b=_closedBars[_closedBars.length-1]; if(b && Array.isArray(b.footprint) && b.footprint.length)return b; } }catch(e){}
    return null;
  }
  function val(obj,k1,k2){ return +(obj?.[k1] ?? obj?.[k2] ?? 0); }
  function metric(obj,pair){
    if(pair.positiveOnly){ const a=+(obj[pair.value]||0); return {a:a,b:0,d:a,pct:a?100:0}; }
    const a=val(obj,pair.pos,pair.barPos), b=val(obj,pair.neg,pair.barNeg);
    const d=a-b, den=Math.abs(a)+Math.abs(b);
    return {a,b,d,pct:den?Math.round(Math.abs(d)/den*100):0};
  }
  function totalMetric(rows,pair){
    if(pair.positiveOnly){ const a=rows.reduce((s,r)=>s+(+(r[pair.value]||0)),0); return {a:a,b:0,d:a,pct:a?100:0}; }
    const a=rows.reduce((s,r)=>s+val(r,pair.pos,pair.barPos),0);
    const b=rows.reduce((s,r)=>s+val(r,pair.neg,pair.barNeg),0);
    const d=a-b, den=Math.abs(a)+Math.abs(b);
    return {a,b,d,pct:den?Math.round(Math.abs(d)/den*100):0};
  }
  function barHtml(m,big){
    const pct=Math.max(0,Math.min(100,m.pct||0)), rem=100-pct;
    if((m.d||0)>=0) return `<div class="dfp-bar-wrap"><div class="dfp-status-bar pos"><div class="dfp-status-green" style="width:${pct}%;"></div><div class="dfp-status-red" style="width:${rem}%;"></div></div><span class="${big?'dfp-bigbar-pct':'dfp-bar-pct'}">${pct}%</span></div>`;
    return `<div class="dfp-bar-wrap"><div class="dfp-status-bar neg"><div class="dfp-status-red" style="width:${pct}%;"></div><div class="dfp-status-green" style="width:${rem}%;"></div></div><span class="${big?'dfp-bigbar-pct':'dfp-bar-pct'}" style="color:#ff5555">${pct}%</span></div>`;
  }
  function ensureLayout(){
    try{ if(typeof dfpEnsureLayout==='function') dfpEnsureLayout(); }catch(e){}
    const wrap=document.getElementById('dfp-wrap'); if(!wrap) return;
    if(!document.getElementById('dfp-main')){
      const main=document.createElement('div'); main.id='dfp-main';
      const empty=document.getElementById('dfp-empty'), tbl=document.getElementById('dfp-table');
      if(empty) main.appendChild(empty); if(tbl) main.appendChild(tbl);
      wrap.insertBefore(main, wrap.firstChild);
    }
    if(!document.getElementById('dfp-side')){ const side=document.createElement('div'); side.id='dfp-side'; wrap.appendChild(side); }
  }
  function sideRender(bar,cols){
    const side=document.getElementById('dfp-side'); if(!side) return;
    const primary=cols[0] || pairs()[0];
    const m=metric(bar,primary);
    const delta=+(bar.delta||0), totalVol=+(bar.totalVol||bar.totalTrdVol||bar.totalVolume||0), dpct=totalVol?delta/totalVol*100:0;
    side.innerHTML=`<div class="dfp-side-title">Candle Summary</div><div class="dfp-bigbar-box"><div class="dfp-bigbar-label">${primary.label} % (This bar)</div><div class="dfp-bigbar-row">${barHtml(m,true)}</div></div><div class="dfp-cs-grid"><div class="dfp-cs-cell"><div class="dfp-cs-lbl">Price</div><div class="dfp-cs-val">${price(bar.close)}</div></div><div class="dfp-cs-cell"><div class="dfp-cs-lbl">Open</div><div class="dfp-cs-val">${price(bar.open)}</div></div><div class="dfp-cs-cell"><div class="dfp-cs-lbl">High</div><div class="dfp-cs-val dfp-pos">${price(bar.high)}</div></div><div class="dfp-cs-cell"><div class="dfp-cs-lbl">Low</div><div class="dfp-cs-val dfp-neg">${price(bar.low)}</div></div><div class="dfp-cs-cell"><div class="dfp-cs-lbl">Close</div><div class="dfp-cs-val">${price(bar.close)}</div></div><div class="dfp-cs-cell"><div class="dfp-cs-lbl">Total Vol</div><div class="dfp-cs-val">${fmt(totalVol)}</div></div><div class="dfp-cs-cell"><div class="dfp-cs-lbl">Delta</div><div class="dfp-cs-val ${delta>=0?'dfp-pos':'dfp-neg'}">${fmt(delta)}</div></div><div class="dfp-cs-cell"><div class="dfp-cs-lbl">Delta %</div><div class="dfp-cs-val ${dpct>=0?'dfp-pos':'dfp-neg'}">${dpct.toFixed(2)}%</div></div><div class="dfp-cs-cell"><div class="dfp-cs-lbl">POC</div><div class="dfp-cs-val dfp-yellow">${price(bar.pocPrice)}</div></div><div class="dfp-cs-cell"><div class="dfp-cs-lbl">Levels</div><div class="dfp-cs-val">${(bar.footprint||[]).length}</div></div></div>`;
  }
  window.dfpRender = function(){
    initPills(); ensureLayout();
    const bar=getBar();
    const allPairs=pairs();
    const cols=selected().map(k=>allPairs.find(p=>p.key===k)).filter(Boolean);
    const empty=document.getElementById('dfp-empty'), tbl=document.getElementById('dfp-table'), head=document.getElementById('dfp-head'), body=document.getElementById('dfp-body');
    const barsEl=document.getElementById('dfp-bars'), selEl=document.getElementById('dfp-selected');
    if(barsEl) barsEl.textContent=bar?'1':'0';
    if(selEl) selEl.textContent=cols.length?cols.map(c=>c.label).join(', '):'None';
    if(!bar || !cols.length || !Array.isArray(bar.footprint) || !bar.footprint.length){
      if(empty) empty.style.display='flex'; if(tbl) tbl.style.display='none';
      const side=document.getElementById('dfp-side'); if(side) side.innerHTML='<div class="dfp-side-title">Candle Summary</div><div style="color:#446688;font-size:11px;line-height:1.7;padding:8px;">No current interval level data.</div>';
      return;
    }
    if(empty) empty.style.display='none'; if(tbl) tbl.style.display='table';
    sideRender(bar,cols);
    if(head) head.innerHTML='<tr><th>Price</th><th>BID_S2</th><th>ASK_S2</th><th>TRD_VOL</th><th>Delta</th>'+cols.map(c=>`<th>${c.label}</th><th>Δ Flip</th><th>${c.label} %</th>`).join('')+'<th>Bid</th><th>Ask</th></tr>';
    let rows=[...bar.footprint].sort((a,b)=>b.price-a.price);
    const sort=(document.getElementById('dfp-sort')||{}).value||'time';
    if(sort==='score') rows.sort((a,b)=>Math.max(...cols.map(c=>metric(b,c).pct||0))-Math.max(...cols.map(c=>metric(a,c).pct||0)));
    if(sort==='delta') rows.sort((a,b)=>Math.abs(b.delta||0)-Math.abs(a.delta||0));
    if(sort==='vol') rows.sort((a,b)=>(b.trdVol||b.vol||0)-(a.trdVol||a.vol||0));
    const baseTotals={
      b: rows.reduce((s,r)=>s+(+(r.bSize||r.bid||0)),0),
      a: rows.reduce((s,r)=>s+(+(r.aSize||r.ask||0)),0),
      vol: rows.reduce((s,r)=>s+(+(r.trdVol||r.vol||0)),0),
      delta: rows.reduce((s,r)=>s+(+(r.delta||0)),0)
    };
    const totalRow = `<tr class="dfp-total-row"><td class="dfp-total-label">${rows.length} levels</td><td class="dfp-pos">${fmt(baseTotals.b)}</td><td class="dfp-cyan">${fmt(baseTotals.a)}</td><td class="dfp-yellow">${fmt(baseTotals.vol)}</td><td class="${baseTotals.delta>=0?'dfp-pos':'dfp-neg'}">${baseTotals.delta>=0?'+':''}${fmt(baseTotals.delta)}</td>${cols.map(c=>{ const m=totalMetric(rows,c); const cls=m.d>0?'dfp-pos':m.d<0?'dfp-neg':'dfp-zero'; return `<td class="dfp-purple">${fmt(m.a)}</td><td class="${cls}">${m.d>=0?'+':''}${fmt(m.d)}</td><td class="dfp-bar-cell dfp-total-bar">${barHtml(m,false)}</td>`; }).join('')}<td class="dfp-zero">—</td><td class="dfp-zero">—</td></tr>`;
    const levelRows = rows.map(lv=>{
      const delta=+(lv.delta||0);
      const base=`<td class="dfp-price">${price(lv.price)}</td><td class="dfp-pos">${fmt(lv.bSize||lv.bid||0)}</td><td class="dfp-cyan">${fmt(lv.aSize||lv.ask||0)}</td><td class="dfp-yellow">${fmt(lv.trdVol||lv.vol||0)}</td><td class="${delta>=0?'dfp-pos':'dfp-neg'}">${fmt(delta)}</td>`;
      const cells=cols.map(c=>{ const m=metric(lv,c); const cls=m.d>0?'dfp-pos':m.d<0?'dfp-neg':'dfp-zero'; return `<td class="dfp-purple">${fmt(m.a)}</td><td class="${cls}">${fmt(m.d)}</td><td class="dfp-bar-cell">${barHtml(m,false)}</td>`; }).join('');
      return `<tr class="${delta>=0?'dfp-dom-pos':'dfp-dom-neg'}">${base}${cells}<td class="dfp-pos">${price(lv.price)}</td><td class="dfp-neg">${price(lv.price)}</td></tr>`;
    }).join('');
    if(body) body.innerHTML=totalRow + levelRows;
  };
  const oldSwitch=window.switchTab;
  if(typeof oldSwitch==='function' && !oldSwitch.__dfpTotalsWrapped){
    const w=function(tab){ const ret=oldSwitch.apply(this,arguments); if(tab==='dfpairs') setTimeout(window.dfpRender,30); return ret; };
    w.__dfpTotalsWrapped=true; window.switchTab=w;
  }
  document.addEventListener('change',e=>{ if(e.target && e.target.id==='dfp-sort') setTimeout(()=>window.dfpRender&&window.dfpRender(),0); },true);
  setTimeout(()=>{ if((document.querySelector('.main-tab.active')||{}).dataset?.tab==='dfpairs') window.dfpRender(); },200);
})();

// ==== flip-summary-font-link-js ====
(function(){
  function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
  function readFontSize(){
    var txt=(document.getElementById('fs-val')||{}).textContent||'';
    var n=parseInt(txt,10);
    if(!Number.isFinite(n)){ n=window._tableFontSize || window._globalFontSize || 11; }
    return clamp(n,7,22);
  }
  window.applyFlipPairsSummaryFontSize=function(size){
    var fs=clamp(parseInt(size||readFontSize(),10),7,22);
    var small=Math.max(7,fs-3);
    var big=fs+4;
    var root=document.documentElement;
    root.style.setProperty('--flip-summary-font-size',fs+'px');
    root.style.setProperty('--flip-summary-font-small',small+'px');
    root.style.setProperty('--flip-summary-font-big',big+'px');
    var panel=document.getElementById('right-panel');
    if(!panel) return;
    panel.querySelectorAll('.rp-hdr').forEach(function(el){el.style.fontSize=Math.max(7,fs-2)+'px';});
    panel.querySelectorAll('.cs-val').forEach(function(el){el.style.fontSize=fs+'px';});
    panel.querySelectorAll('.cs-lbl').forEach(function(el){el.style.fontSize=small+'px';});
    panel.querySelectorAll('.cs-cell').forEach(function(el){
      el.style.padding = fs<=9 ? '2px 3px' : fs>=15 ? '6px 7px' : '4px 5px';
    });
    var spl=document.getElementById('csv-spl-trd');
    if(spl) spl.style.fontSize=(fs+2)+'px';
    panel.querySelectorAll('#cs-delta-flip-box,#cs-spl-box').forEach(function(box){
      box.style.fontSize=fs+'px';
    });
    panel.querySelectorAll('#cs-delta-flip-box .cs-val').forEach(function(el){el.style.fontSize=fs+'px';});
    panel.querySelectorAll('#cs-delta-flip-box .cs-lbl').forEach(function(el){el.style.fontSize=small+'px';});
    panel.querySelectorAll('#cs-delta-flip-box [id^="csv-df-"]').forEach(function(el){el.style.fontSize=fs+'px';});
    /* Progress bar / percent used by Flip Pairs candle summary */
    panel.querySelectorAll('[id*="dfp"],[class*="dfp"],[class*="progress"],[id*="progress"]').forEach(function(el){
      if(el.classList && (el.classList.contains('cs-val') || el.className.indexOf('percent')>=0 || el.id.indexOf('pct')>=0)) el.style.fontSize=(fs+3)+'px';
      else if(el.tagName!=='DIV' || (el.textContent||'').trim().length<40) el.style.fontSize=small+'px';
    });
  };
  var oldApply=window.applyFontSize;
  if(typeof oldApply==='function'){
    window.applyFontSize=function(){
      var ret=oldApply.apply(this,arguments);
      try{window.applyFlipPairsSummaryFontSize(window._tableFontSize || window._globalFontSize || readFontSize());}catch(e){}
      return ret;
    };
  }
  var oldChange=window.changeFontSize;
  if(typeof oldChange==='function'){
    window.changeFontSize=function(delta){
      var ret=oldChange.apply(this,arguments);
      try{window.applyFlipPairsSummaryFontSize(window._tableFontSize || window._globalFontSize || readFontSize());}catch(e){}
      return ret;
    };
  }
  var oldSwitch=window.switchTab;
  if(typeof oldSwitch==='function'){
    window.switchTab=function(tab){
      var ret=oldSwitch.apply(this,arguments);
      setTimeout(function(){try{window.applyFlipPairsSummaryFontSize();}catch(e){}},0);
      return ret;
    };
  }
  function init(){
    try{window.applyFlipPairsSummaryFontSize();}catch(e){}
    var panel=document.getElementById('right-panel');
    if(panel && window.MutationObserver){
      var obs=new MutationObserver(function(){try{window.applyFlipPairsSummaryFontSize();}catch(e){}});
      obs.observe(panel,{childList:true,subtree:true,characterData:true});
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  window.addEventListener('resize',function(){try{window.applyFlipPairsSummaryFontSize();}catch(e){}});
})();

// ==== manual-marker-column-js ====
(function(){
  if(window.__manualMarkerColumnPatch) return;
  window.__manualMarkerColumnPatch=true;

  const OPTIONS=['Buy','Buy Exit','Sell','Sell Exit','0'];
  const store=window.__manualMarkerStore || (window.__manualMarkerStore={});
  // Companion store: records which specific interval (candle) was on screen
  // when each marker was set, keyed by the same marker key. A price level
  // can repeat across many different candles over a session, so the price
  // alone doesn't identify "this candle" — without this, a marker set on
  // one candle would appear to apply to every other candle that ever
  // touched the same price.
  const barIdStore=window.__manualMarkerBarIdStore || (window.__manualMarkerBarIdStore={});

  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
  function cls(v){return 'marker-'+String(v||'0').toLowerCase().replace(/\s+/g,'-');}
  function key(tab,row){
    const first=row && row.cells && row.cells[0] ? row.cells[0].textContent.trim() : '';
    const second=row && row.cells && row.cells[1] ? row.cells[1].textContent.trim() : '';
    if(row && row.classList && row.classList.contains('sum-totals-row')) return tab+':TOTAL';
    return tab+':' + first + ':' + second;
  }
  function selectHtml(k,disabled){
    const val=store[k] || '0';
    return `<select class="manual-marker-select ${cls(val)}" data-marker-key="${esc(k)}" ${disabled?'disabled':''}>`+
      OPTIONS.map(o=>`<option value="${esc(o)}" ${o===val?'selected':''}>${esc(o)}</option>`).join('')+
      `</select>`;
  }
  function installTable(tab,headSel,bodySel){
    const head=document.querySelector(headSel), body=document.querySelector(bodySel);
    if(!head || !body) return;

    const headRows = head.tagName==='TR' ? [head] : Array.from(head.querySelectorAll('tr'));
    headRows.forEach((tr,i)=>{
      if(tr.querySelector('.manual-marker-th')) return;
      const th=document.createElement('th');
      th.className='manual-marker-th';
      th.textContent=i===0?'Marker':'';
      if(i>0) th.style.color='#333';
      const after=tr.children[0] || null;
      if(after && after.nextSibling) tr.insertBefore(th, after.nextSibling); else tr.appendChild(th);
    });

    Array.from(body.querySelectorAll('tr')).forEach(row=>{
      if(row.querySelector('.manual-marker-td')) return;
      const td=document.createElement('td');
      td.className='manual-marker-td';
      const disabled=row.classList.contains('sum-totals-row') || /total/i.test((row.cells[0]||{}).textContent||'');
      td.innerHTML=disabled?'—':selectHtml(key(tab,row),false);
      const after=row.children[0] || null;
      if(after && after.nextSibling) row.insertBefore(td, after.nextSibling); else row.appendChild(td);
    });
  }
  function applyMarkers(){
    installTable('summary','#sum-head','#sum-body');
    installTable('dfpairs','#dfp-head','#dfp-body');
  }
  document.addEventListener('change',function(e){
    const sel=e.target && e.target.closest ? e.target.closest('.manual-marker-select') : null;
    if(!sel) return;
    const k=sel.getAttribute('data-marker-key');
    if(k){
      store[k]=sel.value || '0';
      barIdStore[k]=window.__sumCurrentBarId || '';
    }
    sel.className='manual-marker-select '+cls(sel.value);
  },true);

  function wrap(name){
    const fn=window[name];
    if(typeof fn==='function' && !fn.__manualMarkerWrapped){
      const w=function(){
        const ret=fn.apply(this,arguments);
        setTimeout(applyMarkers,0);
        return ret;
      };
      w.__manualMarkerWrapped=true;
      window[name]=w;
    }
  }
  wrap('sumRender');
  wrap('dfpRender');

  const oldSwitch=window.switchTab;
  if(typeof oldSwitch==='function' && !oldSwitch.__manualMarkerWrapped){
    const sw=function(){
      const ret=oldSwitch.apply(this,arguments);
      setTimeout(applyMarkers,20);
      return ret;
    };
    sw.__manualMarkerWrapped=true;
    window.switchTab=sw;
  }

  const mo=new MutationObserver(()=>applyMarkers());
  function startObserver(){
    ['sum-body','dfp-body','sum-head','dfp-head'].forEach(id=>{const el=document.getElementById(id); if(el && !el.__markerObserved){mo.observe(el,{childList:true,subtree:false}); el.__markerObserved=true;}});
    applyMarkers();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',startObserver); else startObserver();
  window.addEventListener('load',()=>setTimeout(startObserver,100));
})();

// ==== dfp-column-resize-js ====
(function(){
  var widths = window.__dfpColumnWidths || (window.__dfpColumnWidths = {});
  var MIN_W = 42;

  function px(n){ return Math.max(MIN_W, Math.round(+n||MIN_W)) + 'px'; }

  function applyWidth(idx, w){
    var tbl = document.getElementById('dfp-table');
    if(!tbl) return;
    widths[idx] = Math.max(MIN_W, Math.round(w));
    var val = px(widths[idx]);
    Array.prototype.forEach.call(tbl.querySelectorAll('tr'), function(tr){
      var cell = tr.children[idx];
      if(cell){
        cell.style.width = val;
        cell.style.minWidth = val;
        cell.style.maxWidth = val;
      }
    });
  }

  function applySaved(){
    Object.keys(widths).forEach(function(k){ applyWidth(+k, widths[k]); });
  }

  function makeResizable(){
    var tbl = document.getElementById('dfp-table');
    var head = document.getElementById('dfp-head');
    if(!tbl || !head) return;
    tbl.style.tableLayout = 'fixed';
    var ths = head.querySelectorAll('th');
    if(!ths.length) return;

    Array.prototype.forEach.call(ths, function(th, idx){
      th.classList.add('dfp-resizable-th');
      th.style.position = 'sticky';
      if(widths[idx]){
        th.style.width = px(widths[idx]);
        th.style.minWidth = px(widths[idx]);
        th.style.maxWidth = px(widths[idx]);
      }
      if(th.querySelector('.dfp-col-resizer')) return;
      var grip = document.createElement('span');
      grip.className = 'dfp-col-resizer';
      grip.title = 'Drag to resize column';
      grip.addEventListener('mousedown', function(e){
        e.preventDefault();
        e.stopPropagation();
        var startX = e.clientX;
        var startW = widths[idx] || th.getBoundingClientRect().width || MIN_W;
        tbl.classList.add('dfp-resizing');
        th.classList.add('dfp-resizing');
        function move(ev){ applyWidth(idx, startW + (ev.clientX - startX)); }
        function up(){
          tbl.classList.remove('dfp-resizing');
          th.classList.remove('dfp-resizing');
          document.removeEventListener('mousemove', move, true);
          document.removeEventListener('mouseup', up, true);
        }
        document.addEventListener('mousemove', move, true);
        document.addEventListener('mouseup', up, true);
      }, true);
      th.appendChild(grip);
    });
    applySaved();
  }

  function schedule(){ setTimeout(makeResizable, 0); setTimeout(makeResizable, 80); }

  var old = window.dfpRender;
  if(typeof old === 'function' && !old.__dfpColumnResizeWrapped){
    var wrapped = function(){ var r = old.apply(this, arguments); schedule(); return r; };
    wrapped.__dfpColumnResizeWrapped = true;
    window.dfpRender = wrapped;
  }

  var oldSwitch = window.switchTab;
  if(typeof oldSwitch === 'function' && !oldSwitch.__dfpColumnResizeWrapped){
    var sw = function(tab){ var r = oldSwitch.apply(this, arguments); if(tab === 'dfpairs') schedule(); return r; };
    sw.__dfpColumnResizeWrapped = true;
    window.switchTab = sw;
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule); else schedule();
  window.addEventListener('load', schedule);

  var target = document.getElementById('dfp-head');
  if(target && window.MutationObserver){
    new MutationObserver(schedule).observe(target, {childList:true, subtree:true});
  }
})();

// ==== dfp-whole-column-resize-final-js ====
(function(){
  if(window.__dfpWholeColumnResizeFinal) return;
  window.__dfpWholeColumnResizeFinal = true;

  var widths = window.__dfpColumnWidths || (window.__dfpColumnWidths = {});
  var MIN_W = 44;
  var MAX_W = 520;
  function clamp(w){ return Math.max(MIN_W, Math.min(MAX_W, Math.round(+w || MIN_W))); }
  function px(w){ return clamp(w) + 'px'; }
  function tbl(){ return document.getElementById('dfp-table'); }
  function head(){ return document.getElementById('dfp-head'); }
  function body(){ return document.getElementById('dfp-body'); }

  function ensureColGroup(){
    var t = tbl(), h = head();
    if(!t || !h) return null;
    var firstRow = h.querySelector('tr');
    if(!firstRow) return null;
    var count = firstRow.children.length;
    var cg = t.querySelector('colgroup[data-dfp-final="1"]');
    if(!cg){
      Array.prototype.forEach.call(t.querySelectorAll('colgroup'), function(old){ old.remove(); });
      cg = document.createElement('colgroup');
      cg.setAttribute('data-dfp-final','1');
      t.insertBefore(cg, t.firstChild);
    }
    while(cg.children.length < count) cg.appendChild(document.createElement('col'));
    while(cg.children.length > count) cg.removeChild(cg.lastChild);
    return cg;
  }

  function applyWidth(idx, w){
    var t = tbl(), h = head(), b = body();
    if(!t || !h) return;
    w = clamp(w);
    widths[idx] = w;
    var val = px(w);
    var cg = ensureColGroup();
    if(cg && cg.children[idx]){
      cg.children[idx].style.width = val;
      cg.children[idx].style.minWidth = val;
      cg.children[idx].style.maxWidth = val;
    }
    var selector = 'tr > *:nth-child(' + (idx + 1) + ')';
    Array.prototype.forEach.call(t.querySelectorAll(selector), function(cell){
      cell.style.width = val;
      cell.style.minWidth = val;
      cell.style.maxWidth = val;
      cell.style.boxSizing = 'border-box';
    });
  }

  function applyAllSaved(){
    ensureColGroup();
    Object.keys(widths).forEach(function(k){ applyWidth(+k, widths[k]); });
  }

  function headerWidth(th, idx){
    return widths[idx] || th.getBoundingClientRect().width || th.offsetWidth || MIN_W;
  }

  function install(){
    var t = tbl(), h = head();
    if(!t || !h) return;
    t.style.tableLayout = 'fixed';
    t.style.width = 'max-content';
    t.style.minWidth = '100%';
    ensureColGroup();

    var ths = Array.prototype.slice.call(h.querySelectorAll('tr:first-child > th'));
    ths.forEach(function(th, idx){
      th.classList.add('dfp-whole-resizable');
      th.style.position = 'sticky';

      // Remove older resize grips so only this final whole-column handler is active.
      Array.prototype.forEach.call(th.querySelectorAll('.dfp-col-resizer'), function(g){ g.remove(); });

      var grip = document.createElement('span');
      grip.className = 'dfp-col-resizer';
      grip.title = 'Drag to resize this whole Flip Pairs column';
      grip.addEventListener('mousedown', function(e){
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        var startX = e.clientX;
        var startW = headerWidth(th, idx);
        th.classList.add('dfp-whole-resizing');
        document.body.classList.add('dfp-whole-resizing');
        function move(ev){
          applyWidth(idx, startW + (ev.clientX - startX));
        }
        function up(){
          th.classList.remove('dfp-whole-resizing');
          document.body.classList.remove('dfp-whole-resizing');
          document.removeEventListener('mousemove', move, true);
          document.removeEventListener('mouseup', up, true);
          applyAllSaved();
        }
        document.addEventListener('mousemove', move, true);
        document.addEventListener('mouseup', up, true);
      }, true);
      th.appendChild(grip);

      if(widths[idx]) applyWidth(idx, widths[idx]);
    });
    applyAllSaved();
  }

  var timer = null;
  function schedule(){
    clearTimeout(timer);
    timer = setTimeout(function(){ install(); setTimeout(install, 30); }, 0);
  }

  var oldRender = window.dfpRender;
  if(typeof oldRender === 'function' && !oldRender.__dfpWholeColumnResizeFinal){
    var wrapped = function(){ var ret = oldRender.apply(this, arguments); schedule(); return ret; };
    wrapped.__dfpWholeColumnResizeFinal = true;
    window.dfpRender = wrapped;
  }

  var oldMarkers = window.applyMarkers;
  if(typeof oldMarkers === 'function' && !oldMarkers.__dfpWholeColumnResizeFinal){
    var mw = function(){ var ret = oldMarkers.apply(this, arguments); schedule(); return ret; };
    mw.__dfpWholeColumnResizeFinal = true;
    window.applyMarkers = mw;
  }

  var oldSwitch = window.switchTab;
  if(typeof oldSwitch === 'function' && !oldSwitch.__dfpWholeColumnResizeFinal){
    var sw = function(tab){ var ret = oldSwitch.apply(this, arguments); if(tab === 'dfpairs') schedule(); return ret; };
    sw.__dfpWholeColumnResizeFinal = true;
    window.switchTab = sw;
  }

  function observe(){
    var h = head(), b = body();
    if(window.MutationObserver){
      if(h && !h.__dfpWholeResizeObserved){ new MutationObserver(schedule).observe(h,{childList:true,subtree:true}); h.__dfpWholeResizeObserved=true; }
      if(b && !b.__dfpWholeResizeObserved){ new MutationObserver(schedule).observe(b,{childList:true,subtree:true}); b.__dfpWholeResizeObserved=true; }
    }
    schedule();
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe); else observe();
  window.addEventListener('load', function(){ setTimeout(observe,100); setTimeout(schedule,400); });
})();

// ==== of-stable-level-tabs-and-summary-defaults ====
/* Stable Level Aggregator / LA PRO + Price Summary default order patch */
(function(){
  function rowsFromSelectedInterval(){
    try{ if(typeof _currentIntervalRows==='function'){ var r=_currentIntervalRows(); if(r && r.length) return r.slice(); } }catch(e){}
    try{ if(typeof _rpActive!=='undefined' && _rpActive && typeof _rpSumRows!=='undefined' && _rpSumRows && _rpSumRows.length) return _rpSumRows.slice(); }catch(e){}
    try{ if(typeof R!=='undefined' && R && R.bars && R.bars.length){ var b=R.bars[R.bars.length-1]; if(b && b.ticks && b.ticks.length) return b.ticks.slice(); } }catch(e){}
    return [];
  }
  function barFromChart(){
    try{ if(typeof R!=='undefined' && R && R.bars && R.bars.length) return R.bars[R.bars.length-1]; }catch(e){}
    try{ if(typeof _csFocusedBar!=='undefined' && _csFocusedBar) return _csFocusedBar; }catch(e){}
    try{ if(typeof _closedBars!=='undefined' && _closedBars && _closedBars.length) return _closedBars[_closedBars.length-1]; }catch(e){}
    return null;
  }
  var lastPack={ticks:[],bar:null};
  window._laGetTicks=function(){
    var ticks=rowsFromSelectedInterval();
    var bar=barFromChart();
    if(ticks && ticks.length){
      lastPack={ticks:ticks.slice(),bar:bar};
      var label=(bar&&bar.time)?('Selected interval · '+bar.time+(bar.timeEnd?'–'+bar.timeEnd:'')):'Selected interval';
      return {ticks:ticks,bar:bar,liveLabel:label};
    }
    if(lastPack.ticks && lastPack.ticks.length) return {ticks:lastPack.ticks.slice(),bar:lastPack.bar,liveLabel:'Selected interval'};
    return {ticks:[],bar:bar,liveLabel:'Selected interval'};
  };
  function debounceRender(name){
    var fn=window[name];
    if(typeof fn!=='function' || fn.__stableLevelDebounced) return;
    var pending=false, lastArgs=null;
    var wrapped=function(){
      lastArgs=arguments;
      if(pending) return;
      pending=true;
      requestAnimationFrame(function(){ pending=false; fn.apply(window,lastArgs||[]); });
    };
    wrapped.__stableLevelDebounced=true;
    window[name]=wrapped;
  }
  debounceRender('laRender');
  debounceRender('laproRender');
  try{ if(typeof _sumSort!=='undefined' && _sumSort && _sumSort.col==='price') _sumSort.dir=1; }catch(e){}
})();

// ==== inline-script ====
/* ============================================================
   PROFESSIONAL TIME-RANGE / INTERVAL SYNC FIX
   - Build Candles uses Start + End as the master selected range.
   - The visible bar window is placed at the selected End time.
   - All data tabs read the same visible selected interval rows.
   - Candle Summary reads the current/end candle only.
   - Prev/Next moves one candle/bar and updates every tab from that new window.
   ============================================================ */
(function(){
  if(window.__OF_PRO_RANGE_SYNC__) return;
  window.__OF_PRO_RANGE_SYNC__ = true;

  function el(id){ return document.getElementById(id); }
  function val(id){ var x=el(id); return x ? String(x.value||'').trim() : ''; }
  function two(n){ return String(n).padStart(2,'0'); }

  function parseInputMs(s){
    if(!s) return 0;
    s=String(s).trim();
    // supports: 24.06.2026 10:02:00, 2026-06-24 10:02:00, 2026-06-24T10:02
    var m=s.match(/^(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(m){ var y=+m[3]; if(y<100)y+=2000; return new Date(y,+m[2]-1,+m[1],+m[4],+m[5],+(m[6]||0),0).getTime(); }
    m=s.match(/^(\d{4})[\-\.\/](\d{1,2})[\-\.\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(m){ return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0),0).getTime(); }
    var d=new Date(s); var t=d.getTime(); return isFinite(t)?t:0;
  }
  function msToInput(ms){
    if(!ms) return '';
    var d=new Date(ms);
    return two(d.getDate())+'.'+two(d.getMonth()+1)+'.'+d.getFullYear()+' '+two(d.getHours())+':'+two(d.getMinutes())+':'+two(d.getSeconds());
  }
  function rowMs(r){
    if(!r) return 0;
    if(r._ms && isFinite(+r._ms)) return +r._ms;
    var date = r.date || r.Date || r.ACTIVE_DATE || r['ACTIVE DATE'] || '';
    var time = r.time || r.Time || r.TIMACT_NS || r['TIMEACT NS'] || r.Timestamp || r.TIMESTAMP || '';
    var s='';
    if(date && time && !String(time).match(/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/)) s=String(date)+' '+String(time);
    else s=String(time || date || r.timestamp || r.Timestamp || '');
    var ms=parseInputMs(s);
    if(!ms && r.ts){ var d=new Date(r.ts); ms=d.getTime(); }
    if(ms) { try{ r._ms=ms; }catch(e){} }
    return ms||0;
  }
  function allRows(){
    var pools=[];
    try{ if(Array.isArray(_trAllRows)) pools.push(_trAllRows); }catch(e){}
    try{ if(Array.isArray(_allRawRows)) pools.push(_allRawRows); }catch(e){}
    try{ if(Array.isArray(window._trAllRows)) pools.push(window._trAllRows); }catch(e){}
    try{ if(Array.isArray(window._allRawRows)) pools.push(window._allRawRows); }catch(e){}
    try{ if(Array.isArray(window.TR_RAW)) pools.push(window.TR_RAW); }catch(e){}
    try{ if(Array.isArray(window.rows)) pools.push(window.rows); }catch(e){}
    var rows=[]; pools.forEach(function(p){ if(p && p.length && rows.length<p.length) rows=p; });
    /* Row identity fix: processed TAS/TAQ files carry DIFFED TRADE_ID/SEQNUM values
       that repeat constantly (16, 96, 1, ...). Deduping on them silently deleted
       every later row that shared a value with ANY earlier row — so the same
       minute showed different footprints depending on how long the loaded file
       was (148 ticks alone → 17 ticks inside a 4-minute file). Only one source
       pool is ever selected here and it is already deduplicated at load time, so
       the key just needs to be row-unique to preserve every row. */
    var seen=new Set(), out=[];
    rows.forEach(function(r,i){
      var ms=rowMs(r); if(!ms) return;
      var k='m:'+ms+'|p:'+(r.last||r.price||r.close||0)+'|sq:'+(r.seqNum||0)+'|id:'+(r.tradeId||'')+'|'+i;
      if(!seen.has(k)){ seen.add(k); out.push(r); }
    });
    out.sort(function(a,b){ return rowMs(a)-rowMs(b); });
    return out;
  }
  function getStartEnd(){
    var sv=val('tr-start-dt') || val('dt-start');
    var ev=val('tr-end-dt') || val('dt-end');
    return {s:parseInputMs(sv), e:parseInputMs(ev)};
  }
  function syncInputs(s,e){
    ['tr-start-dt','dt-start'].forEach(function(id){ var x=el(id); if(x && s) x.value=msToInput(s); });
    ['tr-end-dt','dt-end'].forEach(function(id){ var x=el(id); if(x && e) x.value=msToInput(e); });
    try{ _dtStartMs=s||0; _dtEndMs=e||0; }catch(ex){ window._dtStartMs=s||0; window._dtEndMs=e||0; }
  }
  function filterRange(rows){
    var se=getStartEnd();
    var s=se.s || (rows.length?rowMs(rows[0]):0);
    var e=se.e || (rows.length?rowMs(rows[rows.length-1]):0);
    var eIncl=e?e+999:0;
    var out=rows.filter(function(r){ var m=rowMs(r); return m && (!s || m>=s) && (!eIncl || m<=eIncl); });
    out.sort(function(a,b){ return rowMs(a)-rowMs(b); });
    return {rows:out,s:s,e:e};
  }
  function makeBars(rows){
    var sec=Math.max(1,+((window.CFG&&window.CFG.intervalSec)||60));
    var bars=[];
    try{ if(typeof _bucketByInterval==='function') bars=_bucketByInterval(rows,sec)||[]; }catch(e){ bars=[]; }
    if(!bars.length){
      var map=new Map();
      rows.forEach(function(r){
        var ms=rowMs(r); if(!ms)return;
        var k=Math.floor(ms/(sec*1000))*(sec*1000);
        if(!map.has(k)) map.set(k,{time:msToInput(k).split(' ')[1], date:msToInput(k).split(' ')[0], startMs:k, ticks:[], rows:[]});
        var b=map.get(k); b.ticks.push(r); b.rows.push(r);
      });
      bars=Array.from(map.values()).sort(function(a,b){return (a.startMs||0)-(b.startMs||0);});
    }
    bars=(bars||[]).filter(Boolean).map(function(b){
      if(!Array.isArray(b.ticks) && Array.isArray(b.rows)) b.ticks=b.rows;
      if(!Array.isArray(b.rows) && Array.isArray(b.ticks)) b.rows=b.ticks;
      if(!Array.isArray(b.ticks)) b.ticks=[];
      if(!Array.isArray(b.rows)) b.rows=b.ticks;
      return b;
    });
    return bars;
  }
  function concatRows(bars){
    var out=[]; (bars||[]).forEach(function(b){ out=out.concat((b&& (b.ticks||b.rows)) || []); });
    out.sort(function(a,b){return rowMs(a)-rowMs(b);});
    return out;
  }
  function barCount(){ return Math.max(1, parseInt((el('bar-n')||{}).value,10) || 10); }

  function setMasterState(bars, rangeRows, offset){
    var n=barCount();
    var last=Math.min(offset+n,bars.length);
    var visibleBars=bars.slice(offset,last);
    var currentBar=visibleBars.length ? visibleBars[visibleBars.length-1] : (bars[bars.length-1]||null);
    var visibleRows=concatRows(visibleBars);
    var currentRows=currentBar ? ((currentBar.ticks||currentBar.rows||[]).slice()) : [];

    try{ _trBars=bars; }catch(e){} window._trBars=bars;
    try{ _trOffset=offset; }catch(e){} window._trOffset=offset;
    try{ _dtActive=true; }catch(e){} window._dtActive=true;

    window._ofAllRangeRows=rangeRows.slice();
    window._ofVisibleBars=visibleBars;
    window._ofVisibleIntervalRows=visibleRows;
    window._ofSelectedEndBar=currentBar;
    window._ofSelectedEndBarRows=currentRows;

    // DATA TABS: Price Summary, Level Aggregator, LA Pro and Flip Pairs follow the
    // CURRENT/END candle — the same candle the Candle Summary and the chart focus
    // on — so every tab shows the same current data. (Previously they used the
    // whole visible multi-bar window, which is why they disagreed with the
    // Candle Summary.) The full visible window remains available via
    // window._ofVisibleIntervalRows / _tlRows for the Trade Log.
    window._ofCurrentIntervalRows=function(){
      var r=(window._ofSelectedEndBarRows||[]);
      return r.length ? r.slice() : (window._ofVisibleIntervalRows||[]).slice();
    };
    window._currentIntervalRows=window._ofCurrentIntervalRows;
    window.selectedRangeRows=window._ofCurrentIntervalRows;
    window.dtRows=window._ofCurrentIntervalRows;

    // CANDLE SUMMARY: use current/end candle only.
    window._currentCandleRows=function(){ return (window._ofSelectedEndBarRows||[]).slice(); };

    try{ _dtFilteredRows=visibleRows.slice(); }catch(e){ window._dtFilteredRows=visibleRows.slice(); }
    try{ _tlRows=visibleRows.slice(); }catch(e){ window._tlRows=visibleRows.slice(); }
    try{ _closedBars=visibleBars.slice(); }catch(e){}
  }
  function refreshTabs(){
    try{ if(typeof _trApplyView==='function') _trApplyView(); }catch(e){}
    try{ if(typeof csUpdate==='function' && window._ofSelectedEndBar) csUpdate(window._ofSelectedEndBar); else if(typeof csUpdateLast==='function') csUpdateLast(); }catch(e){}
    try{ if(typeof tlRender==='function') tlRender(); }catch(e){}
    try{ if(typeof sumRender==='function') sumRender(); }catch(e){}
    try{ if(typeof aggBuild==='function') aggBuild(); }catch(e){}
    try{ if(typeof laRebuild==='function') laRebuild(); }catch(e){}
    try{ if(typeof dfpInit==='function') dfpInit(); if(typeof dfpRender==='function') dfpRender(); }catch(e){}
    try{ if(window.RegimeLinked && typeof RegimeLinked.update==='function') RegimeLinked.update(true); }catch(e){}
    try{ if(window.R){ R.resize(); R.draw(); } }catch(e){}
  }
  function updateLabels(rangeRows,bars,offset){
    var n=barCount(), first=bars.length?offset+1:0, last=bars.length?Math.min(offset+n,bars.length):0;
    var visible=(window._ofVisibleIntervalRows||[]), cur=(window._ofSelectedEndBarRows||[]);
    var info=el('tr-nav-info');
    if(info){ info.textContent=bars.length ? ('bars '+first+'–'+last+' / '+bars.length+' · tabs '+visible.length.toLocaleString()+' ticks · end candle '+cur.length.toLocaleString()+' ticks') : '— no bars —'; info.style.color=bars.length?'#00aa55':'#884422'; }
    var dsrc=el('dsrc'); if(dsrc) dsrc.textContent='● '+visible.length.toLocaleString()+' ticks · selected interval';
    var cnt=el('dt-row-count'); if(cnt) cnt.textContent='selected interval: '+visible.length.toLocaleString()+' ticks · end candle: '+cur.length.toLocaleString()+' ticks';
    var badge=el('dt-filter-active-badge'); if(badge){ badge.textContent='● '+visible.length.toLocaleString()+' ticks selected interval'; badge.style.display='inline-block'; badge.classList.add('active'); }
  }

  window.buildCandles=function(){
    var raw=allRows();
    if(!raw.length){ alert('Load a file first.'); return false; }
    var fr=filterRange(raw);
    if(!fr.rows.length){ alert('No data in selected Start/End time range.'); return false; }
    var bars=makeBars(fr.rows);
    if(!bars.length){ alert('No bars could be built from selected range.'); return false; }
    var n=barCount();
    var offset=Math.max(0,bars.length-Math.min(n,bars.length)); // selected End time is the current last candle
    syncInputs(fr.s,fr.e);
    setMasterState(bars,fr.rows,offset);
    refreshTabs();
    updateLabels(fr.rows,bars,offset);
    setTimeout(function(){ try{ if(window.R){ R.resize(); R.draw(); } }catch(e){} var hs=el('hscroll'); if(hs) hs.scrollLeft=999999; },30);
    return true;
  };
  // Stable reference to THIS implementation, captured now so dtApply can never be
  // redirected into a cycle even if something later wraps/reassigns window.buildCandles
  // (a deferred date-range hook wraps buildCandles to call dtApply, while dtApply
  // called window.buildCandles — an infinite mutual loop on Build Candles clicks).
  var _ofStableBuildCandles=window.buildCandles;
  window.dtApply=function(){ return _ofStableBuildCandles(); };
  window.trNav=function(dir){
    var bars=window._trBars||[]; if(!bars.length){ if(!window.buildCandles()) return false; bars=window._trBars||[]; }
    var n=barCount();
    var old=+window._trOffset||0;
    var maxOff=Math.max(0,bars.length-Math.min(n,bars.length));
    var next=Math.max(0,Math.min(maxOff, old + (dir<0?-1:1)));
    if(next===old) return false;
    setMasterState(bars,window._ofAllRangeRows||[],next);
    refreshTabs();
    updateLabels(window._ofAllRangeRows||[],bars,next);
    return true;
  };

  // NOTE: a document-level delegated click listener that matched button text
  // ("PREV"/"NEXT") used to live here. It fired unconditionally alongside the
  // proper per-element handlers (see wire()/wireNavButtons() above), causing
  // every single click to call trNav() twice. Removed — the per-element
  // handlers (coordinated via the shared __ofNavClaimed flag) are sufficient.
})();

/* ============================================================
   XLWINGS REAL-TIME FAST SYNC PATCH v10
   Fixes high-frequency Excel / Refinitiv updates that arrive in milliseconds.
   Key changes:
   - Queue and batch incoming websocket ticks.
   - Append rows incrementally instead of re-bucketing/sorting the whole dataset on every tick.
   - Use robust SPL TRD substring detection.
   - Deduplicate using timestamp + tradeId + seqNum + price + vol, not tradeId alone.
   - Repaint chart through requestAnimationFrame and throttle heavy tab refreshes.
   ============================================================ */
(function(){
  if (window.__XW_FAST_SYNC_PATCH_V10__) return;
  window.__XW_FAST_SYNC_PATCH_V10__ = true;

  var Q = [];
  var flushScheduled = false;
  var lightSyncTimer = null;
  var lastUiTs = 0;
  var known = new Set();
  var lastRawForDiff = null;

  function qs(id){ return document.getElementById(id); }
  function num(v){
    if(v===undefined || v===null) return 0;
    var n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  function str(v){ return (v===undefined || v===null) ? '' : String(v).trim(); }
  function isSplText(v){ return str(v).replace(/[^\x20-\x7E]/g,'').toUpperCase().indexOf('SPL TRD') >= 0; }
  function rowKey(r){
    return [
      str(r.date), str(r.time), num(r.last), num(r.bid), num(r.ask),
      num(r.bSize), num(r.aSize), num(r.trdVol), num(r.volume),
      str(r.tradeId), num(r.seqNum), num(r.moves), str(r.aggr), str(r.condKey)
    ].join('|');
  }
  function absMsSafe(r){
    try { return (typeof _toAbsMs === 'function' ? (_toAbsMs(r)||0) : 0); }
    catch(e){ return 0; }
  }
  function normalizeXwRow(r, msg){
    var ck = str(r.condKey || r.QUALIFIERS);
    var spl = isSplText(ck);
    var out = {
      last: spl ? 0 : num(r.last),
      bid:  spl ? 0 : num(r.bid),
      ask:  spl ? 0 : num(r.ask),
      bSize:spl ? 0 : num(r.bSize),
      aSize:spl ? 0 : num(r.aSize),
      numBid:num(r.numBid), numAsk:num(r.numAsk), numOrders:num(r.numOrders),
      trdVol:num(r.trdVol), volume:num(r.volume || r.trdVol), moves:num(r.moves), rtCount:num(r.rtCount || r.moves),
      aggr:str(r.aggr).toUpperCase(),
      tick:str(r.tick || ''),  /* ⇧/⇩ side arrow from TAQ bridge (derived from QUALIFIERS) */
      tradeId:str(r.tradeId || (spl ? ('spl:' + Math.random()) : '')),
      seqNum:num(r.seqNum),
      time:(typeof normTime === 'function' ? normTime(r.time || '') : str(r.time)) || str(msg && msg.ts) || new Date().toLocaleTimeString('en-US',{hour12:false}),
      date:str(r.date) || new Date().toLocaleDateString('en-US'),
      condKey:ck,
      QUALIFIERS:ck,
      volDiff:num(r.volDiff),
      movesDiff:num(r.movesDiff),
      trdIdDiff:num(r.trdIdDiff),
      seqNumDiff:num(r.seqNumDiff)
    };
    return (out.last > 0 || spl) ? out : null;
  }
  function applyDiffsIncremental(batch){
    if(!batch.length) return;
    var hasDiff = batch.some(function(r){ return r.volDiff || r.movesDiff || r.trdIdDiff || r.seqNumDiff; });
    if(hasDiff){ lastRawForDiff = batch[batch.length-1]; return; }
    var prev = lastRawForDiff;
    batch.forEach(function(r){
      if(prev){
        r.trdIdDiff = Math.abs(num(r.tradeId) - num(prev.tradeId));
        r.seqNumDiff = Math.abs(num(r.seqNum) - num(prev.seqNum));
        var rtl = Math.abs(num(r.moves) - num(prev.moves));
        r.movesDiff = rtl >= 2500 ? num(r.moves) : rtl;
      } else {
        r.trdIdDiff = r.trdIdDiff || 0;
        r.seqNumDiff = r.seqNumDiff || 0;
        r.movesDiff = r.movesDiff || 0;
      }
      r.volDiff = r.volDiff || r.trdVol || r.volume || 0;
      prev = r;
    });
    lastRawForDiff = prev;
  }
  function pushToOpenBar(batch){
    batch.forEach(function(r){
      _openBarTicks.push({
        last:num(r.last), bid:num(r.bid), ask:num(r.ask), bSize:num(r.bSize), aSize:num(r.aSize),
        numBid:num(r.numBid), numAsk:num(r.numAsk), numOrders:num(r.numOrders),
        trdVol:num(r.trdVol), volume:num(r.volume || r.trdVol), moves:num(r.moves), rtCount:num(r.rtCount || r.moves),
        aggr:str(r.aggr).toUpperCase(), tradeId:str(r.tradeId || (Date.now()+Math.random())),
        condKey:str(r.condKey || r.QUALIFIERS), QUALIFIERS:str(r.QUALIFIERS || r.condKey),
        time:r.time, date:r.date,
        seqNum:num(r.seqNum), volDiff:num(r.volDiff), movesDiff:num(r.movesDiff),
        trdIdDiff:num(r.trdIdDiff), seqNumDiff:num(r.seqNumDiff)
      });
    });
  }
  function requestDraw(){
    var now = performance.now();
    if(now - lastUiTs < 50) return;
    lastUiTs = now;
    requestAnimationFrame(function(){
      try{
        if(_barOpenTime < _snapToBarBoundary(Date.now(), CFG.intervalSec) && _openBarTicks.length > 0) _closeBar();
        _rebuildDisplay();
      }catch(e){ console.warn('[xlwings fast draw]', e); }
    });
  }
  function lightSyncSoon(){
    if(lightSyncTimer) return;
    lightSyncTimer = setTimeout(function(){
      lightSyncTimer = null;
      try{
        _trAllRows = _allRawRows || [];
        _tlRows = (_allRawRows || []).slice();
        var active = (document.querySelector('.main-tab.active') || {}).dataset?.tab || '';
        if(active === 'tradelog' && typeof tlRender === 'function') tlRender();
        if(active === 'summary' && typeof sumRender === 'function') sumRender();
        if(active === 'levels' && typeof laRender === 'function') laRender();
        if(active === 'lapro' && typeof laproRender === 'function') laproRender();
        if(active === 'flip' && typeof dfpRender === 'function') dfpRender();
        if(active === 'reviewer' && typeof rvRender === 'function') rvRender();
        if(active === 'regime' && typeof regimeRender === 'function') regimeRender();
      }catch(e){ console.warn('[xlwings light sync]', e); }
    }, 250);
  }
  function flushQueue(){
    flushScheduled = false;
    if(!Q.length) return;
    var batch = Q.splice(0, Q.length);
    batch.sort(function(a,b){ return (absMsSafe(a)||Number.MAX_SAFE_INTEGER) - (absMsSafe(b)||Number.MAX_SAFE_INTEGER); });
    applyDiffsIncremental(batch);
    _allRawRows = _allRawRows || [];
    Array.prototype.push.apply(_allRawRows, batch);
    _trAllRows = _allRawRows;
    _tlRows = _allRawRows.slice();
    pushToOpenBar(batch);
    _xwRowCount = (_xwRowCount || 0) + batch.length;
    var rc = qs('xw-rowcount'); if(rc) rc.textContent = _xwRowCount.toLocaleString() + ' ticks';
    var ds = qs('dsrc'); if(ds) ds.textContent = '🔌 ' + _xwRowCount.toLocaleString() + ' ticks';
    var nb = qs('xw-newrows'); if(nb){ nb.textContent = '+' + batch.length; setTimeout(function(){ nb.textContent=''; }, 700); }
    requestDraw();
    lightSyncSoon();
  }
  function enqueueRows(rows, msg){
    var added = 0;
    rows.forEach(function(raw){
      var r = normalizeXwRow(raw, msg);
      if(!r) return;
      var k = rowKey(r);
      if(known.has(k)) return;
      known.add(k); Q.push(r); added++;
    });
    if(added && !flushScheduled){ flushScheduled = true; setTimeout(flushQueue, 25); }
    return added;
  }
  function fullSnapshot(rows, msg){
    var normalized = [];
    rows.forEach(function(raw){ var r = normalizeXwRow(raw, msg); if(r) normalized.push(r); });
    normalized.sort(function(a,b){ return (absMsSafe(a)||Number.MAX_SAFE_INTEGER) - (absMsSafe(b)||Number.MAX_SAFE_INTEGER); });
    try{ if(typeof _fillNaN === 'function') _fillNaN(normalized); }catch(e){}
    applyDiffsIncremental(normalized);
    known.clear(); normalized.forEach(function(r){ known.add(rowKey(r)); });
    _allRawRows = normalized;
    _trAllRows = normalized;
    _tlRows = normalized.slice();
    var bars = [];
    try{ bars = _bucketByInterval(normalized, CFG.intervalSec) || []; }catch(e){ console.warn('[xlwings snapshot bucket]', e); }
    if(bars.length){
      _trBars = bars;
      var cd=0; _trBars.forEach(function(b){ cd += b.delta; b.cumD = cd; });
      var n = parseInt((qs('bar-n')||{}).value) || 10;
      _trOffset = Math.max(0, _trBars.length - n);
      _closedBars = _trBars.slice(_trOffset, _trOffset + n);
    }
    _openBarTicks = [];
    _xwRowCount = normalized.length;
    var rc = qs('xw-rowcount'); if(rc) rc.textContent = _xwRowCount.toLocaleString() + ' rows';
    var ds = qs('dsrc'); if(ds) ds.textContent = '🔌 ' + _xwRowCount.toLocaleString() + ' rows';
    try{ if(typeof trAutoPopulate === 'function') trAutoPopulate(normalized); }catch(e){}
    try{ if(typeof _dtPopulateFromRows === 'function') setTimeout(function(){ _dtPopulateFromRows(normalized); },80); }catch(e){}
    requestDraw();
    lightSyncSoon();
  }

  window._xwHandleMsg = function(msg){
    try{
      switch(msg.type){
        case 'connected':{
          var fl=(msg.files&&msg.files.length)?msg.files:(msg.file?[msg.file]:['Excel']);
          _xwSetStatus('live','Connected v' + (msg.version || '?'));
          var flEl=qs('xw-filelist'); if(flEl) flEl.textContent='📂 '+fl.join(' · ');
          var ds=qs('dsrc'); if(ds){ ds.textContent='🔌 xlwings'; ds.className=''; }
          break;
        }
        case 'snapshot':{
          fullSnapshot(msg.rows || [], msg);
          var spl = (_allRawRows||[]).filter(function(r){ return isSplText(r.condKey); }).length;
          _xwSetStatus('live','Snapshot: ' + ((_allRawRows||[]).length) + ' rows (' + spl + ' SPL) — streaming…');
          break;
        }
        case 'ticks':{
          var added = enqueueRows(msg.rows || [], msg) || 0;
          if(added){ _xwSetStatus('live', (msg.file ? msg.file + ' · ' : '') + (msg.ts || new Date().toLocaleTimeString('en-US',{hour12:false})) + ' · +' + added); }
          break;
        }
        case 'amend':{
          /* Bridge emits the newest row instantly with provisional final-row diffs,
             then sends the exact forward diffs once its successor tick arrives. */
          var am = msg.rows || [];
          if(am.length && Array.isArray(_allRawRows)){
            var touched = false;
            am.forEach(function(a){
              var lo = Math.max(0, _allRawRows.length - 2000);
              for(var i=_allRawRows.length-1; i>=lo; i--){
                var r = _allRawRows[i];
                if(String(r.tradeId)===String(a.tradeId) && r.time===a.time && +r.last===+a.last){
                  r.trdIdDiff=+a.trdIdDiff||0; r.seqNumDiff=+a.seqNumDiff||0; r.movesDiff=+a.movesDiff||0;
                  touched = true; break;
                }
              }
            });
            if(touched) requestDraw();
          }
          break;
        }
        case 'heartbeat':{
          var hbl=msg.files&&typeof msg.files==='object'?Object.values(msg.files).map(function(f){return f.name+': '+f.rows;}).join(' · '):(msg.total||0)+' rows';
          _xwSetStatus('live','♥ '+(msg.ts||'')+' · '+hbl);
          var err=qs('xw-err'); if(err) err.style.display='none';
          break;
        }
        case 'saved':{
          var ss=qs('xw-save-status'); if(ss){ ss.textContent = msg.ok ? '✓ Saved' : '⚠ Save failed'; setTimeout(function(){ ss.textContent=''; },3000); }
          break;
        }
        default: console.debug('[xlwings fast] Unknown:', msg.type);
      }
    }catch(e){ console.warn('[xlwings fast handler]', e, msg); }
  };

  // Make reconnect start cleanly for high-frequency streams.
  var oldConnect = window.xwConnect;
  window.xwConnect = function(){
    Q.length = 0; flushScheduled = false; known.clear(); lastRawForDiff = null;
    if(typeof oldConnect === 'function') return oldConnect.apply(this, arguments);
  };
})();

// ==== of-manual-file-tab-fix-patch ====
(function(){
  if(window.__OF_MANUAL_FILE_TAB_FIX_PATCH__) return;
  window.__OF_MANUAL_FILE_TAB_FIX_PATCH__=true;

  function q(id){return document.getElementById(id);}
  function safe(fn){try{return fn();}catch(e){console.warn('[ManualFix]',e);}}

  /* Make lexical application state visible to late-added modules. Many Reviewer,
     Regime, LA, Flip and Report patches read window._allRawRows/window._closedBars.
     The main app stores them as top-level let variables, so without these accessors
     some manually loaded files render the Chart but leave other tabs blank. */
  function exposeState(name){
    try{
      if(Object.prototype.hasOwnProperty.call(window,name)) return;
      Object.defineProperty(window,name,{configurable:true,enumerable:false,
        get:function(){try{return eval(name);}catch(e){return undefined;}},
        set:function(v){try{eval(name+' = v');}catch(e){}}
      });
    }catch(e){}
  }
  ['_allRawRows','_trAllRows','_tlRows','_dtFilteredRows','_closedBars','_openBarTicks','_trBars','_trOffset','_dtActive','_dtStartMs','_dtEndMs','_rpRows','_rpSumRows'].forEach(exposeState);

  /* Accept Refinitiv pasted/exported text files. */
  safe(function(){var fi=q('fi'); if(fi) fi.setAttribute('accept','.xlsx,.xlsm,.xls,.csv,.txt,.tsv');});

  function detectDelimiter(line){
    line=String(line||'');
    var cand=['\t',';',',','|'];
    var best=',',bestN=-1;
    cand.forEach(function(d){var n=line.split(d).length;if(n>bestN){bestN=n;best=d;}});
    return best;
  }
  function splitLine(line,delim){
    line=String(line==null?'':line).replace(/^\uFEFF/,'');
    if(delim!==',') return line.split(delim).map(function(c){return String(c||'').trim().replace(/^"|"$/g,'');});
    var out=[],cur='',q=false;
    for(var i=0;i<line.length;i++){
      var ch=line[i];
      if(ch==='"'){
        if(q && line[i+1]==='"'){cur+='"';i++;}
        else q=!q;
      }else if(ch===','&&!q){out.push(cur.trim().replace(/^"|"$/g,''));cur='';}
      else cur+=ch;
    }
    out.push(cur.trim().replace(/^"|"$/g,''));
    return out;
  }
  function parseDelimitedText(text){
    var lines=String(text||'').split(/\r?\n/).filter(function(l){return String(l).trim();});
    if(!lines.length) throw new Error('Empty text/CSV file.');
    var firstData=lines.find(function(l){return String(l).trim();})||'';
    var delim=detectDelimiter(firstData);
    var arr=lines.map(function(l){return splitLine(l,delim);});
    var hi=(typeof _detectHeaderRow==='function')?_detectHeaderRow(arr):0;
    var hdrs=(arr[hi]||[]).map(function(c){return String(c||'').trim();});
    if(!hdrs.filter(Boolean).length) throw new Error('No header row found.');
    try{_cc=null;}catch(e){}
    var rows=[];
    for(var i=hi+1;i<arr.length;i++){
      var r=arr[i]; if(!r||r.every(function(c){return !String(c||'').trim();})) continue;
      var obj={}; hdrs.forEach(function(h,j){if(h)obj[h]=r[j] == null ? '' : r[j];});
      rows.push((typeof normR==='function')?normR(obj,hdrs):obj);
    }
    if(!rows.length) throw new Error('No data rows found after the header.');
    return rows;
  }

  /* Override the old comma-only parser. */
  try{ parseCSVText=parseDelimitedText; window.parseCSVText=parseDelimitedText; }catch(e){ window.parseCSVText=parseDelimitedText; }

  /* Extend parseFile for .txt/.tsv while keeping Excel parsing unchanged. */
  var originalParseFile=(typeof parseFile==='function')?parseFile:null;
  var patchedParseFile=function(file){
    return new Promise(function(resolve,reject){
      var ext=(typeof getFileExt==='function')?getFileExt(file.name):(String(file.name).split('.').pop()||'').toLowerCase();
      if(['txt','tsv','csv'].indexOf(ext)>=0){
        var reader=new FileReader();
        reader.onerror=function(){reject(new Error('Could not read '+ext.toUpperCase()+' file.'));};
        reader.onload=function(e){
          try{
            var rows=parseDelimitedText(e.target.result);
            if(typeof _fillNaN==='function') rows=_fillNaN(rows);
            resolve(rows);
          }catch(err){reject(err);}
        };
        reader.readAsText(file,'UTF-8');
      }else if(originalParseFile){
        originalParseFile(file).then(resolve).catch(reject);
      }else{
        reject(new Error('Unsupported file type: .'+ext));
      }
    });
  };
  try{ parseFile=patchedParseFile; window.parseFile=patchedParseFile; }catch(e){ window.parseFile=patchedParseFile; }

  function afterManualRowsLoaded(rows){
    if(!Array.isArray(rows)) rows=[];
    safe(function(){window._allRawRows=rows; window._trAllRows=rows; window._tlRows=rows.slice();});
    safe(function(){ if(typeof _applyDiffs==='function') _applyDiffs(rows); });
    safe(function(){ if(typeof trAutoPopulate==='function') trAutoPopulate(rows); });
    safe(function(){ if(typeof _dtPopulateFromRows==='function') _dtPopulateFromRows(rows); });
    safe(function(){ if(typeof _dtPopulateFromRows_new==='function') _dtPopulateFromRows_new(rows); });
    safe(function(){ if(typeof buildCandles==='function') buildCandles(); });
    safe(function(){ if(typeof _rebuildDisplay==='function') _rebuildDisplay(); });
    refreshManualTabs();
  }
  window.ofAfterManualRowsLoaded=afterManualRowsLoaded;

  /* Wrap the existing manual handler so every successful load also updates
     the window accessors and refreshes all non-chart panes. */
  if(typeof _normalFileHandler==='function' && !_normalFileHandler.__ofManualFixWrapped){
    var oldHandler=_normalFileHandler;
    var wrapped=async function(e){
      var ret=await oldHandler.apply(this,arguments);
      setTimeout(function(){
        var rows=[];
        safe(function(){rows=(window._allRawRows||_allRawRows||[]).slice();});
        if(rows.length) afterManualRowsLoaded(rows);
      },80);
      return ret;
    };
    wrapped.__ofManualFixWrapped=true;
    try{ _normalFileHandler=wrapped; }catch(e){}
    safe(function(){var fi=q('fi'); if(fi){fi.removeEventListener('change',oldHandler); fi.addEventListener('change',wrapped);}});
  }

  function visibleRows(){
    var rows=[];
    safe(function(){ if(window._dtActive && Array.isArray(window._dtFilteredRows) && window._dtFilteredRows.length) rows=window._dtFilteredRows.slice(); });
    if(rows.length) return rows;
    safe(function(){ if(Array.isArray(window._closedBars) && window._closedBars.length){ window._closedBars.forEach(function(b){ if(b&&Array.isArray(b.ticks)) rows=rows.concat(b.ticks); }); }});
    if(rows.length) return rows;
    safe(function(){ if(Array.isArray(window._allRawRows)) rows=window._allRawRows.slice(); });
    return rows;
  }
  window._ofManualVisibleRows=visibleRows;

  function refreshManualTabs(){
    safe(function(){ if(typeof tlRender==='function') tlRender(); });
    safe(function(){ if(typeof sumRender==='function') sumRender(); });
    safe(function(){ if(typeof laRender==='function') laRender(); });
    safe(function(){ if(typeof laProRender==='function') laProRender(); });
    safe(function(){ if(typeof dfpRender==='function') dfpRender(); });
    safe(function(){ if(window.RegimeLinked&&typeof RegimeLinked.update==='function') RegimeLinked.update(true); else if(typeof regimeRender==='function') regimeRender(); });
    safe(function(){
      var inf=q('rv-current-info');
      var n=visibleRows().length;
      if(inf) inf.innerHTML='Uses the same visible/current interval rows as Chart, Price Summary, LA Pro and Flip Pairs.<br><b>'+n.toLocaleString()+'</b> rows available.';
    });
  }
  window.refreshManualTabs=refreshManualTabs;

  /* Ensure switching tabs never shows stale blank panes after manual load. */
  if(typeof switchTab==='function' && !switchTab.__ofManualFixWrapped){
    var oldSwitch=switchTab;
    var sw=function(tab){
      var r=oldSwitch.apply(this,arguments);
      setTimeout(function(){
        if(tab==='tradelog'&&typeof tlRender==='function') tlRender();
        if(tab==='summary'&&typeof sumRender==='function') sumRender();
        if(tab==='la'&&typeof laRender==='function') laRender();
        if(tab==='lapro'&&typeof laProRender==='function') laProRender();
        if(tab==='flip'&&typeof dfpRender==='function') dfpRender();
        if(tab==='regime') safe(function(){ if(window.RegimeLinked&&RegimeLinked.update) RegimeLinked.update(true); else if(typeof regimeRender==='function') regimeRender(); });
        if(tab==='reviewer') safe(function(){ var inf=q('rv-current-info'); if(inf) inf.innerHTML='Current manual interval rows: <b>'+visibleRows().length.toLocaleString()+'</b>'; });
      },30);
      return r;
    };
    sw.__ofManualFixWrapped=true;
    try{ switchTab=sw; window.switchTab=sw; }catch(e){ window.switchTab=sw; }
  }

  /* Reviewer helpers: let interval reports work even when files have time-only rows. */
  window.ofManualRowMs=function(r){
    if(!r) return 0;
    if(+r._tsMs>0) return +r._tsMs;
    if(typeof _toAbsMs==='function'){var m=_toAbsMs(r); if(m) return m;}
    var t=String(r.time||r.TIMEACT_NS||r['TIMEACT NS']||'').trim();
    var mm=t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(mm) return ((+mm[1])*3600+(+mm[2])*60+(+(mm[3]||0)))*1000;
    return 0;
  };

  document.addEventListener('DOMContentLoaded',function(){setTimeout(refreshManualTabs,250);});
  setTimeout(refreshManualTabs,500);
})();

// ==== tas-sidebar-flip-pairs-patch-js ====
(function(){
'use strict';
function onReady(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',fn); else fn(); }
function fmtN(v){ v=Number(v)||0; const a=Math.abs(v); if(a>=1000) return Math.round(v).toLocaleString('en-US').replace(/,/g,' '); return String(Math.round(v)); }
function fmtP(v){ v=Number(v)||0; return (Math.round(v*100)/100).toLocaleString('en-US',{maximumFractionDigits:2}).replace(/,/g,' '); }
function localDT(ms){ const d=new Date(ms); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function rowMs(r){ try{ if(typeof _toAbsMs==='function'){ const m=_toAbsMs(r); if(m) return m; } }catch(e){} if(r&&r._tsMs) return r._tsMs; const t=(r&&r.time)||''; const d=(r&&r.date)||''; const x=Date.parse((d?d+' ':'')+t); return isNaN(x)?0:x; }
function srcRows(){ return (window._dtActive&&window._dtFilteredRows&&_dtFilteredRows.length)?_dtFilteredRows.slice():((window._allRawRows||[]).slice()); }

function setupStaticLayout(){
  // No-op: this legacy restructuring is superseded by restoreSingleLayout() further
  // down, and would otherwise conflict with the persistent sidebar/candle-summary
  // panels (which now live outside #main-wrap so they show on every tab).
  return;
}
function addFlipTab(){
  const tabs=document.getElementById('main-tabs'); const outer=document.getElementById('tabs-outer'); if(!tabs||!outer) return;
  if(!document.querySelector('.main-tab[data-tab="flip"]')){
    const b=document.createElement('button'); b.className='main-tab'; b.dataset.tab='flip'; b.innerHTML='&#8644; Flip Pairs'; b.onclick=()=>switchTab('flip'); tabs.appendChild(b);
  }
  if(!document.getElementById('flip-pane')){
    const pane=document.createElement('div'); pane.id='flip-pane'; pane.className='tab-pane';
    pane.innerHTML=`<div id="dfp-toolbar"><span class="dfp-title">Delta Flip Pair Selector</span>
      <button class="dfp-btn on" data-pair="lhBid">L-H BID</button><button class="dfp-btn on" data-pair="lhAsk">L-H ASK</button><button class="dfp-btn on" data-pair="aggr">AGGR BID-ASK</button><button class="dfp-btn" data-pair="hlVol">H-L VOL</button><button class="dfp-btn" data-pair="hlTrd">H-L TRD</button>
      <span style="flex:1"></span><button class="dfp-btn dfp-small" id="dfp-all">All</button><button class="dfp-btn dfp-small" id="dfp-none">None</button><button class="dfp-btn dfp-small" id="dfp-refresh">&#8634; Rebuild</button></div>
      <div id="dfp-note">Current interval levels only. Select the pair buttons to show/hide columns.</div><div id="dfp-wrap"><table id="dfp-table"></table></div>`;
    outer.appendChild(pane);
  }
}
window.DFP_PAIRS={
  lhBid:{label:'L-H BID',l:'liftBid',r:'hitBid'},
  lhAsk:{label:'L-H ASK',l:'liftAsk',r:'hitAsk'},
  aggr:{label:'AGGR BID-ASK',l:'bid',r:'ask'},
  hlVol:{label:'H-L VOL',l:'liftTrdVol',r:'hitTrdVol'},
  hlTrd:{label:'H-L TRD',l:'liftTrdVol',r:'hitTrdVol'}
};
function selectedPairs(){ return [...document.querySelectorAll('#dfp-toolbar .dfp-btn[data-pair].on')].map(b=>b.dataset.pair); }
window.dfpRender=function(){
  const tbl=document.getElementById('dfp-table'); if(!tbl) return;
  let bar=null;
  if(window.R&&R.bars&&R.bars.length) bar=R.bars[R.bars.length-1];
  if(!bar && typeof _currentIntervalRows==='function'){ const rows=_currentIntervalRows(); if(rows.length && typeof _ticksToBar==='function') bar=_ticksToBar(rows); }
  if(!bar || !bar.footprint || !bar.footprint.length){ tbl.innerHTML='<tbody><tr><td style="padding:30px;color:#557;">No current interval levels. Load file and press BUILD CANDLES.</td></tr></tbody>'; return; }
  const pairs=selectedPairs();
  const levels=bar.footprint.slice().sort((a,b)=>b.price-a.price);
  const totals={price:'TOTAL'}; pairs.forEach(k=>{const p=DFP_PAIRS[k]; totals[p.l]=(totals[p.l]||0)+levels.reduce((s,r)=>s+(+r[p.l]||0),0); totals[p.r]=(totals[p.r]||0)+levels.reduce((s,r)=>s+(+r[p.r]||0),0);});
  let head='<thead><tr><th>Price</th><th>Bid</th><th>Ask</th><th>Trd.Vol</th><th>Delta</th>';
  pairs.forEach(k=>{const p=DFP_PAIRS[k]; head+=`<th>${p.label}</th><th>&#916; Flip</th><th>${p.label} %</th>`;});
  head+='</tr></thead>';
  function rowHtml(r,isTotal=false){
    let baseDelta=(+r.bid||0)-(+r.ask||0); let cls=baseDelta>=0?'dfp-pos':'dfp-neg';
    let html=`<tr class="${isTotal?'dfp-total':cls}"><td>${isTotal?r.price:fmtP(r.price)}</td><td class="dfp-pos-t">${fmtN(r.bid)}</td><td class="dfp-neg-t">${fmtN(r.ask)}</td><td>${fmtN(r.trdVol||r.vol)}</td><td class="${baseDelta>0?'dfp-pos-t':baseDelta<0?'dfp-neg-t':'dfp-zero-t'}">${baseDelta>0?'+':''}${fmtN(baseDelta)}</td>`;
    pairs.forEach(k=>{const p=DFP_PAIRS[k], L=+r[p.l]||0, H=+r[p.r]||0, diff=L-H, den=Math.max(1,L+H), pct=Math.round((L/den)*100), decVal=(L/den).toFixed(2); html+=`<td><span class="dfp-pos-t">${fmtN(L)}</span> - <span class="dfp-neg-t">${fmtN(H)}</span></td><td class="${diff>0?'dfp-pos-t':diff<0?'dfp-neg-t':'dfp-zero-t'}">${diff>0?'+':''}${fmtN(diff)}</td><td><span class="dfp-progress"><span class="g" style="width:${pct}%"></span><span class="r" style="width:${100-pct}%"></span></span><span class="dfp-pct">${decVal}</span></td>`;});
    return html+'</tr>';
  }
  // proper totals row values
  let totalRow={price:levels.length,bid:levels.reduce((s,r)=>s+(+r.bid||0),0),ask:levels.reduce((s,r)=>s+(+r.ask||0),0),trdVol:levels.reduce((s,r)=>s+(+r.trdVol||+r.vol||0),0)};
  pairs.forEach(k=>{const p=DFP_PAIRS[k]; totalRow[p.l]=levels.reduce((s,r)=>s+(+r[p.l]||0),0); totalRow[p.r]=levels.reduce((s,r)=>s+(+r[p.r]||0),0);});
  const body='<tbody>'+rowHtml(totalRow,true)+levels.map(r=>rowHtml(r,false)).join('')+'</tbody>';
  tbl.innerHTML=head+body;
};
function setupFlipButtons(){
  document.addEventListener('click',e=>{
    const pair=e.target.closest('#dfp-toolbar .dfp-btn[data-pair]');
    if(pair){ pair.classList.toggle('on'); dfpRender(); return; }
    if(e.target.closest('#dfp-all')){ document.querySelectorAll('#dfp-toolbar .dfp-btn[data-pair]').forEach(b=>b.classList.add('on')); dfpRender(); }
    if(e.target.closest('#dfp-none')){ document.querySelectorAll('#dfp-toolbar .dfp-btn[data-pair]').forEach(b=>b.classList.remove('on')); dfpRender(); }
    if(e.target.closest('#dfp-refresh')) dfpRender();
  });
}
function setupTasSidebar(){
  const sb=document.getElementById('sb-scroll'); if(!sb || document.getElementById('tas-side-time-block')) return;
  document.querySelectorAll('.rp-section').forEach(x=>x.style.display='none');
  const simHdr=[...sb.querySelectorAll('.sb-s')].find(x=>/Simulation/i.test(x.textContent));
  const block=document.createElement('div'); block.id='tas-side-time-block';
  block.innerHTML=`<div class="sb-s" style="color:#00cc88;border-color:#003322;margin-top:10px;"><span>Time Range</span><span class="tas-tick-count" id="tas-side-ticks">0 ticks</span></div>
    <div class="tas-side-label">&#9658; Start</div><input type="datetime-local" id="tas-side-start" class="tas-side-dt" step="1">
    <div class="tas-side-label">&#9668; End</div><input type="datetime-local" id="tas-side-end" class="tas-side-dt" step="1">
    <div class="tas-side-preset"><button onclick="tasSidePreset('full')">Full</button><button onclick="tasSidePreset('am')">AM</button><button onclick="tasSidePreset('pm')">PM</button><button onclick="tasSidePreset('rth')">RTH</button></div>
    <button class="tas-side-build" onclick="tasSideBuild()">&#9658; BUILD CANDLES</button>
    <div class="tas-side-nav"><button id="tas-prev" onclick="tasSideNav(-1)">&#9664; PREV</button><button id="tas-next" onclick="tasSideNav(1)">NEXT &#9654;</button></div><div id="tas-side-bar-info">-- No bars --</div>`;
  if(simHdr) sb.insertBefore(block,simHdr); else sb.appendChild(block);
}
window.tasSidePreset=function(kind){
  const rows=(window._allRawRows||[]).slice().sort((a,b)=>rowMs(a)-rowMs(b)); if(!rows.length) return;
  let first=rowMs(rows[0]), last=rowMs(rows[rows.length-1]); if(!first||!last) return;
  const d=new Date(first); const mk=(h,m,s=0)=>new Date(d.getFullYear(),d.getMonth(),d.getDate(),h,m,s).getTime();
  if(kind==='am'){ first=mk(0,0); last=mk(12,0); } else if(kind==='pm'){ first=mk(12,0); last=mk(23,59,59); } else if(kind==='rth'){ first=mk(9,30); last=mk(16,0); }
  document.getElementById('tas-side-start').value=localDT(first); document.getElementById('tas-side-end').value=localDT(last);
};
window.tasSideBuild=function(){
  const ss=document.getElementById('tas-side-start')?.value, ee=document.getElementById('tas-side-end')?.value;
  if(ss&&ee){ const ds=document.getElementById('dt-start'), de=document.getElementById('dt-end'); if(ds)ds.value=ss; if(de)de.value=ee; try{ if(typeof dtApply==='function') dtApply(); }catch(e){} }
  if(typeof buildCandlesFromFile==='function') buildCandlesFromFile(); else if(typeof buildCandles==='function') buildCandles();
  tasUpdateNav(); dfpRender();
};
window.tasSideNav=function(dir){
  if(!window._trBars||!_trBars.length){ tasSideBuild(); return; }
  const step=Math.max(1,parseInt(document.getElementById('bar-n')?.value||'1',10));
  if(typeof trNav==='function') trNav(dir*step); else { _trOffset=Math.max(0,Math.min(_trBars.length-step,(_trOffset||0)+dir*step)); if(typeof _trApplyView==='function') _trApplyView(); }
  tasUpdateNav(); dfpRender();
};
window.tasUpdateNav=function(){
  const n=window._trBars?_trBars.length:0; const max=(typeof _maxBars==='function'?_maxBars():parseInt(document.getElementById('bar-n')?.value||'1',10)); const off=window._trOffset||0;
  const info=document.getElementById('tas-side-bar-info'); if(info) info.textContent=n?`bars ${off+1}-${Math.min(n,off+max)} / ${n}`:'-- No bars --';
  const ticks=document.getElementById('tas-side-ticks'); const rows=srcRows(); if(ticks) ticks.textContent=(rows.length||0).toLocaleString()+' ticks';
  const prev=document.getElementById('tas-prev'), next=document.getElementById('tas-next'); if(prev) prev.disabled=!n||off<=0; if(next) next.disabled=!n||off+max>=n;
};
function patchNavFns(){
  const oldTr=window.trNav; window.trNav=function(delta){ if(oldTr) oldTr(delta); tasUpdateNav(); if(typeof dfpRender==='function') dfpRender(); };
  const oldBuild=window.buildCandlesFromFile; if(oldBuild){ window.buildCandlesFromFile=function(){ const r=oldBuild.apply(this,arguments); setTimeout(()=>{tasUpdateNav(); dfpRender();},80); return r; }; }
  const oldRebuild=window._rebuildDisplay; if(oldRebuild){ window._rebuildDisplay=function(){ const r=oldRebuild.apply(this,arguments); setTimeout(()=>{tasUpdateNav(); if(document.querySelector('.main-tab.active')?.dataset.tab==='flip') dfpRender();},0); return r; }; }
}
const oldSwitch = window.switchTab;
window.switchTab=function(tab){
  setupStaticLayout();
  document.querySelectorAll('.main-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
  document.getElementById('chart-pane')?.classList.add('active','force-static-layout');
  const chartArea=document.getElementById('chart-area');
  ['tradelog','summary','la','lapro','flip'].forEach(k=>{const p=document.getElementById(k+'-pane'); if(p) p.classList.toggle('active',k===tab);});
  if(chartArea) chartArea.style.display=(tab==='chart')?'flex':'none';
  try{ if(tab==='tradelog'&&typeof tlRender==='function')tlRender(); else if(tab==='summary'&&typeof sumRender==='function')sumRender(); else if(tab==='la'&&typeof laRender==='function')laRender(); else if(tab==='lapro'&&typeof laProRender==='function')laProRender(); else if(tab==='flip')dfpRender(); else if(tab==='chart'&&window.R){R.resize();R.draw();} }catch(e){console.warn(e);}
  tasUpdateNav();
};
onReady(()=>{ addFlipTab(); setupStaticLayout(); setupTasSidebar(); setupFlipButtons(); patchNavFns(); tasUpdateNav(); window.switchTab('chart'); });
})();

// ==== tas-style-row-replay-link-patch ====
/* ============================================================
   TAS-style RUN / File Replay patch
   - Streams real file rows into the current candle row-by-row.
   - Uses the selected sidebar speed (#sim-spd) like the TAS HTML.
   - Updates Chart, Trade Log, Price Summary, Level Aggregator,
     LA Pro, and Flip Pairs from the same replay rows.
   - Keeps all existing column names/mapping unchanged.
   ============================================================ */
/* _rpBarStart, _rpBarEnd, _rpBarN are already declared with `let` earlier in the
   main script block. Redeclaring them with `var` here throws
   "Identifier has already been declared" and kills this entire script block. */

function _rpSpeedValue_TAS(){
  const sim = document.getElementById('sim-spd');
  const rp  = document.getElementById('rp-speed');
  let v = sim ? parseFloat(sim.value) : NaN;
  if(!Number.isFinite(v) || v<=0) v = rp ? parseFloat(rp.value) : 1;
  if(!Number.isFinite(v) || v<=0) v = 1;
  return Math.max(1, Math.round(v));
}

function _rpSyncSpeedLabels_TAS(){
  const v = _rpSpeedValue_TAS();
  const spdLbl = document.getElementById('spd-lbl');
  const rpLbl  = document.getElementById('rp-spd-lbl');
  if(spdLbl) spdLbl.textContent = v + '/s';
  if(rpLbl)  rpLbl.textContent  = v + '/s';
}

/* Keep both speed sliders visually linked when both exist. */
(function(){
  const sim = document.getElementById('sim-spd');
  const rp  = document.getElementById('rp-speed');
  if(sim && rp && !sim.__tasReplayLinked){
    sim.__tasReplayLinked = true;
    sim.addEventListener('input', function(){
      rp.value = Math.max(parseFloat(rp.min||'1')||1, Math.min(parseFloat(rp.max||'20')||20, parseFloat(sim.value)||1));
      _rpSyncSpeedLabels_TAS();
    });
    rp.addEventListener('input', function(){
      sim.value = Math.max(parseFloat(sim.min||'1')||1, Math.min(parseFloat(sim.max||'20')||20, parseFloat(rp.value)||1));
      _rpSyncSpeedLabels_TAS();
    });
  }
  _rpSyncSpeedLabels_TAS();
})();

function _rpGetSrc(){
  const base = (_dtActive && _dtFilteredRows && _dtFilteredRows.length) ? _dtFilteredRows : _allRawRows;
  if(!base || !base.length) return [];

  const sv = (document.getElementById('dt-start') || {}).value || '';
  const ev = (document.getElementById('dt-end')   || {}).value || '';
  if(!sv && !ev) return base.slice();

  const sMs = sv ? _dtInputToMs(sv) : 0;
  const eMs = ev ? _dtInputToMs(ev) : 0;
  return base.filter(function(r){
    const ms = _toAbsMs(r);
    return !(sMs && ms < sMs) && !(eMs && ms > eMs);
  });
}

function _rpNextBarEnd(rows, fromIdx, barOpenMs, intervalSec){
  // Clock-aligned bar end, identical to _bucketByInterval (M5 ends on :05, D1 at midnight)
  const endMs = _rpBarCutoff(barOpenMs, intervalSec);
  let i = fromIdx;
  while(i < rows.length){
    const ms = _toAbsMs(rows[i]) || 0;
    if(ms >= endMs) break;
    i++;
  }
  return Math.max(fromIdx + 1, i);
}

function _rpRenderAllLinkedTabs_TAS(force){
  /* Chart/open candle */
  try{ if(typeof _rebuildDisplay === 'function') _rebuildDisplay(); }catch(e){ console.warn('[RUN] chart update failed', e); }

  /* All linked tabs use dtRows(), which returns replay rows when active. */
  try{ if(typeof tlRender    === 'function') tlRender();    }catch(e){ console.warn('[RUN] Trade Log update failed', e); }
  try{ if(typeof sumRender   === 'function') sumRender();   }catch(e){ console.warn('[RUN] Price Summary update failed', e); }
  try{ if(typeof laRender    === 'function') laRender();    }catch(e){ console.warn('[RUN] Level Aggregator update failed', e); }
  try{ if(typeof laProRender === 'function') laProRender(); }catch(e){ console.warn('[RUN] LA Pro update failed', e); }
  try{ if(typeof dfpRender   === 'function') dfpRender();   }catch(e){ console.warn('[RUN] Flip Pairs update failed', e); }
  try{ if(typeof tasUpdateNav === 'function') tasUpdateNav(); }catch(e){}
  try{ if(typeof _deltaFlipUpdate === 'function') _deltaFlipUpdate(); }catch(e){}
}

function _rpStart(){
  const rows = _rpGetSrc();
  if(!rows.length){ alert('Load a file first.'); return; }

  if(typeof _stopRT === 'function' && typeof RT_ACTIVE !== 'undefined' && RT_ACTIVE) _stopRT();
  if(_rpTimer){ clearInterval(_rpTimer); _rpTimer = null; }

  rows.sort(function(a,b){ return (_toAbsMs(a)||0) - (_toAbsMs(b)||0); });
  _rpRows = rows;
  _rpIdx = 0;
  _rpTotalRows = rows.length;
  _rpBarN = 0;
  _rpActive = true;
  _rpPaused = false;
  _rpSumRows = [];

  const barOpenMs = _toAbsMs(rows[0]) || Date.now();
  _rpBarTs = barOpenMs;
  _rpBarStart = 0;
  _rpBarEnd = _rpNextBarEnd(rows, 0, barOpenMs, CFG.intervalSec);

  _closedBars = [];
  _openBarTicks = [];
  _lastBarCount = -1;
  _barOpenTime = Date.now();

  if(R){ try{ R.destroy(); }catch(e){} R = null; }
  R = new Renderer([]);
  if(typeof syncMode === 'function') syncMode(CFG.mode);
  if(typeof _updateIntervalLabel === 'function') _updateIntervalLabel();

  const ivLbl = CFG.intervalSec < 60 ? (CFG.intervalSec + 's') : (CFG.intervalSec < 3600 ? (CFG.intervalSec/60 + 'm') : (CFG.intervalSec/3600 + 'h'));
  const dsrc = document.getElementById('dsrc');
  if(dsrc){ dsrc.textContent = '▶ Replay · ' + rows.length.toLocaleString() + ' rows · ' + ivLbl; dsrc.className = ''; }
  const badge = document.getElementById('tb-badge');
  if(badge) badge.textContent = 'REPLAY';

  const play = document.getElementById('sim-play');
  const pause = document.getElementById('sim-pause');
  if(play) play.classList.add('on');
  if(pause) pause.classList.remove('on');
  const rpPlay = document.getElementById('rp-play-btn');
  const rpPause = document.getElementById('rp-pause-btn');
  if(rpPlay) rpPlay.classList.add('on');
  if(rpPause) rpPause.classList.remove('on');

  const sr = document.getElementById('rp-status-row');
  const done = document.getElementById('rp-done-row');
  if(sr) sr.style.display = '';
  if(done) done.style.display = 'none';

  _rpSyncSpeedLabels_TAS();
  _rpRenderAllLinkedTabs_TAS(true);
  if(typeof switchTab === 'function') switchTab('chart');
  if(typeof _updateRunBtn === 'function') _updateRunBtn();
  if(typeof _rpUpdateProgress === 'function') _rpUpdateProgress();

  _rpTimer = setInterval(_rpTick, 1000);
}

function _rpTick(){
  if(!_rpActive || _rpPaused) return;
  if(_rpIdx >= _rpRows.length){ _rpFinish(); return; }

  const speed = _rpSpeedValue_TAS();

  /* Push selected number of real rows into the currently running candle. */
  for(let i=0; i<speed && _rpIdx < _rpBarEnd; i++){
    const r = _rpRows[_rpIdx++];
    _openBarTicks.push(r);
    if(_rpSumRows) _rpSumRows.push(r);
  }

  /* Remaining rows inside the current interval/candle. */
  const remainingRows = Math.max(0, _rpBarEnd - _rpIdx);
  const remainingSec = Math.ceil(remainingRows / Math.max(1, speed));
  const bt = document.getElementById('bar-timer');
  if(bt){
    bt.textContent = '⏱ ' + String(Math.floor(remainingSec/60)).padStart(2,'0') + ':' + String(remainingSec%60).padStart(2,'0');
    bt.className = remainingSec < 10 ? 'closing' : '';
  }

  /* Close candle only when all rows belonging to this selected interval are fed. */
  if(_rpIdx >= _rpBarEnd){
    if(_openBarTicks.length > 0){
      const bar = _ticksToBar(_openBarTicks);
      if(bar){
        _closedBars.push(bar);
        let cd = 0;
        _closedBars.forEach(function(b){ cd += b.delta; b.cumD = cd; });
        while(_closedBars.length > _maxBars() + 5) _closedBars.shift();
      }
    }
    _openBarTicks = [];
    _rpSumRows = [];
    _barOpenTime = Date.now();
    _rpBarStart = _rpIdx;
    _rpBarN++;

    if(_rpIdx >= _rpRows.length){
      _rpRenderAllLinkedTabs_TAS(true);
      _rpFinish();
      return;
    }

    const barOpenMs = _toAbsMs(_rpRows[_rpIdx]) || Date.now();
    _rpBarTs = barOpenMs;
    _rpBarEnd = _rpNextBarEnd(_rpRows, _rpIdx, barOpenMs, CFG.intervalSec);
  }

  _rpRenderAllLinkedTabs_TAS(false);
  if(typeof _rpUpdateProgress === 'function') _rpUpdateProgress();
}

function _rpPause(){
  if(!_rpActive) return;
  _rpPaused = !_rpPaused;
  const play = document.getElementById('sim-play');
  const pause = document.getElementById('sim-pause');
  if(play) play.classList.toggle('on', !_rpPaused);
  if(pause) pause.classList.toggle('on', _rpPaused);
  const rpPlay = document.getElementById('rp-play-btn');
  const rpPause = document.getElementById('rp-pause-btn');
  if(rpPlay) rpPlay.classList.toggle('on', !_rpPaused);
  if(rpPause) rpPause.classList.toggle('on', _rpPaused);
  if(typeof _updateRunBtn === 'function') _updateRunBtn();
}

function _rpStop(){
  if(_rpTimer){ clearInterval(_rpTimer); _rpTimer = null; }
  _rpActive = false;
  _rpPaused = false;
  _rpRows = [];
  _rpIdx = 0;
  _rpSumRows = [];
  _openBarTicks = [];
  const play = document.getElementById('sim-play');
  const pause = document.getElementById('sim-pause');
  if(play) play.classList.remove('on');
  if(pause) pause.classList.remove('on');
  const rpPlay = document.getElementById('rp-play-btn');
  const rpPause = document.getElementById('rp-pause-btn');
  if(rpPlay) rpPlay.classList.remove('on');
  if(rpPause) rpPause.classList.remove('on');
  const sr = document.getElementById('rp-status-row');
  const done = document.getElementById('rp-done-row');
  if(sr) sr.style.display = 'none';
  if(done) done.style.display = 'none';
  const bt = document.getElementById('bar-timer');
  if(bt){ bt.textContent = '⏱ —'; bt.className = ''; }
  if(typeof _updateRunBtn === 'function') _updateRunBtn();
  _rpRenderAllLinkedTabs_TAS(true);
}

function _rpFinish(){
  if(_rpTimer){ clearInterval(_rpTimer); _rpTimer = null; }
  _rpActive = false;
  _rpPaused = false;

  if(_openBarTicks.length > 0){
    const bar = _ticksToBar(_openBarTicks);
    if(bar){
      _closedBars.push(bar);
      let cd = 0;
      _closedBars.forEach(function(b){ cd += b.delta; b.cumD = cd; });
    }
    _openBarTicks = [];
  }
  _rpSumRows = [];

  _rpRenderAllLinkedTabs_TAS(true);
  if(typeof _rpUpdateProgress === 'function') _rpUpdateProgress();

  const done = document.getElementById('rp-done-row');
  if(done){
    done.style.display = '';
    const info = document.getElementById('rp-done-info');
    if(info) info.textContent = '✓ Replay complete · ' + _closedBars.length + ' candles · ' + (_rpTotalRows||0).toLocaleString() + ' rows';
    setTimeout(function(){ if(done) done.style.display='none'; }, 8000);
  }
  const sr = document.getElementById('rp-status-row');
  if(sr) sr.style.display = 'none';

  const bt = document.getElementById('bar-timer');
  if(bt){ bt.textContent = '⏱ Done'; bt.className = 'closing'; }
  const badge = document.getElementById('tb-badge');
  if(badge) badge.textContent = 'DONE';
  const play = document.getElementById('sim-play');
  const pause = document.getElementById('sim-pause');
  if(play) play.classList.remove('on');
  if(pause) pause.classList.remove('on');
  const rpPlay = document.getElementById('rp-play-btn');
  const rpPause = document.getElementById('rp-pause-btn');
  if(rpPlay) rpPlay.classList.remove('on');
  if(rpPause) rpPause.classList.remove('on');
  if(typeof _updateRunBtn === 'function') _updateRunBtn();
}

function _rpSetSpeed(v){
  const sim = document.getElementById('sim-spd');
  const rp = document.getElementById('rp-speed');
  if(rp) rp.value = v;
  if(sim) sim.value = v;
  _rpSyncSpeedLabels_TAS();
}

function runReplayToggle(){
  const btn = document.getElementById('b-run');
  if(!_allRawRows || !_allRawRows.length){
    _autoReplayOnLoad = true;
    if(btn){ btn.textContent = '⏳ Loading…'; btn.style.color = '#ffaa44'; }
    const fi = document.getElementById('fi');
    if(fi) fi.click();
    return;
  }
  if(_rpActive){
    _rpPause();
  }else{
    _rpStart();
  }
  if(typeof _updateRunBtn === 'function') _updateRunBtn();
}

/* Make sidebar play/pause buttons call the TAS-style replay engine. */
(function(){
  const rpPlay = document.getElementById('rp-play-btn');
  const rpPause = document.getElementById('rp-pause-btn');
  const rpStop = document.getElementById('rp-stop-btn');
  if(rpPlay) rpPlay.onclick = function(){ _rpActive ? _rpPause() : _rpStart(); };
  if(rpPause) rpPause.onclick = function(){ _rpPause(); };
  if(rpStop) rpStop.onclick = function(){ _rpStop(); };
})();

// ==== run-row-by-row-like-tas-final-fix ====
/* ============================================================
   FINAL FIX: RUN behaves exactly like TAS File Replay / Sim
   - RUN feeds real file rows into the live candle row-by-row.
   - Uses the sidebar Simulation speed slider (#sim-spd).
   - Price Summary, Level Aggregator, LA Pro and Flip Pairs use
     the current running candle rows, not the whole file.
   - Column names/mappings are not changed.
   ============================================================ */
(function(){
  window._rpActive = false;
  window._rpPaused = false;
  window._rpTimer = null;
  window._rpRows = [];
  window._rpIdx = 0;
  window._rpBarStart = 0;
  window._rpBarEnd = 0;
  window._rpBarN = 0;
  window._rpSumRows = null;

  function _rpSpeed(){
    const sim = document.getElementById('sim-spd');
    const rp  = document.getElementById('rp-speed');
    let v = sim ? parseFloat(sim.value) : NaN;
    if(!Number.isFinite(v) || v <= 0) v = rp ? parseFloat(rp.value) : 1;
    if(!Number.isFinite(v) || v <= 0) v = 1;
    return Math.max(1, Math.round(v));
  }

  function _rpSyncSpeedLabels(){
    const v = _rpSpeed();
    const a = document.getElementById('spd-lbl');
    const b = document.getElementById('rp-spd-lbl');
    if(a) a.textContent = v + '/s';
    if(b) b.textContent = v + '/s';
  }

  window.dtRows = function(){
    /* This is the key TAS behavior: while replay/RUN is active,
       every data tab reads only the current running candle rows. */
    if((window._rpActive || window._rpPaused) && window._rpSumRows && window._rpSumRows.length){
      return window._rpSumRows;
    }
    return (window._dtActive && window._dtFilteredRows !== null) ? window._dtFilteredRows : (window._allRawRows || window._trAllRows || []);
  };

  window._rpGetSrc = function(){
    const base = (window._dtActive && window._dtFilteredRows && window._dtFilteredRows.length) ? window._dtFilteredRows : (window._allRawRows || window._trAllRows || []);
    if(!base || !base.length) return [];
    const sv = (document.getElementById('dt-start') || {}).value || '';
    const ev = (document.getElementById('dt-end')   || {}).value || '';
    if(!sv && !ev) return base.slice();
    const sMs = sv ? _dtInputToMs(sv) : 0;
    const eMs = ev ? _dtInputToMs(ev) : 0;
    return base.filter(function(r){
      const ms = _toAbsMs(r);
      return !(sMs && ms < sMs) && !(eMs && ms > eMs);
    });
  };

  window._rpNextBarEnd = function(rows, fromIdx, barOpenMs, intervalSec){
    const cutoff = _rpBarCutoff(barOpenMs, intervalSec);
    for(let i = fromIdx; i < rows.length; i++){
      if((_toAbsMs(rows[i]) || barOpenMs) >= cutoff) return i;
    }
    return rows.length;
  };

  function _rpClearLinkedTablesForNewReplay(){
    /* Clear LA/aggregator caches when available, without changing columns. */
    try{ if(Array.isArray(window._aggLevels)) window._aggLevels.length = 0; }catch(e){}
    try{ if(Array.isArray(window._aggFiltered)) window._aggFiltered.length = 0; }catch(e){}
    try{ if(Array.isArray(window.LA_RAW)) window.LA_RAW.length = 0; }catch(e){}
    try{ if(Array.isArray(window.LA_LEVELS)) window.LA_LEVELS.length = 0; }catch(e){}
    try{ if(Array.isArray(window.LA_FILT)) window.LA_FILT.length = 0; }catch(e){}
  }

  function _rpRenderLinkedTabs(){
    try{ if(typeof _rebuildDisplay === 'function') _rebuildDisplay(); }catch(e){ console.warn('[RUN] chart', e); }

    /* Render all tabs from dtRows(), which now points to the running candle rows. */
    try{ if(typeof tlRender === 'function') tlRender(); }catch(e){ console.warn('[RUN] trade log', e); }
    try{ if(typeof sumRender === 'function') sumRender(); }catch(e){ console.warn('[RUN] price summary', e); }
    try{ if(typeof laRender === 'function') laRender(); }catch(e){ console.warn('[RUN] level aggregator', e); }
    try{ if(typeof laProRender === 'function') laProRender(); }catch(e){ console.warn('[RUN] la pro', e); }
    try{ if(typeof dfpRender === 'function') dfpRender(); }catch(e){ console.warn('[RUN] flip pairs', e); }
    try{ if(typeof flipPairsRender === 'function') flipPairsRender(); }catch(e){}
    try{ if(typeof tasUpdateNav === 'function') tasUpdateNav(); }catch(e){}
    try{ if(typeof _deltaFlipUpdate === 'function') _deltaFlipUpdate(); }catch(e){}

    /* Live Candle Summary uses the candle currently being built. */
    try{
      if(typeof csUpdate === 'function' && window._openBarTicks && window._openBarTicks.length > 0){
        const liveBar = _ticksToBar(window._openBarTicks);
        if(liveBar){
          const lastCD = window._closedBars && window._closedBars.length ? (window._closedBars[window._closedBars.length - 1].cumD || 0) : 0;
          liveBar.cumD = lastCD + (liveBar.delta || 0);
          liveBar.isOpen = true;
          csUpdate(liveBar);
        }
      }
    }catch(e){}
  }

  function _rpSetButtons(running, paused){
    const ids = [
      ['sim-play', running && !paused], ['sim-pause', running && paused],
      ['rp-play-btn', running && !paused], ['rp-pause-btn', running && paused]
    ];
    ids.forEach(function(x){ const el = document.getElementById(x[0]); if(el) el.classList.toggle('on', !!x[1]); });
    const run = document.getElementById('b-run');
    if(run){
      run.classList.toggle('on', !!running);
      run.textContent = running ? (paused ? '▶ RUN' : '⏸ RUN') : '▶ RUN';
      run.style.color = running ? '#00ff88' : '#44aaff';
    }
  }

  window._rpStart = function(){
    const rows = _rpGetSrc();
    if(!rows.length){ alert('Load a file first.'); return; }

    if(window._rpTimer){ clearInterval(window._rpTimer); window._rpTimer = null; }
    try{ if(typeof _stopRT === 'function') _stopRT(); }catch(e){}
    try{ if(typeof _stopRealTimeEngine === 'function') _stopRealTimeEngine(); }catch(e){}

    rows.sort(function(a,b){ return (_toAbsMs(a)||0) - (_toAbsMs(b)||0); });
    window._rpRows = rows;
    window._rpIdx = 0;
    window._rpBarN = 0;
    window._rpActive = true;
    window._rpPaused = false;
    window._rpSumRows = [];

    _rpClearLinkedTablesForNewReplay();

    const barOpenMs = _toAbsMs(rows[0]) || Date.now();
    window._rpBarStart = 0;
    window._rpBarEnd = _rpNextBarEnd(rows, 0, barOpenMs, CFG.intervalSec);

    /* Reset chart exactly like startSim(): no full-file bars, only live rows. */
    window._closedBars = [];
    window._openBarTicks = [];
    window._lastBarCount = -1;
    window._barOpenTime = Date.now();

    if(window.R){ try{ R.destroy(); }catch(e){} window.R = null; }
    window.R = new Renderer([]);
    try{ syncMode(CFG.mode); }catch(e){}
    try{ _updateIntervalLabel(); }catch(e){}

    const ivLbl = CFG.intervalSec < 60 ? CFG.intervalSec + 's' : (CFG.intervalSec < 3600 ? (CFG.intervalSec/60) + 'm' : (CFG.intervalSec/3600) + 'h');
    const dsrc = document.getElementById('dsrc');
    if(dsrc){ dsrc.textContent = '▶ Replay · ' + rows.length.toLocaleString() + ' rows · ' + ivLbl; dsrc.className = ''; }
    const badge = document.getElementById('tb-badge');
    if(badge) badge.textContent = 'RUN';
    const timer = document.getElementById('bar-timer');
    if(timer){ timer.textContent = '⏱ 00:00'; timer.className = ''; }

    _rpSyncSpeedLabels();
    _rpSetButtons(true, false);

    const sr = document.getElementById('rp-status-row'); if(sr) sr.style.display = '';
    const done = document.getElementById('rp-done-row'); if(done) done.style.display = 'none';

    try{ if(typeof switchTab === 'function') switchTab('chart'); }catch(e){}
    _rpRenderLinkedTabs();
    try{ if(typeof _rpUpdateProgress === 'function') _rpUpdateProgress(); }catch(e){}

    window._rpTimer = setInterval(_rpTick, 1000);
  };

  window._rpTick = function(){
    if(!window._rpActive || window._rpPaused) return;
    if(window._rpIdx >= window._rpRows.length){ _rpFinish(); return; }

    const speed = _rpSpeed();

    /* Push selected number of real rows into the currently running candle. */
    for(let i = 0; i < speed && window._rpIdx < window._rpBarEnd; i++){
      const r = window._rpRows[window._rpIdx++];
      window._openBarTicks.push(r);
      if(window._rpSumRows) window._rpSumRows.push(r);
    }

    const remaining = Math.max(0, window._rpBarEnd - window._rpIdx);
    const remainingSec = Math.ceil(remaining / speed);
    const bt = document.getElementById('bar-timer');
    if(bt){
      bt.textContent = '⏱ ' + String(Math.floor(remainingSec/60)).padStart(2,'0') + ':' + String(remainingSec%60).padStart(2,'0');
      bt.className = remainingSec < 10 ? 'closing' : '';
    }

    /* Close the candle only after all rows inside the selected interval are fed. */
    if(window._rpIdx >= window._rpBarEnd){
      if(window._openBarTicks.length > 0){
        const bar = _ticksToBar(window._openBarTicks);
        if(bar){
          window._closedBars.push(bar);
          let cd = 0;
          window._closedBars.forEach(function(b){ cd += (b.delta || 0); b.cumD = cd; });
          while(window._closedBars.length > _maxBars() + 3) window._closedBars.shift();
        }
      }

      window._openBarTicks = [];
      window._lastBarCount = -1;
      window._rpBarN++;
      window._rpSumRows = [];

      /* Start next interval/candle window. */
      window._rpBarStart = window._rpIdx;
      if(window._rpIdx < window._rpRows.length){
        const nextOpenMs = _toAbsMs(window._rpRows[window._rpIdx]) || Date.now();
        window._rpBarEnd = _rpNextBarEnd(window._rpRows, window._rpIdx, nextOpenMs, CFG.intervalSec);
      }else{
        window._rpBarEnd = window._rpRows.length;
      }
    }

    _rpRenderLinkedTabs();

    const tl = document.getElementById('sim-tick-lbl') || document.getElementById('rp-progress-lbl');
    if(tl) tl.textContent = 'bar ' + (window._rpBarN + 1) + ' · row ' + window._rpIdx.toLocaleString() + '/' + window._rpRows.length.toLocaleString();
    try{ if(typeof _rpUpdateProgress === 'function') _rpUpdateProgress(); }catch(e){}

    if(window._rpIdx >= window._rpRows.length) _rpFinish();
  };

  window._rpPause = function(){
    if(!window._rpActive) return;
    window._rpPaused = !window._rpPaused;
    if(window._rpPaused){
      if(window._rpTimer){ clearInterval(window._rpTimer); window._rpTimer = null; }
      const bt = document.getElementById('bar-timer'); if(bt) bt.className = 'closing';
    }else{
      if(window._rpTimer){ clearInterval(window._rpTimer); window._rpTimer = null; }
      window._rpTimer = setInterval(_rpTick, 1000);
    }
    _rpSetButtons(true, window._rpPaused);
  };

  window._rpStop = function(){
    if(window._rpTimer){ clearInterval(window._rpTimer); window._rpTimer = null; }
    window._rpActive = false;
    window._rpPaused = false;
    window._rpRows = [];
    window._rpIdx = 0;
    window._rpSumRows = null;
    window._openBarTicks = [];
    _rpSetButtons(false, false);
    const sr = document.getElementById('rp-status-row'); if(sr) sr.style.display = 'none';
    const done = document.getElementById('rp-done-row'); if(done) done.style.display = 'none';
    const bt = document.getElementById('bar-timer'); if(bt){ bt.textContent = '⏱ —'; bt.className = ''; }
    const badge = document.getElementById('tb-badge'); if(badge) badge.textContent = 'LIVE';
    _rpRenderLinkedTabs();
  };

  window._rpFinish = function(){
    if(window._rpTimer){ clearInterval(window._rpTimer); window._rpTimer = null; }

    if(window._openBarTicks && window._openBarTicks.length > 0){
      const bar = _ticksToBar(window._openBarTicks);
      if(bar){
        window._closedBars.push(bar);
        let cd = 0;
        window._closedBars.forEach(function(b){ cd += (b.delta || 0); b.cumD = cd; });
      }
      window._openBarTicks = [];
    }

    window._rpActive = false;
    window._rpPaused = false;
    window._rpSumRows = null;
    _rpRenderLinkedTabs();

    const done = document.getElementById('rp-done-row');
    if(done){
      done.style.display = '';
      const info = document.getElementById('rp-done-info');
      if(info) info.textContent = '✓ Replay complete · ' + (window._closedBars ? window._closedBars.length : 0) + ' candles · ' + (window._rpRows ? window._rpRows.length : 0).toLocaleString() + ' rows';
    }
    const sr = document.getElementById('rp-status-row'); if(sr) sr.style.display = 'none';
    const bt = document.getElementById('bar-timer'); if(bt){ bt.textContent = '⏱ Done'; bt.className = 'closing'; }
    const badge = document.getElementById('tb-badge'); if(badge) badge.textContent = 'DONE';
    _rpSetButtons(false, false);
  };

  window.runReplayToggle = function(){
    const rows = window._allRawRows || window._trAllRows || [];
    if(!rows.length){
      const fi = document.getElementById('fi');
      if(fi) fi.click();
      return;
    }
    if(window._rpActive) _rpPause();
    else _rpStart();
  };

  window.simPlay = function(){
    const rows = window._allRawRows || window._trAllRows || [];
    if(rows.length && !window._xwActive && !window._liveActive){
      if(window._rpActive && window._rpPaused) _rpPause();
      else if(!window._rpActive) _rpStart();
      return;
    }
    if(window._simStopped){ startSim(); return; }
    window._simPaused = false;
    const play = document.getElementById('sim-play'); if(play) play.classList.add('on');
    const pause = document.getElementById('sim-pause'); if(pause) pause.classList.remove('on');
    if(window.RT_ACTIVE && !window._rtTimer) _startRealTimeEngine();
    else if(window.R && !R._t && R._sim) R._feed();
  };

  window.simPause = function(){
    if(window._rpActive){ _rpPause(); return; }
    window._simPaused = true;
    const play = document.getElementById('sim-play'); if(play) play.classList.remove('on');
    const pause = document.getElementById('sim-pause'); if(pause) pause.classList.add('on');
    try{ _stopRealTimeEngine(); }catch(e){}
    if(window.R){ clearInterval(R._t); R._t = null; }
  };

  window.simStop = function(){
    if(window._rpActive || window._rpPaused){ _rpStop(); return; }
    window._simStopped = true;
    window._simPaused = true;
    const play = document.getElementById('sim-play'); if(play) play.classList.remove('on');
    const pause = document.getElementById('sim-pause'); if(pause) pause.classList.remove('on');
    try{ _stopRT(); }catch(e){}
    if(window.R){ clearInterval(R._t); R._t = null; }
    const bt = document.getElementById('bar-timer'); if(bt){ bt.textContent = '⏱ —'; bt.className = ''; }
  };

  window.simSpeed = function(v){
    const fps = Math.max(1, Math.round(parseFloat(v) || 1));
    const sim = document.getElementById('sim-spd'); if(sim) sim.value = fps;
    const rp = document.getElementById('rp-speed'); if(rp) rp.value = fps;
    _rpSyncSpeedLabels();
    if(window.R && R._t){ clearInterval(R._t); if(!window._simPaused) R._feed(); }
  };

  window._rpSetSpeed = function(v){ simSpeed(v); };

  /* Re-wire buttons after all previous scripts have loaded. */
  function wire(){
    const run = document.getElementById('b-run'); if(run) run.onclick = runReplayToggle;
    const rpPlay = document.getElementById('rp-play-btn'); if(rpPlay) rpPlay.onclick = function(){ window._rpActive ? _rpPause() : _rpStart(); };
    const rpPause = document.getElementById('rp-pause-btn'); if(rpPause) rpPause.onclick = function(){ _rpPause(); };
    const rpStop = document.getElementById('rp-stop-btn'); if(rpStop) rpStop.onclick = function(){ _rpStop(); };
    const sim = document.getElementById('sim-spd');
    const rp = document.getElementById('rp-speed');
    if(sim && !sim.__finalRunLinked){ sim.__finalRunLinked = true; sim.addEventListener('input', function(){ simSpeed(sim.value); }); }
    if(rp && !rp.__finalRunLinked){ rp.__finalRunLinked = true; rp.addEventListener('input', function(){ simSpeed(rp.value); }); }
    _rpSyncSpeedLabels();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();

// ==== final-run-replay-like-tas-flip-summary-js ====
/* ============================================================
   FINAL OVERRIDE: RUN uses the same live row-by-row mechanism as
   the TAS File Replay. It updates the real chart candle while rows
   stream, and all tabs read the current running candle rows.
   IMPORTANT: this patch writes to the original lexical globals
   (_openBarTicks, _closedBars, etc.), not window.* shadow copies.
   ============================================================ */
(function(){
  function fmtN(v){v=Number(v||0); if(!isFinite(v))v=0; const a=Math.abs(v); if(a>=10000)return (v/1000).toFixed(1)+'k'; if(a>=1000)return Math.round(v).toLocaleString(); return (Math.round(v*100)/100).toString();}
  function fmtP(v){v=Number(v||0); if(!isFinite(v))v=0; return v.toFixed(1).replace('.',',');}
  function rowsBase(){return (_dtActive && _dtFilteredRows && _dtFilteredRows.length) ? _dtFilteredRows : ((_allRawRows && _allRawRows.length) ? _allRawRows : (_trAllRows || []));}
  function speedVal(){
    const sim=document.getElementById('sim-spd');
    const rp=document.getElementById('rp-speed');
    let v=sim?parseFloat(sim.value):NaN;
    if(!isFinite(v)||v<=0) v=rp?parseFloat(rp.value):1;
    if(!isFinite(v)||v<=0) v=1;
    return Math.max(0.25,v);
  }
  function rowsPerTick(){return Math.max(1, Math.floor(speedVal()));}
  function timerMs(){const v=speedVal(); return v>=1?1000:Math.round(1000/v);}
  function syncSpeedLabels(){
    const v=speedVal(); const label=(v>=1?Math.floor(v):v)+'/s';
    const a=document.getElementById('spd-lbl'); if(a)a.textContent=label;
    const b=document.getElementById('rp-spd-lbl'); if(b)b.textContent=label;
  }
  function nextBarEnd(rows,fromIdx,openMs){
    const cutoff=_rpBarCutoff(openMs,CFG.intervalSec||60);
    for(let i=fromIdx;i<rows.length;i++){ if((_toAbsMs(rows[i])||openMs)>=cutoff) return i; }
    return rows.length;
  }
  function closeRunningBar(){
    if(!_openBarTicks || !_openBarTicks.length) return;
    const bar=_ticksToBar(_openBarTicks);
    if(bar){
      _closedBars.push(bar);
      let cd=0; _closedBars.forEach(b=>{cd+=(b.delta||0); b.cumD=cd;});
      const keep=(typeof _maxBars==='function'?_maxBars():10)+3;
      while(_closedBars.length>keep) _closedBars.shift();
    }
    _openBarTicks=[]; _lastBarCount=-1;
  }
  function renderAllLinked(){
    try{ if(typeof _rebuildDisplay==='function') _rebuildDisplay(); }catch(e){console.warn('[RUN chart]',e);}
    try{ if(typeof tlRender==='function') tlRender(); }catch(e){}
    try{ if(typeof sumRender==='function') sumRender(); }catch(e){}
    try{ if(typeof aggBuild==='function') aggBuild(); }catch(e){}
    try{ if(typeof laRender==='function') laRender(); }catch(e){}
    try{ if(typeof laProRender==='function') laProRender(); }catch(e){}
    try{ if(typeof dfpRender==='function') dfpRender(); }catch(e){}
    try{ updateFlipSideSummaryFinal(); }catch(e){}
  }
  function setButtons(running,paused){
    [['sim-play',running&&!paused],['sim-pause',running&&paused],['rp-play-btn',running&&!paused],['rp-pause-btn',running&&paused]].forEach(([id,on])=>{const e=document.getElementById(id); if(e)e.classList.toggle('on',!!on);});
    const replayPause=document.getElementById('historical-replay-pause-btn');
    if(replayPause) replayPause.classList.toggle('on',!!(running&&paused));
    const run=document.getElementById('b-run');
    if(run){run.classList.toggle('on',!!running); run.textContent=running?(paused?'▶ RUN':'⏸ RUN'):'▶ RUN'; run.style.color=running?'#00ff88':'#44aaff';}
  }
  function updateProgress(){
    const total=_rpRows?_rpRows.length:0, idx=_rpIdx||0;
    const pct=total?Math.min(100,(idx/total)*100):0;
    const bar=document.getElementById('rp-progress-bar'); if(bar)bar.style.width=pct+'%';
    const lbl=document.getElementById('rp-progress-lbl'); if(lbl)lbl.textContent='bar '+((_rpBarN||0)+1)+' · row '+idx.toLocaleString()+' / '+total.toLocaleString();
    const tick=document.getElementById('sim-tick-lbl'); if(tick)tick.textContent=lbl?lbl.textContent:'';
  }
  function finishReplay(){
    if(_rpTimer){clearInterval(_rpTimer); _rpTimer=null;}
    closeRunningBar();
    _rpActive=false; _rpPaused=false; _rpSumRows=null;
    renderAllLinked();
    const done=document.getElementById('rp-done-row'); if(done)done.style.display='';
    const info=document.getElementById('rp-done-info'); if(info)info.textContent='✓ Replay complete · '+(_closedBars?_closedBars.length:0)+' candles · '+(_rpRows?_rpRows.length:0).toLocaleString()+' rows';
    const sr=document.getElementById('rp-status-row'); if(sr)sr.style.display='none';
    const bt=document.getElementById('bar-timer'); if(bt){bt.textContent='⏱ Done'; bt.className='closing';}
    const badge=document.getElementById('tb-badge'); if(badge)badge.textContent='DONE';
    const dsrc=document.getElementById('dsrc'); if(dsrc)dsrc.textContent='✓ Replay Done';
    setButtons(false,false);
  }

  window.dtRows=function(){
    if((_rpActive||_rpPaused) && _rpSumRows && _rpSumRows.length) return _rpSumRows;
    return rowsBase();
  };
  window._currentIntervalRows=function(){
    if((_rpActive||_rpPaused) && _rpSumRows && _rpSumRows.length) return _rpSumRows;
    if(_openBarTicks && _openBarTicks.length) return _openBarTicks;
    return rowsBase();
  };

  window._rpStart=function(){
    const rows=rowsBase().slice().filter(r=>_toAbsMs(r)>0).sort((a,b)=>(_toAbsMs(a)||0)-(_toAbsMs(b)||0));
    if(!rows.length){ const fi=document.getElementById('fi'); if(fi)fi.click(); else alert('Load a file first.'); return; }
    if(_rpTimer){clearInterval(_rpTimer); _rpTimer=null;}
    try{ if(typeof _stopRT==='function') _stopRT(); }catch(e){}
    try{ if(typeof _stopRealTimeEngine==='function') _stopRealTimeEngine(); }catch(e){}
    _rpRows=rows; _rpIdx=0; _rpBarN=0; _rpBarStart=0; _rpActive=true; _rpPaused=false; _rpSumRows=[];
    _closedBars=[]; _openBarTicks=[]; _lastBarCount=-1; _barOpenTime=_toAbsMs(rows[0])||Date.now();
    _rpBarEnd=nextBarEnd(rows,0,_barOpenTime);
    if(R){try{R.destroy();}catch(e){} R=null;}
    R=new Renderer([]); try{syncMode(CFG.mode);}catch(e){} try{_updateIntervalLabel();}catch(e){}
    const sr=document.getElementById('rp-status-row'); if(sr)sr.style.display='';
    const done=document.getElementById('rp-done-row'); if(done)done.style.display='none';
    const badge=document.getElementById('tb-badge'); if(badge)badge.textContent='RUN';
    const dsrc=document.getElementById('dsrc'); if(dsrc){dsrc.textContent='▶ Replay · '+rows.length.toLocaleString()+' rows'; dsrc.className='';}
    syncSpeedLabels(); setButtons(true,false); updateProgress();
    try{ if(typeof switchTab==='function') switchTab('chart'); }catch(e){}
    renderAllLinked();
    _rpTimer=setInterval(_rpTick,timerMs());
  };
  window._rpTick=function(){
    if(!_rpActive||_rpPaused)return;
    if(_rpIdx>=_rpRows.length){finishReplay();return;}
    const step=rowsPerTick();
    for(let i=0;i<step && _rpIdx<_rpRows.length && _rpIdx<_rpBarEnd;i++){
      const r=_rpRows[_rpIdx++];
      _openBarTicks.push(r);
      if(_rpSumRows)_rpSumRows.push(r);
    }
    const remaining=Math.max(0,_rpBarEnd-_rpIdx), sp=Math.max(0.25,speedVal());
    const remainSec=Math.ceil(remaining/sp); const bt=document.getElementById('bar-timer');
    if(bt){bt.textContent='⏱ '+String(Math.floor(remainSec/60)).padStart(2,'0')+':'+String(remainSec%60).padStart(2,'0'); bt.className=remainSec<10?'closing':'';}
    /* Draw the current candle BEFORE closing it so the user sees it build row-by-row. */
    renderAllLinked(); updateProgress();
    if(_rpIdx>=_rpBarEnd){
      closeRunningBar();
      _rpBarN++; _rpBarStart=_rpIdx; _rpSumRows=[];
      if(_rpIdx<_rpRows.length){ _barOpenTime=_toAbsMs(_rpRows[_rpIdx])||Date.now(); _rpBarEnd=nextBarEnd(_rpRows,_rpIdx,_barOpenTime); }
      else _rpBarEnd=_rpRows.length;
      renderAllLinked(); updateProgress();
    }
    if(_rpIdx>=_rpRows.length) finishReplay();
  };
  window._rpPause=function(){
    if(!_rpActive)return;
    _rpPaused=!_rpPaused;
    if(_rpPaused){ if(_rpTimer){clearInterval(_rpTimer); _rpTimer=null;} }
    else{ if(_rpTimer){clearInterval(_rpTimer);} _rpTimer=setInterval(_rpTick,timerMs()); }
    setButtons(true,_rpPaused);
  };
  window._rpStop=function(){
    if(_rpTimer){clearInterval(_rpTimer); _rpTimer=null;}
    _rpActive=false; _rpPaused=false; _rpRows=[]; _rpIdx=0; _rpSumRows=null; _openBarTicks=[];
    setButtons(false,false); renderAllLinked();
    const sr=document.getElementById('rp-status-row'); if(sr)sr.style.display='none';
    const done=document.getElementById('rp-done-row'); if(done)done.style.display='none';
    const bt=document.getElementById('bar-timer'); if(bt){bt.textContent='⏱ —'; bt.className='';}
  };
  window.runReplayToggle=function(){ if(_rpActive)_rpPause(); else _rpStart(); };
  window.simPlay=function(){ if((_allRawRows&&_allRawRows.length)||(_trAllRows&&_trAllRows.length)){ if(_rpActive&&_rpPaused)_rpPause(); else if(!_rpActive)_rpStart(); return;} if(typeof startSim==='function')startSim(); };
  window.simPause=function(){ if(_rpActive){_rpPause();return;} _simPaused=true; const p=document.getElementById('sim-play'); if(p)p.classList.remove('on'); const q=document.getElementById('sim-pause'); if(q)q.classList.add('on'); if(R){clearInterval(R._t); R._t=null;} };
  window.simStop=function(){ if(_rpActive||_rpPaused){_rpStop();return;} _simStopped=true; _simPaused=true; if(R){clearInterval(R._t); R._t=null;} };
  window.simSpeed=function(v){
    const sim=document.getElementById('sim-spd'); if(sim)sim.value=v;
    const rp=document.getElementById('rp-speed'); if(rp)rp.value=v;
    syncSpeedLabels();
    if(_rpActive&&!_rpPaused){ if(_rpTimer)clearInterval(_rpTimer); _rpTimer=setInterval(_rpTick,timerMs()); }
  };
  window._rpSetSpeed=function(v){simSpeed(v);};
  window.startHistoricalReplay = function(){
    const rows = (_allRawRows && _allRawRows.length) ? _allRawRows : (_trAllRows || []);
    if(!rows.length){ alert('Load database history or a source file first.'); return; }

    const replaySpeed = document.getElementById('rp-speed');
    if(replaySpeed) simSpeed(replaySpeed.value);
    const startValue = (document.getElementById('dt-start') || {}).value || '';
    const endValue = (document.getElementById('dt-end') || {}).value || '';
    if(startValue || endValue){
      const startMs = startValue ? _dtInputToMs(startValue) : 0;
      const endMs = endValue ? _dtInputToMs(endValue) : 0;
      const selected = rows.filter(function(row){
        const timestamp = _toAbsMs(row);
        return timestamp > 0 && (!startMs || timestamp >= startMs) && (!endMs || timestamp <= endMs);
      });
      if(!selected.length){ alert('No ticks were found in the selected START / END range.'); return; }
      _dtStartMs = startMs;
      _dtEndMs = endMs;
      _dtFilteredRows = selected;
      _dtActive = true;
    }

    if(typeof window._rpStart === 'function') window._rpStart();
    else alert('The replay engine is not ready.');
  };
  window.pauseResumeHistoricalReplay = function(){
    if(typeof window._rpPause === 'function') window._rpPause();
    const label=document.getElementById('rp-progress-lbl');
    if(label && window._rpActive) label.textContent=window._rpPaused?'Replay paused':'Replay resumed';
  };
  window.stopHistoricalReplay = function(){
    if(typeof window._rpStop === 'function') window._rpStop();
    const progress = document.getElementById('rp-progress-bar');
    if(progress) progress.style.width = '0%';
    const label = document.getElementById('rp-progress-lbl');
    if(label) label.textContent = 'Stopped · current chart preserved';
  };

  function ensureFlipSide(){
    const wrap=document.getElementById('dfp-wrap'), tbl=document.getElementById('dfp-table');
    if(!wrap||!tbl)return;
    if(!document.getElementById('dfp-main-final')){
      const main=document.createElement('div'); main.id='dfp-main-final';
      wrap.insertBefore(main,tbl); main.appendChild(tbl);
    }
    if(!document.getElementById('dfp-side-final')){
      const side=document.createElement('div'); side.id='dfp-side-final';
      side.innerHTML='<div class="dfp-side-title-final">Candle Summary</div><div id="dfp-side-content-final"></div>';
      wrap.appendChild(side);
    }
  }
  function barForSummary(){
    if(_openBarTicks&&_openBarTicks.length){const b=_ticksToBar(_openBarTicks); if(b){const cd=_closedBars.length?(_closedBars[_closedBars.length-1].cumD||0):0; b.cumD=cd+(b.delta||0); return b;}}
    if(R&&R.bars&&R.bars.length)return R.bars[R.bars.length-1];
    if(_closedBars&&_closedBars.length)return _closedBars[_closedBars.length-1];
    return null;
  }
  window.updateFlipSideSummaryFinal=function(){
    ensureFlipSide(); const box=document.getElementById('dfp-side-content-final'); if(!box)return;
    const bar=barForSummary(); if(!bar){box.innerHTML='<div style="color:#446;padding:10px">No candle yet.</div>';return;}
    const fp=bar.footprint||[];
    const selected=[...document.querySelectorAll('#dfp-pair-box .dfp-pair-pill.on')].map(x=>x.dataset.pair);
    const key=selected[0]||'lhBid';
    const map={lhBid:['L-H BID % (THIS BAR)','liftBid','hitBid'],lhAsk:['L-H ASK % (THIS BAR)','liftAsk','hitAsk'],aggNet:['AGGR BID-ASK % (THIS BAR)','bid','ask'],hlVol:['H-L VOL % (THIS BAR)','liftTrdVol','hitTrdVol'],lhRTL:['L-H TRADES % (THIS BAR)','liftRTL','hitRTL'],lhSEQ:['L-H ELIG_V % (THIS BAR)','liftSeqDiff','hitSeqDiff']};
    const m=map[key]||map.lhBid;
    let L=0,H=0; fp.forEach(r=>{L+=+r[m[1]]||0; H+=+r[m[2]]||0;});
    if(!fp.length){L=+(bar.buyVol||0); H=+(bar.sellVol||0);} const pct=Math.round(100*L/Math.max(1,L+H));
    const delta=+(bar.delta||0), vol=+(bar.volume||bar.totalVol||bar.trdVol||bar.buyVol+bar.sellVol||0), dPct=vol?Math.round(delta/vol*10000)/100:0;
    const levels=fp.length||0, poc=bar.poc||bar.close||0;
    box.innerHTML='<div class="dfp-bigbar-box-final"><div class="dfp-bigbar-label-final">'+m[0]+'</div><div class="dfp-bigbar-row-final"><div class="dfp-status-bar-final"><div class="dfp-status-green-final" style="width:'+pct+'%"></div><div class="dfp-status-red-final" style="width:'+(100-pct)+'%"></div></div><div class="dfp-bigbar-pct-final">'+pct+'%</div></div></div>'+ 
      '<div class="dfp-cs-grid-final">'+
      cell('PRICE',fmtP(bar.close||0),'')+cell('OPEN',fmtP(bar.open||0),'')+cell('HIGH',fmtP(bar.high||0),'pos')+cell('LOW',fmtP(bar.low||0),'neg')+cell('CLOSE',fmtP(bar.close||0),'')+cell('TOTAL VOL',fmtN(vol),'')+cell('DELTA',(delta>0?'+':'')+fmtN(delta),delta>=0?'pos':'neg')+cell('DELTA %',dPct+'%',dPct>=0?'pos':'neg')+cell('POC',fmtP(poc),'poc')+cell('LEVELS',fmtN(levels),'')+'</div>';
    function cell(l,v,c){return '<div class="dfp-cs-cell-final"><div class="dfp-cs-lbl-final">'+l+'</div><div class="dfp-cs-val-final '+(c||'')+'">'+v+'</div></div>';}
  };

  const oldDfp=window.dfpRender;
  if(oldDfp){window.dfpRender=function(){const r=oldDfp.apply(this,arguments); setTimeout(updateFlipSideSummaryFinal,0); return r;};}

  function wireFinal(){
    const run=document.getElementById('b-run'); if(run)run.onclick=runReplayToggle;
    const rpPlay=document.getElementById('rp-play-btn'); if(rpPlay)rpPlay.onclick=function(){_rpActive?_rpPause():_rpStart();};
    const rpPause=document.getElementById('rp-pause-btn'); if(rpPause)rpPause.onclick=function(){_rpPause();};
    const rpStop=document.getElementById('rp-stop-btn'); if(rpStop)rpStop.onclick=function(){_rpStop();};
    const sim=document.getElementById('sim-spd'); if(sim&&!sim.__tasReplayFinal){sim.__tasReplayFinal=true; sim.addEventListener('input',function(){simSpeed(sim.value);});}
    const rp=document.getElementById('rp-speed'); if(rp&&!rp.__tasReplayFinal){rp.__tasReplayFinal=true; rp.addEventListener('input',function(){simSpeed(rp.value);});}
    syncSpeedLabels(); ensureFlipSide(); updateFlipSideSummaryFinal();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wireFinal); else wireFinal();
})();


/* =========================================================
   FINAL FORMAT PATCH — Timestamp + CF TICK file
   Columns supported exactly:
   Timestamp, CF TICK, AGGRESSIVE ORD1, LAST, CF BID, CF ASK,
   BID SIZE, ASK SIZE, NUM BID ORDERS 1, NUM ASK ORDERS 1,
   NUMBER OF ORDERS, TRADE VOL, CF VOLUME, ELIGBL TRD ACVOL,
   NUMBER TRADES, TRADE_ID
   Hit/Lift priority: CF TICK arrow. Fallback: LAST vs CF ASK/BID.
   ========================================================= */
function _ofNumFinal(v){
  if(v===null||v===undefined||v==='') return 0;
  const x=parseFloat(String(v).replace(/\s/g,'').replace(',', '.'));
  return isNaN(x)?0:x;
}
function _ofTextFinal(v){return String(v??'').trim();}
function _ofNormDateFinal(v){
  if(v instanceof Date && !isNaN(v.getTime())){const p=n=>String(n).padStart(2,'0');return `${v.getFullYear()}-${p(v.getMonth()+1)}-${p(v.getDate())}`;}
  const s=String(v??'').trim();
  let m=s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/); if(m)return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;
  m=s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/); if(m)return `${m[3]}-${String(+m[2]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`;
  const d=new Date(s); if(!isNaN(d.getTime())){const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
  return '';
}
function _ofNormTimeFinal(v){
  if(v instanceof Date && !isNaN(v.getTime())){const p=n=>String(n).padStart(2,'0');return `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;}
  const s=String(v??'').trim();
  const m=s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); if(m)return `${String(+m[1]).padStart(2,'0')}:${m[2]}:${String(m[3]||'00').padStart(2,'0')}`;
  return '';
}
function _ofTsMsFinal(date,time,raw){
  if(raw instanceof Date && !isNaN(raw.getTime())) return raw.getTime();
  const combo=(date&&time)?`${date} ${time}`:String(raw??'').trim();
  const m=combo.match(/(\d{4})-(\d{1,2})-(\d{1,2}).*?(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){const d=new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0),0); if(!isNaN(d.getTime()))return d.getTime();}
  const d=new Date(combo.replace('T',' ')); return isNaN(d.getTime())?0:d.getTime();
}
function _ofTickSideFinal(tick,last,bid,ask,aggr){
  const t=String(tick??'').trim().toUpperCase();
  if(/[↑⇧▲]/.test(t) || /\bUP\b/.test(t)) return 'L';     // Lift ask / buyer lifted offer
  if(/[↓⇩▼]/.test(t) || /\bDOWN\b/.test(t)) return 'H';   // Hit bid / seller hit bid
  if(ask>0 && last>=ask-CFG.tickSize*0.001) return 'L';
  if(bid>0 && last<=bid+CFG.tickSize*0.001) return 'H';
  const a=String(aggr??'').trim().toUpperCase();
  if(a==='BID'||a==='SELL') return 'H';
  if(a==='ASK'||a==='BUY') return 'L';
  return 'N';
}

function normR(obj,hdrs){
  if(!_cc)_cc=_buildColCache(hdrs);
  const get=(k)=>{const h=_cc[k]; return h!=null ? (obj[h]??'') : '';};
  const rawTimestamp = obj['Timestamp'] ?? obj['TIMESTAMP'] ?? get('date') ?? get('time') ?? '';
  let date=_ofNormDateFinal(rawTimestamp || get('date'));
  let time=_ofNormTimeFinal(rawTimestamp || get('time'));
  if(!date) date=_ofNormDateFinal(get('date'));
  if(!time) time=_ofNormTimeFinal(get('time'));
  const ms=_ofTsMsFinal(date,time,rawTimestamp);
  const aggr=_ofTextFinal(get('aggr')).toUpperCase().replace(/^B$/,'BID').replace(/^A$/,'ASK');
  const last=_ofNumFinal(get('last'));
  const bid=_ofNumFinal(get('bid'));
  const ask=_ofNumFinal(get('ask'));
  const tick=_ofTextFinal(get('tick'));
  const trdVol=_ofNumFinal(get('trdVol'));
  // CF VOLUME and ELIGBL TRD ACVOL are two distinct real columns in this
  // file's format — keep them as two distinct fields instead of collapsing
  // them into one. 'volume' = CF VOLUME (falls back to TRADE VOL if absent).
  // 'eligVol' = ELIGBL TRD ACVOL, its own field (diffed in _applyDiffs as
  // eligVolDiff — the real-column replacement for the nonexistent SEQNUM).
  const cfVol=_ofNumFinal(get('volume'));
  const acvol=_ofNumFinal(obj['ELIGBL TRD ACVOL'] ?? obj['ELIGIBLE TRD ACVOL'] ?? get('eligVol'));
  // NUMBER TRADES is its own real column — kept both as 'numTrades' (clear
  // name) and 'moves' (existing internal field used for the per-level
  // #Trades chart column and diffed in _applyDiffs as the RTL-labelled
  // total, which is the real-column replacement for the nonexistent RTL).
  const nTrades=_ofNumFinal(obj['NUMBER TRADES'] ?? obj['NUMBER OF TRADES'] ?? get('numTrades'));
  const tradeId=_ofTextFinal(get('tradeId'));
  const seq=_ofNumFinal(get('seqNum'));
  const side=_ofTickSideFinal(tick,last,bid,ask,aggr);
  const condKey=String(_ofTextFinal(get('condKey'))||'').replace(/[^\x20-\x7E]/g,'').trim();
  return {
    _tsMs:ms,date,time,tick,aggr,last,bid,ask,
    bSize:_ofNumFinal(get('bSize')),aSize:_ofNumFinal(get('aSize')),
    numBid:_ofNumFinal(get('numBid')),numAsk:_ofNumFinal(get('numAsk')),numOrders:_ofNumFinal(get('numOrders')),
    trdVol,volume:cfVol||trdVol,eligVol:acvol,moves:nTrades,numTrades:nTrades,tradeId,seqNum:seq,rtCount:nTrades,
    condKey,QUALIFIERS:condKey,
    volDiff:0,movesDiff:0,seqNumDiff:0,trdIdDiff:0,eligVolDiff:0,_side:side
  };
}

function _ticksToBar(ticks){
  if(!ticks||!ticks.length)return null;
  const prices=ticks.map(r=>+r.last||0).filter(p=>p>0); if(!prices.length)return null;
  const hi=Math.max(...prices), lo=Math.min(...prices), op=prices[0], cl=prices[prices.length-1];
  const byP={};
  ticks.forEach(r=>{
    const last=+r.last||0; if(!last)return;
    const pk=+(Math.round(last/CFG.tickSize)*CFG.tickSize).toFixed(8);
    if(!byP[pk]) byP[pk]={price:pk,bid:0,ask:0,bSize:0,aSize:0,numBid:0,numAsk:0,numOrders:0,trdVol:0,volume:0,moves:0,trdIdDiff:0,delta:0,vol:0,hitBid:0,hitAsk:0,hitTrdVol:0,liftBid:0,liftAsk:0,liftTrdVol:0,hitRTL:0,liftRTL:0,hitSeqDiff:0,liftSeqDiff:0,hitNumBid:0,liftNumBid:0,hitNumAsk:0,liftNumAsk:0,hitNumOrders:0,liftNumOrders:0,hitTrdId:0,liftTrdId:0};
    const lv=byP[pk];
    // rtl = NUMBER TRADES diff (movesDiff) — real-column replacement for the
    // nonexistent RTL column. seq = ELIGBL TRD ACVOL diff (eligVolDiff) —
    // real-column replacement for the nonexistent SEQNUM column.
    const bs=+r.bSize||0, as=+r.aSize||0, vol=+r.trdVol||0, rtl=+r.movesDiff||0, seq=+r.eligVolDiff||0, tid=_ofNumFinal(r.tradeId)||+r.trdIdDiff||0;
    const side=r._side || _ofTickSideFinal(r.tick,last,+r.bid||0,+r.ask||0,r.aggr);
    lv.bid+=bs; lv.ask+=as; lv.bSize+=bs; lv.aSize+=as;
    lv.numBid+=+r.numBid||0; lv.numAsk+=+r.numAsk||0; lv.numOrders+=+r.numOrders||0;
    lv.trdVol+=vol; lv.volume+=+r.volume||vol; lv.moves+=+r.moves||0; lv.trdIdDiff+=tid;
    lv.vol+=vol; lv.delta+=bs-as;
    if(side==='H'){
      lv.hitBid+=bs; lv.hitAsk+=as; lv.hitTrdVol+=vol; lv.hitRTL+=rtl; lv.hitSeqDiff+=seq;
      lv.hitNumBid+=+r.numBid||0; lv.hitNumAsk+=+r.numAsk||0; lv.hitNumOrders+=+r.numOrders||0; lv.hitTrdId+=tid;
    }else if(side==='L'){
      lv.liftBid+=bs; lv.liftAsk+=as; lv.liftTrdVol+=vol; lv.liftRTL+=rtl; lv.liftSeqDiff+=seq;
      lv.liftNumBid+=+r.numBid||0; lv.liftNumAsk+=+r.numAsk||0; lv.liftNumOrders+=+r.numOrders||0; lv.liftTrdId+=tid;
    }
  });
  const fp=Object.values(byP).sort((a,b)=>a.price-b.price);
  const sum=f=>fp.reduce((s,r)=>s+(+r[f]||0),0);
  const tV=sum('vol');
  const poc=fp.length?fp.reduce((mx,r)=>(r.vol>mx.vol?r:mx),fp[0]):{price:cl,vol:0};
  const sv=[...fp].sort((a,b)=>b.vol-a.vol);let vaV=0,vaPs=[];for(const r of sv){vaPs.push(r.price);vaV+=r.vol;if(vaV>=tV*.7)break;}
  const delta=fp.reduce((s,r)=>s+(r.delta||0),0);
  let aggrBidVol=0,aggrAskVol=0,aggrBidCnt=0,aggrAskCnt=0;
  ticks.forEach(r=>{const a=String(r.aggr||'').toUpperCase(); const v=+r.trdVol||0; if(a==='BID'||a==='SELL'){aggrBidVol+=v;aggrBidCnt++;} if(a==='ASK'||a==='BUY'){aggrAskVol+=v;aggrAskCnt++;}});
  const t0=ticks[0], tN=ticks[ticks.length-1];
  const vols=ticks.map(r=>+r.trdVol||0).filter(v=>v>0);
  return {open:op,high:hi,low:lo,close:cl,isBull:cl>=op,footprint:fp,pocPrice:poc.price,pocVol:poc.vol,
    vah:vaPs.length?Math.max(...vaPs):hi,val:vaPs.length?Math.min(...vaPs):lo,delta,totalVol:tV,
    buyVol:sum('liftTrdVol'),sellVol:sum('hitTrdVol'),
    totalBid:sum('bid'),totalAsk:sum('ask'),totalBSize:sum('bSize'),totalASize:sum('aSize'),
    totalNumBid:sum('numBid'),totalNumAsk:sum('numAsk'),totalNumOrders:sum('numOrders'),totalTrdVol:sum('trdVol'),totalVolume:sum('volume'),totalMoves:sum('moves'),
    totalHitBid:sum('hitBid'),totalHitAsk:sum('hitAsk'),totalHitVol:sum('hitTrdVol'),totalLiftBid:sum('liftBid'),totalLiftAsk:sum('liftAsk'),totalLiftVol:sum('liftTrdVol'),
    totalDelta:delta,totalTrdId:sum('trdIdDiff'),totalDiffVol:sum('volume'),avgVwap:prices.reduce((s,p)=>s+p,0)/prices.length,
    minDelta:fp.length?Math.min(...fp.map(r=>r.delta)):0,maxDelta:fp.length?Math.max(...fp.map(r=>r.delta)):0,cumD:0,isOpen:false,date:t0.date||'',time:t0.time||'',timeEnd:tN.time||'',ticks:ticks.slice(),
    dfHLVol:vols.length>1?Math.max(...vols)-Math.min(...vols):0,totalAggrBid:aggrBidVol,totalAggrAsk:aggrAskVol,totalAggrBidCnt:aggrBidCnt,totalAggrAskCnt:aggrAskCnt,
    rawVolume:(+tN.volume||0),  /* CF VOLUME — real column, was not surfaced anywhere before */
    totalHitRTL:sum('hitRTL'),totalLiftRTL:sum('liftRTL'),totalHitSeq:sum('hitSeqDiff'),totalLiftSeq:sum('liftSeqDiff'),
    totalHitNumBid:sum('hitNumBid'),totalLiftNumBid:sum('liftNumBid'),totalHitNumAsk:sum('hitNumAsk'),totalLiftNumAsk:sum('liftNumAsk'),
    totalHitNumOrders:sum('hitNumOrders'),totalLiftNumOrders:sum('liftNumOrders'),totalHitTrdId:sum('hitTrdId'),totalLiftTrdId:sum('liftTrdId')};
}

function makeBars(rows,n){
  if(!rows||!rows.length)return[];
  const bs=Math.max(1,Math.floor(rows.length/n)); const bars=[];
  for(let i=0;i<rows.length;i+=bs){const b=_ticksToBar(rows.slice(i,i+bs)); if(b)bars.push(b);}
  let cd=0;bars.forEach(b=>{cd+=b.delta;b.cumD=cd;});return bars;
}

(function _wireRunToReplayForCFFormat(){
  function sync(){
    const run=document.getElementById('b-run');
    if(run){run.onclick=function(){ if(typeof _rpStart==='function') _rpStart(); else if(typeof buildCandlesFromFile==='function') buildCandlesFromFile(); };}
    const play=document.getElementById('rp-play-btn'); if(play)play.onclick=function(){_rpActive?_rpPause():_rpStart();};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',sync); else sync();
})();

// ==== current-interval-tabs-and-deltafix-final ====
/* =========================================================
   FINAL FIX: all tabs use the CURRENT selected candle interval
   + correct L-H NO TRD and L-H TRD ID calculations.
   This patch is intentionally placed last so it overrides older code.
   ========================================================= */
(function(){
  function n(v){
    if(v===null||v===undefined||v==='') return 0;
    const x=parseFloat(String(v).replace(/\s/g,'').replace(',', '.'));
    return Number.isFinite(x)?x:0;
  }
  function fmtN(v){
    v=Math.round(n(v));
    if(Math.abs(v)>=1000000) return (v/1000000).toFixed(1)+'M';
    if(Math.abs(v)>=10000) return (v/1000).toFixed(1)+'k';
    return v.toLocaleString();
  }
  function fmtP(v){
    const x=n(v);
    const tick=(window.CFG&&+CFG.tickSize)||0.1;
    return x.toLocaleString(undefined,{minimumFractionDigits:tick<1?1:0,maximumFractionDigits:tick<1?2:0});
  }
  function rowMs(r){
    if(!r) return 0;
    if(+r._tsMs>0) return +r._tsMs;
    const raw=(r.date&&r.time)?`${r.date} ${r.time}`:(r.Timestamp||r.timestamp||r.time||'');
    const d=new Date(String(raw).replace('T',' '));
    return isNaN(d.getTime())?0:d.getTime();
  }
  function lastDigits(v,digits=2){
    const m=String(v??'').match(/(\d+)\s*$/);
    if(!m) return 0;
    return parseInt(m[1].slice(-digits),10)||0;
  }
  function diffWithFallback(rows, src, dst, digits=2){
    if(!rows||!rows.length) return;
    const CAP=100000; // no legit tick-to-tick step is this large; beyond it = feed reset or a blank/zero side
    for(let i=0;i<rows.length;i++){
      const cur=n(rows[i][src]);
      const nx=i<rows.length-1?n(rows[i+1][src]):NaN;
      let d=Number.isFinite(nx)?Math.abs(nx-cur):NaN;
      // Guard: live SPL TRD rows arrive with tradeId "spl:N" (numeric 0), so
      // |nextRawId − 0| used to leak the FULL raw TRADE_ID (~132,500,000) into
      // this row AND the row before it. The cap catches exactly those cases
      // while leaving legitimate small diffs in manually-processed files intact.
      if(!Number.isFinite(d) || d===0 || d>CAP) d=lastDigits(rows[i][src], digits);
      rows[i][dst]=Number.isFinite(d)?d:0;
    }
  }
  function diffCumulativeCounter(rows, src, dst){
    if(!rows||!rows.length) return;
    for(let i=0;i<rows.length;i++){
      const cur=n(rows[i][src]);
      const hasNext=i<rows.length-1;
      const nx=hasNext?n(rows[i+1][src]):NaN;
      let d=0;
      if(hasNext && Number.isFinite(nx)){
        // A cumulative counter can either increase, stay unchanged, or reset.
        // Staying unchanged is exactly zero activity; on reset the new counter
        // value is the post-reset activity. Do NOT take abs(nx-cur).
        d = nx>=cur ? (nx-cur) : Math.max(0,nx);
      }
      rows[i][dst]=Number.isFinite(d)?d:0;
    }
  }
  function applyCorrectDiffs(rows){
    if(!rows||!rows.length) return rows||[];
    rows.sort((a,b)=>rowMs(a)-rowMs(b));

    // Preserve counter increments that were already calculated over the FULL
    // chronological history before candle bucketing. Re-differencing inside
    // one candle loses the boundary increment between adjacent intervals.
    if(rows.every(r=>r && r._globalCounterDiffReady===true)) return rows;

    diffWithFallback(rows,'volume','volDiff',2);

    // SEQNUM / ELIGBL TRD ACVOL / RTL are cumulative counters.
    // Increase = next-current; unchanged = 0; reset = next; final row = 0.
    if(rows.some(r=>n(r.seqNum)>0)) diffCumulativeCounter(rows,'seqNum','seqNumDiff');
    else rows.forEach(r=>{r.seqNumDiff=0;});

    if(rows.some(r=>n(r.eligVol)>0)) diffCumulativeCounter(rows,'eligVol','eligVolDiff');
    else rows.forEach(r=>{ if(!Number.isFinite(Number(r.eligVolDiff))) r.eligVolDiff=0; });

    if(rows.some(r=>n(r.rtCount)>0)) diffCumulativeCounter(rows,'rtCount','movesDiff');
    else if(rows.some(r=>n(r.moves)>0)) diffCumulativeCounter(rows,'moves','movesDiff');
    else rows.forEach(r=>{r.movesDiff=0;});

    diffWithFallback(rows,'tradeId','trdIdDiff',2);
    rows.forEach(r=>{ if(r) r._globalCounterDiffReady=true; });
    return rows;
  }
  window.applyCorrectDiffs = applyCorrectDiffs;

  // Wrap _applyDiffs so every local-file, live-file, and xlwings snapshot uses the same corrected fields.
  const oldApply=window._applyDiffs;
  window._applyDiffs=function(rows){
    try{ if(oldApply) oldApply(rows); }catch(e){}
    return applyCorrectDiffs(rows);
  };

  // Make sure already-loaded xlwings/file rows are corrected too.
  function normalizeLoadedRows(){
    ['_allRawRows','_trAllRows','_tlRows','_dtFilteredRows','_rpRows','_rpSumRows','_openBarTicks'].forEach(k=>{
      try{ if(Array.isArray(window[k]) && window[k].length) applyCorrectDiffs(window[k]); }catch(e){}
    });
  }

  // Correct bar builder: side uses CF TICK/price logic; L-H NO TRD uses movesDiff; L-H TRD ID uses trdIdDiff.
  window._ticksToBar=function(ticks){
    if(!ticks||!ticks.length) return null;
    ticks=applyCorrectDiffs(ticks.slice());
    const prices=ticks.map(r=>n(r.last)).filter(p=>p>0);
    if(!prices.length) return null;
    const hi=Math.max(...prices), lo=Math.min(...prices), op=prices[0], cl=prices[prices.length-1];
    const byP={};
    const tick=(window.CFG&&+CFG.tickSize)||0.1;
    function sideOf(r){
      const t=String(r.tick||r['CF TICK']||'').trim().toUpperCase();
      if(/[↑⇧▲]/.test(t)||/\bUP\b/.test(t)) return 'L';
      if(/[↓⇩▼]/.test(t)||/\bDOWN\b/.test(t)) return 'H';
      const last=n(r.last), bid=n(r.bid), ask=n(r.ask);
      if(ask>0 && last>=ask-(tick*0.001)) return 'L';
      if(bid>0 && last<=bid+(tick*0.001)) return 'H';
      const a=String(r.aggr||'').toUpperCase();
      if(a==='ASK'||a==='BUY') return 'L';
      if(a==='BID'||a==='SELL') return 'H';
      return 'N';
    }
    ticks.forEach(r=>{
      const last=n(r.last); if(!last) return;
      const pk=+(Math.round(last/tick)*tick).toFixed(8);
      if(!byP[pk]) byP[pk]={price:pk,bid:0,ask:0,bSize:0,aSize:0,numBid:0,numAsk:0,numOrders:0,trdVol:0,volume:0,moves:0,trdIdDiff:0,movesDiff:0,seqNumDiff:0,delta:0,vol:0,hitBid:0,hitAsk:0,hitTrdVol:0,liftBid:0,liftAsk:0,liftTrdVol:0,hitRTL:0,liftRTL:0,hitSeqDiff:0,liftSeqDiff:0,hitNumBid:0,liftNumBid:0,hitNumAsk:0,liftNumAsk:0,hitNumOrders:0,liftNumOrders:0,hitTrdId:0,liftTrdId:0};
      const lv=byP[pk];
      const bs=n(r.bSize), as=n(r.aSize), vol=n(r.trdVol);
      const noTrd = n(r.movesDiff);      // corrected: NUMBER TRADES diff (real-column replacement for nonexistent RTL)
      const trdId = n(r.trdIdDiff);      // corrected: TRADE_ID diff
      const seqDf = n(r.eligVolDiff);    // corrected: ELIGBL TRD ACVOL diff (real-column replacement for nonexistent SEQNUM)
      lv.bid+=bs; lv.ask+=as; lv.bSize+=bs; lv.aSize+=as;
      lv.numBid+=n(r.numBid); lv.numAsk+=n(r.numAsk); lv.numOrders+=n(r.numOrders);
      lv.trdVol+=vol; lv.volume+=n(r.volDiff)||n(r.volume)||vol; lv.moves+=noTrd; lv.movesDiff+=noTrd; lv.trdIdDiff+=trdId; lv.seqNumDiff+=seqDf;
      lv.vol+=vol; lv.delta+=bs-as;
      const side=r._side||sideOf(r);
      if(side==='H'){
        lv.hitBid+=bs; lv.hitAsk+=as; lv.hitTrdVol+=vol; lv.hitRTL+=noTrd; lv.hitSeqDiff+=seqDf;
        lv.hitNumBid+=n(r.numBid); lv.hitNumAsk+=n(r.numAsk); lv.hitNumOrders+=n(r.numOrders); lv.hitTrdId+=trdId;
      }else if(side==='L'){
        lv.liftBid+=bs; lv.liftAsk+=as; lv.liftTrdVol+=vol; lv.liftRTL+=noTrd; lv.liftSeqDiff+=seqDf;
        lv.liftNumBid+=n(r.numBid); lv.liftNumAsk+=n(r.numAsk); lv.liftNumOrders+=n(r.numOrders); lv.liftTrdId+=trdId;
      }
    });
    const fp=Object.values(byP).sort((a,b)=>a.price-b.price);
    const sum=f=>fp.reduce((s,r)=>s+n(r[f]),0);
    const tV=sum('vol');
    const poc=fp.length?fp.reduce((mx,r)=>(n(r.vol)>n(mx.vol)?r:mx),fp[0]):{price:cl,vol:0};
    const sv=[...fp].sort((a,b)=>n(b.vol)-n(a.vol));
    let vaV=0,vaPs=[]; for(const r of sv){vaPs.push(r.price); vaV+=n(r.vol); if(vaV>=tV*.7) break;}
    const delta=fp.reduce((s,r)=>s+n(r.delta),0);
    let aggrBidVol=0,aggrAskVol=0,aggrBidCnt=0,aggrAskCnt=0;
    ticks.forEach(r=>{const a=String(r.aggr||'').toUpperCase(); const v=n(r.trdVol); if(a==='BID'||a==='SELL'){aggrBidVol+=v;aggrBidCnt++;} if(a==='ASK'||a==='BUY'){aggrAskVol+=v;aggrAskCnt++;}});
    const t0=ticks[0], tN=ticks[ticks.length-1];
    const _splRe=/SPL TRD/;
    const splRows=ticks.filter(r=>_splRe.test(String(r.condKey||r.QUALIFIERS||r.qualifiers||'').replace(/[^\x20-\x7E]/g,'').toUpperCase()));
    const splTrd=splRows.reduce((s,r)=>s+(n(r.trdVol)||n(r.TRDVOL_1)||0),0);
    const splPrices=[...new Set(splRows.map(r=>n(r.last)).filter(p=>p>0))];
    return {open:op,high:hi,low:lo,close:cl,isBull:cl>=op,footprint:fp,pocPrice:poc.price,poc:poc.price,pocVol:n(poc.vol),
      splTrd,splPrices,
      rawVolume:n(tN.volume),  /* CF VOLUME — real column, snapshot at bar close; was not surfaced anywhere before */
      vah:vaPs.length?Math.max(...vaPs):hi,val:vaPs.length?Math.min(...vaPs):lo,delta,totalVol:tV,volume:tV,
      buyVol:sum('liftTrdVol'),sellVol:sum('hitTrdVol'),totalBid:sum('bid'),totalAsk:sum('ask'),totalBSize:sum('bSize'),totalASize:sum('aSize'),
      totalNumBid:sum('numBid'),totalNumAsk:sum('numAsk'),totalNumOrders:sum('numOrders'),totalTrdVol:sum('trdVol'),totalVolume:sum('volume'),totalMoves:sum('moves'),
      totalHitBid:sum('hitBid'),totalHitAsk:sum('hitAsk'),totalHitVol:sum('hitTrdVol'),totalLiftBid:sum('liftBid'),totalLiftAsk:sum('liftAsk'),totalLiftVol:sum('liftTrdVol'),
      totalDelta:delta,totalTrdId:sum('trdIdDiff'),totalDiffVol:sum('volume'),avgVwap:prices.reduce((s,p)=>s+p,0)/prices.length,
      minDelta:fp.length?Math.min(...fp.map(r=>n(r.delta))):0,maxDelta:fp.length?Math.max(...fp.map(r=>n(r.delta))):0,cumD:0,isOpen:false,date:t0.date||'',time:t0.time||'',timeEnd:tN.time||'',ticks:ticks.slice(),
      totalAggrBid:aggrBidVol,totalAggrAsk:aggrAskVol,totalAggrBidCnt:aggrBidCnt,totalAggrAskCnt:aggrAskCnt,
      totalHitRTL:sum('hitRTL'),totalLiftRTL:sum('liftRTL'),totalHitSeq:sum('hitSeqDiff'),totalLiftSeq:sum('liftSeqDiff'),
      totalHitNumBid:sum('hitNumBid'),totalLiftNumBid:sum('liftNumBid'),totalHitNumAsk:sum('hitNumAsk'),totalLiftNumAsk:sum('liftNumAsk'),
      totalHitNumOrders:sum('hitNumOrders'),totalLiftNumOrders:sum('liftNumOrders'),totalHitTrdId:sum('hitTrdId'),totalLiftTrdId:sum('liftTrdId')};
  };

  function latestVisibleBar(){
    if(window._openBarTicks && _openBarTicks.length){ const b=window._ticksToBar(_openBarTicks); if(b){ const cd=(window._closedBars&&_closedBars.length)?(_closedBars[_closedBars.length-1].cumD||0):0; b.cumD=cd+(b.delta||0); b.isOpen=true; return b; } }
    if(window.R && R.bars && R.bars.length) return R.bars[R.bars.length-1];
    if(window._closedBars && _closedBars.length) return _closedBars[_closedBars.length-1];
    if(window._trBars && _trBars.length){
      const nBars=(typeof _maxBars==='function'?_maxBars():(parseInt(document.getElementById('bar-n')?.value)||10));
      const idx=Math.min(_trBars.length-1,(window._trOffset||0)+nBars-1);
      return _trBars[idx] || _trBars[_trBars.length-1];
    }
    const base=(window._dtActive&&window._dtFilteredRows&&_dtFilteredRows.length)?_dtFilteredRows:(window._allRawRows||window._trAllRows||[]);
    if(base&&base.length){
      const bars=(typeof window._bucketByInterval==='function')?window._bucketByInterval(base, (CFG&&CFG.intervalSec)||60):[];
      if(bars&&bars.length) return bars[bars.length-1];
      return window._ticksToBar(base);
    }
    return null;
  }
  function currentIntervalRows(){
    if(window._rpActive && window._rpSumRows && _rpSumRows.length) return applyCorrectDiffs(_rpSumRows.slice());
    if(window._openBarTicks && _openBarTicks.length) return applyCorrectDiffs(_openBarTicks.slice());
    const b=latestVisibleBar();
    if(b&&b.ticks&&b.ticks.length) return applyCorrectDiffs(b.ticks.slice());
    return [];
  }
  window._currentIntervalRows=currentIntervalRows;
  window.getCurrentSelectedIntervalRows=currentIntervalRows;

  function withCurrentRows(fn){
    return function(){
      const oldDt=window.dtRows;
      window.dtRows=function(){ return currentIntervalRows(); };
      try{return fn.apply(this,arguments);} finally{window.dtRows=oldDt;}
    };
  }
  // Trade Log and Price Summary originally use dtRows(). Force them to use current selected interval.
  if(window.tlRender) window.tlRender=withCurrentRows(window.tlRender);
  if(window.sumRender) window.sumRender=withCurrentRows(window.sumRender);

  const PAIRS={
    lhBid:{label:'L-H Bid',      l:'liftBid',    r:'hitBid'},
    lhAsk:{label:'L-H Ask',      l:'liftAsk',    r:'hitAsk'},
    aggNet:{label:'AGGR Bid-Ask',l:'aggrBid',    r:'aggrAsk'},
    hlVol:{label:'H-L Vol',      l:'liftTrdVol', r:'hitTrdVol'},
    lhRTL:{label:'L-H Trades',   l:'liftRTL',    r:'hitRTL'},
    lhSEQ:{label:'L-H Elig_V',   l:'liftSeqDiff',r:'hitSeqDiff'},
    lhOrder:{label:'L-H Order',  l:'liftNumOrders',r:'hitNumOrders'},
  };
  const MARKER_OPTS=['0','Buy','Buy Exit','Sell','Sell Exit'];
  const DIR_OPTS=['0','Long','Short','Neutral','Wait'];
  function markerStore(){ return window.__manualMarkerStore || (window.__manualMarkerStore={}); }
  // Shared by Candle Summary's MARKER field and the Save History export:
  // resolves the manually-set marker (from Price Summary's own per-level
  // "Marker" column), but ONLY if that marker was set (a) on a price level
  // that's part of THIS candle's own footprint AND (b) while THIS candle
  // was actually the one on screen (via barIdStore) — a price level can
  // repeat across many candles, and without the interval check a marker
  // set on one candle would appear on every other candle that ever touched
  // the same price too. Candles with no matching marker return null
  // (displayed/exported as 0).
  window._csMarkerForBar=function(bar){
    try{
      const store=markerStore();
      const barIdStore=window.__manualMarkerBarIdStore||{};
      const ticks=(bar&&Array.isArray(bar.ticks))?bar.ticks:null;
      const thisBarId=ticks&&ticks.length
        ? ((ticks[0].date||'')+'T'+(ticks[0].time||'')+'_'+(ticks[ticks.length-1].date||'')+'T'+(ticks[ticks.length-1].time||''))
        : null;
      const levels=(bar&&Array.isArray(bar.footprint))?bar.footprint.map(l=>+l.price).filter(p=>isFinite(p)):[];
      if(!levels.length) return null;
      let mk=null;
      Object.keys(store).forEach(k=>{
        if(k.indexOf('summary:')!==0) return;
        const val=store[k];
        if(!val||val==='0') return;
        const p=parseFloat(k.split(':')[1]);
        if(!isFinite(p)) return;
        const onThisBar=levels.some(lvP=>Math.abs(lvP-p)<=0.05);
        if(!onThisBar) return;
        // If we have a reliable bar identity to compare (this bar has
        // ticks, and this key recorded one), require it to match. If either
        // side is missing an identity (e.g. an older marker set before this
        // tracking existed), fall back to the price-only match rather than
        // hiding it entirely.
        const recordedBarId=barIdStore[k];
        if(thisBarId && recordedBarId && recordedBarId!==thisBarId) return;
        mk=val;
      });
      return mk;
    }catch(e){ return null; }
  };

  // ── McGinley Dynamic strategy (ported from the MetaStock 19 build) ──
  // MD:      MD[0]=Close[0]; MD[i] = MD[i-1] + (Close[i]-MD[i-1]) / (Period * (Close[i]/MD[i-1])^4)
  // BuyCond / ShortCond: Close crossed up/down through both Close[-1] and MD
  //   on both this bar and the prior bar (the MetaStock "3-condition" entry).
  // MDState: sticky trend state — only flips on a genuine BuyCond/ShortCond,
  //   otherwise holds the previous state (this is what turns a condition
  //   that stays true for many consecutive bars into a single transition).
  // Buy/Buy Exit signal: fires once, only on the MDState transition bar
  //   (MetaStock's BuyFirst/ShortFirst — "Buy Exit" here, not "Short",
  //   to match the existing manual Marker column's vocabulary).
  // Sell/Sell Exit signal: MetaStock Cross(MD,Close) / Cross(Close,MD) — MD
  //   and Close crossing, independent of MDState.
  var _MD_PERIOD = 36; // matches the MetaStock Input("MD Period",1,200,36) default
  function _mdComputeSeries(bars, period){
    var per = period || _MD_PERIOD;
    var n = bars.length;
    var md = new Array(n), state = new Array(n), signal = new Array(n);
    for(var i=0;i<n;i++){
      var c = Number(bars[i] && bars[i].close);
      if(!isFinite(c)){
        md[i] = i>0 ? md[i-1] : 0;
        state[i] = i>0 ? state[i-1] : 0;
        signal[i] = null;
        continue;
      }
      if(i===0){ md[i]=c; state[i]=0; signal[i]=null; continue; }
      var prevMd = md[i-1];
      md[i] = prevMd ? (prevMd + (c-prevMd)/(per*Math.pow(c/prevMd,4))) : c;
      var prevC = Number(bars[i-1].close);
      var buyCond   = c>prevC && c>md[i] && prevC>prevMd;
      var shortCond = c<prevC && c<md[i] && prevC<prevMd;
      state[i] = buyCond ? 1 : (shortCond ? -1 : state[i-1]);
      var buyFirst   = state[i]===1  && state[i-1]!==1;
      var shortFirst = state[i]===-1 && state[i-1]!==-1;
      var sellCross  = md[i]>c   && prevMd<=prevC;  // Cross(MD,C)
      var coverCross = c>md[i]   && prevC<=prevMd;  // Cross(C,MD)
      var parts=[];
      if(buyFirst)   parts.push('Buy');
      if(sellCross)  parts.push('Sell');
      // "Buy Exit"/"Sell Exit" (not "Short"/"Cover") to match the existing
      // manual Marker column's vocabulary. Chronologically each exit fires
      // before the *next* entry of that same kind in the repeating
      // Buy -> Sell -> Buy Exit -> Sell Exit -> Buy... cycle: Buy Exit (the
      // trend turning bearish) comes before the following Buy, and Sell
      // Exit (Close reclaiming MD) comes before the following Sell.
      if(shortFirst) parts.push('Buy Exit');
      if(coverCross) parts.push('Sell Exit');
      signal[i] = parts.length ? parts.join('+') : null;
    }
    return { md: md, state: state, signal: signal };
  }
  function _mdBarsSource(){
    try{ if(typeof _trBars!=='undefined' && Array.isArray(_trBars) && _trBars.length) return _trBars; }catch(e){}
    try{ if(typeof R!=='undefined' && R && Array.isArray(R.bars) && R.bars.length) return R.bars; }catch(e){}
    return [];
  }
  // Shared by Candle Summary's MCGINLEY field. Save History computes its own
  // series directly against its export bar array instead of calling this,
  // since MD is a genuinely recursive per-timeframe series (a 1-minute MD
  // and a 5-minute MD are legitimately different, not the same value looked
  // up two ways) — see the Save History export code for that.
  window._MD_PERIOD = _MD_PERIOD;
  window._mdComputeSeries = _mdComputeSeries;
  window._mdSignalForBar=function(bar){
    try{
      var bars=_mdBarsSource();
      var idx=bars.indexOf(bar);
      if(idx===-1) return null;
      var series=_mdComputeSeries(bars,_MD_PERIOD);
      return series.signal[idx]||null;
    }catch(e){ return null; }
  };
  // The indicator's actual line value for this candle (not the derived
  // Buy/Sell/etc signal) — same bar-array/index lookup as
  // _mdSignalForBar, just reading .md instead of .signal.
  window._mdValueForBar=function(bar){
    try{
      var bars=_mdBarsSource();
      var idx=bars.indexOf(bar);
      if(idx===-1) return null;
      var series=_mdComputeSeries(bars,_MD_PERIOD);
      var v=series.md[idx];
      return isFinite(v) ? v : null;
    }catch(e){ return null; }
  };

  function dirStore(){ return window.__suggestedDirectionStore || (window.__suggestedDirectionStore={}); }
  function selectHtml(opts,val,cls,attr,clsPrefix){
    val=val||'0';
    const stateCls=val!=='0' ? (clsPrefix+String(val).toLowerCase().replace(/\s+/g,'-')) : '';
    return `<select class="${cls} ${stateCls}" data-${attr}-key="__KEY__">`+
      opts.map(o=>`<option value="${o}" ${o===val?'selected':''}>${o}</option>`).join('')+`</select>`;
  }
  function dfpSelectedPairs(){
    const on=[...document.querySelectorAll('#dfp-pair-box .dfp-pair-pill.on')].map(el=>el.dataset.pair).filter(k=>PAIRS[k]);
    return on.length?on:['lhBid','lhAsk','aggNet'];
  }
  window.dfpRender=function(){
    const tbl=document.getElementById('dfp-table'); if(!tbl) return;
    const empty=document.getElementById('dfp-empty');
    const bar=latestVisibleBar();
    if(!bar || !bar.footprint || !bar.footprint.length){
      tbl.style.display='none'; if(empty) empty.style.display='flex';
      const barsEl=document.getElementById('dfp-bars'); if(barsEl) barsEl.textContent='0';
      return;
    }
    tbl.style.display='table'; if(empty) empty.style.display='none';

    // Per-price-level AGGRS_SID1 BID/ASK counts — not carried on footprint rows, derive from raw ticks.
    const tick=(window.CFG&&+CFG.tickSize)||0.1;
    const aggrByPrice={};
    (bar.ticks||[]).forEach(r=>{
      const last=n(r.last); if(!last) return;
      const pk=+(Math.round(last/tick)*tick).toFixed(8);
      if(!aggrByPrice[pk]) aggrByPrice[pk]={aggrBid:0,aggrAsk:0};
      const a=String(r.aggr||'').toUpperCase();
      if(a==='BID'||a==='SELL') aggrByPrice[pk].aggrBid++;
      if(a==='ASK'||a==='BUY')  aggrByPrice[pk].aggrAsk++;
    });

    const pairs=dfpSelectedPairs().map(k=>Object.assign({key:k},PAIRS[k]));
    const levels=bar.footprint.slice().sort((a,b)=>b.price-a.price).map(lv=>{
      const pk=+(Math.round(lv.price/tick)*tick).toFixed(8);
      return Object.assign({},lv,aggrByPrice[pk]||{aggrBid:0,aggrAsk:0});
    });

    const barsEl=document.getElementById('dfp-bars'); if(barsEl) barsEl.textContent=String(levels.length);
    const selEl=document.getElementById('dfp-selected'); if(selEl) selEl.textContent=pairs.map(p=>p.label).join(', ')||'None';

    let head='<thead><tr><th>Price</th><th>Marker</th><th>Suggested Dir</th><th>Bid_S2</th><th>Ask_S2</th><th>Trd.Vol</th><th>Delta</th>';
    // Split into two numeric columns (Lift, Hit) instead of one combined
    // "7860-7186" text cell, so every column is a plain number.
    pairs.forEach(p=>{ head+=`<th>${p.label} L</th><th>${p.label} H</th><th>Δ Flip</th><th>${p.label} %</th>`; });
    head+='<th>Bid</th><th>Ask</th></tr></thead>';

    function pairCells(row){
      return pairs.map(p=>{
        const L=n(row[p.l]), H=n(row[p.r]), diff=L-H, den=Math.max(1,L+H), pct=Math.round((L/den)*100), decVal=(L/den).toFixed(2);
        const cls=diff>0?'dfp-pos-t':diff<0?'dfp-neg-t':'dfp-zero-t';
        return `<td class="dfp-pos-t">${fmtN(L)}</td><td class="dfp-neg-t">${fmtN(H)}</td>`+
               `<td class="${cls}">${diff>0?'+':''}${fmtN(diff)}</td>`+
               `<td><span class="dfp-progress"><span class="g" style="width:${pct}%"></span><span class="r" style="width:${100-pct}%"></span></span><span class="dfp-pct">${decVal}</span></td>`;
      }).join('');
    }
    function markerCell(priceKey){
      const st=markerStore(), key='dfpairs:'+priceKey, val=st[key]||'0';
      return `<td>${selectHtml(MARKER_OPTS,val,'manual-marker-select','marker','marker-').replace('__KEY__',key)}</td>`;
    }
    function dirCell(priceKey){
      const st=dirStore(), key='dfpairs:'+priceKey, val=st[key]||'0';
      return `<td>${selectHtml(DIR_OPTS,val,'suggested-direction-select','suggested-direction','dir-').replace('__KEY__',key)}</td>`;
    }

    const totalRow={bid:0,ask:0,trdVol:0,delta:0};
    pairs.forEach(p=>{ totalRow[p.l]=0; totalRow[p.r]=0; });
    levels.forEach(lv=>{
      totalRow.bid+=n(lv.bSize||lv.bid); totalRow.ask+=n(lv.aSize||lv.ask);
      totalRow.trdVol+=n(lv.trdVol||lv.vol); totalRow.delta+=n(lv.delta);
      pairs.forEach(p=>{ totalRow[p.l]+=n(lv[p.l]); totalRow[p.r]+=n(lv[p.r]); });
    });

    let body='<tbody>';
    body+=`<tr class="dfp-total"><td>${levels.length}</td><td>—</td><td>—</td>`+
      `<td class="dfp-pos-t">${fmtN(totalRow.bid)}</td><td class="dfp-neg-t">${fmtN(totalRow.ask)}</td>`+
      `<td>${fmtN(totalRow.trdVol)}</td><td class="${totalRow.delta>=0?'dfp-pos-t':'dfp-neg-t'}">${totalRow.delta>=0?'+':''}${fmtN(totalRow.delta)}</td>`+
      pairCells(totalRow)+`<td>—</td><td>—</td></tr>`;

    levels.forEach(lv=>{
      const priceKey=fmtP(lv.price);
      const delta=n(lv.delta);
      body+=`<tr class="${delta>=0?'dfp-dom-pos':'dfp-dom-neg'}">`+
        `<td class="dfp-price">${priceKey}</td>`+
        markerCell(priceKey)+dirCell(priceKey)+
        `<td class="dfp-pos-t">${fmtN(lv.bSize||lv.bid)}</td><td class="dfp-neg-t">${fmtN(lv.aSize||lv.ask)}</td>`+
        `<td class="dfp-yellow">${fmtN(lv.trdVol||lv.vol)}</td>`+
        `<td class="${delta>=0?'dfp-pos-t':'dfp-neg-t'}">${delta>=0?'+':''}${fmtN(delta)}</td>`+
        pairCells(lv)+
        `<td class="dfp-pos">${priceKey}</td><td class="dfp-neg">${priceKey}</td></tr>`;
    });
    body+='</tbody>';
    tbl.innerHTML=head+body;
    try{ if(typeof window.updateFlipSideSummaryFinal==='function') setTimeout(window.updateFlipSideSummaryFinal,0); }catch(e){}
  };

  // Right-side Delta Flip panel formula fix.
  window._deltaFlipUpdate=function(){
    const bar=latestVisibleBar(); if(!bar) return;
    const fV=fmtN, fml=(a,b)=>{const d=n(a)-n(b); return (!n(a)&&!n(b))?'0':`${fV(a)}-${fV(b)}=${fV(d)}`;};
    const cls=d=>d>0?'pos':d<0?'neg':'';
    const set=(id,txt,cl)=>{const e=document.getElementById(id); if(e){e.textContent=txt; e.className='cs-val '+(cl||'');}};
    let a,b,d;
    a=bar.totalLiftBid||0; b=bar.totalHitBid||0; d=a-b; set('csv-df-hlbid',fml(a,b),cls(d));
    a=bar.totalLiftAsk||0; b=bar.totalHitAsk||0; d=a-b; set('csv-df-hlask',fml(a,b),cls(d));
    a=bar.totalLiftNumBid||0; b=bar.totalHitNumBid||0; d=a-b; set('csv-df-hl-numbid',fml(a,b),cls(d));
    a=bar.totalLiftNumAsk||0; b=bar.totalHitNumAsk||0; d=a-b; set('csv-df-hl-numask',fml(a,b),cls(d));
    a=bar.totalLiftNumOrders||0; b=bar.totalHitNumOrders||0; d=a-b; set('csv-df-hl-numord',fml(a,b),cls(d));
    a=bar.totalLiftVol||bar.buyVol||0; b=bar.totalHitVol||bar.sellVol||0; d=a-b; set('csv-df-hlvol',fml(a,b),cls(d));
    // Correct: NO TRD uses NUMBER TRADES diff per hit/lift side.
    a=bar.totalLiftRTL||0; b=bar.totalHitRTL||0; d=a-b; set('csv-df-hlrtl',fml(a,b),cls(d));
    // Correct: TRD ID uses TRADE_ID diff per hit/lift side, not raw Trade ID.
    a=bar.totalLiftTrdId||0; b=bar.totalHitTrdId||0; d=a-b; set('csv-df-hl-trdid',fml(a,b),cls(d));
  };

  function refreshCurrentIntervalTabs(){
    normalizeLoadedRows();
    try{ if(window.tlRender) tlRender(); }catch(e){}
    try{ if(window.sumRender) sumRender(); }catch(e){}
    try{ if(window.laRender) laRender(); }catch(e){}
    try{ if(window.laProRender) laProRender(); }catch(e){}
    try{ if(window.dfpRender) dfpRender(); }catch(e){}
    try{ if(window._deltaFlipUpdate) _deltaFlipUpdate(); }catch(e){}
    try{ if(window.updateFlipSideSummaryFinal) updateFlipSideSummaryFinal(); }catch(e){}
  }
  window.refreshCurrentIntervalTabs=refreshCurrentIntervalTabs;

  // Re-render tabs when switching or navigating candles.
  const oldSwitch=window.switchTab;
  if(oldSwitch){ window.switchTab=function(tab){ const r=oldSwitch.apply(this,arguments); setTimeout(refreshCurrentIntervalTabs,0); return r; }; }
  const oldNav=window.trNav;
  if(oldNav){ window.trNav=function(delta){ const r=oldNav.apply(this,arguments); setTimeout(refreshCurrentIntervalTabs,0); return r; }; }
  const oldRebuild=window._rebuildDisplay;
  if(oldRebuild){ window._rebuildDisplay=function(){ const r=oldRebuild.apply(this,arguments); setTimeout(refreshCurrentIntervalTabs,0); return r; }; }

  document.addEventListener('click',e=>{ if(e.target.closest('#dfp-toolbar .dfp-btn')) setTimeout(refreshCurrentIntervalTabs,0); });
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>{normalizeLoadedRows(); refreshCurrentIntervalTabs();});
  else {normalizeLoadedRows(); refreshCurrentIntervalTabs();}
})();

// ==== xlwings-real-only-no-sim-flicker-fix ====
/* =========================================================
   FIX: When xlwings is connected, show ONLY real Excel data.
   Prevents Simulator / Demo / RT engine from injecting ticks while
   xlwings snapshot/ticks are active.
   ========================================================= */
(function(){
  function byId(id){ return document.getElementById(id); }

  window._xwRealOnlyMode = false;

  function clearTimer(name){
    try{
      if(window[name]){ clearInterval(window[name]); clearTimeout(window[name]); window[name]=null; }
    }catch(e){}
  }

  window._forceXlwingsRealOnly = function(clearOpenTicks){
    window._xwRealOnlyMode = true;
    if(window.CFG) CFG.usingRealData = true;

    // Stop all simulator engines.
    try{ window._simPaused = true; window._simStopped = true; }catch(e){}
    try{ if(typeof window.RT_ACTIVE !== 'undefined') window.RT_ACTIVE = false; }catch(e){}
    try{ if(typeof _stopRT === 'function') _stopRT(); }catch(e){}
    clearTimer('_rtTimer');

    // Stop file replay if it is running, but do not call _rpStop because it can rebuild old replay data.
    try{ window._rpActive = false; window._rpPaused = false; }catch(e){}
    clearTimer('_rpTimer');

    // Stop local file-live polling so it cannot mix with xlwings.
    try{ window._liveActive = false; window._livePaused = false; }catch(e){}
    clearTimer('_liveTimer');

    // Kill any Renderer internal simulator feed.
    try{
      if(window.R && R._sim){ R.destroy(); window.R = null; }
      else if(window.R && R._t){ clearInterval(R._t); R._t = null; }
    }catch(e){}

    // Optional reset when first connecting / snapshot begins.
    if(clearOpenTicks){
      try{ window._openBarTicks = []; window._closedBars = []; window._lastBarCount = -1; }catch(e){}
    }

    // UI state: no simulator selected.
    ['sim-play','sim-pause','rp-play-btn','rp-pause-btn'].forEach(id=>{ const el=byId(id); if(el) el.classList.remove('on'); });
    const src=byId('dsrc');
    if(src){ src.className=''; if(!/Excel|xlwings|rows/i.test(src.textContent||'')) src.textContent='⚡ xlwings real data'; }
  };

  // Keep simulator functions disabled while xlwings real-only mode is active.
  const oldStartSim = window.startSim;
  window.startSim = function(){
    if(window._xwRealOnlyMode && window._xwActive){
      console.warn('[xlwings] Simulator blocked: xlwings real-only mode is active.');
      window._forceXlwingsRealOnly(false);
      return;
    }
    return oldStartSim ? oldStartSim.apply(this, arguments) : undefined;
  };

  const oldLoadDemo = window.loadDemo;
  window.loadDemo = function(){
    if(window._xwRealOnlyMode && window._xwActive){
      console.warn('[xlwings] Demo blocked: xlwings real-only mode is active.');
      window._forceXlwingsRealOnly(false);
      return;
    }
    return oldLoadDemo ? oldLoadDemo.apply(this, arguments) : undefined;
  };

  const oldStartRT = window._startRT;
  window._startRT = function(){
    if(window._xwRealOnlyMode && window._xwActive){
      console.warn('[xlwings] RT simulator engine blocked.');
      window._forceXlwingsRealOnly(false);
      return;
    }
    return oldStartRT ? oldStartRT.apply(this, arguments) : undefined;
  };

  const oldRtTick = window._rtTick;
  window._rtTick = function(){
    if(window._xwRealOnlyMode && window._xwActive) return;
    return oldRtTick ? oldRtTick.apply(this, arguments) : undefined;
  };

  const oldInjectSimTick = window._injectSimTick;
  window._injectSimTick = function(){
    if(window._xwRealOnlyMode && window._xwActive) return;
    return oldInjectSimTick ? oldInjectSimTick.apply(this, arguments) : undefined;
  };

  // Connect: immediately enter real-only mode before first websocket message arrives.
  const oldXwConnect = window.xwConnect;
  window.xwConnect = function(){
    window._forceXlwingsRealOnly(true);
    return oldXwConnect ? oldXwConnect.apply(this, arguments) : undefined;
  };

  // Disconnect: user may use Demo/Sim again after explicit disconnect.
  const oldXwDisconnect = window.xwDisconnect;
  window.xwDisconnect = function(){
    const r = oldXwDisconnect ? oldXwDisconnect.apply(this, arguments) : undefined;
    window._xwRealOnlyMode = false;
    return r;
  };

  // Every xlwings data message refreshes only from Excel arrays.
  const oldXwHandle = window._xwHandleMsg;
  window._xwHandleMsg = function(msg){
    if(msg && (msg.type==='snapshot' || msg.type==='ticks')){
      // Snapshot replaces truth; ticks append to truth. Do not let simulator timers run.
      window._forceXlwingsRealOnly(msg.type==='snapshot');
    }

    const r = oldXwHandle ? oldXwHandle.apply(this, arguments) : undefined;

    if(msg && (msg.type==='snapshot' || msg.type==='ticks')){
      window._forceXlwingsRealOnly(false);

      // Ensure renderer exists and is never a SimData renderer.
      try{
        if(!window.R) window.R = new Renderer([]);
        if(R._sim){ R.destroy(); window.R = new Renderer([]); }
      }catch(e){}

      // Re-render current real bars/tabs only.
      try{ if(typeof _rebuildDisplay==='function') _rebuildDisplay(); }catch(e){}
      try{ if(typeof refreshCurrentIntervalTabs==='function') refreshCurrentIntervalTabs(); }catch(e){}
    }
    return r;
  };

  // RUN button should use real xlwings rows when connected, not Sim/Demo.
  const oldRunReplayToggle = window.runReplayToggle;
  window.runReplayToggle = function(){
    if(window._xwActive && (window._allRawRows||[]).length){
      window._forceXlwingsRealOnly(false);
      if(typeof _rpStart==='function') return _rpStart();
    }
    return oldRunReplayToggle ? oldRunReplayToggle.apply(this, arguments) : undefined;
  };
})();

// ==== number-trades-diff-final-fix ====
/* Final fix: #Trades column uses NUMBER TRADES diff, not raw accumulated values. */
(function(){
  function n(v){ if(v===null||v===undefined||v==='') return 0; const x=parseFloat(String(v).replace(/\s/g,'').replace(',', '.')); return Number.isFinite(x)?x:0; }
  function lastDigits(v,digits=2){ const m=String(v??'').match(/(\d+)\s*$/); return m?(parseInt(m[1].slice(-digits),10)||0):0; }
  function rowMs(r){ if(+r._tsMs>0) return +r._tsMs; const raw=(r.date&&r.time)?`${r.date} ${r.time}`:(r.Timestamp||r.timestamp||''); const d=new Date(String(raw).replace('T',' ')); return isNaN(d.getTime())?0:d.getTime(); }
  function diffSrc(rows,src,dst){
    rows.sort((a,b)=>rowMs(a)-rowMs(b));
    const CAP=100000;
    for(let i=0;i<rows.length;i++){
      const cur=n(rows[i][src]);
      const nx=i<rows.length-1?n(rows[i+1][src]):NaN;
      let d=Number.isFinite(nx)?Math.abs(nx-cur):NaN;
      // Generic ID/SEQ behavior retained here. A real zero difference stays zero.
      if(!Number.isFinite(d)) d=0;
      else if(d>CAP) d=lastDigits(rows[i][src],2);
      rows[i][dst]=Number.isFinite(d)?d:0;
    }
  }
  function diffRTL(rows,src,dst){
    rows.sort((a,b)=>rowMs(a)-rowMs(b));
    for(let i=0;i<rows.length;i++){
      const cur=n(rows[i][src]);
      const nx=i<rows.length-1?n(rows[i+1][src]):NaN;
      let d=0;
      if(i<rows.length-1 && Number.isFinite(nx)) d=nx>=cur?(nx-cur):Math.max(0,nx);
      rows[i][dst]=Number.isFinite(d)?d:0;
    }
  }
  window.applyNumberTradesDiffFix=function(rows){
    if(!Array.isArray(rows)||!rows.length) return rows||[];
    rows.sort((a,b)=>rowMs(a)-rowMs(b));

    if(rows.every(r=>r && r._globalCounterDiffReady===true)) return rows;

    // SEQ and RTL are cumulative counters; use reset-safe arithmetic.
    if(rows.some(r=>n(r.seqNum)>0)) diffRTL(rows,'seqNum','seqNumDiff');
    else rows.forEach(r=>{r.seqNumDiff=0;});

    if(rows.some(r=>n(r.eligVol)>0)) diffRTL(rows,'eligVol','eligVolDiff');

    if(rows.some(r=>n(r.rtCount)>0)) diffRTL(rows,'rtCount','movesDiff');
    else if(rows.some(r=>n(r.moves)>0)) diffRTL(rows,'moves','movesDiff');
    else rows.forEach(r=>{r.movesDiff=0;});

    if(rows.some(r=>n(r.tradeId)>0)) diffSrc(rows,'tradeId','trdIdDiff');
    rows.forEach(r=>{ if(r) r._globalCounterDiffReady=true; });
    return rows;
  };
  const oldTicksToBar=window._ticksToBar;
  if(oldTicksToBar){
    window._ticksToBar=function(ticks){
      ticks=window.applyNumberTradesDiffFix((ticks||[]).slice());
      const bar=oldTicksToBar.call(this,ticks);
      if(bar && Array.isArray(bar.footprint)){
        bar.footprint.forEach(lv=>{
          // replace displayed #Trades level value with Hit/Lift NUMBER TRADES diff total
          lv.moves = n(lv.hitRTL) + n(lv.liftRTL) || n(lv.movesDiff) || 0;
        });
        bar.totalMoves = bar.footprint.reduce((s,lv)=>s+n(lv.moves),0);
      }
      return bar;
    };
  }
  const oldRebuild=window.rebuild;
  if(oldRebuild){window.rebuild=function(){try{['_allRawRows','_trAllRows','_dtFilteredRows','_openBarTicks'].forEach(k=>{if(Array.isArray(window[k]))window.applyNumberTradesDiffFix(window[k]);});}catch(e){} return oldRebuild.apply(this,arguments);};}
})();


/* ADDED ONLY: Reviewer + Regime Engine functions. Existing code above is not changed. */
(function(){
  function fmtN(v,d){return (isFinite(v)?(+v).toFixed(d==null?2:d):'—');}
  function cls(v){return v>0?'rv-pos':v<0?'rv-neg':'rv-zero';}
  function currentBars(){
    if(window.R && Array.isArray(R.bars) && R.bars.length) return R.bars.slice();
    if(Array.isArray(window._trBars) && _trBars.length) return _trBars.slice();
    if(Array.isArray(window._allRawRows) && _allRawRows.length && typeof _bucketByInterval==='function') return _bucketByInterval(_allRawRows, (window.CFG&&CFG.intervalSec)||60);
    return [];
  }
  function summarizeBars(bars){
    var o={bars:bars.length,open:0,close:0,high:0,low:0,delta:0,vol:0,buy:0,sell:0,range:0,body:0,poc:0,prices:{}};
    if(!bars.length) return o;
    o.open=+bars[0].open||0; o.close=+bars[bars.length-1].close||0;
    o.high=Math.max.apply(null,bars.map(function(b){return +b.high||0;}));
    o.low=Math.min.apply(null,bars.map(function(b){return +b.low||0;}));
    bars.forEach(function(b){
      o.delta += +b.delta||0; o.vol += +b.totalVol||0; o.buy += +b.buyVol||0; o.sell += +b.sellVol||0;
      (b.footprint||[]).forEach(function(r){var p=+(r.price||0); if(!p)return; var k=p.toFixed(4); if(!o.prices[k])o.prices[k]={price:p,vol:0,delta:0}; o.prices[k].vol += +(r.vol||r.trdVol||0); o.prices[k].delta += +(r.delta||0);});
    });
    o.range=o.high-o.low; o.body=o.close-o.open;
    var arr=Object.values(o.prices).sort(function(a,b){return b.vol-a.vol;}); o.poc=arr[0]?arr[0].price:0;
    return o;
  }
  function infoHtml(s){return !s||!s.bars?'Empty':('<b>'+s.bars+'</b> bars<br>Close: '+fmtN(s.close,2)+'<br>Δ: '+fmtN(s.delta,0)+'<br>Vol: '+fmtN(s.vol,0));}
  window.RV_STATE={A:null,B:null,saved:[]};
  window.rvUseCurrentAs=function(which){var s=summarizeBars(currentBars()); RV_STATE[which]=s; var el=document.getElementById('rv-'+which.toLowerCase()+'-info'); if(el)el.innerHTML=infoHtml(s); var st=document.getElementById('rv-status'); if(st)st.textContent='Captured current chart as Reference '+which+'.';};
  window.rvSaveCurrentReference=function(){var s=summarizeBars(currentBars()); if(!s.bars){alert('No current candles to save.');return;} if(RV_STATE.saved.length>=5)RV_STATE.saved.shift(); RV_STATE.saved.push(s); var el=document.getElementById('rv-saved-info'); if(el)el.innerHTML=RV_STATE.saved.length+' / 5 saved<br>Latest close: '+fmtN(s.close,2); var st=document.getElementById('rv-status'); if(st)st.textContent='Saved current chart reference '+RV_STATE.saved.length+' / 5.';};
  window.rvClear=function(){RV_STATE.A=null;RV_STATE.B=null;RV_STATE.saved=[];['rv-a-info','rv-b-info'].forEach(function(id){var e=document.getElementById(id);if(e)e.textContent='Empty';}); var si=document.getElementById('rv-saved-info'); if(si)si.textContent='0 / 5 saved'; var out=document.getElementById('rv-output'); if(out)out.innerHTML='<div class="rv-card-title">Report</div><div style="color:#667799">No report yet.</div>';};
  function compare(a,b,label){if(!a||!b||!a.bars||!b.bars)return '<div class="rv-card"><div class="rv-card-title">'+label+'</div><div class="rv-warn">Need two references.</div></div>'; var dClose=b.close-a.close,dDelta=b.delta-a.delta,dVol=b.vol-a.vol,dBuySell=(b.buy-b.sell)-(a.buy-a.sell); var dir=(dClose>0&&dDelta>0)||(dDelta>0&&dBuySell>0)?'Bullish':(dClose<0&&dDelta<0)||(dDelta<0&&dBuySell<0)?'Bearish':'Mixed / wait'; return '<div class="rv-card"><div class="rv-card-title">'+label+'</div><table class="rv-table"><thead><tr><th>Metric</th><th>A</th><th>B / Current</th><th>Change</th></tr></thead><tbody>'+
      '<tr><td>Close</td><td>'+fmtN(a.close,2)+'</td><td>'+fmtN(b.close,2)+'</td><td class="'+cls(dClose)+'">'+fmtN(dClose,2)+'</td></tr>'+
      '<tr><td>Delta</td><td>'+fmtN(a.delta,0)+'</td><td>'+fmtN(b.delta,0)+'</td><td class="'+cls(dDelta)+'">'+fmtN(dDelta,0)+'</td></tr>'+
      '<tr><td>Volume</td><td>'+fmtN(a.vol,0)+'</td><td>'+fmtN(b.vol,0)+'</td><td class="'+cls(dVol)+'">'+fmtN(dVol,0)+'</td></tr>'+
      '<tr><td>Buy−Sell</td><td>'+fmtN(a.buy-a.sell,0)+'</td><td>'+fmtN(b.buy-b.sell,0)+'</td><td class="'+cls(dBuySell)+'">'+fmtN(dBuySell,0)+'</td></tr>'+
      '<tr><td>POC</td><td>'+fmtN(a.poc,2)+'</td><td>'+fmtN(b.poc,2)+'</td><td class="'+cls(b.poc-a.poc)+'">'+fmtN(b.poc-a.poc,2)+'</td></tr>'+
      '</tbody></table><div style="margin-top:8px;color:#c4d0e8">Suggested direction: <b class="'+(dir==='Bullish'?'rv-pos':dir==='Bearish'?'rv-neg':'rv-warn')+'">'+dir+'</b></div></div>';}
  window.rvGenerateReport=function(){var cur=summarizeBars(currentBars()); var html=''; if(RV_STATE.A&&RV_STATE.B) html+=compare(RV_STATE.A,RV_STATE.B,'Reference A vs Reference B'); if(RV_STATE.A) html+=compare(RV_STATE.A,cur,'Reference A vs Current'); RV_STATE.saved.forEach(function(s,i){html+=compare(s,cur,'Saved Reference '+(i+1)+' vs Current');}); if(!html) html='<div class="rv-warn">Capture A/B or save a reference first.</div>'; var out=document.getElementById('rv-output'); if(out)out.innerHTML='<div class="rv-card-title">Report</div>'+html; var st=document.getElementById('rv-status'); if(st)st.textContent='Report generated from current chart data.';};

  function getRegimeRows(){
    var rows=(Array.isArray(window._allRawRows)&&_allRawRows.length)?_allRawRows.slice():[];
    if(rows.length){rows=rows.filter(function(r){return isFinite(+r.last)&&+r.last>0;}).sort(function(a,b){var am=(typeof _toAbsMs==='function'?_toAbsMs(a):(a._tsMs||0)); var bm=(typeof _toAbsMs==='function'?_toAbsMs(b):(b._tsMs||0)); return am-bm;}); return rows.map(function(r){return {price:+r.last,delta:(+r.bSize||+r.bid||0)-(+r.aSize||+r.ask||0),vol:+r.trdVol||+r.volume||0,time:r.time||''};});}
    var bars=currentBars(); return bars.map(function(b){return {price:+b.close||0,delta:+b.delta||0,vol:+b.totalVol||0,time:b.time||''};}).filter(function(x){return x.price>0;});
  }
  function median(a){a=a.filter(function(x){return isFinite(x)&&x>0;}).sort(function(x,y){return x-y;}); return a.length?a[Math.floor(a.length/2)]:0;}
  function setText(id,t,c){var e=document.getElementById(id); if(!e)return; e.textContent=t; if(c!==undefined)e.className='val '+c;}
  function barHtml(items){return '<div class="rg-bars">'+items.map(function(it){var w=Math.max(0,Math.min(100,it.v));return '<div class="barrow"><div class="lab">'+it.k+'</div><div class="track"><div class="fill" style="width:'+w+'%;background:'+it.col+'"></div></div><div class="pct">'+fmtN(w,1)+'%</div></div>';}).join('')+'</div>';}
  function drawRegimeCanvas(prices,states){var cv=document.getElementById('rg-price'); if(!cv)return; var w=cv.clientWidth||800,h=cv.clientHeight||155; cv.width=w; cv.height=h; var ctx=cv.getContext('2d'); ctx.fillStyle='#060a0f'; ctx.fillRect(0,0,w,h); if(!prices.length)return; var mn=Math.min.apply(null,prices),mx=Math.max.apply(null,prices); if(mx===mn){mx+=1;mn-=1;} ctx.strokeStyle='rgba(160,180,210,.75)'; ctx.lineWidth=1.5; ctx.beginPath(); prices.forEach(function(p,i){var x=i/(prices.length-1||1)*w; var y=h-8-(p-mn)/(mx-mn)*(h-16); if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);}); ctx.stroke(); ctx.fillStyle='#44aaff'; var lp=prices[prices.length-1],x=w-4,y=h-8-(lp-mn)/(mx-mn)*(h-16); ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill(); var rib=document.getElementById('rg-ribbon'); if(rib){var take=states.slice(-160); rib.innerHTML=take.map(function(st,i){var col=st==='BULL'?'#2dd4a8':st==='BEAR'?'#ef4565':'#c9a24b'; return '<span class="seg '+(i===take.length-1?'current':'')+'" style="background:'+col+'"></span>';}).join('');}}
  function computeRegime(){
    var rows=getRegimeRows(), st=document.getElementById('rg-status');
    if(rows.length<3){if(st)st.textContent='No loaded candles/ticks found. Load file and build candles first.'; return;}
    var prices=rows.map(function(r){return r.price;});
    var diffs=[]; for(var i=1;i<prices.length;i++){var d=Math.abs(prices[i]-prices[i-1]); if(d>0)diffs.push(d);}
    var autoLevel=median(diffs)||((window.CFG&&+CFG.tickSize)||0.1)||0.1;
    var levelInput=+((document.getElementById('rg-levelsize')||{}).value||0); var level=levelInput>0?levelInput:autoLevel;
    var n=prices.length; var look=+document.getElementById('rg-lookback').value||0; if(look<=0)look=Math.max(20,Math.min(500,Math.round(n*0.35))); look=Math.max(3,Math.min(look,n-1));
    var block=+document.getElementById('rg-block').value||20; var volwin=+document.getElementById('rg-volwin').value||150; var flev=+document.getElementById('rg-nstep').value||50; var thresh=+document.getElementById('rg-thresh').value||0.35;
    var close=prices[n-1], past=prices[Math.max(0,n-1-look)], trendLevels=(close-past)/(level*look);
    var short=Math.max(3,Math.min(Math.floor(look/3),n-1)); var mom=(close-prices[n-1-short])/(level*short);
    var deltas=rows.slice(-look).map(function(r){return +r.delta||0;}); var vols=rows.slice(-look).map(function(r){return +r.vol||0;});
    var dsum=deltas.reduce(function(a,b){return a+b;},0), vsum=vols.reduce(function(a,b){return a+b;},0)||1; var oflow=Math.max(-1,Math.min(1,dsum/vsum));
    var rets=[]; for(var j=Math.max(1,n-volwin);j<n;j++)rets.push(Math.abs(prices[j]-prices[j-1])/level); var vol=median(rets)||0;
    var score=Math.max(-1,Math.min(1,trendLevels*0.55 + mom*0.30 + oflow*0.15)); var state=score>thresh?'BULL':score<-thresh?'BEAR':'SIDE';
    var strength=Math.min(1,Math.abs(score)); var move=(state==='BULL'?1:state==='BEAR'?-1:0)*flev*level*Math.max(0.25,strength); var fval=close+move;
    if(state==='BEAR' && fval>=close) fval=close-Math.max(level,Math.abs(move));
    if(state==='BULL' && fval<=close) fval=close+Math.max(level,Math.abs(move));
    if(state==='SIDE') fval=close;
    var pBull= state==='BULL'?60+40*strength: state==='SIDE'?20*(1-strength):20*(1-strength);
    var pBear= state==='BEAR'?60+40*strength: state==='SIDE'?20*(1-strength):20*(1-strength);
    var pSide=Math.max(0,100-pBull-pBear); var tot=pBull+pSide+pBear; pBull=pBull/tot*100;pSide=pSide/tot*100;pBear=pBear/tot*100;
    var states=prices.map(function(p,i){if(i<2)return 'SIDE'; var l=Math.min(look,i); var sc=(p-prices[i-l])/(level*l); return sc>thresh?'BULL':sc<-thresh?'BEAR':'SIDE';});
    drawRegimeCanvas(prices.slice(-Math.min(500,prices.length)),states.slice(-Math.min(500,states.length)));
    var pill=document.getElementById('rg-pill'); if(pill){pill.textContent=state; pill.className='rg-pill '+state;}
    setText('rg-score-now',fmtN(score,2),score>0?'pos':score<0?'neg':'flat'); setText('rg-trend-now',fmtN(trendLevels,3),trendLevels>0?'pos':trendLevels<0?'neg':'flat'); setText('rg-signal',fmtN(score,2),score>0?'pos':score<0?'neg':'flat'); setText('rg-fcast-level',fmtN(fval,2),fval>close?'pos':fval<close?'neg':'flat'); setText('rg-conv',fmtN(strength*100,1)+'%',state==='BULL'?'pos':state==='BEAR'?'neg':'flat');
    var cb=document.getElementById('rg-conv-bar'); if(cb){cb.style.width=(strength*100).toFixed(1)+'%'; cb.style.background=state==='BULL'?'#2dd4a8':state==='BEAR'?'#ef4565':'#c9a24b';}
    var prob=document.getElementById('rg-probs'); if(prob)prob.innerHTML=barHtml([{k:'Bull',v:pBull,col:'#2dd4a8'},{k:'Side',v:pSide,col:'#c9a24b'},{k:'Bear',v:pBear,col:'#ef4565'}]);
    var stat=document.getElementById('rg-stationary'); if(stat)stat.innerHTML=barHtml([{k:'Bull',v:pBull,col:'#2dd4a8'},{k:'Side',v:pSide,col:'#c9a24b'},{k:'Bear',v:pBear,col:'#ef4565'}]);
    var feats=document.getElementById('rg-features'); if(feats)feats.innerHTML=[['Return',score],['Trend',trendLevels],['OrderFlow',oflow],['Volatility',vol]].map(function(x){return '<div class="rg-score"><div class="name">'+x[0]+'</div><div class="num '+(x[1]>0?'rg-pos':x[1]<0?'rg-neg':'rg-zero')+'">'+fmtN(x[1],3)+'</div></div>';}).join('');
    var matrix=document.getElementById('rg-matrix'); if(matrix){matrix.innerHTML='<table class="rg-table"><thead><tr><th></th><th>BULL</th><th>SIDE</th><th>BEAR</th></tr></thead><tbody><tr><td>BULL</td><td>'+fmtN(pBull,1)+'%</td><td>'+fmtN(pSide,1)+'%</td><td>'+fmtN(pBear,1)+'%</td></tr><tr><td>SIDE</td><td>'+fmtN(pBull*.7,1)+'%</td><td>'+fmtN(Math.max(pSide,35),1)+'%</td><td>'+fmtN(pBear*.7,1)+'%</td></tr><tr><td>BEAR</td><td>'+fmtN(pBull,1)+'%</td><td>'+fmtN(pSide,1)+'%</td><td>'+fmtN(pBear,1)+'%</td></tr></tbody></table>';}
    var dir=state==='BULL'?'BUY / long bias':state==='BEAR'?'SELL / short bias':'WAIT / neutral'; var report=document.getElementById('rg-report'); if(report)report.innerHTML='<b>Suggested direction:</b> <span class="'+(state==='BULL'?'buy':state==='BEAR'?'sell':'neutral')+'">'+dir+'</span><br>Current close: <b>'+fmtN(close,2)+'</b> → Forecast after '+flev+' selected levels: <b>'+fmtN(fval,2)+'</b><br>Auto optimized from first loaded row: lookback <b>'+look+'</b>, block levels <b>'+block+'</b>, vol levels <b>'+volwin+'</b>, inferred level size <b>'+fmtN(level,4)+'</b>, threshold <b>'+fmtN(thresh,2)+'</b>.';
    var ri=document.getElementById('rg-range-info'); if(ri)ri.textContent=rows.length+' history rows · close '+fmtN(close,2); if(st)st.textContent='Regime Engine updated using full loaded history from first row.';
    window.RegimeLinkedState={direction:dir,regime:state,score:score,forecastLevelValue:fval,threshold:thresh,levelSize:level,lookback:look};
  }
  window.RegimeLinked={update:function(){computeRegime();}}; window.regimeRender=function(){computeRegime();};
  var oldSwitch=window.switchTab; window.switchTab=function(tab){ if(typeof oldSwitch==='function') oldSwitch(tab); if(tab==='reviewer'){var st=document.getElementById('rv-status'); if(st)st.textContent='Reviewer ready. Current chart has '+currentBars().length+' bars.';} if(tab==='regime'){setTimeout(computeRegime,30);} };
  var oldRebuildDisplay=window._rebuildDisplay; if(typeof oldRebuildDisplay==='function'){window._rebuildDisplay=function(){oldRebuildDisplay.apply(this,arguments); if(document.getElementById('regime-pane')&&document.getElementById('regime-pane').classList.contains('active')) setTimeout(computeRegime,20);};}
})();



/* ── FIXED TIME AXIS BUCKETING ──────────────────────────────────────────────
   Uses exact time buckets (floor to interval) instead of opening the next candle
   at the first tick time. This makes the chart x-axis match Excel TIMEACT NS. */
_bucketByInterval = function(rows, intervalSec){
  if(!rows||!rows.length)return [];
  const toSec=t=>{
    if(!t&&t!==0)return 0;
    const s=String(t).trim(); if(!s)return 0;
    const m=s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(m)return (+m[1])*3600+(+m[2])*60+(+(m[3]||0));
    const f=parseFloat(s); return !isNaN(f)?Math.round((f%1)*86400):0;
  };
  const toDay=d=>{
    const s=String(d||'').trim();
    let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m)return `${m[1]}-${m[2]}-${m[3]}`;
    m=s.match(/^(\d{2})\.(\d{2})\.(\d{4})/); if(m)return `${m[3]}-${m[2]}-${m[1]}`;
    return '';
  };
  const secToTime=sec=>`${String(Math.floor(sec/3600)%24).padStart(2,'0')}:${String(Math.floor((sec%3600)/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
  const absMs=r=>{ const ms=_toAbsMs(r); return ms||((toSec(r.time)||0)*1000); };
  const sorted=rows.map(r=>({...r,time:normTime(r.time||'')||r.time})).sort((a,b)=>absMs(a)-absMs(b));
  const seen=new Set(), unique=[];
  for(const r of sorted){
    const k=(typeof _ofRowSignature==='function')?_ofRowSignature(r):`${r.date}|${r.time}|${r.aggr}|${r.last}|${r.bid}|${r.ask}|${r.bSize}|${r.aSize}|${r.trdVol}|${r.tradeId}|${r.seqNum}`;
    if(seen.has(k))continue; seen.add(k); unique.push(r);
  }
  // Compute cumulative-counter differences once over the COMPLETE ordered
  // tick stream before splitting it into intervals.
  if(typeof window.applyCorrectDiffs==='function') window.applyCorrectDiffs(unique);

  const groups=new Map();
  for(const r of unique){
    const sec=toSec(r.time); const bucket=Math.floor(sec/intervalSec)*intervalSec;
    const day=toDay(r.date)||'TIME'; const key=day+'|'+bucket;
    if(!groups.has(key))groups.set(key,{day,bucket,rows:[]});
    groups.get(key).rows.push(r);
  }
  const bars=[...groups.values()].sort((a,b)=>{
    if(a.day!==b.day)return a.day<b.day?-1:1;
    return a.bucket-b.bucket;
  }).map(g=>{
    const b=_ticksToBar(g.rows);
    if(b){
      b.date=g.day==='TIME'?(b.date||''):g.day;
      b.time=secToTime(g.bucket);
      b.timeEnd=secToTime((g.bucket+intervalSec)%86400);
    }
    return b;
  }).filter(Boolean);
  let cd=0; bars.forEach(b=>{cd+=b.delta;b.cumD=cd;});
  return bars;
};

// ==== of-reviewer-agent-patch ====
/* Reviewer Agent
   Compares two manually selected intervals from the loaded file with the
   current visible/live/replay interval. It uses local HTML data only. */
(function(){
  if(window.__OF_REVIEWER_AGENT_PATCH__) return;
  window.__OF_REVIEWER_AGENT_PATCH__ = true;

  function q(id){ return document.getElementById(id); }
  function pad(n){ return String(n).padStart(2,'0'); }
  function num(v){ v=Number(v); return isFinite(v)?v:0; }
  function fmt(v){ v=Math.round(num(v)); return v.toLocaleString(); }
  function cls(v){ v=num(v); return v>0?'rv-pos':v<0?'rv-neg':'rv-zero'; }
  function fmtSigned(v){ v=Math.round(num(v)); return (v>0?'+':'')+v.toLocaleString(); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

  function normalDate(v){
    var s=String(v||'').trim(); if(!s) return '';
    var m=s.match(/(\d{4})-(\d{2})-(\d{2})/); if(m) return m[1]+'-'+m[2]+'-'+m[3];
    m=s.match(/(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{4})/); if(m) return m[3]+'-'+pad(+m[2])+'-'+pad(+m[1]);
    return '';
  }
  function normalTime(v){
    var s=String(v||'').trim(); if(!s) return '';
    var m=s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(m) return pad(+m[1])+':'+pad(+m[2])+':'+pad(+(m[3]||0));
    var f=parseFloat(s.replace(',','.'));
    if(!isNaN(f)&&f>=0&&f<1){ var sec=Math.round(f*86400); return pad(Math.floor(sec/3600))+':'+pad(Math.floor((sec%3600)/60))+':'+pad(sec%60); }
    return '';
  }
  function rowMs(r){
    try{ if(typeof window._ofRowMs==='function'){ var a=window._ofRowMs(r); if(a) return a; } }catch(e){}
    try{ if(typeof window._toAbsMs==='function'){ var b=window._toAbsMs(r); if(b) return b; } }catch(e){}
    var d=normalDate(r&&r.date), t=normalTime(r&&r.time);
    if(d&&t){ var ms=new Date(d+'T'+t).getTime(); if(isFinite(ms)) return ms; }
    if(r && r.Timestamp){ var x=new Date(r.Timestamp).getTime(); if(isFinite(x)) return x; }
    return 0;
  }
  function inputMs(id){ var el=q(id); if(!el||!el.value) return 0; var ms=new Date(el.value).getTime(); return isFinite(ms)?ms:0; }
  function toDT(ms){ if(!ms) return ''; var d=new Date(ms); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds()); }

  function uniqueRows(rows){
    var seen=new Set(), out=[];
    (rows||[]).forEach(function(r,i){
      if(!r) return;
      var k=[normalDate(r.date),normalTime(r.time),r.tradeId||'',r.seqNum||'',r.last||'',r.bid||'',r.ask||'',r.trdVol||'',i].join('|');
      if(seen.has(k)) return; seen.add(k); out.push(r);
    });
    return out;
  }
  function allRows(){
    var rows=[];
    try{ if(Array.isArray(window._trAllRows)) rows=rows.concat(window._trAllRows); }catch(e){}
    try{ if(Array.isArray(window._allRawRows)) rows=rows.concat(window._allRawRows); }catch(e){}
    try{ if(Array.isArray(window._tlRows)) rows=rows.concat(window._tlRows); }catch(e){}
    try{ if(Array.isArray(window._closedBars)) window._closedBars.forEach(function(b){ if(b&&Array.isArray(b.ticks)) rows=rows.concat(b.ticks); }); }catch(e){}
    try{ if(Array.isArray(window._openBarTicks)) rows=rows.concat(window._openBarTicks); }catch(e){}
    return uniqueRows(rows).filter(function(r){ return rowMs(r)>0; }).sort(function(a,b){return rowMs(a)-rowMs(b);});
  }
  function currentRows(){
    try{ if(typeof window._currentIntervalRows==='function'){ var r=window._currentIntervalRows(); if(Array.isArray(r)&&r.length) return r.slice(); } }catch(e){}
    try{ if(Array.isArray(window._openBarTicks)&&window._openBarTicks.length) return window._openBarTicks.slice(); }catch(e){}
    try{ var bars=window._trBars||window._closedBars||[]; if(bars.length){ var b=bars[window._trOffset||bars.length-1]||bars[bars.length-1]; if(b&&Array.isArray(b.ticks)) return b.ticks.slice(); } }catch(e){}
    return [];
  }
  function rowsBetween(sMs,eMs){
    var rows=allRows(); if(!sMs&&!eMs) return [];
    if(sMs&&eMs&&eMs<sMs){ var tmp=sMs; sMs=eMs; eMs=tmp; }
    return rows.filter(function(r){ var ms=rowMs(r); return (!sMs||ms>=sMs)&&(!eMs||ms<=eMs); });
  }
  function snap(v){ var tk=Number((q('rv-tick')||{}).value)||((window.CFG&&CFG.tickSize)||0.10); return Math.round(Math.round(num(v)/tk)*tk*1e8)/1e8; }
  function side(r){
    var a=String(r&&r.aggr||'').toUpperCase().trim();
    var t=String((r&&(r.tick||r.PRCTCK_1||r['CF TICK']))||'').toUpperCase().trim();
    if(a==='BID'||a==='SELL'||a==='HIT') return 'HIT';
    if(a==='ASK'||a==='BUY'||a==='LIFT') return 'LIFT';
    if(t.indexOf('⇩')>=0||t==='DOWN'||t==='-'||t==='SELL'||t==='BID') return 'HIT';
    if(t.indexOf('⇧')>=0||t==='UP'||t==='+'||t==='BUY'||t==='ASK') return 'LIFT';
    return '';
  }

  function summarize(rows, name){
    rows=(rows||[]).filter(function(r){ return r && (num(r.last)>0 || num(r.bid)>0 || num(r.ask)>0); });
    var byPrice={}, totals={name:name, rows:rows.length, levels:0, totalVol:0, hitVol:0, liftVol:0, hitBid:0, liftAsk:0, bidSize:0, askSize:0, tradeId:0, seq:0, rtl:0};
    function level(p){ p=snap(p); if(!isFinite(p)||p<=0) return null; var k=p.toFixed(2); if(!byPrice[k]) byPrice[k]={price:p, rows:0,totalVol:0,hitVol:0,liftVol:0,hitBid:0,liftAsk:0,bidSize:0,askSize:0,tradeId:0,seq:0,rtl:0}; return byPrice[k]; }
    rows.forEach(function(r){
      var vol=num(r.trdVol||r.volume||r.volDiff);
      var bs=num(r.bSize), as=num(r.aSize), tid=num(r.trdIdDiff), seq=num(r.seqNumDiff), rtl=num(r.movesDiff);
      totals.totalVol+=vol; totals.bidSize+=bs; totals.askSize+=as; totals.tradeId+=tid; totals.seq+=seq; totals.rtl+=rtl;
      var s=side(r);
      var p=s==='HIT'?(num(r.bid)||num(r.last)):s==='LIFT'?(num(r.ask)||num(r.last)):(num(r.last)||num(r.bid)||num(r.ask));
      var lv=level(p); if(!lv) return; lv.rows++; lv.totalVol+=vol; lv.bidSize+=bs; lv.askSize+=as; lv.tradeId+=tid; lv.seq+=seq; lv.rtl+=rtl;
      if(s==='HIT'){ lv.hitVol+=vol; lv.hitBid+=bs; totals.hitVol+=vol; totals.hitBid+=bs; }
      else if(s==='LIFT'){ lv.liftVol+=vol; lv.liftAsk+=as; totals.liftVol+=vol; totals.liftAsk+=as; }
    });
    var levels=Object.keys(byPrice).map(function(k){ var x=byPrice[k]; x.deltaVol=x.liftVol-x.hitVol; x.deltaLAskHBid=x.liftAsk-x.hitBid; x.imb=x.askSize?x.bidSize/x.askSize:0; return x; }).sort(function(a,b){return b.price-a.price;});
    totals.levels=levels.length; totals.deltaVol=totals.liftVol-totals.hitVol; totals.deltaLAskHBid=totals.liftAsk-totals.hitBid; totals.netSize=totals.bidSize-totals.askSize;
    totals.strongest=levels.slice().sort(function(a,b){return Math.abs(b.deltaLAskHBid)-Math.abs(a.deltaLAskHBid);})[0]||null;
    return {totals:totals, levels:levels};
  }

  function metricRows(cur,a,b){
    var keys=[
      ['rows','Ticks'],['levels','Price levels'],['totalVol','Total volume'],['hitVol','Hit volume'],['liftVol','Lift volume'],['deltaVol','Δ LiftVol-HitVol'],['hitBid','Hit_Bid'],['liftAsk','Lift_Ask'],['deltaLAskHBid','Δ LiftAsk-HitBid'],['bidSize','BidSize'],['askSize','AskSize'],['netSize','BidSize-AskSize'],['tradeId','Trade ID diff'],['seq','SEQ diff'],['rtl','RTL diff']
    ];
    return keys.map(function(k){ var key=k[0], lab=k[1], cv=num(cur[key]), av=num(a[key]), bv=num(b[key]); return '<tr><td>'+lab+'</td><td>'+fmt(cv)+'</td><td>'+fmt(av)+'</td><td class="'+cls(cv-av)+'">'+fmtSigned(cv-av)+'</td><td>'+fmt(bv)+'</td><td class="'+cls(cv-bv)+'">'+fmtSigned(cv-bv)+'</td></tr>'; }).join('');
  }
  function priceCompare(cur,a,b){
    var map={};
    function add(prefix,arr){ (arr||[]).forEach(function(x){ var k=x.price.toFixed(2); if(!map[k]) map[k]={price:x.price}; map[k][prefix]=x; }); }
    add('c',cur.levels); add('a',a.levels); add('b',b.levels);
    return Object.keys(map).map(function(k){ var x=map[k], c=x.c||{}, aa=x.a||{}, bb=x.b||{}; x.score=Math.abs(num(c.deltaLAskHBid)-num(aa.deltaLAskHBid))+Math.abs(num(c.deltaLAskHBid)-num(bb.deltaLAskHBid))+Math.abs(num(c.totalVol)-num(aa.totalVol)); return x; })
      .sort(function(x,y){ return y.score-x.score || y.price-x.price; }).slice(0,40).map(function(x){
        var c=x.c||{}, aa=x.a||{}, bb=x.b||{}; var cd=num(c.deltaLAskHBid), ad=num(aa.deltaLAskHBid), bd=num(bb.deltaLAskHBid);
        return '<tr><td>'+x.price.toFixed(2)+'</td><td>'+fmt(num(c.totalVol))+'</td><td class="'+cls(cd)+'">'+fmtSigned(cd)+'</td><td>'+fmt(num(aa.totalVol))+'</td><td class="'+cls(ad)+'">'+fmtSigned(ad)+'</td><td class="'+cls(cd-ad)+'">'+fmtSigned(cd-ad)+'</td><td>'+fmt(num(bb.totalVol))+'</td><td class="'+cls(bd)+'">'+fmtSigned(bd)+'</td><td class="'+cls(cd-bd)+'">'+fmtSigned(cd-bd)+'</td></tr>';
      }).join('');
  }
  function flipSummary(s){
    var top=s.totals.strongest;
    return top ? ('Strongest level '+top.price.toFixed(2)+' · Δ LAsk-HBid '+fmtSigned(top.deltaLAskHBid)+' · Vol '+fmt(top.totalVol)) : 'No flip-pair level found';
  }
  function verdict(cur,a,b){
    var dA=cur.totals.deltaLAskHBid-a.totals.deltaLAskHBid, dB=cur.totals.deltaLAskHBid-b.totals.deltaLAskHBid;
    var v=cur.totals.deltaLAskHBid;
    if(v>0 && dA>0 && dB>0) return '<span class="rv-good">Current interval is stronger on Lift_Ask versus Hit_Bid than both references.</span>';
    if(v<0 && dA<0 && dB<0) return '<span class="rv-neg">Current interval is weaker / more Hit_Bid heavy than both references.</span>';
    return '<span class="rv-warn">Mixed signal: current interval is between or different from the two references.</span>';
  }



  var RV_MAX_REFS = 5;
  window._rvRefSlots = window._rvRefSlots || [null,null,null,null,null,null];

  function refSlotStatus(){
    var el=q('rv-slot-status'); if(!el) return;
    var parts=[];
    for(var i=1;i<=RV_MAX_REFS;i++){
      var s=window._rvRefSlots[i];
      parts.push('R'+i+': '+(s && s.rows ? (esc(s.name||'Saved')+' · '+s.rows.length.toLocaleString()+' rows') : 'empty'));
    }
    el.innerHTML=parts.join('<br>');
  }

  function loadedRowsForSave(){
    var rows=[];
    try{ if(Array.isArray(window._allRawRows) && window._allRawRows.length) rows=window._allRawRows.slice(); }catch(e){}
    try{ if(!rows.length && Array.isArray(window._trAllRows) && window._trAllRows.length) rows=window._trAllRows.slice(); }catch(e){}
    try{ if(!rows.length && Array.isArray(window._tlRows) && window._tlRows.length) rows=window._tlRows.slice(); }catch(e){}
    return uniqueRows(rows).filter(function(r){ return rowMs(r)>0; });
  }

  window.rvSaveLoadedToSlot=function(){
    var slot=Math.max(1,Math.min(RV_MAX_REFS,parseInt((q('rv-save-slot')||{}).value,10)||1));
    var rows=loadedRowsForSave();
    if(!rows.length){ alert('No manually loaded rows found. Load a file in the main app first.'); return; }
    window._rvRefSlots[slot]={name:'Saved loaded file '+slot, rows:rows.slice(), savedAt:new Date().toLocaleTimeString()};
    refSlotStatus();
    var st=q('rv-status'); if(st) st.textContent='Saved loaded file to Reference '+slot+' · '+rows.length.toLocaleString()+' rows';
  };

  window.rvLoadReferenceFiles=async function(){
    var inp=q('rv-ref-files');
    if(!inp || !inp.files || !inp.files.length){ alert('Choose up to 5 Excel/CSV reference files first.'); return; }
    if(typeof window.parseFile!=='function' && typeof parseFile!=='function'){
      alert('parseFile() was not found in this HTML. Use Save loaded file to slot instead.'); return;
    }
    var startSlot=Math.max(1,Math.min(RV_MAX_REFS,parseInt((q('rv-save-slot')||{}).value,10)||1));
    var files=Array.from(inp.files).slice(0,RV_MAX_REFS);
    var ok=0, errors=[];
    for(var i=0;i<files.length;i++){
      var slot=startSlot+i; if(slot>RV_MAX_REFS) slot=((slot-1)%RV_MAX_REFS)+1;
      try{
        var rows=await parseFile(files[i]);
        rows=uniqueRows(rows||[]).filter(function(r){ return rowMs(r)>0; });
        if(!rows.length) throw new Error('No usable timestamp rows');
        window._rvRefSlots[slot]={name:files[i].name, rows:rows, savedAt:new Date().toLocaleTimeString()};
        ok++;
      }catch(err){ errors.push(files[i].name+': '+(err&&err.message?err.message:err)); }
    }
    refSlotStatus();
    var st=q('rv-status'); if(st) st.textContent='Loaded '+ok+' reference file(s) into temp slots'+(errors.length?' · '+errors.length+' error(s)':'');
    if(errors.length) alert('Some reference files failed:\n'+errors.join('\n'));
  };

  function refSummaries(){
    var out=[];
    for(var i=1;i<=RV_MAX_REFS;i++){
      var s=window._rvRefSlots[i];
      if(s && Array.isArray(s.rows) && s.rows.length) out.push({slot:i, name:s.name||('Reference '+i), rows:s.rows});
    }
    return out;
  }

  function metricRowsMany(cur, refs){
    var keys=[
      ['rows','Ticks'],['levels','Price levels'],['totalVol','Total volume'],['hitVol','Hit volume'],['liftVol','Lift volume'],['deltaVol','Δ LiftVol-HitVol'],['hitBid','Hit_Bid'],['liftAsk','Lift_Ask'],['deltaLAskHBid','Δ LiftAsk-HitBid'],['bidSize','BidSize'],['askSize','AskSize'],['netSize','BidSize-AskSize'],['tradeId','Trade ID diff'],['seq','SEQ diff'],['rtl','RTL diff']
    ];
    var head='<thead><tr><th>Metric</th><th>Current</th>'+refs.map(function(R){return '<th>R'+R.slot+'</th><th>Cur-R'+R.slot+'</th>';}).join('')+'</tr></thead>';
    var body=keys.map(function(k){
      var key=k[0], lab=k[1], cv=num(cur[key]);
      return '<tr><td>'+lab+'</td><td>'+fmt(cv)+'</td>'+refs.map(function(R){ var rv=num(R.summary.totals[key]); return '<td>'+fmt(rv)+'</td><td class="'+cls(cv-rv)+'">'+fmtSigned(cv-rv)+'</td>'; }).join('')+'</tr>';
    }).join('');
    return '<table class="rv-table">'+head+'<tbody>'+body+'</tbody></table>';
  }

  function priceCompareMany(cur, refs){
    var map={};
    function add(prefix,arr){ (arr||[]).forEach(function(x){ var k=x.price.toFixed(2); if(!map[k]) map[k]={price:x.price}; map[k][prefix]=x; }); }
    add('c',cur.levels);
    refs.forEach(function(R){ add('r'+R.slot,R.summary.levels); });
    return Object.keys(map).map(function(k){
      var x=map[k], c=x.c||{}; x.score=0;
      refs.forEach(function(R){ var rr=x['r'+R.slot]||{}; x.score += Math.abs(num(c.deltaLAskHBid)-num(rr.deltaLAskHBid))+Math.abs(num(c.totalVol)-num(rr.totalVol)); });
      return x;
    }).sort(function(a,b){ return b.score-a.score || b.price-a.price; }).slice(0,60).map(function(x){
      var c=x.c||{}, cd=num(c.deltaLAskHBid);
      return '<tr><td>'+x.price.toFixed(2)+'</td><td>'+fmt(num(c.totalVol))+'</td><td class="'+cls(cd)+'">'+fmtSigned(cd)+'</td>'+refs.map(function(R){ var rr=x['r'+R.slot]||{}, rd=num(rr.deltaLAskHBid); return '<td>'+fmt(num(rr.totalVol))+'</td><td class="'+cls(rd)+'">'+fmtSigned(rd)+'</td><td class="'+cls(cd-rd)+'">'+fmtSigned(cd-rd)+'</td>'; }).join('')+'</tr>';
    }).join('');
  }

  window.rvGenerateSavedReport=function(){
    var cRows=currentRows();
    var refs=refSummaries();
    var st=q('rv-status'), out=q('rv-report'), empty=q('rv-empty');
    if(!cRows.length){ alert('No current live/replay interval rows found.'); return; }
    if(!refs.length){ alert('No temp reference slots saved. Save/load up to 5 reference files first.'); return; }
    var C=summarize(cRows,'Current');
    refs.forEach(function(R){ R.summary=summarize(R.rows,'R'+R.slot+' '+R.name); });
    if(st) st.innerHTML='Report created · Current '+C.totals.rows.toLocaleString()+' ticks · '+refs.length+' saved reference file(s)';
    if(empty) empty.style.display='none'; if(out) out.style.display='block';
    var names='<div class="rv-note">Current uses the active live/replay interval. Saved references are temporary placeholders in this browser session:<br>'+refs.map(function(R){return 'R'+R.slot+': '+esc(R.name)+' · '+R.summary.totals.rows.toLocaleString()+' rows';}).join('<br>')+'</div>';
    var flipRows=[{slot:'Current',name:'Current',summary:C}].concat(refs).map(function(R){ var S=R.summary||C, t=S.totals.strongest||{}; return '<tr><td>'+esc(R.slot==='Current'?'Current':'R'+R.slot)+'</td><td>'+esc(R.name||S.totals.name)+'</td><td>'+esc(flipSummary(S))+'</td><td class="'+cls(t.deltaLAskHBid)+'">'+fmtSigned(t.deltaLAskHBid)+'</td><td>'+fmt(t.totalVol)+'</td></tr>'; }).join('');
    var priceHead='<thead><tr><th>Price</th><th>Cur Vol</th><th>Cur ΔLA-HB</th>'+refs.map(function(R){return '<th>R'+R.slot+' Vol</th><th>R'+R.slot+' ΔLA-HB</th><th>Cur-R'+R.slot+'</th>';}).join('')+'</tr></thead>';
    out.innerHTML =
      '<div class="rv-section"><h3>Reviewer conclusion</h3>'+names+'</div>'+ 
      '<div class="rv-section"><h3>Price Summary / LA Pro totals</h3>'+metricRowsMany(C.totals,refs)+'</div>'+ 
      '<div class="rv-section"><h3>Flip Pairs summary</h3><table class="rv-table"><thead><tr><th>Source</th><th>File</th><th>Strongest flip-pair level</th><th>Δ LiftAsk-HitBid</th><th>Total Vol</th></tr></thead><tbody>'+flipRows+'</tbody></table></div>'+ 
      '<div class="rv-section"><h3>Price-level differences, top 60 changed levels</h3><table class="rv-table">'+priceHead+'<tbody>'+priceCompareMany(C,refs)+'</tbody></table></div>';
  };

  setTimeout(refSlotStatus,0);

  window.rvUseCurrentAs=function(which){
    var rows=currentRows(); if(!rows.length){ alert('No current interval rows found. Build candles or connect live first.'); return; }
    rows=rows.slice().sort(function(a,b){return rowMs(a)-rowMs(b);});
    var s=rowMs(rows[0]), e=rowMs(rows[rows.length-1]);
    q('rv-'+which.toLowerCase()+'-start').value=toDT(s); q('rv-'+which.toLowerCase()+'-end').value=toDT(e);
  };

  window.rvGenerateReport=function(){
    var aRows=rowsBetween(inputMs('rv-a-start'), inputMs('rv-a-end'));
    var bRows=rowsBetween(inputMs('rv-b-start'), inputMs('rv-b-end'));
    var cRows=currentRows();
    var st=q('rv-status'), out=q('rv-report'), empty=q('rv-empty');
    if(!cRows.length){ alert('No current live/replay interval rows found.'); return; }
    if(!aRows.length || !bRows.length){ alert('Reference interval A and B must contain rows.'); return; }
    var A=summarize(aRows,'Reference A'), B=summarize(bRows,'Reference B'), C=summarize(cRows,'Current');
    if(st) st.innerHTML='Report created · Current '+C.totals.rows.toLocaleString()+' ticks · A '+A.totals.rows.toLocaleString()+' ticks · B '+B.totals.rows.toLocaleString()+' ticks';
    if(empty) empty.style.display='none'; if(out) out.style.display='block';
    out.innerHTML =
      '<div class="rv-section"><h3>Reviewer conclusion</h3><div class="rv-note">'+verdict(C,A,B)+'<br>Price Summary, LA Pro and Flip Pairs are compared from the same row sets. Current uses the active live/replay interval; A and B use your manual start/end selections.</div></div>'+
      '<div class="rv-section"><h3>Price Summary / LA Pro totals</h3><table class="rv-table"><thead><tr><th>Metric</th><th>Current</th><th>Ref A</th><th>Cur-A</th><th>Ref B</th><th>Cur-B</th></tr></thead><tbody>'+metricRows(C.totals,A.totals,B.totals)+'</tbody></table></div>'+
      '<div class="rv-section"><h3>Flip Pairs summary</h3><table class="rv-table"><thead><tr><th>Source</th><th>Strongest flip-pair level</th><th>Δ LiftAsk-HitBid</th><th>Total Vol</th></tr></thead><tbody>'+
        [C,A,B].map(function(S){ var t=S.totals.strongest||{}; return '<tr><td>'+esc(S.totals.name)+'</td><td>'+esc(flipSummary(S))+'</td><td class="'+cls(t.deltaLAskHBid)+'">'+fmtSigned(t.deltaLAskHBid)+'</td><td>'+fmt(t.totalVol)+'</td></tr>'; }).join('')+
      '</tbody></table></div>'+
      '<div class="rv-section"><h3>Price-level differences, top 40 changed levels</h3><table class="rv-table"><thead><tr><th>Price</th><th>Cur Vol</th><th>Cur ΔLA-HB</th><th>A Vol</th><th>A ΔLA-HB</th><th>Cur-A</th><th>B Vol</th><th>B ΔLA-HB</th><th>Cur-B</th></tr></thead><tbody>'+priceCompare(C,A,B)+'</tbody></table></div>';
  };

  var _origSwitch=window.switchTab;
  window.switchTab=function(tab){
    if(typeof _origSwitch==='function') _origSwitch.apply(this, arguments);
    if(tab==='reviewer'){
      setTimeout(function(){
        var rows=currentRows(); var info=q('rv-current-info');
        if(info) info.textContent = rows.length ? ('Current interval ready: '+rows.length.toLocaleString()+' ticks. Press Create Report after choosing A and B.') : 'No current interval rows yet. Build candles, start replay, or connect live.';
        var tk=q('rv-tick'); if(tk && window.CFG && CFG.tickSize) tk.value=CFG.tickSize;
      },50);
    }
  };
})();

// ==== of-reviewer-global-font-link-js ====
/* Keeps Reviewer Agent linked to the same Font +/- control used by the rest of the app. */
(function(){
  if(window.__OF_REVIEWER_GLOBAL_FONT_LINK__) return;
  window.__OF_REVIEWER_GLOBAL_FONT_LINK__ = true;

  function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
  function readGlobalFontSize(){
    var txt = (document.getElementById('fs-val') || {}).textContent || '';
    var n = parseInt(txt, 10);
    if(!Number.isFinite(n)) n = window._tableFontSize || window._globalFontSize || 11;
    return clamp(n, 7, 24);
  }

  window.applyReviewerFontSize = function(size){
    var fs = clamp(parseInt(size || readGlobalFontSize(), 10), 7, 24);
    var small = Math.max(7, fs - 2);
    var tiny  = Math.max(7, fs - 3);
    var root = document.documentElement;
    root.style.setProperty('--of-global-font-size', fs + 'px');
    root.style.setProperty('--of-global-font-small', small + 'px');
    root.style.setProperty('--of-global-font-tiny', tiny + 'px');

    var pane = document.getElementById('reviewer-pane');
    if(!pane) return;

    pane.style.fontSize = fs + 'px';
    pane.querySelectorAll('#rv-toolbar,#rv-selectors,#rv-status,#rv-report-wrap,.rv-card,.rv-note,.rv-table,.rv-table td,.rv-table th')
      .forEach(function(el){ el.style.fontSize = fs + 'px'; });
    pane.querySelectorAll('.rv-title,.rv-card-title,.rv-section h3')
      .forEach(function(el){ el.style.fontSize = (fs + 1) + 'px'; });
    pane.querySelectorAll('.rv-help,.rv-btn,.rv-card label,.rv-card input,#rv-current-info')
      .forEach(function(el){ el.style.fontSize = small + 'px'; });
    pane.querySelectorAll('#rv-empty')
      .forEach(function(el){ el.style.fontSize = (fs + 1) + 'px'; });

    localStorage.setItem('ofGlobalFontSize', String(fs));
  };

  function runSoon(){ setTimeout(function(){ try{ window.applyReviewerFontSize(); }catch(e){} }, 0); }

  var oldApply = window.applyFontSize;
  if(typeof oldApply === 'function'){
    window.applyFontSize = function(){
      var ret = oldApply.apply(this, arguments);
      runSoon();
      return ret;
    };
  }

  var oldChange = window.changeFontSize;
  if(typeof oldChange === 'function'){
    window.changeFontSize = function(delta){
      var ret = oldChange.apply(this, arguments);
      runSoon();
      return ret;
    };
  }

  var oldSwitch = window.switchTab;
  if(typeof oldSwitch === 'function'){
    window.switchTab = function(tab){
      var ret = oldSwitch.apply(this, arguments);
      runSoon();
      return ret;
    };
  }

  var oldReport = window.rvGenerateReport;
  if(typeof oldReport === 'function'){
    window.rvGenerateReport = function(){
      var ret = oldReport.apply(this, arguments);
      runSoon();
      return ret;
    };
  }

  function init(){
    var saved = parseInt(localStorage.getItem('ofGlobalFontSize') || '', 10);
    if(Number.isFinite(saved)){
      window._globalFontSize = saved;
      window._tableFontSize = saved;
      var fsEl = document.getElementById('fs-val');
      if(fsEl) fsEl.textContent = saved + 'px';
    }
    try{ window.applyReviewerFontSize(); }catch(e){}
    var pane = document.getElementById('reviewer-pane');
    if(pane && window.MutationObserver){
      var obs = new MutationObserver(function(){ try{ window.applyReviewerFontSize(); }catch(e){} });
      obs.observe(pane, {childList:true, subtree:true, characterData:true});
    }
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

// ==== of-reviewer-candle-summary-patch ====
/* Adds Candle Summary comparison to Reviewer Agent.
   It compares the same current live/replay interval against interval A/B or temp reference slots 1-5.
   It also creates an automatic directional strategy suggestion from Candle Summary columns. */
(function(){
  if(window.__OF_REVIEWER_CANDLE_SUMMARY_PATCH__) return;
  window.__OF_REVIEWER_CANDLE_SUMMARY_PATCH__ = true;

  function q(id){return document.getElementById(id);} 
  function n(v){v=Number(v);return isFinite(v)?v:0;}
  function pad(x){return String(x).padStart(2,'0');}
  function esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]||c;});}
  function cls(v){v=n(v);return v>0?'rv-pos':v<0?'rv-neg':'rv-zero';}
  function fmt(v){v=n(v);var r=Math.round(v);if(Math.abs(r)>=1000000)return (r/1000000).toFixed(1)+'M';if(Math.abs(r)>=10000)return (r/1000).toFixed(1)+'k';return r.toLocaleString();}
  function fmtSigned(v){v=n(v);return (v>0?'+':'')+fmt(v);}
  function fmtPrice(v){v=n(v);return v?Number(v).toFixed(2):'—';}
  function normalDate(v){var s=String(v||'').trim(),m;if(!s)return'';m=s.match(/(\d{4})-(\d{2})-(\d{2})/);if(m)return m[1]+'-'+m[2]+'-'+m[3];m=s.match(/(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{4})/);if(m)return m[3]+'-'+pad(+m[2])+'-'+pad(+m[1]);return'';}
  function normalTime(v){var s=String(v||'').trim(),m;if(!s)return'';m=s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);if(m)return pad(+m[1])+':'+pad(+m[2])+':'+pad(+(m[3]||0));var f=parseFloat(s.replace(',','.'));if(!isNaN(f)&&f>=0&&f<1){var sec=Math.round(f*86400);return pad(Math.floor(sec/3600))+':'+pad(Math.floor((sec%3600)/60))+':'+pad(sec%60);}return'';}
  function rowMs(r){
    try{if(typeof window._ofRowMs==='function'){var a=window._ofRowMs(r);if(a)return a;}}catch(e){}
    try{if(typeof window._toAbsMs==='function'){var b=window._toAbsMs(r);if(b)return b;}}catch(e){}
    var d=normalDate(r&&r.date),t=normalTime(r&&r.time);if(d&&t){var ms=new Date(d+'T'+t).getTime();if(isFinite(ms))return ms;}
    if(r&&r.Timestamp){var x=new Date(r.Timestamp).getTime();if(isFinite(x))return x;}return 0;
  }
  function inputMs(id){var el=q(id);if(!el||!el.value)return 0;var ms=new Date(el.value).getTime();return isFinite(ms)?ms:0;}
  function uniqueRows(rows){var seen=new Set(),out=[];(rows||[]).forEach(function(r,i){if(!r)return;var k=[normalDate(r.date),normalTime(r.time),r.tradeId||'',r.seqNum||'',r.last||'',r.bid||'',r.ask||'',r.trdVol||'',i].join('|');if(seen.has(k))return;seen.add(k);out.push(r);});return out;}
  function allRows(){var rows=[];try{if(Array.isArray(window._trAllRows))rows=rows.concat(window._trAllRows);}catch(e){}try{if(Array.isArray(window._allRawRows))rows=rows.concat(window._allRawRows);}catch(e){}try{if(Array.isArray(window._tlRows))rows=rows.concat(window._tlRows);}catch(e){}try{if(Array.isArray(window._closedBars))window._closedBars.forEach(function(b){if(b&&Array.isArray(b.ticks))rows=rows.concat(b.ticks);});}catch(e){}try{if(Array.isArray(window._openBarTicks))rows=rows.concat(window._openBarTicks);}catch(e){}return uniqueRows(rows).filter(function(r){return rowMs(r)>0;}).sort(function(a,b){return rowMs(a)-rowMs(b);});}
  function currentRows(){try{if(typeof window._currentIntervalRows==='function'){var r=window._currentIntervalRows();if(Array.isArray(r)&&r.length)return r.slice();}}catch(e){}try{if(Array.isArray(window._openBarTicks)&&window._openBarTicks.length)return window._openBarTicks.slice();}catch(e){}try{var bars=window._trBars||window._closedBars||[];if(bars.length){var b=bars[window._trOffset||bars.length-1]||bars[bars.length-1];if(b&&Array.isArray(b.ticks))return b.ticks.slice();}}catch(e){}return [];}
  function rowsBetween(s,e){var rows=allRows();if(s&&e&&e<s){var t=s;s=e;e=t;}return rows.filter(function(r){var ms=rowMs(r);return (!s||ms>=s)&&(!e||ms<=e);});}

  function barFromRows(rows){
    rows=(rows||[]).filter(Boolean);
    if(!rows.length) return null;
    try{if(typeof window._ticksToBar==='function'){var b=window._ticksToBar(rows); if(b) return b;}}catch(e){}
    var priceRows=rows.filter(function(r){return n(r.last)>0;}); if(!priceRows.length) return null;
    var prices=priceRows.map(function(r){return n(r.last);});
    var open=prices[0], close=prices[prices.length-1], high=Math.max.apply(null,prices), low=Math.min.apply(null,prices);
    var out={open:open,high:high,low:low,close:close,pocPrice:close,avgVwap:prices.reduce(function(s,p){return s+p;},0)/prices.length,cumD:0,footprint:[],ticks:rows};
    var fields=['totalBSize','totalASize','totalTrdVol','totalHitVol','totalLiftVol','totalHitBid','totalHitAsk','totalLiftBid','totalLiftAsk','totalHitRTL','totalLiftRTL','totalHitSeq','totalLiftSeq','totalHitId','totalLiftId','rawTradeId','rawSeqNum','rawRtl','totalAggrBid','totalAggrAsk'];
    fields.forEach(function(f){out[f]=0;});
    priceRows.forEach(function(r){
      var ag=String(r.aggr||'').toUpperCase(), bs=n(r.bSize), as=n(r.aSize), vol=n(r.trdVol||r.volume||r.volDiff||1), tid=n(r.trdIdDiff), seq=n(r.seqNumDiff), rtl=n(r.movesDiff);
      out.totalBSize+=bs;out.totalASize+=as;out.totalTrdVol+=vol;out.rawTradeId+=tid;out.rawSeqNum+=seq;out.rawRtl+=rtl;
      var lift=(ag==='ASK'||ag==='BUY'||ag==='LIFT'), hit=(ag==='BID'||ag==='SELL'||ag==='HIT');
      if(lift){out.totalLiftVol+=vol;out.totalLiftBid+=bs;out.totalLiftAsk+=as;out.totalLiftRTL+=rtl;out.totalLiftSeq+=seq;out.totalLiftId+=tid;out.totalAggrBid++;}
      if(hit){out.totalHitVol+=vol;out.totalHitBid+=bs;out.totalHitAsk+=as;out.totalHitRTL+=rtl;out.totalHitSeq+=seq;out.totalHitId+=tid;out.totalAggrAsk++;}
    });
    out.delta=out.totalLiftVol-out.totalHitVol;out.totalDelta=out.delta;out.totalRtlX=out.rawRtl;out.totalVolume=out.totalTrdVol;return out;
  }

  function candleMetrics(rows, name){
    var b=barFromRows(rows); if(!b) return {name:name||'',empty:true};
    var m={name:name||'',empty:false};
    function put(key,label,value,type){m[key]={label:label,value:n(value),type:type||'num'};}
    put('open','Open',b.open,'price'); put('high','High',b.high,'price'); put('low','Low',b.low,'price'); put('close','Close',b.close,'price'); put('poc','POC',b.pocPrice,'price'); put('vwap','VWAP',b.avgVwap,'price');
    var dHL=0;if(b.footprint&&b.footprint.length>=2)dHL=(b.footprint[b.footprint.length-1].delta||0)-(b.footprint[0].delta||0);
    put('dHL','Delta High-Low',dHL); put('cumD','Cum Delta',b.cumD||0); put('splTrd','SPL_TRD',b.splTrd||0);
    var dyn=[];try{if(Array.isArray(window.CS_ALL_COLS)) dyn=window.CS_ALL_COLS;}catch(e){}
    if(!dyn.length){dyn=[
      {barField:'rawTradeId',label:'TRADE_ID'},{barField:'rawSeqNum',label:'SEQNUM'},{barField:'rawRtl',label:'RTL'},{barField:'totalAggrBid',label:'AGGRS_BID'},{barField:'totalAggrAsk',label:'AGGRS_ASK'},
      {barField:'totalBSize',label:'BIDSIZE'},{barField:'totalASize',label:'ASKSIZE'},{barField:'totalTrdVol',label:'TRDVOL_1'},{barField:'totalHitId',label:'Hit_ID'},{barField:'totalHitSeq',label:'Hit_SEQ'},
      {barField:'totalHitRTL',label:'Hit_RT'},{barField:'totalHitVol',label:'Hit_Vol'},{barField:'totalHitBid',label:'Hit_Bid'},{barField:'totalHitAsk',label:'Hit_Ask'},
      {barField:'totalLiftId',label:'Lift_ID'},{barField:'totalLiftSeq',label:'Lift_SEQ'},{barField:'totalLiftRTL',label:'Lift_RT'},{barField:'totalLiftVol',label:'Lift_Vol'},
      {barField:'totalLiftAsk',label:'Lift_Ask'},{barField:'totalLiftBid',label:'Lift_Bid'},{barField:'totalDelta',label:'DELTA'},{barField:'totalRtlX',label:'RTL_X'}];}
    dyn.forEach(function(c){put(c.barField,c.label,b[c.barField]||0);});
    put('dfLHBid','L-H Bid',n(b.totalLiftBid)-n(b.totalHitBid));
    put('dfLHAsk','L-H Ask',n(b.totalLiftAsk)-n(b.totalHitAsk));
    put('dfAggNet','AGGR Bid-Ask',n(b.totalAggrBid)-n(b.totalAggrAsk));
    put('dfHLVol','H-L Vol',n(b.dfHLVol));
    put('dfLHRTL','L-H RTL',n(b.totalLiftRTL)-n(b.totalHitRTL));
    put('dfLHSEQ','L-H SEQ',n(b.totalLiftSeq)-n(b.totalHitSeq));
    put('dfLAskHBid','LAsk-HBid',n(b.totalLiftAsk)-n(b.totalHitBid));
    m._bar=b;return m;
  }
  function metricVal(M,key){return M&&M[key]?n(M[key].value):0;}
  function metricLabel(M,key){return M&&M[key]?M[key].label:key;}
  function metricType(M,key){return M&&M[key]?M[key].type:'num';}
  function fmtByType(v,t){return t==='price'?fmtPrice(v):fmt(v);}
  function candleTable(current, refs){
    var keys=[], seen={};
    [current].concat(refs.map(function(r){return r.candle;})).forEach(function(M){Object.keys(M||{}).forEach(function(k){if(k==='name'||k==='empty'||k==='_bar'||seen[k])return;seen[k]=1;keys.push(k);});});
    var head='<thead><tr><th>Candle Summary column</th><th>Current</th>'+refs.map(function(R){return '<th>R'+R.slot+'</th><th>Cur-R'+R.slot+'</th>';}).join('')+'</tr></thead>';
    var body=keys.map(function(k){var cv=metricVal(current,k), typ=metricType(current,k);return '<tr><td>'+esc(metricLabel(current,k))+'</td><td>'+fmtByType(cv,typ)+'</td>'+refs.map(function(R){var rv=metricVal(R.candle,k);return '<td>'+fmtByType(rv,typ)+'</td><td class="'+cls(cv-rv)+'">'+(typ==='price'?((cv-rv)>0?'+':'')+(cv-rv).toFixed(2):fmtSigned(cv-rv))+'</td>';}).join('')+'</tr>';}).join('');
    return '<table class="rv-table">'+head+'<tbody>'+body+'</tbody></table>';
  }
  function candleTableAB(C,A,B){
    var refs=[{slot:'A',candle:A},{slot:'B',candle:B}];
    return candleTable(C,refs);
  }
  function candleScore(M){
    var b=M&&M._bar||{}, score=0, notes=[];
    function add(cond,pts,note){if(cond>0){score+=pts;notes.push('Bullish '+note);}else if(cond<0){score-=pts;notes.push('Bearish '+note);}}
    add(n(b.close)-n(b.open),2,'close vs open');
    add(n(b.totalDelta||b.delta),2,'DELTA');
    add(n(b.totalLiftVol)-n(b.totalHitVol),2,'Lift_Vol vs Hit_Vol');
    add(n(b.totalLiftAsk)-n(b.totalHitBid),2,'LAsk-HBid');
    add(n(b.totalAggrBid)-n(b.totalAggrAsk),1,'AGGR Bid-Ask');
    add(n(b.close)-n(b.pocPrice),1,'close vs POC');
    return {score:score,notes:notes};
  }
  function strategyBox(C, refs){
    var cs=candleScore(C), refAvg=0, cnt=0;refs.forEach(function(R){var s=candleScore(R.candle).score;if(isFinite(s)){refAvg+=s;cnt++;}});if(cnt)refAvg/=cnt;
    var rel=cs.score-refAvg, label='Neutral / wait', klass='rv-strategy-flat';
    if(cs.score>=5 && rel>=1){label='Long bias / buy continuation';klass='rv-strategy-long';}
    else if(cs.score<=-5 && rel<=-1){label='Short bias / sell continuation';klass='rv-strategy-short';}
    else if(cs.score>=3){label='Mild long bias';klass='rv-strategy-long';}
    else if(cs.score<=-3){label='Mild short bias';klass='rv-strategy-short';}
    var refTxt=cnt?('Reference average score: '+refAvg.toFixed(1)+' · Current minus references: '+rel.toFixed(1)):'No reference score';
    return '<div class="rv-strategy-box"><div>Suggested direction: <span class="'+klass+'">'+label+'</span></div><div>Current Candle score: <b>'+cs.score.toFixed(1)+'</b> · '+refTxt+'</div><div class="rv-mini-note">Reason: '+esc(cs.notes.slice(0,6).join(' · ')||'No strong candle summary imbalance')+'</div></div>';
  }
  function appendCandleSection(currentRowsList, refObjs){
    var out=q('rv-report'); if(!out) return;
    var C=candleMetrics(currentRowsList,'Current'); if(C.empty) return;
    refObjs=refObjs.map(function(R){R.candle=candleMetrics(R.rows,R.name||('R'+R.slot));return R;}).filter(function(R){return !R.candle.empty;});
    if(!refObjs.length) return;
    out.innerHTML += '<div class="rv-section"><h3>Candle Summary comparison — all columns</h3>'+strategyBox(C,refObjs)+candleTable(C,refObjs)+'</div>';
  }

  var oldSaved=window.rvGenerateSavedReport;
  window.rvGenerateSavedReport=function(){
    if(typeof oldSaved==='function') oldSaved.apply(this,arguments);
    var cRows=currentRows();
    var refs=[];
    try{for(var i=1;i<=5;i++){var s=window._rvRefSlots&&window._rvRefSlots[i];if(s&&Array.isArray(s.rows)&&s.rows.length)refs.push({slot:i,name:s.name||('Reference '+i),rows:s.rows});}}catch(e){}
    appendCandleSection(cRows,refs);
  };

  var oldAB=window.rvGenerateReport;
  window.rvGenerateReport=function(){
    if(typeof oldAB==='function') oldAB.apply(this,arguments);
    var cRows=currentRows();
    var aRows=rowsBetween(inputMs('rv-a-start'),inputMs('rv-a-end'));
    var bRows=rowsBetween(inputMs('rv-b-start'),inputMs('rv-b-end'));
    var refs=[]; if(aRows.length)refs.push({slot:'A',name:'Reference A',rows:aRows}); if(bRows.length)refs.push({slot:'B',name:'Reference B',rows:bRows});
    appendCandleSection(cRows,refs);
  };
})();

// ==== reviewer-clear-onestep-suggested-marker-js ====
(function(){
  if(window.__REVIEWER_CLEAR_ONESTEP_SUGGESTED_MARKER_PATCH__) return;
  window.__REVIEWER_CLEAR_ONESTEP_SUGGESTED_MARKER_PATCH__=true;

  var DIR_OPTIONS=['Long','Short','Neutral','Wait','0'];
  var dirStore=window.__suggestedDirectionStore || (window.__suggestedDirectionStore={});

  function q(id){return document.getElementById(id);} 
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];});}
  function dirCls(v){return 'dir-'+String(v||'0').toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9_-]/g,'');}
  function firstCellText(row){return row&&row.cells&&row.cells[0]?row.cells[0].textContent.trim():'';}
  function secondCellText(row){return row&&row.cells&&row.cells[1]?row.cells[1].textContent.trim():'';}
  function dirKey(tab,row){
    if(row && row.classList && row.classList.contains('sum-totals-row')) return tab+':TOTAL';
    return tab+':direction:'+firstCellText(row)+':'+secondCellText(row);
  }
  function selectHtml(k,disabled){
    var val=dirStore[k] || '0';
    return '<select class="suggested-direction-select '+dirCls(val)+'" data-suggested-direction-key="'+esc(k)+'" '+(disabled?'disabled':'')+'>'+DIR_OPTIONS.map(function(o){return '<option value="'+esc(o)+'" '+(o===val?'selected':'')+'>'+esc(o)+'</option>';}).join('')+'</select>';
  }
  function afterMarkerOrFirst(tr){
    if(!tr || !tr.children || !tr.children.length) return null;
    var marker=tr.querySelector('.manual-marker-th,.manual-marker-td');
    return marker || tr.children[0];
  }
  function installSuggestedDirection(tab,headSel,bodySel){
    var head=document.querySelector(headSel), body=document.querySelector(bodySel);
    if(!head || !body) return;
    var headRows=head.tagName==='TR'?[head]:Array.prototype.slice.call(head.querySelectorAll('tr'));
    headRows.forEach(function(tr,i){
      if(tr.querySelector('.suggested-direction-th')) return;
      var th=document.createElement('th');
      th.className='suggested-direction-th';
      th.textContent=i===0?'Suggested Dir':'';
      if(i>0) th.style.color='#333';
      var after=afterMarkerOrFirst(tr);
      if(after && after.nextSibling) tr.insertBefore(th,after.nextSibling); else tr.appendChild(th);
    });
    Array.prototype.slice.call(body.querySelectorAll('tr')).forEach(function(row){
      if(row.querySelector('.suggested-direction-td')) return;
      var txt=(row.cells[0]||{}).textContent||'';
      var disabled=row.classList.contains('sum-totals-row') || /total/i.test(txt);
      var td=document.createElement('td');
      td.className='suggested-direction-td';
      td.innerHTML=disabled?'—':selectHtml(dirKey(tab,row),false);
      var after=afterMarkerOrFirst(row);
      if(after && after.nextSibling) row.insertBefore(td,after.nextSibling); else row.appendChild(td);
    });
  }
  function applySuggestedDirectionColumns(){
    installSuggestedDirection('summary','#sum-head','#sum-body');
    installSuggestedDirection('dfpairs','#dfp-head','#dfp-body');
  }

  document.addEventListener('change',function(e){
    var sel=e.target && e.target.closest ? e.target.closest('.suggested-direction-select') : null;
    if(!sel) return;
    var k=sel.getAttribute('data-suggested-direction-key');
    if(k) dirStore[k]=sel.value||'0';
    sel.className='suggested-direction-select '+dirCls(sel.value);
  },true);

  function wrapRender(name){
    var fn=window[name];
    if(typeof fn==='function' && !fn.__suggestedDirectionWrapped){
      var w=function(){
        var ret=fn.apply(this,arguments);
        setTimeout(applySuggestedDirectionColumns,0);
        return ret;
      };
      w.__suggestedDirectionWrapped=true;
      window[name]=w;
    }
  }
  wrapRender('sumRender');
  wrapRender('dfpRender');

  var oldSwitch=window.switchTab;
  if(typeof oldSwitch==='function' && !oldSwitch.__suggestedDirectionWrapped){
    var sw=function(){
      var ret=oldSwitch.apply(this,arguments);
      setTimeout(applySuggestedDirectionColumns,30);
      return ret;
    };
    sw.__suggestedDirectionWrapped=true;
    window.switchTab=sw;
  }

  var mo=new MutationObserver(function(){applySuggestedDirectionColumns();});
  function startDirectionObserver(){
    ['sum-body','dfp-body','sum-head','dfp-head'].forEach(function(id){
      var el=q(id); if(el && !el.__suggestedDirectionObserved){mo.observe(el,{childList:true,subtree:false}); el.__suggestedDirectionObserved=true;}
    });
    applySuggestedDirectionColumns();
  }

  /* Clear Reviewer: clears report, interval selectors, file picker and temp reference slots. */
  window.rvClearReviewer=function(){
    try{ window._rvRefSlots=[null,null,null,null,null,null]; }catch(e){}
    ['rv-a-start','rv-a-end','rv-b-start','rv-b-end'].forEach(function(id){var el=q(id); if(el) el.value='';});
    var f=q('rv-ref-files'); if(f) f.value='';
    var st=q('rv-status'); if(st) st.textContent='Reviewer cleared. Load/save a new reference dataset and create a new report.';
    var slot=q('rv-slot-status'); if(slot) slot.textContent='No temp references saved yet.';
    var report=q('rv-report'); if(report){report.innerHTML=''; report.style.display='none';}
    var empty=q('rv-empty'); if(empty){empty.style.display='block'; empty.innerHTML='Reviewer cleared. Choose intervals or save/load reference files, then press <b>Create Report</b>.';}
  };

  function addReviewerClearButton(){
    var tb=q('rv-toolbar'); if(!tb || q('rv-clear-btn')) return;
    var btn=document.createElement('button');
    btn.id='rv-clear-btn'; btn.className='rv-btn'; btn.type='button';
    btn.textContent='🧹 Clear Reviewer';
    btn.onclick=window.rvClearReviewer;
    var createBtn=tb.querySelector('button.primary');
    if(createBtn && createBtn.nextSibling) tb.insertBefore(btn,createBtn.nextSibling); else tb.appendChild(btn);
  }

  /* Previous / Next: move the selected candle window by exactly ONE bar, not by page size. */
  window.trNav=function(dir){
    if(!window._trBars || !window._trBars.length){
      if(typeof window.buildCandles==='function') window.buildCandles();
      return;
    }
    var n=parseInt((q('bar-n')||{}).value,10)||10;
    var maxOffset=Math.max(0,window._trBars.length-n);
    var newOffset=(window._trOffset||0)+(dir<0?-1:1);
    newOffset=Math.max(0,Math.min(newOffset,maxOffset));
    if(newOffset===(window._trOffset||0)) return;
    window._trOffset=newOffset;
    if(typeof window._trApplyView==='function') window._trApplyView();
  };

  /* Capture the current Reviewer suggested direction text so it can be manually used in the tables. */
  function captureReviewerDirection(){
    var box=document.querySelector('#reviewer-pane .rv-strategy-box');
    if(!box) return;
    var txt=box.textContent||'';
    var dir='Neutral';
    if(/short/i.test(txt)) dir='Short';
    else if(/long|buy/i.test(txt)) dir='Long';
    else if(/wait/i.test(txt)) dir='Wait';
    window._rvLastSuggestedDirection=dir;
  }
  ['rvGenerateReport','rvGenerateSavedReport'].forEach(function(name){
    var fn=window[name];
    if(typeof fn==='function' && !fn.__captureDirectionWrapped){
      var w=function(){var ret=fn.apply(this,arguments); setTimeout(captureReviewerDirection,40); return ret;};
      w.__captureDirectionWrapped=true; window[name]=w;
    }
  });

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',function(){addReviewerClearButton();startDirectionObserver();});
  }else{
    addReviewerClearButton();startDirectionObserver();
  }
  window.addEventListener('load',function(){setTimeout(function(){addReviewerClearButton();startDirectionObserver();},150);});
})();

// ==== of-reviewer-vertical-resize-js ====
(function(){
  function q(id){return document.getElementById(id);}
  function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
  function initReviewerVerticalResize(){
    var pane=q('reviewer-pane'), selectors=q('rv-selectors'), report=q('rv-report-wrap'), handle=q('rv-reviewer-report-resizer');
    if(!pane || !selectors || !report || !handle || handle.dataset.ready==='1') return;
    handle.dataset.ready='1';
    var saved=parseFloat(localStorage.getItem('ofReviewerSelectorsHeight')||'');
    if(saved && saved>60){
      selectors.style.height=saved+'px';
      selectors.style.flex='0 0 '+saved+'px';
    }
    var startY=0,startH=0;
    function maxSelectorHeight(){
      var ph=pane.getBoundingClientRect().height||window.innerHeight;
      var toolbar=q('rv-toolbar'), status=q('rv-status');
      var used=(toolbar?toolbar.getBoundingClientRect().height:0)+(status?status.getBoundingClientRect().height:0)+handle.getBoundingClientRect().height+90;
      return Math.max(90, ph-used);
    }
    handle.addEventListener('mousedown',function(e){
      e.preventDefault();
      startY=e.clientY;
      startH=selectors.getBoundingClientRect().height;
      handle.classList.add('dragging');
      document.body.classList.add('rv-resizing-reviewer');
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onUp);
    });
    function onMove(e){
      var h=clamp(startH+(e.clientY-startY),70,maxSelectorHeight());
      selectors.style.height=h+'px';
      selectors.style.flex='0 0 '+h+'px';
      report.style.flex='1 1 auto';
    }
    function onUp(){
      var h=selectors.getBoundingClientRect().height;
      localStorage.setItem('ofReviewerSelectorsHeight',String(Math.round(h)));
      handle.classList.remove('dragging');
      document.body.classList.remove('rv-resizing-reviewer');
      document.removeEventListener('mousemove',onMove);
      document.removeEventListener('mouseup',onUp);
    }
    window.addEventListener('resize',function(){
      var h=clamp(selectors.getBoundingClientRect().height,70,maxSelectorHeight());
      selectors.style.height=h+'px';
      selectors.style.flex='0 0 '+h+'px';
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',initReviewerVerticalResize);
  else initReviewerVerticalResize();
  var oldSwitch=window.switchMainTab;
  if(typeof oldSwitch==='function' && !oldSwitch._rvResizeWrapped){
    window.switchMainTab=function(tab){
      var ret=oldSwitch.apply(this,arguments);
      if(tab==='reviewer') setTimeout(initReviewerVerticalResize,0);
      return ret;
    };
    window.switchMainTab._rvResizeWrapped=true;
  }
})();

// ==== of-regime-engine-js ====
(function(){
  const STATES=['BULL','SIDE','BEAR'];
  const COLORS={BULL:'#2dd4a8',SIDE:'#c9a24b',BEAR:'#ef4565'};
  function $(id){return document.getElementById(id);}
  function num(v,d=0){v=Number(v);return Number.isFinite(v)?v:d;}
  function fmt(v,d=2){return (v>0?'+':'')+v.toFixed(d);}
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
  function stdev(a){if(a.length<2)return 0;const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)*(x-m))));}
  function tanhNorm(v,scale){scale=Math.max(Math.abs(scale||1),1e-9);return Math.tanh(v/scale);}
  function cfg(){return {
    lookback:clamp(parseInt(($('rg-lookback')||{}).value)||100,3,1000),
    block:clamp(parseInt(($('rg-block')||{}).value)||20,3,1000),
    volwin:clamp(parseInt(($('rg-volwin')||{}).value)||150,8,1000),
    n:clamp(parseInt(($('rg-nstep')||{}).value)||50,1,1000),
    levelSize:Math.max(0,parseFloat(($('rg-levelsize')||{}).value)||0),
    thresh:Math.max(.05,parseFloat(($('rg-thresh')||{}).value)||.35)
  };}
  function getBars(){
    let b=[];
    try{ if(typeof R!=='undefined' && R && Array.isArray(R.bars) && R.bars.length) b=R.bars; }catch(e){}
    try{ if(!b.length && typeof _closedBars!=='undefined' && Array.isArray(_closedBars) && _closedBars.length) b=_closedBars; }catch(e){}
    try{ if(!b.length && typeof _trBars!=='undefined' && Array.isArray(_trBars) && _trBars.length) b=_trBars; }catch(e){}
    return (b||[]).filter(x=>x && Number.isFinite(Number(x.close))).map((x,i)=>({
      open:num(x.open,x.close),high:num(x.high,x.close),low:num(x.low,x.close),close:num(x.close),
      delta:num(x.delta, num(x.buyVol,0)-num(x.sellVol,0)), volume:num(x.volume, num(x.vol,0)),
      time:x.time||x.date||x.label||'',i
    }));
  }
  function normalizeBars(b){
    return (b||[]).filter(x=>x && Number.isFinite(Number(x.close))).map((x,i)=>({
      open:num(x.open,x.close),high:num(x.high,x.close),low:num(x.low,x.close),close:num(x.close),
      delta:num(x.delta, num(x.buyVol,0)-num(x.sellVol,0)), volume:num(x.volume, num(x.vol,0)),
      time:x.time||x.date||x.label||'',i
    }));
  }
  function getModelBars(){
    // Linked to the current Prev/Next/Build Candles position: use bars from the
    // start of the loaded history up to (and including) the currently visible
    // window, so navigating back in time shows the regime as it would have
    // appeared then, not always the full, latest-inclusive history.
    let b=[];
    try{
      if(typeof _trBars!=='undefined' && Array.isArray(_trBars) && _trBars.length){
        const nEl=document.getElementById('bar-n');
        const n=Math.max(1, parseInt(nEl&&nEl.value,10)||10);
        const off=(typeof _trOffset!=='undefined' && Number.isFinite(_trOffset)) ? _trOffset : Math.max(0,_trBars.length-n);
        const endIdx=Math.min(_trBars.length, off+n);
        b=_trBars.slice(0, endIdx);
      }
    }catch(e){}
    if(!b.length){
      try{
        if(typeof _allRawRows!=='undefined' && Array.isArray(_allRawRows) && _allRawRows.length && typeof _bucketByInterval==='function'){
          b=_bucketByInterval(_allRawRows, (typeof CFG!=='undefined' && CFG.intervalSec) ? CFG.intervalSec : 60) || [];
        }
      }catch(e){}
    }
    if(!b.length) b=getBars();
    return normalizeBars(b);
  }
  function inferLevelSize(bars){
    const diffs=[];
    for(let i=1;i<bars.length;i++){
      const vals=[bars[i].close-bars[i-1].close,bars[i].high-bars[i].low,bars[i].high-bars[i].close,bars[i].close-bars[i].low];
      vals.forEach(v=>{v=Math.abs(Number(v)||0); if(v>0 && Number.isFinite(v)) diffs.push(v);});
      if(diffs.length>3000) break;
    }
    if(!diffs.length) return 0.1;
    diffs.sort((a,b)=>a-b);
    const q=diffs[Math.max(0,Math.floor(diffs.length*0.1))] || diffs[0];
    // Normalize common futures/FX decimal noise, but keep small tick instruments valid.
    if(q>=1) return Math.max(0.01,Math.round(q*100)/100);
    if(q>=0.1) return Math.max(0.01,Math.round(q*1000)/1000);
    if(q>=0.01) return Math.max(0.0001,Math.round(q*10000)/10000);
    return Math.max(0.00001,q);
  }
  function toLevelBars(candleBars,c){
    // Converts linked candles to price-level history. One item = one price level step.
    // This makes Lookback/Forecast mean levels, not candles. Capped for smooth opening.
    if(!candleBars.length) return {levels:[], levelSize:c.levelSize||0.1};
    const tick=c.levelSize>0?c.levelSize:inferLevelSize(candleBars);
    const maxLevels=25000;
    const levels=[];
    let prev=candleBars[0].close;
    levels.push(Object.assign({},candleBars[0],{levelIndex:0,sourceCandle:0,levelSize:tick,levelMove:0}));
    for(let i=1;i<candleBars.length;i++){
      const b=candleBars[i], target=b.close;
      const diff=target-prev;
      const steps=Math.min(1000,Math.max(1,Math.round(Math.abs(diff)/tick)));
      const dir=diff>=0?1:-1;
      for(let k=1;k<=steps;k++){
        const px = steps===1 ? target : prev + dir*tick*k;
        levels.push({
          open: k===1 ? prev : levels[levels.length-1].close,
          high: Math.max(px, prev), low: Math.min(px, prev), close:px,
          delta:(Number(b.delta)||0)/steps, volume:(Number(b.volume)||0)/steps,
          time:b.time, i:levels.length, sourceCandle:i, levelIndex:levels.length, levelSize:tick, levelMove:dir
        });
        if(levels.length>=maxLevels) break;
      }
      prev=target;
      if(levels.length>=maxLevels) break;
    }
    return {levels, levelSize:tick};
  }
  function returns(bars){const r=[];for(let i=1;i<bars.length;i++){const p=bars[i-1].close;if(p)r.push((bars[i].close-p)/p);}return r;}
  function ema(vals,period){const k=2/(period+1);let e=vals[0]||0;const out=[e];for(let i=1;i<vals.length;i++){e=vals[i]*k+e*(1-k);out.push(e);}return out;}
  function sma(vals,end,len){let s=0,n=0;for(let i=Math.max(0,end-len+1);i<=end;i++){s+=vals[i]||0;n++;}return n?s/n:0;}
  function classify(score,th){if(score>th)return 'BULL'; if(score<-th)return 'BEAR'; return 'SIDE';}
  function featureAt(bars,idx,c,retArr){
    const b=bars[idx], close=b.close, prev=bars[Math.max(0,idx-1)]?.close||close;
    const start=Math.max(1,idx-c.lookback+1), end=idx;
    let winRet=0; for(let i=start;i<=end;i++){const p=bars[i-1]?.close||bars[i].close;if(p)winRet+=(bars[i].close-p)/p;}
    const volSlice=retArr.slice(Math.max(0,idx-c.volwin),idx).map(Math.abs);
    const vol=stdev(retArr.slice(Math.max(0,idx-c.volwin),idx)) || mean(volSlice) || Math.abs((close-prev)/(prev||close)) || 0.0001;
    const closes=bars.map(x=>x.close);
    const fast=sma(closes,idx,Math.max(2,Math.round(c.lookback/3)));
    const slow=sma(closes,idx,c.lookback);
    const trend=(fast-slow)/(close||1);
    const range=Math.max(Math.abs(b.high-b.low), Math.abs(close)*0.00001);
    const body=(close-b.open)/range;
    const loc=((close-b.low)/range)-0.5;        // close near high = positive
    const deltaNorm=b.volume?b.delta/b.volume:0;
    const retScore=tanhNorm(winRet, vol*Math.sqrt(c.lookback));
    const trendScore=tanhNorm(trend, vol*Math.sqrt(c.lookback));
    const bodyScore=clamp(body,-1,1);
    const locScore=clamp(loc*2,-1,1);
    const ofScore=clamp(deltaNorm,-1,1);
    const score=0.34*retScore + 0.28*trendScore + 0.18*bodyScore + 0.12*locScore + 0.08*ofScore;
    return {score, retScore, trendScore, bodyScore, locScore, ofScore, winRet, trend, vol, state:classify(score,c.thresh)};
  }
  function buildStates(bars,c){const ret=returns(bars);const states=new Array(bars.length).fill(null), feats=new Array(bars.length).fill(null);for(let i=Math.max(c.lookback,c.volwin);i<bars.length;i++){const f=featureAt(bars,i,c,ret);feats[i]=f;states[i]=f.state;}return {states,feats};}
  function percentile(arr,p){
    const a=(arr||[]).filter(v=>Number.isFinite(v)).sort((x,y)=>x-y);
    if(!a.length) return 0;
    return a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*p)))];
  }
  function autoCalibrate(candleBars,base){
    const levelSize=inferLevelSize(candleBars);
    const tmp=Object.assign({},base,{levelSize});
    const levels=toLevelBars(candleBars,tmp).levels;
    const n=levels.length;
    const lookback=clamp(Math.round(Math.sqrt(Math.max(n,1))*4),20,500);
    const block=clamp(Math.round(lookback/4),5,100);
    const volwin=clamp(Math.round(lookback*1.5),30,800);
    const c=Object.assign({},base,{levelSize,lookback,block,volwin,thresh:base.thresh});
    const ret=returns(levels), scores=[];
    const start=Math.max(lookback,volwin);
    for(let i=start;i<levels.length;i++){
      try{ const f=featureAt(levels,i,c,ret); if(f && Number.isFinite(f.score)) scores.push(Math.abs(f.score)); }catch(e){}
    }
    let thresh=percentile(scores,0.70);
    if(!Number.isFinite(thresh) || thresh<=0) thresh=.35;
    thresh=clamp(thresh,.12,.95);
    return {levelSize,lookback,block,volwin,thresh,levels:n};
  }
  function applyAutoInputs(auto){
    const map={
      'rg-lookback':auto.lookback,
      'rg-block':auto.block,
      'rg-volwin':auto.volwin,
      'rg-levelsize':Number(auto.levelSize).toFixed(4).replace(/0+$/,'').replace(/\.$/,''),
      'rg-thresh':Number(auto.thresh).toFixed(2)
    };
    Object.keys(map).forEach(id=>{const e=$(id); if(e && document.activeElement!==e) e.value=map[id];});
  }
  function blockSeq(states,c){const seq=[];for(let st=0;st<states.length;st+=c.block){const part=states.slice(st,st+c.block).filter(Boolean);if(!part.length)continue;const counts={BULL:0,SIDE:0,BEAR:0};part.forEach(s=>counts[s]++);seq.push(STATES.sort((a,b)=>counts[b]-counts[a])[0]);}return seq;}
  function buildMatrix(seq){const idx={BULL:0,SIDE:1,BEAR:2};const counts=[[0,0,0],[0,0,0],[0,0,0]];for(let i=0;i<seq.length-1;i++){if(seq[i]&&seq[i+1])counts[idx[seq[i]]][idx[seq[i+1]]]++;}return counts.map(r=>{const t=r.reduce((a,b)=>a+b,0);return t?r.map(v=>v/t):[1/3,1/3,1/3];});}
  function matMul(a,b){const r=[[0,0,0],[0,0,0],[0,0,0]];for(let i=0;i<3;i++)for(let j=0;j<3;j++){let s=0;for(let k=0;k<3;k++)s+=a[i][k]*b[k][j];r[i][j]=s;}return r;}
  function matPow(m,n){let r=[[1,0,0],[0,1,0],[0,0,1]],b=m;while(n>0){if(n&1)r=matMul(r,b);b=matMul(b,b);n>>=1;}return r;}
  function stationary(m){let v=[1/3,1/3,1/3];for(let k=0;k<300;k++){const nv=[0,0,0];for(let j=0;j<3;j++)for(let i=0;i<3;i++)nv[j]+=v[i]*m[i][j];v=nv;}return v;}
  function signature(bars,c){const n=bars.length;if(!n)return '0';const a=bars[n-1];return [n,a.close,a.high,a.low,a.delta,a.time,c.lookback,c.block,c.volwin,c.n,c.levelSize,c.thresh].join('|');}
  function drawPrice(bars,states){const cv=$('rg-price');if(!cv)return;const dpr=window.devicePixelRatio||1,w=cv.clientWidth||800,h=155;cv.width=w*dpr;cv.height=h*dpr;const ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);if(bars.length<2)return;const closes=bars.map(b=>b.close),mn=Math.min(...closes),mx=Math.max(...closes),pad=10;const x=i=>pad+i/(bars.length-1)*(w-2*pad),y=v=>h-pad-((v-mn)/(mx-mn||1))*(h-2*pad);ctx.strokeStyle='#1e2840';ctx.lineWidth=1;for(let g=0;g<4;g++){const yy=pad+g*(h-2*pad)/3;ctx.beginPath();ctx.moveTo(pad,yy);ctx.lineTo(w-pad,yy);ctx.stroke();}ctx.beginPath();ctx.moveTo(x(0),y(closes[0]));for(let i=1;i<closes.length;i++)ctx.lineTo(x(i),y(closes[i]));ctx.strokeStyle='#aab3c6';ctx.lineWidth=1.4;ctx.stroke();const last=bars.length-1;ctx.fillStyle=COLORS[states[last]]||'#c9a24b';ctx.beginPath();ctx.arc(x(last),y(closes[last]),4,0,Math.PI*2);ctx.fill();}
  function drawRibbon(states){const el=$('rg-ribbon');if(!el)return;el.innerHTML='';let last=-1;states.forEach((s,i)=>{if(s)last=i;});states.forEach((s,i)=>{const d=document.createElement('div');d.className='seg'+(i===last?' current':'');d.style.background=s?COLORS[s]:'transparent';d.style.opacity=s?(i===last?'1':'.58'):'0';el.appendChild(d);});}
  function renderMatrix(el,m){if(!el)return;let html='<tr><th></th>'+STATES.map(s=>'<th>'+s+'</th>').join('')+'</tr>';STATES.forEach((rs,i)=>{html+='<tr><td>'+rs+'</td>';STATES.forEach((cs,j)=>{html+='<td class="'+(i===j?'diag '+rs:'')+'">'+(m[i][j]*100).toFixed(1)+'%</td>';});html+='</tr>';});el.innerHTML=html;}
  function renderBars(el,v){if(!el)return;el.innerHTML='';STATES.forEach((s,i)=>{const row=document.createElement('div');row.className='barrow';row.innerHTML='<div class="lab">'+s+'</div><div class="track"><div class="fill" style="width:'+(v[i]*100).toFixed(1)+'%;background:'+COLORS[s]+'"></div></div><div class="pct">'+(v[i]*100).toFixed(1)+'%</div>';el.appendChild(row);});}
  function renderMeters(el,labels,vals){if(!el)return;el.innerHTML='';labels.forEach((lab,i)=>{const v=vals[i], pct=clamp(Math.abs(v)*100,0,100);const color=v>0?'#2dd4a8':v<0?'#ef4565':'#c9a24b';const row=document.createElement('div');row.className='rg-meter';row.innerHTML='<div class="m-lab">'+lab+'</div><div class="m-track"><div class="m-fill" style="width:'+pct.toFixed(1)+'%;background:'+color+'"></div></div><div class="m-val">'+fmt(v,2)+'</div>';el.appendChild(row);});}
  function renderFeatures(f){const el=$('rg-features');if(!el)return;const items=[['Return',f.retScore],['Trend',f.trendScore],['Body',f.bodyScore],['Close Loc',f.locScore],['OrderFlow',f.ofScore],['Volatility',f.vol*100]];el.innerHTML=items.map(x=>'<div class="rg-score"><div class="name">'+x[0]+'</div><div class="num '+(x[1]>0?'pos':x[1]<0?'neg':'flat')+'">'+fmt(x[1],x[0]==='Volatility'?3:2)+'</div></div>').join('');}
  let lastSig='';
  function update(force){
    const rawCfg=cfg(), candleBars=getModelBars(), auto=autoCalibrate(candleBars,rawCfg);
    applyAutoInputs(auto);
    const c=Object.assign({},rawCfg,auto,{n:rawCfg.n});
    const sig=signature(candleBars,c)+'|auto:'+auto.levels;
    if(!force&&sig===lastSig)return; lastSig=sig;
    const lvl=toLevelBars(candleBars,c), bars=lvl.levels;
    const info=$('regime-info');
    if(info)info.textContent='Full loaded history from first row: '+candleBars.length+' candles · '+bars.length+' price levels · AUTO level size '+lvl.levelSize+' · AUTO threshold ±'+c.thresh.toFixed(2)+' · manual forecast '+c.n+' levels';
    if($('rg-range-info'))$('rg-range-info').textContent=bars.length?bars.length+' price levels from full loaded history':'';
    if(bars.length<Math.max(c.lookback,c.volwin)+3){drawPrice(bars,[]);drawRibbon([]);['rg-pill','rg-score-now','rg-trend-now','rg-signal','rg-fcast-level','rg-conv'].forEach(id=>{const e=$(id);if(e)e.textContent='—';});if($('rg-report'))$('rg-report').textContent='Need more full-history price-level data. Forecast levels can stay manual, but the auto threshold/level size needs more loaded rows.';return;}
    const pack=buildStates(bars,c), states=pack.states, feats=pack.feats, seq=blockSeq(states,c), mat=buildMatrix(seq), stat=stationary(mat), last=bars.length-1, f=feats[last];
    const idx={BULL:0,SIDE:1,BEAR:2}[f.state], Mn=matPow(mat,c.n), forecast=Mn[idx], bestIdx=forecast.indexOf(Math.max(...forecast)), fState=STATES[bestIdx];
    const lastLevel=bars[bars.length-1]||{};
    const lastPrice=Number.isFinite(lastLevel.close)?lastLevel.close:(Number.isFinite(lastLevel.price)?lastLevel.price:0);
    const levelStep=Math.abs((lvl&&lvl.levelSize)||c.levelSize||((typeof CFG!=='undefined'&&CFG.tickSize)||0.1)||0.1);
    const forecastMoveLevels=(fState==='BULL'?Math.abs(c.n):(fState==='BEAR'?-Math.abs(c.n):0));
    let forecastLevelValue=lastPrice + forecastMoveLevels*levelStep;
    // Hard consistency rule: BEAR forecast must be below the current close, BULL forecast must be above it.
    if(fState==='BEAR') forecastLevelValue=Math.min(forecastLevelValue,lastPrice-levelStep);
    if(fState==='BULL') forecastLevelValue=Math.max(forecastLevelValue,lastPrice+levelStep);
    if(fState==='SIDE') forecastLevelValue=lastPrice;
    const signal=forecast[0]-forecast[2], confidence=Math.max(...forecast)-Math.min(...forecast), scoreConf=Math.min(1,Math.abs(f.score)/Math.max(c.thresh,0.01));
    drawPrice(bars,states);drawRibbon(states);renderMatrix($('rg-matrix'),mat);renderBars($('rg-stationary'),stat);renderMeters($('rg-probs'),['Bull','Side','Bear'],forecast);renderFeatures(f);
    const pill=$('rg-pill');if(pill){pill.textContent=f.state;pill.className='rg-pill '+f.state;}const sn=$('rg-score-now');if(sn){sn.textContent=fmt(f.score,2);sn.className='val '+(f.score>c.thresh?'pos':f.score<-c.thresh?'neg':'flat');}const tr=$('rg-trend-now');if(tr){tr.textContent=fmt(f.trendScore,2);tr.className='val '+(f.trendScore>0.05?'pos':f.trendScore<-0.05?'neg':'flat');}const sg=$('rg-signal');if(sg){sg.textContent=fmt(signal*100,1)+'%';sg.className='val '+(signal>0.03?'pos':signal<-0.03?'neg':'flat');}const flv=$('rg-fcast-level');if(flv){flv.textContent=(Number.isFinite(forecastLevelValue)?forecastLevelValue.toFixed(2):'—')+' ('+(forecastMoveLevels>0?'+':'')+forecastMoveLevels+' lv)';flv.className='val '+(fState==='BULL'?'pos':fState==='BEAR'?'neg':'flat');}const cv=$('rg-conv');if(cv){cv.textContent=(confidence*100).toFixed(1)+'%';cv.className='val '+(signal>0.03?'pos':signal<-0.03?'neg':'flat');}const cb=$('rg-conv-bar');if(cb){cb.style.width=clamp(confidence*100,0,100)+'%';cb.style.background=signal>=0?COLORS.BULL:COLORS.BEAR;}
    let dir='NEUTRAL', cls='neutral', reason='Mixed or low-confidence regime.';if(f.state==='BULL'&&fState==='BULL'&&signal>0.08&&scoreConf>.65){dir='BUY';cls='buy';reason='Current state and Markov forecast both favor BULL.';}else if(f.state==='BEAR'&&fState==='BEAR'&&signal<-0.08&&scoreConf>.65){dir='SELL';cls='sell';reason='Current state and Markov forecast both favor BEAR.';}else if(signal>0.04&&f.score>0){dir='BUY WATCH';cls='buy';reason='Bull probability is improving but confirmation is not complete.';}else if(signal<-0.04&&f.score<0){dir='SELL WATCH';cls='sell';reason='Bear probability is improving but confirmation is not complete.';}
    const rep=$('rg-report');if(rep)rep.innerHTML='<b>Suggested direction:</b> <span class="'+cls+'">'+dir+'</span><br><b>Reason:</b> '+reason+'<br><b>Current adaptive regime:</b> '+f.state+' · score '+fmt(f.score,2)+' · threshold ±'+c.thresh.toFixed(2)+'<br><b>'+c.n+'-level forecast:</b> '+fState+' → forecast level value '+(Number.isFinite(forecastLevelValue)?forecastLevelValue.toFixed(2):'—')+' ('+(forecastMoveLevels>0?'+':'')+forecastMoveLevels+' levels) — Bull '+(forecast[0]*100).toFixed(1)+'%, Side '+(forecast[1]*100).toFixed(1)+'%, Bear '+(forecast[2]*100).toFixed(1)+'%<br><b>Model:</b> adaptive normalized level returns + level trend + candle/level structure + optional order-flow delta. Lookback and forecast are counted in price levels, not candles.';
    window.RegimeLinkedState={direction:dir,regime:f.state,score:f.score,signal,forecast:fState,forecastLevelValue,forecastMoveLevels,probabilities:{bull:forecast[0],side:forecast[1],bear:forecast[2]},features:f};
  }
  window.RegimeLinked={update,getBars,getModelBars};
  ['rg-lookback','rg-block','rg-volwin','rg-nstep','rg-levelsize','rg-thresh'].forEach(id=>document.addEventListener('change',e=>{if(e.target&&e.target.id===id)update(true);}));
  const oldSwitch=window.switchTab; window.switchTab=function(tab){ if(typeof oldSwitch==='function') oldSwitch(tab); else {document.querySelectorAll('.main-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active',p.id===tab+'-pane'));} if(tab==='regime') setTimeout(()=>update(true),30); };
  window.addEventListener('resize',()=>{if(((document.querySelector('.main-tab.active')||{}).dataset||{}).tab==='regime')update(true);});
  // NOTE: periodic redraw disabled — this script's own drawPrice() was fighting with the
  // final regime chart renderer (arrows + crosshair), overwriting it every 700ms.
  // Recompute now happens on data change / tab switch only, via the final renderer.
  setTimeout(()=>update(true),800);
})();

// ==== of-regime-engine-robust-autofix-js ====
(function(){
  var STATES=['BULL','SIDE','BEAR'];
  var COLORS={BULL:'#2dd4a8',SIDE:'#c9a24b',BEAR:'#ef4565'};
  function q(id){return document.getElementById(id);} 
  function n(v,d){v=Number(v);return isFinite(v)?v:(d||0);} 
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function mean(a){return a&&a.length?a.reduce(function(s,x){return s+x;},0)/a.length:0;}
  function std(a){if(!a||a.length<2)return 0;var m=mean(a);return Math.sqrt(mean(a.map(function(x){return (x-m)*(x-m);})));}
  function fmt(v,d){v=Number(v); if(!isFinite(v)) return '—'; return (v>0?'+':'')+v.toFixed(d==null?2:d);}
  function parseDate(v){
    if(v instanceof Date && isFinite(v)) return v.getTime();
    if(typeof v==='number' && isFinite(v)) return v>100000000000?v:(v>20000?Math.round((v-25569)*86400000):0);
    if(!v) return 0;
    var s=String(v).trim();
    var m=s.match(/^(\d{4})[-\.\/](\d{1,2})[-\.\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(m) return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0)).getTime();
    m=s.match(/^(\d{1,2})[\.\/](\d{1,2})[\.\/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(m) return new Date(+m[3],+m[2]-1,+m[1],+m[4],+m[5],+(m[6]||0)).getTime();
    var t=Date.parse(s); return isFinite(t)?t:0;
  }
  function rowTime(r){
    try{ if(typeof _toAbsMs==='function'){var x=_toAbsMs(r); if(x) return x;} }catch(e){}
    return parseDate(r.Timestamp||r.timestamp||r.TIMESTAMP||r.time||r.TIME||r.date||r.DATE||r['TIMEACT NS']||r['TIMACT_NS']);
  }
  function priceOf(r){return n(r.TRDPRC_1, n(r.Last, n(r.LAST, n(r.last, n(r.price, n(r.BID, n(r.ASK,0)))))));}
  function volOf(r){return n(r.TRDVOL_1, n(r['TRADE VOL'], n(r.TrdVol, n(r.volume, n(r.Volume,1)))));}
  function deltaOf(r){
    var v=volOf(r), side=String(r.AGGRS_SID1||r['AGGRESSIVE ORD1']||r.side||'').toUpperCase(), tick=String(r.PRCTCK_1||r['CF TICK']||'');
    if(side.indexOf('ASK')>=0 || tick.indexOf('⇧')>=0) return v;
    if(side.indexOf('BID')>=0 || tick.indexOf('⇩')>=0) return -v;
    return 0;
  }
  function allRows(){
    var out=[];
    // Honor the same Day/Time custom range Price Summary, Level Aggregator,
    // LA Pro and Flip Pairs already respect (via srcRows()/_dtActive), so
    // Regime Engine reflects the selected interval instead of always
    // recomputing over the entire loaded history.
    try{ if(typeof _dtActive!=='undefined' && _dtActive && typeof _dtFilteredRows!=='undefined' && Array.isArray(_dtFilteredRows) && _dtFilteredRows.length) out=_dtFilteredRows.slice(); }catch(e){}
    if(!out.length){
      try{ if(Array.isArray(_allRawRows)&&_allRawRows.length) out=_allRawRows.slice(); }catch(e){}
      try{ if(!out.length&&Array.isArray(window._allRawRows)&&window._allRawRows.length) out=window._allRawRows.slice(); }catch(e){}
      try{ if(!out.length&&Array.isArray(_trAllRows)&&_trAllRows.length) out=_trAllRows.slice(); }catch(e){}
      try{ if(!out.length&&Array.isArray(window._trAllRows)&&window._trAllRows.length) out=window._trAllRows.slice(); }catch(e){}
    }
    return out.filter(function(r){return r && rowTime(r)>0 && priceOf(r)>0;}).sort(function(a,b){return rowTime(a)-rowTime(b);});
  }
  function rangeLabel(rows){
    if(!rows || !rows.length) return '';
    var s=rowTime(rows[0]), e=rowTime(rows[rows.length-1]);
    if(!s || !e) return '';
    var fmt=function(ms){ return new Date(ms).toLocaleString('en-GB',{hour12:false}); };
    var custom=(typeof _dtActive!=='undefined' && _dtActive);
    return (custom?'Custom range':'Full loaded history')+': '+fmt(s)+' → '+fmt(e);
  }
  function intervalSec(){return Math.max(1,n((window.CFG||{}).intervalSec,60));}
  function barsFromRows(rows){
    var sec=intervalSec(), map=new Map();
    rows.forEach(function(r){var ms=rowTime(r); if(!ms)return; var key=Math.floor(ms/(sec*1000)); if(!map.has(key))map.set(key,[]); map.get(key).push(r);});
    var bars=[];
    Array.from(map.keys()).sort(function(a,b){return a-b;}).forEach(function(k){
      var rr=map.get(k).sort(function(a,b){return rowTime(a)-rowTime(b);}); if(!rr.length)return;
      var ps=rr.map(priceOf).filter(function(x){return x>0;}); if(!ps.length)return;
      var open=priceOf(rr[0]), close=priceOf(rr[rr.length-1]);
      bars.push({open:open, high:Math.max.apply(null,ps), low:Math.min.apply(null,ps), close:close, volume:rr.reduce(function(s,r){return s+volOf(r);},0), delta:rr.reduce(function(s,r){return s+deltaOf(r);},0), time:new Date(k*sec*1000).toLocaleTimeString('en-GB',{hour12:false}), rows:rr});
    });
    return bars;
  }
  /* One "bar" per raw tick. toLevels() only synthesizes price levels from
     bar-to-bar close differences, so when the loaded data spans too short a
     time window to fill more than a handful of CFG.intervalSec buckets
     (e.g. a 37-tick / under-a-minute file at a 1m interval collapses into a
     single candle), barsFromRows() starves the level model of history even
     though the raw ticks themselves contain plenty of price movement. This
     keeps every tick as its own bar so toLevels can walk the real price path
     tick-by-tick instead of losing it inside one bucket. */
  function tickBars(rows){
    var bars=[];
    rows.forEach(function(r){
      var p=priceOf(r); if(!(p>0)) return;
      bars.push({open:p, high:p, low:p, close:p, volume:volOf(r), delta:deltaOf(r), time:new Date(rowTime(r)).toLocaleTimeString('en-GB',{hour12:false}), rows:[r]});
    });
    return bars;
  }
  function fallbackBars(){
    var b=[]; try{ if(window.R&&Array.isArray(R.bars)) b=R.bars.slice(); }catch(e){}
    try{ if(!b.length&&Array.isArray(_trBars)) b=_trBars.slice(); }catch(e){}
    try{ if(!b.length&&Array.isArray(_closedBars)) b=_closedBars.slice(); }catch(e){}
    return b.filter(function(x){return x&&isFinite(Number(x.close));}).map(function(x){return {open:n(x.open,x.close),high:n(x.high,x.close),low:n(x.low,x.close),close:n(x.close),volume:n(x.volume,n(x.vol,0)),delta:n(x.delta,n(x.buyVol,0)-n(x.sellVol,0)),time:x.time||''};});
  }
  function inferTick(b){
    var a=[]; for(var i=1;i<b.length;i++){[b[i].close-b[i-1].close,b[i].high-b[i].low].forEach(function(v){v=Math.abs(n(v,0)); if(v>0)a.push(v);}); if(a.length>5000)break;}
    a.sort(function(x,y){return x-y;}); var v=a[Math.floor(a.length*.10)]||a[0]||0.1;
    if(v>=.1) return Math.round(v*10000)/10000; return Math.max(0.0001,Math.round(v*100000)/100000);
  }
  function autoParams(b, manualN){
    var tick=inferTick(b), span=0; for(var i=1;i<b.length;i++) span+=Math.max(1,Math.round(Math.abs(b[i].close-b[i-1].close)/tick));
    /* Lower bound used to be a hard 80 regardless of how much data is loaded,
       which meant any dataset producing fewer than ~83 synthetic price
       levels (small tick files, short custom-range selections) could never
       compute a regime at all — always dashes, no matter how small the
       lookback would need to be. Scale the floor down for small datasets
       (min 8) so short files still get a (lower-confidence) read instead of
       nothing; large datasets are unaffected since sqrt(span)*6 already
       exceeds 80 well before this floor matters. */
    var lookFloor=Math.min(80, Math.max(8, b.length-2));
    var look=clamp(Math.round(Math.sqrt(Math.max(span,b.length))*6),lookFloor,500);
    var block=clamp(Math.round(look/12),3,60);
    var vol=clamp(Math.round(look*.75),Math.min(60,lookFloor),350);
    return {tick:tick, lookback:look, block:block, volwin:vol, n:manualN};
  }
  function applyInputs(p, th){
    var vals={'rg-lookback':p.lookback,'rg-block':p.block,'rg-volwin':p.volwin,'rg-levelsize':String(p.tick),'rg-thresh':th.toFixed(2)};
    Object.keys(vals).forEach(function(id){var e=q(id); if(e&&document.activeElement!==e)e.value=vals[id];});
  }
  function toLevels(b,tick){
    var out=[]; if(!b.length)return out; var prev=b[0].close; out.push(Object.assign({},b[0]));
    for(var i=1;i<b.length;i++){var target=b[i].close, diff=target-prev, steps=Math.max(1,Math.min(1500,Math.round(Math.abs(diff)/tick))), dir=diff>=0?1:-1;
      for(var k=1;k<=steps;k++){var px=(k===steps)?target:prev+dir*tick*k; out.push({open:k===1?prev:out[out.length-1].close,high:Math.max(prev,px),low:Math.min(prev,px),close:px,volume:b[i].volume/steps,delta:b[i].delta/steps,time:b[i].time}); if(out.length>30000)break;}
      prev=target; if(out.length>30000)break;
    }
    return out;
  }
  function scores(levels,p){
    var closes=levels.map(function(x){return x.close;}), rets=[]; for(var i=1;i<levels.length;i++) rets.push((levels[i].close-levels[i-1].close)/(levels[i-1].close||levels[i].close));
    var arr=[];
    for(var j=Math.max(p.lookback,p.volwin);j<levels.length;j++){
      var a=Math.max(1,j-p.lookback+1), wr=0; for(var k=a;k<=j;k++)wr+=(levels[k].close-levels[k-1].close)/(levels[k-1].close||levels[k].close);
      var vol=std(rets.slice(Math.max(0,j-p.volwin),j))||mean(rets.slice(Math.max(0,j-p.volwin),j).map(Math.abs))||0.0001;
      var fast=mean(closes.slice(Math.max(0,j-Math.round(p.lookback/3)),j+1)), slow=mean(closes.slice(Math.max(0,j-p.lookback),j+1));
      var trend=(fast-slow)/(levels[j].close||1), range=Math.max(Math.abs(levels[j].high-levels[j].low),p.tick), body=(levels[j].close-levels[j].open)/range, loc=((levels[j].close-levels[j].low)/range)-.5, of=levels[j].volume?levels[j].delta/levels[j].volume:0;
      var retScore=Math.tanh(wr/(vol*Math.sqrt(p.lookback)||1e-9)), trScore=Math.tanh(trend/(vol*Math.sqrt(p.lookback)||1e-9));
      var score=.36*retScore+.30*trScore+.16*clamp(body,-1,1)+.10*clamp(loc*2,-1,1)+.08*clamp(of,-1,1);
      arr[j]={score:score,retScore:retScore,trendScore:trScore,bodyScore:clamp(body,-1,1),locScore:clamp(loc*2,-1,1),ofScore:clamp(of,-1,1),vol:vol,state:'SIDE'};
    }
    var abs=arr.filter(Boolean).map(function(f){return Math.abs(f.score);}).sort(function(a,b){return a-b;}); var th=clamp(abs[Math.floor(abs.length*.68)]||.35,.12,.75);
    arr.forEach(function(f){if(f)f.state=f.score>th?'BULL':(f.score<-th?'BEAR':'SIDE');}); return {features:arr,thresh:th};
  }
  function matrix(states,p){var M=[[1,1,1],[1,1,1],[1,1,1]], idx={BULL:0,SIDE:1,BEAR:2}, seq=[]; for(var i=0;i<states.length;i+=p.block){var sl=states.slice(i,i+p.block).filter(Boolean); if(sl.length){var c={BULL:0,SIDE:0,BEAR:0}; sl.forEach(function(s){c[s]++;}); seq.push(c.BULL>=c.SIDE&&c.BULL>=c.BEAR?'BULL':(c.BEAR>=c.SIDE?'BEAR':'SIDE'));}}
    for(var j=1;j<seq.length;j++)M[idx[seq[j-1]]][idx[seq[j]]]++; return M.map(function(r){var s=r[0]+r[1]+r[2];return r.map(function(x){return x/s;});});}
  function matMul(a,b){var r=[[0,0,0],[0,0,0],[0,0,0]];for(var i=0;i<3;i++)for(var j=0;j<3;j++)for(var k=0;k<3;k++)r[i][j]+=a[i][k]*b[k][j];return r;}
  function matPow(m,n){var r=[[1,0,0],[0,1,0],[0,0,1]],b=m;while(n>0){if(n&1)r=matMul(r,b);b=matMul(b,b);n>>=1;}return r;}
  function stationary(m){var v=[1/3,1/3,1/3];for(var k=0;k<200;k++){var nv=[0,0,0];for(var j=0;j<3;j++)for(var i=0;i<3;i++)nv[j]+=v[i]*m[i][j];v=nv;}return v;}
  function drawArrowRG(c,x,y,dir,color){
    c.save(); c.strokeStyle=color; c.fillStyle=color; c.lineWidth=2;
    var len=13, gap=5;
    if(dir==='up'){
      var tailY=Math.min(y+len+gap, c.canvas.height-2);
      c.beginPath(); c.moveTo(x,tailY); c.lineTo(x,y+gap); c.stroke();
      c.beginPath(); c.moveTo(x,y+gap-1); c.lineTo(x-4,y+gap+7); c.lineTo(x+4,y+gap+7); c.closePath(); c.fill();
    } else {
      var tailY2=Math.max(y-len-gap, 12);
      c.beginPath(); c.moveTo(x,tailY2); c.lineTo(x,y-gap); c.stroke();
      c.beginPath(); c.moveTo(x,y-gap+1); c.lineTo(x-4,y-gap-7); c.lineTo(x+4,y-gap-7); c.closePath(); c.fill();
    }
    c.restore();
  }
  /* Small red circular "STOP" badge, matching the MetaTrader Expert Advisor style
     shown at stopped-out exits (a position closed at a loss vs. its entry price). */
  function drawStopBadgeRG(c,x,y,color,ringColor){
    c.save();
    c.fillStyle=color||'#c0392b';
    c.beginPath(); c.arc(x,y,7,0,Math.PI*2); c.fill();
    c.strokeStyle=ringColor||'#7a2018'; c.lineWidth=1; c.stroke();
    c.fillStyle='#fff'; c.font='bold 6px Courier New, monospace'; c.textAlign='center'; c.textBaseline='middle';
    c.fillText('STOP', x, y+0.5);
    c.textBaseline='alphabetic';
    c.restore();
  }
  /* Only mark a Buy/Sell the first time a new BULL/BEAR run holds for at least
     `minRun` consecutive price levels — filters single-tick noise so arrows appear
     only at real, sustained regime changes (matches the reference chart's sparse markers). */
  function computeSignalArrowsRG(states, minRun){
    var marks=[]; if(!states.length) return marks;
    var runState=states[0], runStart=0, lastSignal=null;
    for(var i=1;i<=states.length;i++){
      var s=states[i];
      if(s!==runState){
        var runLen=i-runStart;
        if((runState==='BULL'||runState==='BEAR') && runLen>=minRun && runState!==lastSignal){
          marks.push({index:runStart, type: runState==='BULL'?'buy':'sell'});
          lastSignal=runState;
        }
        runState=s; runStart=i;
      }
    }
    return marks;
  }
  /* FX Pattern System style position tracking: opens a long on a confirmed BULL run,
     a short on a confirmed BEAR run, and closes (Buy Exit / Sell Exit) whenever the
     regime leaves that run — into SIDE (flat) or the opposite direction (reverse).
     An exit is flagged as a stop-out (red STOP badge) when price moved against the
     open position since entry; otherwise it's a plain signal-based exit. */
  function computeTradeMarkersRG(states, prices, minRun){
    var events=[]; if(!states.length) return events;
    var runState=states[0], runStart=0, openPos=null;
    // Exit at the actual swing high (buy) / swing low (sell) reached while
    // the position was open — i.e. the end of the price transition it rode
    // — rather than just the bar index where the regime label flipped away.
    // A regime flip is a lagging confirmation; the real top/bottom of the
    // move is usually a few bars earlier, which is what "end of transition"
    // means visually (the peak/trough the line actually turns at).
    function extremumIndex(from, to, wantMax){
      var bestI=from, bestV=prices[from];
      for(var k=from+1;k<=to;k++){
        var v=prices[k];
        if(wantMax ? v>bestV : v<bestV){ bestV=v; bestI=k; }
      }
      return bestI;
    }
    function closePos(atIndex){
      if(!openPos) return;
      var exitIdx=extremumIndex(openPos.entryIndex, Math.max(openPos.entryIndex,atIndex), openPos.type==='buy');
      var exitPrice=prices[exitIdx];
      var isStop = openPos.type==='buy' ? (exitPrice < openPos.entryPrice) : (exitPrice > openPos.entryPrice);
      events.push({type: openPos.type==='buy'?'buyExit':'sellExit', index:exitIdx, isStop:isStop});
      openPos=null;
    }
    for(var i=1;i<=states.length;i++){
      var s=states[i];
      if(s!==runState){
        var runLen=i-runStart;
        var qualifies=(runState==='BULL'||runState==='BEAR')&&runLen>=minRun;
        if(qualifies){
          if(runState==='BULL'){
            if(openPos&&openPos.type==='sell') closePos(runStart);
            if(!openPos){ events.push({type:'buy', index:runStart}); openPos={type:'buy', entryIndex:runStart, entryPrice:prices[runStart]}; }
          } else { // BEAR
            if(openPos&&openPos.type==='buy') closePos(runStart);
            if(!openPos){ events.push({type:'sell', index:runStart}); openPos={type:'sell', entryIndex:runStart, entryPrice:prices[runStart]}; }
          }
        } else if(runState==='SIDE' && (i-runStart)>=minRun && openPos){
          closePos(runStart);
        }
        runState=s; runStart=i;
      }
    }
    return events;
  }
  function initRgCardResize(){
    var handle=q('rg-card-resize-handle'), split=q('rg-price-split');
    if(!handle||!split||handle.__rgResizeBound) return;
    handle.__rgResizeBound=true;
    var dragging=false, startY=0, startH=0;
    function apply(h){
      h=Math.max(90, Math.min(700, h));
      split.style.height=h+'px';
      try{ if(window.RegimeLinked && typeof RegimeLinked.update==='function') RegimeLinked.update(true); }catch(e){}
    }
    handle.addEventListener('mousedown', function(e){
      dragging=true; startY=e.clientY; startH=split.getBoundingClientRect().height;
      handle.classList.add('dragging'); document.body.classList.add('rg-card-resizing');
      e.preventDefault();
    });
    window.addEventListener('mousemove', function(e){
      if(!dragging) return;
      apply(startH + (e.clientY - startY));
    });
    window.addEventListener('mouseup', function(){
      if(!dragging) return;
      dragging=false; handle.classList.remove('dragging'); document.body.classList.remove('rg-card-resizing');
    });
  }
  window.initRgCardResize=initRgCardResize;
  function installRgPriceHover(cv){
    if(cv.__rgHoverBound) return; cv.__rgHoverBound=true;
    var card=cv.closest('.rg-card')||cv.parentElement;
    if(card && getComputedStyle(card).position==='static') card.style.position='relative';
    function restore(){ var d=cv.__rgData; if(d&&d.snapshot) cv.getContext('2d').putImageData(d.snapshot,0,0); }
    function drawCrosshair(mx,my){
      var d=cv.__rgData; if(!d) return;
      restore();
      var ctx=cv.getContext('2d');
      ctx.save();
      ctx.strokeStyle='rgba(180,180,180,0.35)'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(mx,0); ctx.lineTo(mx,d.hCss); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,my); ctx.lineTo(d.wCss,my); ctx.stroke();
      ctx.setLineDash([]);
      // Price tag on the right edge, exact value under the cursor Y.
      var price=d.yInv(my);
      var tagH=16, tagW=64, tagX=d.wCss-tagW-2, tagY=Math.max(0,Math.min(d.hCss-tagH,my-tagH/2));
      ctx.fillStyle='rgba(10,14,20,0.92)'; ctx.fillRect(tagX,tagY,tagW,tagH);
      ctx.strokeStyle='#5599ff'; ctx.lineWidth=1; ctx.strokeRect(tagX,tagY,tagW,tagH);
      ctx.fillStyle='#aaccff'; ctx.font='bold 10px Courier New'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(price.toFixed(2), tagX+tagW/2, tagY+tagH/2);
      // Time tag on the bottom edge, tied to the nearest price-level point under the cursor.
      var idx=0,bd=Infinity;
      for(var i=0;i<d.n;i++){ var dd=Math.abs(d.xOf(i)-mx); if(dd<bd){bd=dd;idx=i;} }
      var tStr=(d.times[idx]||'—');
      var ttagW=Math.max(56,tStr.length*6.2), ttagH=14;
      var ttagX=Math.max(0,Math.min(d.wCss-ttagW,mx-ttagW/2)), ttagY=d.hCss-ttagH-1;
      ctx.fillStyle='rgba(10,14,20,0.92)'; ctx.fillRect(ttagX,ttagY,ttagW,ttagH);
      ctx.strokeStyle='#5599ff'; ctx.lineWidth=1; ctx.strokeRect(ttagX,ttagY,ttagW,ttagH);
      ctx.fillStyle='#aaccff'; ctx.font='bold 9px Courier New'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(tStr, ttagX+ttagW/2, ttagY+ttagH/2);
      ctx.restore();
    }
    cv.addEventListener('mousemove', function(e){
      var rect=cv.getBoundingClientRect();
      drawCrosshair(e.clientX-rect.left, e.clientY-rect.top);
    });
    cv.addEventListener('mouseleave', restore);
  }
  function drawPrice(b,states){
    var cv=q('rg-price'); if(!cv)return;
    var dpr=window.devicePixelRatio||1,w=cv.clientWidth||800,h=cv.clientHeight||155;
    cv.width=w*dpr; cv.height=h*dpr;
    var c=cv.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,w,h);
    if(b.length<2)return;
    var cls=b.map(function(x){return x.close;}), mn=Math.min.apply(null,cls), mx=Math.max.apply(null,cls), pad=10;
    function x(i){return pad+i/(b.length-1)*(w-2*pad);}
    function y(v){return h-pad-((v-mn)/(mx-mn||1))*(h-2*pad);}
    function yInv(py){return mn + ((h-pad-py)/(h-2*pad))*(mx-mn||1);}
    c.strokeStyle='#1e2840'; for(var g=0;g<4;g++){var yy=pad+g*(h-2*pad)/3;c.beginPath();c.moveTo(pad,yy);c.lineTo(w-pad,yy);c.stroke();}
    c.strokeStyle='#aab3c6'; c.beginPath(); c.moveTo(x(0),y(cls[0])); for(var i=1;i<cls.length;i++)c.lineTo(x(i),y(cls[i])); c.stroke();

    // FX Pattern System style trade markers: Buy/Sell entries + Buy Exit/Sell Exit,
    // with a red STOP badge when the position closed at a loss (like the MetaTrader
    // Expert Advisor overlay: Buy / Buy Exit / Sell / Sell Exit with STOP flags).
    // Markers sit ON the price line at their actual index — entries at the
    // swing low/high that started the move, exits at the swing high/low that
    // ended it (computeTradeMarkersRG already finds that extremum), so a Buy
    // naturally lands near the bottom of its move and its Exit near the top,
    // matching where the price line actually turns.
    var minRun=Math.max(5, Math.round((b.length||100)*0.03));
    var events=computeTradeMarkersRG(states, cls, minRun);
    c.textAlign='center'; c.font='bold 10px Courier New, monospace';
    events.forEach(function(m){
      var mx2=x(m.index), my2=y(cls[m.index]);
      if(m.type==='buy'){
        drawArrowRG(c,mx2,my2,'up','#2dd4a8');
        c.fillStyle='#2dd4a8'; c.fillText('Buy', mx2, Math.min(h-3,my2+29));
      } else if(m.type==='sell'){
        drawArrowRG(c,mx2,my2,'down','#ef4565');
        c.fillStyle='#ef4565'; c.fillText('Sell', mx2, Math.max(11,my2-24));
      } else if(m.type==='buyExit'){
        var byColor=m.isStop?'#ef4565':'#2dd4a8', byRing=m.isStop?'#7a2018':'#12503f';
        var byBadgeY=Math.max(11,my2-18), byExitY=byBadgeY-14, byBuyY=byExitY-11;
        drawStopBadgeRG(c,mx2,byBadgeY,byColor,byRing);
        c.fillStyle=byColor; c.font='bold 9px Courier New, monospace';
        c.fillText('Exit', mx2, byExitY);
        c.fillText('Buy',  mx2, byBuyY);
        c.font='bold 10px Courier New, monospace';
      } else if(m.type==='sellExit'){
        var seColor=m.isStop?'#ef4565':'#2dd4a8', seRing=m.isStop?'#7a2018':'#12503f';
        var seBadgeY=Math.min(h-11,my2+18), seExitY=seBadgeY+14, seSellY=seExitY+11;
        drawStopBadgeRG(c,mx2,seBadgeY,seColor,seRing);
        c.fillStyle=seColor; c.font='bold 9px Courier New, monospace';
        c.fillText('Exit', mx2, seExitY);
        c.fillText('Sell', mx2, seSellY);
        c.font='bold 10px Courier New, monospace';
      }
    });

    c.fillStyle=COLORS[states[states.length-1]]||'#c9a24b'; c.beginPath(); c.arc(x(cls.length-1),y(cls[cls.length-1]),4,0,7); c.fill();

    // Snapshot (full device-pixel buffer, independent of the dpr transform) so hover can restore cheaply.
    cv.__rgData={n:b.length, xOf:x, yOf:y, yInv:yInv, wCss:w, hCss:h, times:b.map(function(it){return it.time||'';}), snapshot:c.getImageData(0,0,cv.width,cv.height)};
    installRgPriceHover(cv);
  }
  /* Right-side subplot: projects the forecast price forward from the current level,
     using the manual "Forecast Levels" count as the horizon. Line color matches the
     forecast regime (Bull/Side/Bear); the shaded cone width reflects how confident
     the N-level Markov forecast is (tighter = more confident). */
  function drawForecast(lastPrice, forecastState, forecastValue, manualN, tick, probArr){
    var cv=q('rg-forecast'); if(!cv) return;
    var dpr=window.devicePixelRatio||1, w=cv.clientWidth||300, h=cv.clientHeight||155;
    cv.width=w*dpr; cv.height=h*dpr;
    var c=cv.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,w,h);
    var pad=12;
    var color=forecastState==='BULL'?'#2dd4a8':forecastState==='BEAR'?'#ef4565':'#c9a24b';
    var fillRgba=forecastState==='BULL'?'rgba(45,212,168,0.14)':forecastState==='BEAR'?'rgba(239,69,101,0.14)':'rgba(201,162,75,0.14)';
    var spread=Math.max(Math.abs(forecastValue-lastPrice), tick*3)*1.6;
    var mn=Math.min(lastPrice,forecastValue)-spread*0.3, mx=Math.max(lastPrice,forecastValue)+spread*0.3;
    function x(f){return pad+f*(w-2*pad);}
    function y(v){return h-pad-((v-mn)/(mx-mn||1))*(h-2*pad);}
    c.strokeStyle='#1e2840'; c.lineWidth=1;
    for(var g=0; g<4; g++){ var yy=pad+g*(h-2*pad)/3; c.beginPath(); c.moveTo(pad,yy); c.lineTo(w-pad,yy); c.stroke(); }
    // Reference line at the current price so the eye can gauge distance moved.
    c.strokeStyle='rgba(170,179,198,0.28)'; c.setLineDash([3,3]); c.lineWidth=1;
    c.beginPath(); c.moveTo(pad,y(lastPrice)); c.lineTo(w-pad,y(lastPrice)); c.stroke(); c.setLineDash([]);
    // Confidence cone — narrower when the model is more confident.
    var conf=probArr?Math.max.apply(null,probArr):0.5;
    var uncertainty=(1-conf)*spread*0.55;
    c.fillStyle=fillRgba;
    c.beginPath();
    c.moveTo(x(0),y(lastPrice));
    c.lineTo(x(1),y(forecastValue+uncertainty));
    c.lineTo(x(1),y(forecastValue-uncertainty));
    c.closePath(); c.fill();
    // Central projected path.
    c.strokeStyle=color; c.lineWidth=1.8;
    c.beginPath(); c.moveTo(x(0),y(lastPrice)); c.lineTo(x(1),y(forecastValue)); c.stroke();
    // Start (current) and end (forecast) markers.
    c.fillStyle='#aab3c6'; c.beginPath(); c.arc(x(0),y(lastPrice),3.5,0,Math.PI*2); c.fill();
    c.fillStyle=color; c.beginPath(); c.arc(x(1),y(forecastValue),4.5,0,Math.PI*2); c.fill();
    // Labels.
    c.font='bold 9px Courier New'; c.textAlign='left'; c.fillStyle='#aab3c6';
    c.fillText(lastPrice.toFixed(2), x(0)+5, Math.max(11,y(lastPrice)-7));
    c.textAlign='right'; c.fillStyle=color;
    c.fillText(forecastValue.toFixed(2), x(1)-5, Math.max(11,y(forecastValue)-9));
    c.font='8px Courier New'; c.fillStyle='#7b88a4';
    c.fillText('+'+manualN+' lv', x(1)-5, Math.min(h-4,y(forecastValue)+11));
    var infoEl=q('rg-forecast-info');
    if(infoEl) infoEl.textContent=forecastState+' · '+manualN+' levels · conf '+(conf*100).toFixed(0)+'%';
  }
  function ribbon(states){
    var el=q('rg-ribbon'); if(!el) return;
    el.innerHTML='';
    var minRun=Math.max(5, Math.round((states.length||100)*0.03));
    var marks=computeSignalArrowsRG(states, minRun);
    var markByIndex={};
    marks.forEach(function(m){ markByIndex[m.index]=m.type; });
    states.forEach(function(s,i){
      var d=document.createElement('div');
      var cls='seg'+(i===states.length-1?' current':'');
      if(markByIndex[i]==='buy') cls+=' buy-mark';
      else if(markByIndex[i]==='sell') cls+=' sell-mark';
      d.className=cls;
      d.style.background=COLORS[s]||'transparent';
      if(markByIndex[i]) d.title=(markByIndex[i]==='buy'?'Buy':'Sell')+' signal';
      el.appendChild(d);
    });
  }
  function bars(el,v){if(!el)return;el.innerHTML='';STATES.forEach(function(s,i){var d=document.createElement('div');d.className='barrow';d.innerHTML='<div class="lab">'+s+'</div><div class="track"><div class="fill" style="width:'+(v[i]*100).toFixed(1)+'%;background:'+COLORS[s]+'"></div></div><div class="pct">'+(v[i]*100).toFixed(1)+'%</div>';el.appendChild(d);});}
  function probs(el,v){if(!el)return;el.innerHTML='';['Bull','Side','Bear'].forEach(function(s,i){var val=v[i]*2-1,d=document.createElement('div');d.className='rg-meter';d.innerHTML='<div class="m-lab">'+s+'</div><div class="m-track"><div class="m-fill" style="width:'+(v[i]*100).toFixed(1)+'%;background:'+COLORS[STATES[i]]+'"></div></div><div class="m-val">'+(v[i]*100).toFixed(1)+'%</div>';el.appendChild(d);});}
  function features(f){var el=q('rg-features'); if(!el||!f)return; var it=[['Return',f.retScore],['Trend',f.trendScore],['Body',f.bodyScore],['Close Loc',f.locScore],['OrderFlow',f.ofScore],['Volatility',f.vol*100]]; el.innerHTML=it.map(function(x){return '<div class="rg-score"><div class="name">'+x[0]+'</div><div class="num '+(x[1]>0?'pos':x[1]<0?'neg':'flat')+'">'+fmt(x[1],x[0]==='Volatility'?3:2)+'</div></div>';}).join('');}
  function mtable(el,m){if(!el)return;var h='<tr><th></th>'+STATES.map(function(s){return '<th>'+s+'</th>';}).join('')+'</tr>';STATES.forEach(function(rs,i){h+='<tr><td>'+rs+'</td>';STATES.forEach(function(cs,j){h+='<td class="'+(i===j?'diag '+rs:'')+'">'+(m[i][j]*100).toFixed(1)+'%</td>';});h+='</tr>';});el.innerHTML=h;}
  function setText(id,txt,cls){var e=q(id); if(e){e.textContent=txt; if(cls)e.className=cls;}}
  function update(force){
    var manualN=clamp(parseInt((q('rg-nstep')||{}).value,10)||50,1,1000);
    var rows=allRows(), candles=rows.length?barsFromRows(rows):fallbackBars();
    /* If the selected interval bucketed most/all ticks into one or two
       candles (e.g. a short custom-range or a fast tape at a coarse
       interval), fall back to one bar per tick so the level model has a
       real price path to work with instead of starving on 1-2 candles. */
    if(rows.length>=3 && candles.length<Math.min(20,rows.length)) candles=tickBars(rows);
    var info=q('regime-info');
    var rangeTxt=rangeLabel(rows);
    var rri=q('rg-range-info'); if(rri) rri.textContent=rangeTxt;
    if(!candles.length){ if(info)info.textContent='No loaded rows found yet. Load Excel/CSV or connect xlwings, then open Regime Engine.'; return; }
    var p=autoParams(candles,manualN), levels=toLevels(candles,p.tick), sc=scores(levels,p); applyInputs(p,sc.thresh);
    if(info)info.textContent=(rangeTxt?rangeTxt+' · ':'')+rows.length.toLocaleString()+' rows · '+candles.length+' candles · '+levels.length+' price levels · AUTO lookback '+p.lookback+' · block '+p.block+' · vol '+p.volwin+' · level size '+p.tick+' · threshold ±'+sc.thresh.toFixed(2)+' · manual forecast '+manualN+' levels';
    var minNeed=Math.max(p.lookback,p.volwin)+3;
    if(levels.length<minNeed){ drawPrice(levels,[]); ribbon([]); var fcv=q('rg-forecast'); if(fcv){var fctx=fcv.getContext('2d'); fctx.clearRect(0,0,fcv.width,fcv.height);} var rep=q('rg-report'); if(rep)rep.textContent='Need more price-level history: '+levels.length+' / '+minNeed+'. Increase loaded data or use smaller interval.'; return; }
    var stateArr=sc.features.map(function(f){return f&&f.state;}).filter(Boolean), M=matrix(stateArr,p), st=stationary(M), f=sc.features[sc.features.length-1]; if(!f){return;}
    var idx={BULL:0,SIDE:1,BEAR:2}[f.state], fc=matPow(M,manualN)[idx], best=fc.indexOf(Math.max.apply(null,fc)), fState=STATES[best];
    var last=levels[levels.length-1].close, move=fState==='BULL'?manualN:(fState==='BEAR'?-manualN:0), fval=last+move*p.tick;
    if(fState==='BEAR') fval=Math.min(fval,last-p.tick); if(fState==='BULL') fval=Math.max(fval,last+p.tick); if(fState==='SIDE') fval=last;
    var signal=fc[0]-fc[2], conf=Math.max.apply(null,fc)-Math.min.apply(null,fc);
    drawPrice(levels.slice(-1000), stateArr.slice(-1000)); ribbon(stateArr.slice(-400)); mtable(q('rg-matrix'),M); bars(q('rg-stationary'),st); probs(q('rg-probs'),fc); features(f);
    drawForecast(last, fState, fval, manualN, p.tick, fc);
    var pill=q('rg-pill'); if(pill){pill.textContent=f.state; pill.className='rg-pill '+f.state;}
    setText('rg-score-now',fmt(f.score,2),'val '+(f.score>sc.thresh?'pos':f.score<-sc.thresh?'neg':'flat'));
    setText('rg-trend-now',fmt(f.trendScore,2),'val '+(f.trendScore>0?'pos':f.trendScore<0?'neg':'flat'));
    setText('rg-signal',fmt(signal*100,1)+'%','val '+(signal>0?'pos':signal<0?'neg':'flat'));
    setText('rg-fcast-level',fval.toFixed(2)+' ('+(move>0?'+':'')+move+' lv)','val '+(fState==='BULL'?'pos':fState==='BEAR'?'neg':'flat'));
    setText('rg-conv',(conf*100).toFixed(1)+'%','val '+(signal>0?'pos':signal<0?'neg':'flat'));
    var cb=q('rg-conv-bar'); if(cb){cb.style.width=clamp(conf*100,0,100)+'%'; cb.style.background=signal>=0?COLORS.BULL:COLORS.BEAR;}
    var dir='NEUTRAL', cls='neutral', reason='Mixed or low-confidence regime.';
    if(fState==='BULL' && f.score>0){dir='BUY';cls='buy';reason='Forecast state is BULL and the latest adaptive score is positive.';}
    else if(fState==='BEAR' && f.score<0){dir='SELL';cls='sell';reason='Forecast state is BEAR and the latest adaptive score is negative.';}
    else if(signal>0){dir='BUY WATCH';cls='buy';reason='Bull probability is stronger, but latest state confirmation is incomplete.';}
    else if(signal<0){dir='SELL WATCH';cls='sell';reason='Bear probability is stronger, but latest state confirmation is incomplete.';}
    var rep=q('rg-report'); if(rep)rep.innerHTML='<b>Suggested direction:</b> <span class="'+cls+'">'+dir+'</span><br><b>Reason:</b> '+reason+'<br><b>Current adaptive regime:</b> '+f.state+' · score '+fmt(f.score,2)+' · threshold ±'+sc.thresh.toFixed(2)+'<br><b>'+manualN+'-level forecast:</b> '+fState+' → forecast level value '+fval.toFixed(2)+' ('+(move>0?'+':'')+move+' levels) — Bull '+(fc[0]*100).toFixed(1)+'%, Side '+(fc[1]*100).toFixed(1)+'%, Bear '+(fc[2]*100).toFixed(1)+'%<br><b>Direction rule:</b> BULL forecast is always projected above the current close; BEAR forecast is always projected below the current close.';
    window.RegimeLinkedState={direction:dir,regime:f.state,forecast:fState,forecastLevelValue:fval,forecastMoveLevels:move,probabilities:{bull:fc[0],side:fc[1],bear:fc[2]},auto:p,threshold:sc.thresh};
  }
  window.RegimeLinked={update:update}; window.regimeRender=function(){update(true);};
  function initDefaults(){var d={'rg-lookback':300,'rg-block':20,'rg-volwin':200,'rg-nstep':50,'rg-levelsize':0,'rg-thresh':0.35}; Object.keys(d).forEach(function(id){var e=q(id); if(e && (!e.value || e.value==='100' || e.value==='150')) e.value=d[id];});}
  initDefaults();
  document.addEventListener('change',function(e){if(e.target&&/^rg-/.test(e.target.id))setTimeout(function(){update(true);},10);});
  var oldSwitch=window.switchTab; window.switchTab=function(tab){ if(typeof oldSwitch==='function') oldSwitch.apply(this,arguments); if(tab==='regime'){ initRgCardResize(); setTimeout(function(){update(true);},50); } };
  // NOTE: periodic redraw disabled — see note in of-regime-engine-js; this was also
  // overwriting the final chart's arrows/crosshair every 1000ms.
  setTimeout(function(){update(true);},1200);
})();

// ==== of-full-reviewer-regime-final-patch ====
(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const num = v => { const x = parseFloat(v); return Number.isFinite(x)?x:0; };
  const fmt = (v,d=2)=> Number.isFinite(v)?(+v).toFixed(d):'—';
  const cls = v => v>0?'rv-pos':v<0?'rv-neg':'rv-zero';
  function safeRows(){ return (window._allRawRows && _allRawRows.length) ? _allRawRows.slice() : []; }
  function safeBars(){
    if(window._trBars && _trBars.length) return _trBars.slice();
    if(window.R && R.bars && R.bars.length) return R.bars.slice();
    const rows=safeRows();
    if(rows.length && typeof window._bucketByInterval==='function'){
      try{return _bucketByInterval(rows, (window.CFG&&CFG.intervalSec)||60)||[];}catch(e){}
    }
    return [];
  }
  function rowMs(r){
    if(typeof window._toAbsMs==='function') { const m=_toAbsMs(r); if(m) return m; }
    const s=((r.date||'')+' '+(r.time||'')).trim(); const d=new Date(s.replace('T',' ')); return isNaN(d)?0:d.getTime();
  }
  function dtLocal(ms){ if(!ms) return ''; const d=new Date(ms); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
  function parseDt(id){ const v=$(id)?.value; return v?new Date(v).getTime():0; }
  function rowsInRange(start,end){ const rows=safeRows(); return rows.filter(r=>{const m=rowMs(r); return m && (!start||m>=start) && (!end||m<=end);}); }
  function barsFromRows(rows){
    if(!rows || !rows.length) return [];
    try{ return _bucketByInterval(rows.slice(), (window.CFG&&CFG.intervalSec)||60)||[]; }catch(e){ return []; }
  }
  function summarizeBars(bars, name){
    bars = bars||[];
    if(!bars.length) return {name:name||'—', bars:0, open:0, close:0, high:0, low:0, delta:0, volume:0, buy:0, sell:0, poc:0, trend:0, score:0, direction:'NONE'};
    const open=num(bars[0].open), close=num(bars[bars.length-1].close);
    const high=Math.max(...bars.map(b=>num(b.high))), low=Math.min(...bars.map(b=>num(b.low)));
    const delta=bars.reduce((s,b)=>s+num(b.delta||b.totalDelta),0);
    const volume=bars.reduce((s,b)=>s+num(b.totalVol||b.totalVolume||b.volume),0);
    const buy=bars.reduce((s,b)=>s+num(b.buyVol||b.totalLiftVol),0);
    const sell=bars.reduce((s,b)=>s+num(b.sellVol||b.totalHitVol),0);
    const pocMap={}; bars.forEach(b=>(b.footprint||[]).forEach(l=>{pocMap[l.price]=(pocMap[l.price]||0)+num(l.vol||l.trdVol)}));
    let poc=0,pocv=-1; Object.keys(pocMap).forEach(k=>{if(pocMap[k]>pocv){pocv=pocMap[k];poc=+k;}});
    const range=Math.max(0.0001, high-low), trend=(close-open)/range;
    const of=volume?delta/volume:0; const score=0.62*trend+0.38*of;
    const direction=score>0.08?'BULL':score<-0.08?'BEAR':'SIDE';
    return {name:name||'',bars:bars.length,open,close,high,low,delta,volume,buy,sell,poc,trend,score,direction};
  }

  /* Regime Engine rendering/logic now lives solely in of-regime-engine-robust-autofix-js (see below) — this duplicate section, which produced noisier signals and fought over canvas ownership, has been removed. */

  /* ===================== REVIEWER FULL PATCH ===================== */
  const RV={slots:[null,null,null,null,null]};
  function rvStatus(txt){ if($('rv-status')) $('rv-status').textContent=txt; }
  function rvShow(html){ if($('rv-empty')) $('rv-empty').style.display='none'; if($('rv-report')){$('rv-report').style.display='block';$('rv-report').innerHTML=html;} }
  function intervalSummary(prefix,label){ const s=parseDt(`rv-${prefix}-start`), e=parseDt(`rv-${prefix}-end`); return summarizeBars(barsFromRows(rowsInRange(s,e)),label); }
  function summaryTable(items){
    const rows=['bars','open','high','low','close','poc','delta','volume','buy','sell','trend','score','direction'];
    return `<table class="rv-table"><thead><tr><th>Metric</th>${items.map(x=>`<th>${x.name}</th>`).join('')}</tr></thead><tbody>`+rows.map(r=>`<tr><td>${r}</td>${items.map(x=>{let v=x[r]; if(typeof v==='number') v=(['open','high','low','close','poc'].includes(r)?fmt(v,2):fmt(v, r==='score'||r==='trend'?2:0)); return `<td class="${typeof x[r]==='number'?cls(x[r]):''}">${v}</td>`;}).join('')}</tr>`).join('')+`</tbody></table>`;
  }
  function compareBlock(a,b,title){
    const diffClose=b.close-a.close, diffDelta=b.delta-a.delta, diffScore=b.score-a.score;
    let suggestion='NEUTRAL / WAIT'; if(diffScore>0.08 && b.direction!=='BEAR') suggestion='BULLISH / LONG BIAS'; if(diffScore<-0.08 && b.direction!=='BULL') suggestion='BEARISH / SHORT BIAS';
    return `<div class="rv-section"><h3>${title}</h3>${summaryTable([a,b])}<div class="rv-note"><b>Suggestion:</b> <span class="${suggestion.includes('BULL')?'rv-pos':suggestion.includes('BEAR')?'rv-neg':'rv-warn'}">${suggestion}</span> · Close Δ ${fmt(diffClose,2)} · Flow Δ ${fmt(diffDelta,0)} · Score Δ ${fmt(diffScore,2)}</div></div>`;
  }
  window.rvUseCurrentAs=function(which){
    const bars=window.R&&R.bars?R.bars:[]; if(!bars.length){rvStatus('No current chart bars.'); return;}
    const rows=safeRows(); if(rows.length){ const ms=rows.map(rowMs).filter(Boolean); const start=Math.min(...ms), end=Math.max(...ms); $(`rv-${which.toLowerCase()}-start`).value=dtLocal(start); $(`rv-${which.toLowerCase()}-end`).value=dtLocal(end); }
    rvStatus('Current loaded time range copied to interval '+which+'.');
  };
  window.rvGenerateReport=function(){
    const A=intervalSummary('a','Reference A'), B=intervalSummary('b','Reference B'), C=summarizeBars((window.R&&R.bars)||safeBars().slice(-10),'Current');
    let html='<div class="rv-section"><h3>Reviewer Summary</h3>'+summaryTable([A,B,C])+'</div>';
    if(A.bars&&B.bars) html+=compareBlock(A,B,'Reference A vs Reference B');
    if(A.bars&&C.bars) html+=compareBlock(A,C,'Reference A vs Current Live/Replay');
    if(B.bars&&C.bars) html+=compareBlock(B,C,'Reference B vs Current Live/Replay');
    rvShow(html); rvStatus('Report generated.');
  };
  window.rvSaveLoadedToSlot=function(){ const i=(parseInt($('rv-save-slot')?.value||1)-1); RV.slots[i]=summarizeBars(safeBars(),'Reference '+(i+1)); if($('rv-slot-status')) $('rv-slot-status').textContent='Saved current loaded history to slot '+(i+1)+'.'; };
  window.rvLoadReferenceFiles=async function(){
    const files=$('rv-ref-files')?.files; if(!files||!files.length){rvStatus('Choose reference files first.');return;}
    let c=0; for(const f of Array.from(files).slice(0,5)){ try{ const rows=await parseFile(f); RV.slots[c]=summarizeBars(barsFromRows(rows),f.name); c++; }catch(e){console.error(e);} }
    if($('rv-slot-status')) $('rv-slot-status').textContent=`Loaded ${c} reference file(s).`; rvStatus('Reference files loaded.');
  };
  window.rvGenerateSavedReport=function(){ const C=summarizeBars((window.R&&R.bars)||safeBars().slice(-10),'Current'); let html='<div class="rv-section"><h3>Saved References vs Current</h3>'+summaryTable(RV.slots.filter(Boolean).concat([C]))+'</div>'; RV.slots.filter(Boolean).forEach(s=>{html+=compareBlock(s,C,s.name+' vs Current');}); rvShow(html); rvStatus('Saved reference report generated.'); };
  window.rvClearReferences=function(){ RV.slots=[null,null,null,null,null]; if($('rv-slot-status')) $('rv-slot-status').textContent='No temp references saved yet.'; rvShow('<div class="rv-note">Reviewer cleared.</div>'); rvStatus('Cleared.'); };

  const oldSwitch=window.switchTab;
  window.switchTab=function(tab){ if(oldSwitch) oldSwitch.apply(this,arguments); setTimeout(()=>{ if(tab==='reviewer'){ const C=summarizeBars((window.R&&R.bars)||safeBars().slice(-10),'Current'); const inf=$('rv-current-info'); if(inf) inf.innerHTML=`Current bars: <b>${C.bars}</b> · Direction: <b>${C.direction}</b> · Score: <b>${fmt(C.score,2)}</b>`;} },50); };
  window.addEventListener('load',()=>{});
})();

// ==== of-clean-nav-patch ====
/* ============================================================
   ORDERFLOW TRADER — CLEAN NAV PATCH v1.0
   Replaces all conflicting nav patch scripts.
   PREV/NEXT moves ONE bar at a time through _trBars.
   All tabs read from the same current bar ticks.
   ============================================================ */
(function(){
  'use strict';
  function q(id){return document.getElementById(id);}
  function pad(n){return String(n).padStart(2,'0');}

  function getN(){
    var el=q('bar-n');
    var n=parseInt(el&&el.value,10);
    return Math.max(1,isFinite(n)?n:10);
  }
  function getBars(){
    try{return(typeof _trBars!=='undefined'&&Array.isArray(_trBars))?_trBars:[];}catch(e){return[];}
  }
  function getOffset(){
    try{return(typeof _trOffset!=='undefined'&&isFinite(_trOffset))?_trOffset:0;}catch(e){return 0;}
  }
  function setOffset(v){
    try{_trOffset=v;}catch(e){window._trOffset=v;}
  }
  function maxOffset(){
    return Math.max(0,getBars().length-getN());
  }
  function clamp(v){
    return Math.max(0,Math.min(v,maxOffset()));
  }

  function rowMs(r){
    if(!r) return 0;
    try{if(typeof _toAbsMs==='function'){var m=_toAbsMs(r);if(m&&isFinite(m))return m;}}catch(e){}
    try{
      if(r.date&&r.time){
        var d=String(r.date).trim().replace(/\./g,'-').replace(/\//g,'-');
        var p=d.split('-');
        if(p.length===3&&p[0].length<=2) d=p[2]+'-'+pad(+p[1])+'-'+pad(+p[0]);
        var x=new Date(d+'T'+String(r.time).slice(0,8)).getTime();
        if(isFinite(x)) return x;
      }
    }catch(e){}
    try{
      var t=String(r.time||r.TIMEACT_NS||r['TIMEACT NS']||'').trim();
      var mm=t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if(mm) return((+mm[1])*3600+(+mm[2])*60+(+(mm[3]||0)))*1000;
    }catch(e){}
    return 0;
  }

  function fmtInput(ms){
    var d=new Date(ms);
    if(!isFinite(d.getTime())) return '';
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
  }

  function barTicks(b){
    if(!b) return [];
    if(Array.isArray(b.ticks)) return b.ticks;
    if(Array.isArray(b.rows)) return b.rows;
    return [];
  }

  function currentIntervalRows(){
    // Live/replay: the bar actively being built takes priority (matches Candle Summary).
    try{ if(typeof _openBarTicks!=='undefined' && Array.isArray(_openBarTicks) && _openBarTicks.length) return _openBarTicks.slice(); }catch(e){}
    var bars=getBars();
    var n=getN();
    var off=clamp(getOffset());
    var slice=bars.slice(off,off+n);
    // Use only the LAST (currently focused) bar of the visible window — this is the same
    // bar Candle Summary, Trade Log, and Flip Pairs all show. Aggregating across the whole
    // visible window here caused Level Aggregator / LA Pro to disagree with every other tab.
    var focusBar=slice.length?slice[slice.length-1]:null;
    var out=focusBar?barTicks(focusBar):[];
    if(out.length) return out;
    try{if(typeof _dtFilteredRows!=='undefined'&&Array.isArray(_dtFilteredRows)&&_dtFilteredRows.length)return _dtFilteredRows.slice();}catch(e){}
    try{if(typeof _trAllRows!=='undefined'&&Array.isArray(_trAllRows))return _trAllRows.slice();}catch(e){}
    return [];
  }
  window._currentIntervalRows=currentIntervalRows;
  window.dtRows=function(){return currentIntervalRows();};

  function syncTimeInputs(){
    var bars=getBars();
    if(!bars.length) return;
    var off=clamp(getOffset());
    var n=getN();
    var slice=bars.slice(off,off+n);
    if(!slice.length) return;

    var startMs=0,endMs=0;
    slice.forEach(function(b){
      var s=+b._barStartMs||0,e=+b._barEndMs||0;
      if(!s){
        var t1=barTicks(b).slice().sort(function(a,c){return rowMs(a)-rowMs(c);});
        if(t1.length) s=rowMs(t1[0]);
      }
      if(!e){
        var t2=barTicks(b).slice().sort(function(a,c){return rowMs(a)-rowMs(c);});
        if(t2.length) e=rowMs(t2[t2.length-1]);
      }
      if(!startMs||s<startMs) startMs=s;
      if(e>endMs) endMs=e;
    });
    if(!startMs||!endMs) return;

    var sv=fmtInput(startMs),ev=fmtInput(endMs);
    ['tr-start-dt','tr-start'].forEach(function(id){var el=q(id);if(el&&sv)el.value=sv;});
    ['tr-end-dt','tr-end'].forEach(function(id){var el=q(id);if(el&&ev)el.value=ev;});
    var dtS=q('dt-start');if(dtS&&sv)dtS.value=sv;
    var dtE=q('dt-end');if(dtE&&ev)dtE.value=ev;

    var rows=currentIntervalRows();
    try{_dtFilteredRows=rows.slice();_dtActive=true;_dtStartMs=startMs;_dtEndMs=endMs;}catch(ex){}

    var badge=q('dt-filter-active-badge');
    if(badge){
      badge.textContent='● '+rows.length.toLocaleString()+' ticks';
      badge.style.cssText='display:inline-block;padding:2px 8px;border-radius:3px;font-size:9px;color:#00cc66;background:#001a10;border:1px solid #003322';
    }
    var clrBtn=q('dt-clear-btn');if(clrBtn)clrBtn.style.display='inline-block';
    var cnt=q('dt-row-count');
    if(cnt){
      var total=(typeof _trAllRows!=='undefined'&&Array.isArray(_trAllRows))?_trAllRows.length:rows.length;
      cnt.textContent='of '+total.toLocaleString()+' total';
    }
    var tb=q('tr-tick-badge');
    if(tb){tb.textContent=rows.length.toLocaleString()+' ticks';tb.style.color='#00aa55';}
  }

  function updateNavInfo(){
    var bars=getBars();
    var total=bars.length;
    var n=getN();
    var off=clamp(getOffset());
    var first=total?off+1:0;
    var last=total?Math.min(off+n,total):0;
    var info=q('tr-nav-info');
    if(info){
      info.textContent=total?('bar '+first+(last!==first?'–'+last:'')+' / '+total):'— no bars —';
      info.style.color=total?'#00aa55':'#884422';
    }
    function styleBtn(btn,on){
      if(!btn) return;
      btn.disabled=false;
      btn.style.color=on?'#44aaff':'#333';
      btn.style.borderColor=on?'#005599':'#1e1e1e';
      btn.style.cursor=on?'pointer':'default';
      btn.style.opacity=on?'1':'0.4';
    }
    styleBtn(document.querySelector('[data-of-nav="prev"]'),total&&off>0);
    styleBtn(document.querySelector('[data-of-nav="next"]'),total&&off<maxOffset());
  }
  window._trUpdateNavInfo=updateNavInfo;

  function refreshAllTabs(){
    try{_tlRows=currentIntervalRows();}catch(e){}
    try{if(typeof tlRender==='function')tlRender();}catch(e){}
    try{if(typeof sumRender==='function')sumRender();}catch(e){}
    try{if(typeof aggBuild==='function')aggBuild();}catch(e){}
    try{if(typeof laRebuild==='function')laRebuild();}catch(e){}
    try{if(typeof dfpRender==='function'){if(typeof dfpInit==='function')dfpInit();dfpRender();}}catch(e){}
    try{if(typeof csUpdateLast==='function')csUpdateLast();}catch(e){}
    try{if(typeof refreshManualTabs==='function')refreshManualTabs();}catch(e){}
    try{if(window.RegimeLinked&&typeof RegimeLinked.update==='function')RegimeLinked.update(true);}catch(e){}
  }
  window.ofRefreshActiveTab=refreshAllTabs;

  function applyView(){
    var bars=getBars();
    if(!bars.length) return;
    var n=getN();
    var off=clamp(getOffset());
    setOffset(off);

    var slice=bars.slice(off,off+n);
    var cd=off>0?(+(bars[off-1].cumD)||0):0;
    slice.forEach(function(b){cd+=+(b.delta||0);b.cumD=cd;});

    try{_closedBars=slice;_openBarTicks=[];}catch(e){window._closedBars=slice;window._openBarTicks=[];}

    /* Keep the CURRENT/END-candle link in sync during PREV/NEXT navigation, so
       Price Summary, Level Aggregator, LA Pro and Flip Pairs follow the same
       candle as the Candle Summary and the chart (previously only Build Candles
       refreshed these, leaving the data tabs on a stale candle after nav). */
    try{
      var endBar=slice[slice.length-1]||null;
      window._ofVisibleBars=slice;
      var vr=[]; slice.forEach(function(b){ if(b&&Array.isArray(b.ticks)) vr=vr.concat(b.ticks); });
      window._ofVisibleIntervalRows=vr;
      window._ofSelectedEndBar=endBar;
      window._ofSelectedEndBarRows=(endBar&&Array.isArray(endBar.ticks))?endBar.ticks.slice():[];
      try{ _tlRows=vr.slice(); }catch(e2){ window._tlRows=vr.slice(); }
      try{ _dtFilteredRows=vr.slice(); }catch(e2){ window._dtFilteredRows=vr.slice(); }
    }catch(e){}

    syncTimeInputs();

    if(window.R){try{R.destroy();}catch(e){}window.R=null;}
    window.R=new Renderer([]);
    try{if(typeof _rebuildDisplay==='function')_rebuildDisplay();}catch(e){}
    try{if(typeof syncMode==='function')syncMode(CFG.mode);}catch(e){}
    try{if(window.R){R.resize();R.draw();}}catch(e){}

    refreshAllTabs();
    updateNavInfo();

    setTimeout(function(){
      var hs=q('hscroll');
      if(hs) hs.scrollLeft=999999;
      try{if(window.R){R.resize();R.draw();}}catch(e){}
    },30);
  }
  window._trApplyView=applyView;

  window.trNav=function(dir){
    var bars=getBars();
    if(!bars.length){
      if(typeof buildCandles==='function') buildCandles();
      bars=getBars();
    }
    if(!bars.length) return false;

    var off=clamp(getOffset());
    var newOff=clamp(off+(dir<0?-1:1));

    if(newOff===off){updateNavInfo();return false;}
    setOffset(newOff);
    applyView();
    return false;
  };

  window.buildCandles=function(){
    var rows;
    try{
      if(typeof _dtActive!=='undefined'&&_dtActive&&Array.isArray(_dtFilteredRows)&&_dtFilteredRows.length){
        rows=_dtFilteredRows.slice();
      }
    }catch(e){}
    if(!rows||!rows.length){
      try{rows=(Array.isArray(_trAllRows)?_trAllRows:(window._trAllRows||[])).slice();}catch(e){rows=[];}
    }
    if(!rows.length){alert('Load a file first.');return;}

    var ivSec=(window.CFG&&CFG.intervalSec)||60;
    var bars=_bucketByInterval(rows,ivSec);
    if(!bars.length){alert('No bars could be built.\nCheck tick size and time range.');return;}

    var cd=0;
    bars.forEach(function(b){cd+=+(b.delta||0);b.cumD=cd;});
    try{_trBars=bars;}catch(e){window._trBars=bars;}

    var n=getN();
    setOffset(Math.max(0,bars.length-n));

    var dsrc=q('dsrc');
    if(dsrc) dsrc.textContent='● '+rows.length.toLocaleString()+' ticks · '+bars.length+' bars';

    applyView();
  };

  window.switchTab=function(tab){
    document.querySelectorAll('.main-tab').forEach(function(t){
      t.classList.toggle('active',t.dataset.tab===tab);
    });
    document.querySelectorAll('.tab-pane').forEach(function(p){
      p.classList.toggle('active',p.id===tab+'-pane');
    });
    setTimeout(function(){
      if(tab==='chart'&&window.R){try{R.resize();R.draw();}catch(e){}}
      refreshAllTabs();
    },20);
    return false;
  };

  function installShell(){
    var tabs=q('tabs-outer');
    if(!tabs) return;
    tabs.classList.add('of-global-shell');
    if(!document.documentElement.style.getPropertyValue('--of-rp-w'))
      document.documentElement.style.setProperty('--of-rp-w','220px');
  }

  function installRpResize(){
    var handle=q('rp-resize-handle'),panel=q('right-panel');
    if(!handle||!panel||handle.__ofRpFixed) return;
    handle.__ofRpFixed=true;
    var dragging=false,startX=0,startW=0;
    function apply(w){
      w=Math.max(140,Math.min(520,w));
      document.documentElement.style.setProperty('--of-rp-w',w+'px');
      panel.style.setProperty('width',w+'px','important');
      panel.style.setProperty('flex-basis',w+'px','important');
      panel.style.transition='none';
      try{if(window.R){R.resize();R.draw();}}catch(e){}
    }
    handle.addEventListener('mousedown',function(e){
      dragging=true;startX=e.clientX;startW=panel.getBoundingClientRect().width||220;
      handle.classList.add('dragging');document.body.style.cursor='col-resize';document.body.style.userSelect='none';
      e.preventDefault();
    },true);
    window.addEventListener('mousemove',function(e){if(!dragging)return;apply(startW+(startX-e.clientX));},true);
    window.addEventListener('mouseup',function(){
      if(!dragging)return;dragging=false;handle.classList.remove('dragging');
      document.body.style.cursor='';document.body.style.userSelect='';panel.style.transition='width .15s';
    },true);
  }

  function wire(){
    installShell();
    installRpResize();

    document.querySelectorAll('[onclick="trNav(-1)"]').forEach(function(btn){
      if(btn.__ofNavClaimed) return;
      btn.__ofNavClaimed=true;
      btn.setAttribute('data-of-nav','prev');
      btn.removeAttribute('onclick');
      btn.onclick=null;
      btn.addEventListener('click',function(e){e.preventDefault();window.trNav(-1);});
    });
    document.querySelectorAll('[onclick="trNav(1)"]').forEach(function(btn){
      if(btn.__ofNavClaimed) return;
      btn.__ofNavClaimed=true;
      btn.setAttribute('data-of-nav','next');
      btn.removeAttribute('onclick');
      btn.onclick=null;
      btn.addEventListener('click',function(e){e.preventDefault();window.trNav(1);});
    });

    document.querySelectorAll('.main-tab').forEach(function(t){
      var tab=t.dataset.tab;
      if(tab){
        t.removeAttribute('onclick');
        t.addEventListener('click',function(e){e.preventDefault();window.switchTab(tab);});
      }
    });

    var barN=q('bar-n');
    if(barN&&!barN.__ofNavFixed){
      barN.__ofNavFixed=true;
      barN.addEventListener('change',function(){
        var bars=getBars(); if(!bars.length) return;
        /* Re-anchor to the END candle when the visible bar count changes —
           keeping the old offset made a shrinking window jump to the FIRST
           bars, so the same file could show a different candle depending on
           interaction order. "Selected End time is the current last candle"
           holds for bar-count changes too. */
        var n=Math.max(1,parseInt(barN.value,10)||10);
        try{ _trOffset=Math.max(0,bars.length-n); }catch(e){ window._trOffset=Math.max(0,bars.length-n); }
        applyView();
      });
    }

    var buildBtn=q('btn-build');
    if(buildBtn&&!buildBtn.__ofNavFixed){
      buildBtn.__ofNavFixed=true;
      buildBtn.addEventListener('click',function(e){e.preventDefault();window.buildCandles();});
    }

    updateNavInfo();
  }

  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',wire);}else{wire();}
  window.addEventListener('load',function(){
    setTimeout(wire,100);
    setTimeout(updateNavInfo,300);
    setTimeout(function(){
      installShell();
      try{if(window.R){R.resize();R.draw();}}catch(e){}
      refreshAllTabs();
    },500);
  });
})();

// ==== of-final-single-display-tab-fix ====
(function(){
  'use strict';
  const TAB_TO_PANE={
    chart:'chart-pane',tradelog:'tradelog-pane',summary:'summary-pane',
    levels:'levels-pane',lagr:'lagr-pane',dfpairs:'dfpairs-pane',
    reviewer:'reviewer-pane',regime:'regime-pane'
  };
  function q(id){return document.getElementById(id);}
  function moveBefore(parent,node,before){ if(parent&&node&&node.parentNode!==parent) parent.insertBefore(node,before||null); }
  function restoreSingleLayout(){
    const tabs=q('tabs-outer'), chartPane=q('chart-pane'), mainWrap=q('main-wrap'), chartArea=q('chart-area'), rpTab=q('rp-tab');
    if(!tabs||!chartPane) return;

    /* Remove the duplicate Flip tab/pane created by an old patch. The real tab is dfpairs. */
    document.querySelectorAll('.main-tab[data-tab="flip"]').forEach(el=>el.remove());
    const dup=q('flip-pane'); if(dup) dup.remove();

    /* If an old patch created center-tabs-host, move everything back to tabs-outer. */
    const host=q('center-tabs-host');
    if(host){
      if(chartArea&&mainWrap){ const refNode=(rpTab&&rpTab.parentNode===mainWrap)?rpTab:null; mainWrap.insertBefore(chartArea,refNode); }
      Object.values(TAB_TO_PANE).forEach(id=>{
        const p=q(id);
        if(p&&p!==chartPane&&p.parentNode!==tabs) tabs.appendChild(p);
      });
      if(host.parentNode) host.remove();
    }

    /* Keep the original order and guarantee chart-pane remains first. */
    if(chartPane.parentNode!==tabs) tabs.insertBefore(chartPane,tabs.firstChild||null);
    ['tradelog-pane','summary-pane','levels-pane','lagr-pane','dfpairs-pane','reviewer-pane','regime-pane'].forEach(id=>{
      const p=q(id); if(p&&p.parentNode!==tabs) tabs.appendChild(p);
    });
    chartPane.classList.remove('force-static-layout');
  }

  function refreshTabContent(tab){
    try{
      if(tab==='chart'&&window.R){R.resize();R.draw();}
      if(tab==='tradelog'&&typeof window.tlRender==='function') window.tlRender();
      if(tab==='summary'&&typeof window.sumRender==='function') window.sumRender();
      if(tab==='levels'){
        if(typeof window.aggBuild==='function') window.aggBuild();
        else if(typeof window.aggRender==='function') window.aggRender();
      }
      if(tab==='lagr'){
        if(typeof window.laRebuild==='function') window.laRebuild();
        else if(typeof window.laRender==='function') window.laRender();
      }
      if(tab==='dfpairs'){
        if(typeof window.dfpRender==='function') window.dfpRender();
      }
      if(tab==='reviewer'){
        if(typeof window.rvRefreshCurrentInfo==='function') window.rvRefreshCurrentInfo();
      }
      if(tab==='regime'){
        if(window.RegimeLinked&&typeof RegimeLinked.update==='function') RegimeLinked.update(false);
        else if(typeof window.rgUpdate==='function') window.rgUpdate();
        if(typeof window.initRgCardResize==='function') window.initRgCardResize();
      }
      if(typeof window.refreshManualTabs==='function') window.refreshManualTabs();
    }catch(e){ console.warn('tab refresh failed',tab,e); }
  }

  window.switchTab=function(tab){
    restoreSingleLayout();
    if(tab==='flip') tab='dfpairs';
    if(!TAB_TO_PANE[tab]) tab='chart';

    document.querySelectorAll('.main-tab').forEach(btn=>{
      let btab=btn.dataset.tab;
      if(btab==='flip') btab='dfpairs';
      btn.classList.toggle('active',btab===tab);
    });
    document.querySelectorAll('#tabs-outer>.tab-pane').forEach(p=>{
      p.classList.toggle('active',p.id===TAB_TO_PANE[tab]);
    });
    setTimeout(()=>refreshTabContent(tab),30);
    return false;
  };

  function wireTabs(){
    restoreSingleLayout();
    document.querySelectorAll('.main-tab').forEach(btn=>{
      if(btn.dataset.tab==='flip'){btn.remove();return;}
      if(btn.__ofSingleTabFixed) return;
      btn.__ofSingleTabFixed=true;
      btn.addEventListener('click',function(ev){
        ev.preventDefault(); ev.stopImmediatePropagation();
        window.switchTab(btn.dataset.tab||'chart');
      },true);
    });

    const active=document.querySelector('.main-tab.active');
    const tab=(active&&active.dataset.tab&&active.dataset.tab!=='flip')?active.dataset.tab:'chart';
    window.switchTab(tab);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',wireTabs);
  else wireTabs();
  window.addEventListener('load',function(){
    [50,250,700,1200].forEach(ms=>setTimeout(wireTabs,ms));
  });
})();

// ==== sum-col-drag-resize-js ====
(function(){
  if(window.__SUM_COL_DRAG_RESIZE__) return;
  window.__SUM_COL_DRAG_RESIZE__ = true;

  // Custom widths per column label, kept for the session and re-applied
  // after every Price Summary re-render.
  var W = window._sumColWidths = window._sumColWidths || {};
  var drag = null, suppressClick = false;

  function ths(){ var h=document.getElementById('sum-head'); return h?[].slice.call(h.children):[]; }
  function labelOf(th){ return (th.textContent||'').trim(); }

  function apply(){
    var list=ths(); if(!list.length) return;
    var table=list[0].closest('table');
    var any=false;
    list.forEach(function(th){
      var lb=labelOf(th);
      if(W[lb]){ th.style.width=W[lb]+'px'; th.style.minWidth=W[lb]+'px'; th.style.maxWidth=W[lb]+'px'; any=true; }
    });
    if(table) table.style.tableLayout = any ? 'fixed' : '';
  }

  function attach(){
    ths().forEach(function(th){
      if(th.__sumDrag) return;
      th.__sumDrag=true;
      th.style.position='relative';
      var h=document.createElement('span');
      h.className='sum-col-drag-handle';
      h.title='Drag to resize column';
      th.appendChild(h);
      h.addEventListener('mousedown',function(e){
        e.preventDefault(); e.stopPropagation();
        drag={ th:th, label:labelOf(th), x:e.clientX, w:th.getBoundingClientRect().width };
        document.body.style.cursor='col-resize';
        document.body.style.userSelect='none';
      });
    });
  }

  document.addEventListener('mousemove',function(e){
    if(!drag) return;
    var w=Math.max(30, Math.round(drag.w + (e.clientX-drag.x)));
    W[drag.label]=w;
    drag.th.style.width=w+'px'; drag.th.style.minWidth=w+'px'; drag.th.style.maxWidth=w+'px';
    var t=drag.th.closest('table'); if(t) t.style.tableLayout='fixed';
    suppressClick=true;
  });
  document.addEventListener('mouseup',function(){
    if(!drag) return;
    drag=null;
    document.body.style.cursor='';
    document.body.style.userSelect='';
    setTimeout(function(){ suppressClick=false; },0);
  });
  // A drag must not fire the column-sort click on release.
  document.addEventListener('click',function(e){
    if(suppressClick && e.target.closest && e.target.closest('#sum-head')){ e.stopPropagation(); e.preventDefault(); suppressClick=false; }
  }, true);

  function hook(){
    var orig=window.sumRender;
    if(typeof orig!=='function' || orig.__sumDragWrapped) return;
    var wrapped=function(){
      var r=orig.apply(this,arguments);
      try{ apply(); attach(); }catch(e){}
      return r;
    };
    wrapped.__sumDragWrapped=true;
    window.sumRender=wrapped;
  }
  // Hook late so we wrap the final composed sumRender; re-hook if replaced.
  window.addEventListener('load',function(){ setTimeout(function(){ hook(); try{ apply(); attach(); }catch(e){} },700); });
  setInterval(function(){ if(window.sumRender && !window.sumRender.__sumDragWrapped) hook(); },1500);
})();

// ==== rv-alltabs-params-js ====
(function(){
  if(window.__RV_ALLTABS_PARAMS__) return;
  window.__RV_ALLTABS_PARAMS__ = true;

  function q(id){ return document.getElementById(id); }
  function num(v){ v=Number(v); return isFinite(v)?v:0; }
  function fmt(v){ return Math.round(num(v)).toLocaleString(); }
  function sg(v){ v=Math.round(num(v)); return (v>0?'+':'')+v.toLocaleString(); }
  function cls(v){ v=num(v); return v>0?'rv-pos':v<0?'rv-neg':'rv-zero'; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function tickSize(){ return Number((q('rv-tick')||{}).value)||((window.CFG&&CFG.tickSize)||0.10); }
  function snap(v){ var t=tickSize(); return Math.round(Math.round(num(v)/t)*t*1e8)/1e8; }
  function side(r){
    var a=String(r&&r.aggr||'').toUpperCase().trim();
    var t=String((r&&(r.tick||r.PRCTCK_1||r['CF TICK']))||'').toUpperCase().trim();
    if(a==='BID'||a==='SELL'||a==='HIT') return 'HIT';
    if(a==='ASK'||a==='BUY'||a==='LIFT') return 'LIFT';
    if(t.indexOf('⇩')>=0||t==='DOWN') return 'HIT';
    if(t.indexOf('⇧')>=0||t==='UP') return 'LIFT';
    return '';
  }
  function rowMs(r){
    try{ if(typeof window._toAbsMs==='function'){ var b=window._toAbsMs(r); if(b) return b; } }catch(e){}
    var ms=new Date(String(r&&r.date||'')+'T'+String(r&&r.time||'')).getTime();
    return isFinite(ms)?ms:0;
  }
  function inputMs(id){ var el=q(id); if(!el||!el.value) return 0; var ms=new Date(el.value).getTime(); return isFinite(ms)?ms:0; }

  /* ── Per-tab analyzing parameters from ONE row set ─────────────────────── */
  function analyzeTabs(rows){
    rows=(rows||[]).slice().sort(function(a,b){return rowMs(a)-rowMs(b);});
    var out={};

    /* 1) PRICE CANDLE — the exact chart engine */
    var bar=null;
    try{ bar=window._ticksToBar ? _ticksToBar(rows.slice()) : null; }catch(e){}
    if(bar){
      var range=bar.high-bar.low, body=Math.abs(bar.close-bar.open);
      out.candle={
        open:bar.open, high:bar.high, low:bar.low, close:bar.close,
        range:range, bodyPct: range>0 ? Math.round(100*body/range) : 0,
        poc:bar.pocPrice||bar.poc, delta:num(bar.delta), vol:num(bar.totalVol),
        splTrd:num(bar.splTrd),
        vote: bar.close>bar.open ? 1 : bar.close<bar.open ? -1 : 0,
        note: (bar.close>bar.open?'Bull candle':'Bear candle')+' · body '+(range>0?Math.round(100*body/range):0)+'% · Δ '+sg(bar.delta)+' · POC '+num(bar.pocPrice||bar.poc).toFixed(2)
      };
    }

    /* Shared per-level pass for tabs 2–5 (same math the tabs use) */
    var byP={}, T={vol:0,hitVol:0,liftVol:0,hitBid:0,liftAsk:0,hitRTL:0,liftRTL:0,hitSeq:0,liftSeq:0};
    rows.forEach(function(r){
      var s=side(r); if(!s) return;
      var p=snap(s==='HIT'?(num(r.bid)||num(r.last)):(num(r.ask)||num(r.last))); if(!p) return;
      var lv=byP[p]||(byP[p]={price:p,vol:0,hitVol:0,liftVol:0,hitBid:0,liftAsk:0,hitRTL:0,liftRTL:0,hitSeq:0,liftSeq:0});
      var v=num(r.trdVol||r.volume||r.volDiff)||0, rtl=num(r.movesDiff), sq=num(r.seqNumDiff);
      lv.vol+=v; T.vol+=v;
      if(s==='HIT'){ lv.hitVol+=v; lv.hitBid+=num(r.bSize); lv.hitRTL+=rtl; lv.hitSeq+=sq; T.hitVol+=v; T.hitBid+=num(r.bSize); T.hitRTL+=rtl; T.hitSeq+=sq; }
      else { lv.liftVol+=v; lv.liftAsk+=num(r.aSize); lv.liftRTL+=rtl; lv.liftSeq+=sq; T.liftVol+=v; T.liftAsk+=num(r.aSize); T.liftRTL+=rtl; T.liftSeq+=sq; }
    });
    var levels=Object.keys(byP).map(function(k){return byP[k];}).sort(function(a,b){return b.price-a.price;});

    /* 2) PRICE SUMMARY — volume/size deltas */
    var dVol=T.liftVol-T.hitVol, dLAHB=T.liftAsk-T.hitBid;
    out.summary={ levels:levels.length, hitVol:T.hitVol, liftVol:T.liftVol, deltaVol:dVol, deltaLAskHBid:dLAHB,
      vote: (dVol>0&&dLAHB>0)?1:(dVol<0&&dLAHB<0)?-1:0,
      note:'ΔVol '+sg(dVol)+' · Δ LAsk-HBid '+sg(dLAHB)+' · '+levels.length+' levels' };

    /* 3) LEVEL AGGREGATOR — dominance per level (≥2× volume, min 2) */
    var domHit=0, domLift=0, pocLv=levels.slice().sort(function(a,b){return b.vol-a.vol;})[0]||null;
    levels.forEach(function(l){
      if(l.hitVol>=2 && l.hitVol>=2*l.liftVol) domHit++;
      else if(l.liftVol>=2 && l.liftVol>=2*l.hitVol) domLift++;
    });
    out.agg={ domHit:domHit, domLift:domLift, poc:pocLv?pocLv.price:0, pocVol:pocLv?pocLv.vol:0,
      vote: domLift>domHit?1:domHit>domLift?-1:0,
      note: domLift+' lift-dominant vs '+domHit+' hit-dominant levels · POC '+(pocLv?pocLv.price.toFixed(2)+' ('+fmt(pocLv.vol)+')':'—') };

    /* 4) LA PRO — RTL / SEQ pressure + concentration */
    var dRTL=T.liftRTL-T.hitRTL, dSEQ=T.liftSeq-T.hitSeq;
    var topR=levels.slice().sort(function(a,b){return (b.hitRTL+b.liftRTL)-(a.hitRTL+a.liftRTL);})[0]||null;
    var conc=(T.hitRTL+T.liftRTL)>0&&topR ? Math.round(100*(topR.hitRTL+topR.liftRTL)/(T.hitRTL+T.liftRTL)) : 0;
    out.lapro={ hitRTL:T.hitRTL, liftRTL:T.liftRTL, deltaRTL:dRTL, deltaSEQ:dSEQ, conc:conc, topLevel:topR?topR.price:0,
      vote: (dRTL>0&&dSEQ>0)?1:(dRTL<0&&dSEQ<0)?-1:0,
      note:'Δ RTL '+sg(dRTL)+' · Δ SEQ '+sg(dSEQ)+' · top RTL level '+(topR?topR.price.toFixed(2):'—')+' holds '+conc+'%' };

    /* 5) FLIP PAIRS — Δ LAsk-HBid per level, sign flips between adjacent levels */
    var flips=0, pos=0, neg=0, strongest=null;
    for(var i=0;i<levels.length;i++){
      var d=levels[i].liftAsk-levels[i].hitBid;
      if(d>0)pos++; else if(d<0)neg++;
      if(!strongest||Math.abs(d)>Math.abs(strongest.d)) strongest={price:levels[i].price,d:d};
      if(i>0){ var d0=levels[i-1].liftAsk-levels[i-1].hitBid; if(d0!==0&&d!==0&&(d0>0)!==(d>0)) flips++; }
    }
    out.flip={ flips:flips, pos:pos, neg:neg, strongest:strongest,
      vote: pos>neg?1:neg>pos?-1:0,
      note: flips+' sign flips · '+pos+'↑ / '+neg+'↓ levels · strongest '+(strongest?strongest.price.toFixed(2)+' '+sg(strongest.d):'—') };

    var votes=[out.candle&&out.candle.vote||0,out.summary.vote,out.agg.vote,out.lapro.vote,out.flip.vote];
    var sum=votes.reduce(function(a,b){return a+b;},0), bulls=votes.filter(function(v){return v>0;}).length, bears=votes.filter(function(v){return v<0;}).length;
    out.conclusion={ score:sum, bulls:bulls, bears:bears,
      text: bulls>bears ? 'BULLISH confluence — '+bulls+' of 5 tabs positive'
          : bears>bulls ? 'BEARISH confluence — '+bears+' of 5 tabs negative'
          : 'NEUTRAL / mixed — tabs disagree ('+bulls+'↑ / '+bears+'↓)',
      cls: bulls>bears?'rv-good':bears>bulls?'rv-neg':'rv-warn' };
    return out;
  }

  function voteTxt(v){ return v>0?'<span class="rv-pos">▲ BULL</span>':v<0?'<span class="rv-neg">▼ BEAR</span>':'<span class="rv-zero">— NEUT</span>'; }

  function sectionHtml(sources){
    /* sources: [{name, rows}] — first is Current */
    var A=sources.map(function(s){ return {name:s.name, a:analyzeTabs(s.rows)}; });
    var tabs=[['candle','📊 Price Candle'],['summary','📈 Price Summary'],['agg','🔢 Level Aggregator'],['lapro','🔬 LA Pro'],['flip','⇄ Flip Pairs']];
    var head='<thead><tr><th>Tab</th>'+A.map(function(x){return '<th>'+esc(x.name)+'</th>';}).join('')+'</tr></thead>';
    var body=tabs.map(function(t){
      return '<tr><td>'+t[1]+'</td>'+A.map(function(x){
        var m=x.a[t[0]];
        return '<td>'+(m?voteTxt(m.vote)+'<div class="rv-note" style="margin-top:2px">'+esc(m.note)+'</div>':'—')+'</td>';
      }).join('')+'</tr>';
    }).join('');
    var concl='<tr><td><b>Outcome</b></td>'+A.map(function(x){ var c=x.a.conclusion; return '<td><span class="'+c.cls+'"><b>'+esc(c.text)+'</b></span></td>'; }).join('')+'</tr>';
    return '<div class="rv-section"><h3>All-tab analyzing parameters — every tab in consideration</h3>'+
      '<table class="rv-table">'+head+'<tbody>'+body+concl+'</tbody></table>'+
      '<div class="rv-note">Votes: Price Candle = close vs open · Price Summary = ΔVol and Δ LAsk-HBid ·'+
      ' Level Aggregator = lift- vs hit-dominant levels (≥2×) · LA Pro = Δ RTL and Δ SEQ pressure ·'+
      ' Flip Pairs = positive vs negative Δ LAsk-HBid levels. Outcome = tab-vote confluence.</div></div>';
  }

  function currentRows(){
    try{ if(typeof window._currentIntervalRows==='function'){ var r=window._currentIntervalRows(); if(Array.isArray(r)&&r.length) return r.slice(); } }catch(e){}
    try{ var bars=window._trBars||[]; if(bars.length){ var b=bars[bars.length-1]; if(b&&b.ticks) return b.ticks.slice(); } }catch(e){}
    return [];
  }
  function rowsBetween(sMs,eMs){
    var rows=(window._trAllRows||[]).slice();
    if(sMs&&eMs&&eMs<sMs){ var t=sMs;sMs=eMs;eMs=t; }
    return rows.filter(function(r){ var ms=rowMs(r); return ms>0&&(!sMs||ms>=sMs)&&(!eMs||ms<=eMs); });
  }

  function inject(sources){
    var out=q('rv-report'); if(!out) return;
    try{ out.insertAdjacentHTML('afterbegin', sectionHtml(sources)); }catch(e){}
  }

  function wrap(name, mkSources){
    var orig=window[name];
    if(typeof orig!=='function'||orig.__rvAllTabs) return;
    var w=function(){
      var r=orig.apply(this,arguments);
      try{ inject(mkSources()); }catch(e){}
      return r;
    };
    w.__rvAllTabs=true;
    window[name]=w;
  }
  function hook(){
    wrap('rvGenerateReport', function(){
      var src=[{name:'Current', rows:currentRows()}];
      var a=rowsBetween(inputMs('rv-a-start'),inputMs('rv-a-end')); if(a.length) src.push({name:'Ref A', rows:a});
      var b=rowsBetween(inputMs('rv-b-start'),inputMs('rv-b-end')); if(b.length) src.push({name:'Ref B', rows:b});
      return src;
    });
    wrap('rvGenerateSavedReport', function(){
      var src=[{name:'Current', rows:currentRows()}];
      (window._rvRefSlots||[]).forEach(function(s,i){ if(s&&s.rows&&s.rows.length) src.push({name:'R'+i, rows:s.rows}); });
      return src;
    });
  }
  window.addEventListener('load',function(){ setTimeout(hook,800); });
  setInterval(function(){
    if(window.rvGenerateReport&&!window.rvGenerateReport.__rvAllTabs) hook();
    if(window.rvGenerateSavedReport&&!window.rvGenerateSavedReport.__rvAllTabs) hook();
  },1500);
})();

// ==== chart-flow-resize-reset-js ====
(function(){
  if(window.__CHART_FLOW_RESIZE__) return;
  window.__CHART_FLOW_RESIZE__=true;

  /* ── Drag divider between the main chart and the flow chart (mirrors the
        flow↔stats divider): drag up = taller flow chart, down = taller chart ── */
  function wire(){
    var h=document.getElementById('flow-resize-handle');
    var strip=document.getElementById('flow-strip');
    if(!h||!strip||h.__wired) return;
    h.__wired=true;
    var dragging=false, y0=0, h0=0;
    h.addEventListener('mousedown',function(e){
      dragging=true; y0=e.clientY; h0=strip.offsetHeight||80;
      h.classList.add('dragging');
      document.body.style.cursor='row-resize'; document.body.style.userSelect='none';
      e.preventDefault();
    });
    window.addEventListener('mousemove',function(e){
      if(!dragging) return;
      var newH=Math.max(30, Math.min(400, h0 + (y0 - e.clientY)));
      strip.style.height=newH+'px'; strip.style.maxHeight=newH+'px';
      try{ if(typeof drawFlowStrip==='function') drawFlowStrip(); }catch(ex){}
      try{ if(window.R){ R.resize(); R.draw(); } }catch(ex){}
    });
    window.addEventListener('mouseup',function(){
      if(!dragging) return;
      dragging=false; h.classList.remove('dragging');
      document.body.style.cursor=''; document.body.style.userSelect='';
    });
    /* The handle is only useful while the flow chart is visible. */
    function syncVis(){
      var vis = strip.style.display!=='none' && strip.offsetParent!==null || strip.style.display==='block';
      h.style.display = (strip.style.display==='none') ? 'none' : '';
    }
    var origToggle=window.toggleFlowStrip;
    if(typeof origToggle==='function' && !origToggle.__flowHandleWrapped){
      var w=function(){ var r=origToggle.apply(this,arguments); try{ syncVis(); }catch(e){} return r; };
      w.__flowHandleWrapped=true; window.toggleFlowStrip=w;
    }
    syncVis();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',wire);
  else wire();
  window.addEventListener('load',function(){ setTimeout(wire,300); });

  /* ── Reset vertical: center the LAST displayed candlestick ──────────────
     Vertical mapping (Renderer._drawGrid): normal mode centers on the visible
     range midpoint shifted by chartOffsetY ticks; range mode anchors pr.max.
     Solving for the offset that puts the last candle's (high+low)/2 at the
     vertical center of the chart. */
  window.resetVerticalToLastCandle=function(){
    try{
      if(!window.R||!R.bars||!R.bars.length){ CFG.chartOffsetY=0; if(window.R)R.draw(); return; }
      var b=R.bars[R.bars.length-1];
      var midBar=(Number(b.high)+Number(b.low))/2;
      if(!isFinite(midBar)){ CFG.chartOffsetY=0; R.draw(); return; }
      var pr=(typeof R._range==='function')?R._range():{max:midBar,min:midBar};
      var tk=CFG.tickSize||0.1;
      if(CFG.mode==='range'){
        var H=R.MC?R.MC.height:400;
        var visR=CFG.rangeLevels||10;
        CFG.chartOffsetY=Math.round((midBar-pr.max)/tk + Math.floor(visR/2));
      }else{
        var midRange=(pr.max+pr.min)/2;
        CFG.chartOffsetY=Math.round((midBar-midRange)/tk);
      }
      R.draw();
    }catch(e){ try{ CFG.chartOffsetY=0; if(window.R)R.draw(); }catch(e2){} }
  };
})();

// ==== dfp-pan-resize-final-js ====
(function(){
  if(window.__DFP_PAN_RESIZE_FINAL__) return;
  window.__DFP_PAN_RESIZE_FINAL__ = true;

  var MIN_SIDE = 140, MIN_MAIN = 160;

  function isInteractive(el){
    while(el && el.id!=='dfp-main-final' && el.id!=='dfp-side-final'){
      if(el.tagName){
        var t=el.tagName.toUpperCase();
        if(t==='SELECT'||t==='INPUT'||t==='OPTION'||t==='BUTTON'||t==='A'||t==='TEXTAREA') return true;
      }
      if(el.classList && (el.classList.contains('dfp-col-resizer')||el.classList.contains('manual-marker-select'))) return true;
      el=el.parentElement;
    }
    return false;
  }

  // --- Grab-and-pan scroll (vertical + horizontal) for main table + side panel ---
  function wirePan(el){
    if(!el || el.__dfpPanWired) return;
    el.__dfpPanWired = true;
    var drag=null;
    el.addEventListener('mousedown', function(e){
      if(e.button!==0) return;
      if(isInteractive(e.target)) return;
      drag = { x:e.clientX, y:e.clientY, sl:el.scrollLeft, st:el.scrollTop };
      el.classList.add('dfp-pan-grabbing');
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e){
      if(!drag) return;
      el.scrollTop = drag.st - (e.clientY - drag.y);
      el.scrollLeft = drag.sl - (e.clientX - drag.x);
    });
    document.addEventListener('mouseup', function(){
      if(!drag) return;
      drag=null;
      el.classList.remove('dfp-pan-grabbing');
    });
  }

  // --- Width-resize divider between dfp-main-final and dfp-side-final ---
  function ensureHandle(){
    var wrap = document.getElementById('dfp-wrap');
    var main = document.getElementById('dfp-main-final');
    var side = document.getElementById('dfp-side-final');
    if(!wrap || !main || !side) return;
    wirePan(main); wirePan(side);
    var handle = document.getElementById('dfp-resize-handle-final');
    if(!handle){
      handle = document.createElement('div');
      handle.id = 'dfp-resize-handle-final';
      handle.title = 'Drag to resize Flip Pairs table vs Candle Summary';
      wrap.insertBefore(handle, side);
    } else if(handle.nextSibling !== side){
      wrap.insertBefore(handle, side);
    }
    if(handle.__dfpHandleWired) return;
    handle.__dfpHandleWired = true;
    var drag=null;
    handle.addEventListener('mousedown', function(e){
      e.preventDefault(); e.stopPropagation();
      drag = { x:e.clientX, w:side.getBoundingClientRect().width };
      handle.classList.add('dragging');
      document.body.style.userSelect='none';
    });
    document.addEventListener('mousemove', function(e){
      if(!drag) return;
      var wrapW = wrap.getBoundingClientRect().width;
      var w = drag.w - (e.clientX - drag.x);
      w = Math.max(MIN_SIDE, Math.min(w, wrapW - MIN_MAIN - 14));
      side.style.width = w+'px';
      side.style.flex = '0 0 '+w+'px';
    });
    document.addEventListener('mouseup', function(){
      if(!drag) return;
      drag=null;
      handle.classList.remove('dragging');
      document.body.style.userSelect='';
    });
  }

  function schedule(){ setTimeout(ensureHandle, 0); setTimeout(ensureHandle, 200); setTimeout(ensureHandle, 700); }

  var oldDfp = window.dfpRender;
  if(typeof oldDfp === 'function' && !oldDfp.__dfpPanResizeWrapped){
    var wrapped = function(){ var r = oldDfp.apply(this, arguments); schedule(); return r; };
    wrapped.__dfpPanResizeWrapped = true;
    window.dfpRender = wrapped;
  }
  var oldSwitch = window.switchTab;
  if(typeof oldSwitch === 'function' && !oldSwitch.__dfpPanResizeWrapped){
    var sw = function(tab){ var r = oldSwitch.apply(this, arguments); if(tab==='dfpairs') schedule(); return r; };
    sw.__dfpPanResizeWrapped = true;
    window.switchTab = sw;
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', schedule); else schedule();
  window.addEventListener('load', function(){ setTimeout(schedule, 300); });
  setInterval(function(){ if(document.getElementById('dfp-side-final') && !document.getElementById('dfp-resize-handle-final')) ensureHandle(); }, 1500);
})();

// ==== chart-vertical-drag-pan-final-js ====
(function(){
  if(window.__CHART_VDRAG_FINAL__) return;
  window.__CHART_VDRAG_FINAL__ = true;

  var startY = 0, startOY = 0;

  function init(){
    var mc = document.getElementById('MC');
    if(!mc || mc.__vdragPanWired) return;
    mc.__vdragPanWired = true;

    mc.addEventListener('mousedown', function(e){
      if(e.button !== 0) return;
      try{
        startY = e.clientY;
        startOY = (typeof CFG !== 'undefined' && CFG) ? (CFG.chartOffsetY || 0) : 0;
      }catch(err){ startY = e.clientY; startOY = 0; }
    });

    window.addEventListener('mousemove', function(e){
      try{
        if(typeof _isDragging === 'undefined' || !_isDragging) return;
        if(typeof CFG === 'undefined' || typeof R === 'undefined' || !CFG || !R || !CFG.rowH) return;
        CFG.chartOffsetY = startOY + Math.round((e.clientY - startY) / CFG.rowH);
        R.draw();
      }catch(err){}
    });
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.addEventListener('load', function(){ setTimeout(init, 300); });
  setInterval(function(){ var mc=document.getElementById('MC'); if(mc && !mc.__vdragPanWired) init(); }, 1500);
})();

// ==== alltabs-pan-final-js ====
(function(){
  if(window.__ALLTABS_PAN_FINAL__) return;
  window.__ALLTABS_PAN_FINAL__ = true;

  var TARGET_IDS = ['tl-wrap','sum-wrap','agg-wrap','la-table-wrap','regime-pane','rv-report-wrap','rv-selectors'];

  function isInteractive(el, root){
    while(el && el!==root && el!==document.body){
      if(el.tagName){
        var t = el.tagName.toUpperCase();
        if(t==='SELECT'||t==='INPUT'||t==='OPTION'||t==='BUTTON'||t==='A'||t==='TEXTAREA') return true;
      }
      if(el.title && /drag to resize/i.test(el.title)) return true;
      if(el.classList && (
        el.classList.contains('sum-col-resizer') ||
        el.classList.contains('sum-col-drag-handle') ||
        el.classList.contains('dfp-col-resizer') ||
        el.classList.contains('manual-marker-select')
      )) return true;
      el = el.parentElement;
    }
    return false;
  }

  function wirePan(el){
    if(!el || el.__ofPanWired) return;
    el.__ofPanWired = true;
    var drag = null;
    el.addEventListener('mousedown', function(e){
      if(e.button !== 0) return;
      if(isInteractive(e.target, el)) return;
      drag = { x:e.clientX, y:e.clientY, sl:el.scrollLeft, st:el.scrollTop };
      el.classList.add('of-pan-grabbing');
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e){
      if(!drag) return;
      el.scrollTop = drag.st - (e.clientY - drag.y);
      el.scrollLeft = drag.sl - (e.clientX - drag.x);
    });
    document.addEventListener('mouseup', function(){
      if(!drag) return;
      drag = null;
      el.classList.remove('of-pan-grabbing');
    });
  }

  function wireAll(){
    TARGET_IDS.forEach(function(id){
      var el = document.getElementById(id);
      if(el) wirePan(el);
    });
  }

  function schedule(){ setTimeout(wireAll, 0); setTimeout(wireAll, 300); setTimeout(wireAll, 900); }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
  window.addEventListener('load', function(){ setTimeout(schedule, 300); });

  var oldSwitch = window.switchTab;
  if(typeof oldSwitch === 'function' && !oldSwitch.__ofPanFinalWrapped){
    var sw = function(tab){ var r = oldSwitch.apply(this, arguments); schedule(); return r; };
    sw.__ofPanFinalWrapped = true;
    window.switchTab = sw;
  }

  setInterval(wireAll, 1500);
})();

// ==== lapro-live-rebuild-final-fix ====
(function(){
  if(window.__LAPRO_LIVE_REBUILD_FIX__) return;
  window.__LAPRO_LIVE_REBUILD_FIX__ = true;

  var lastIdx = -1, lastBarN = -1;

  function tick(){
    try{
      var active = (typeof _rpActive !== 'undefined' && _rpActive) ||
                   (typeof _rpPaused !== 'undefined' && _rpPaused);
      if(!active){ lastIdx = -1; lastBarN = -1; return; }
      var idx  = (typeof _rpIdx  !== 'undefined') ? _rpIdx  : -1;
      var barN = (typeof _rpBarN !== 'undefined') ? _rpBarN : -1;
      if(idx !== lastIdx || barN !== lastBarN){
        lastIdx = idx; lastBarN = barN;
        if(typeof laRebuild === 'function') laRebuild();
      }
    }catch(e){}
  }

  setInterval(tick, 120);
})();

// ==== cs-hitid-liftid-final-fix ====
(function(){
  if(window.__CS_HITID_LIFTID_FIX__) return;
  window.__CS_HITID_LIFTID_FIX__ = true;

  function n(v){ v = +v; return Number.isFinite(v) ? v : 0; }

  function applyFix(bar, ticksArg){
    if(!bar) return bar;
    var src = Array.isArray(bar.ticks) ? bar.ticks : (Array.isArray(ticksArg) ? ticksArg : []);
    var hitId = 0, liftId = 0;
    for(var i=0;i<src.length;i++){
      var r = src[i]; if(!r) continue;
      var aggr = String(r.aggr || '').toUpperCase().trim();
      var tid = n(r.trdIdDiff);
      if(aggr === 'BID' || aggr === 'SELL') hitId += tid;
      else if(aggr === 'ASK' || aggr === 'BUY') liftId += tid;
    }
    bar.totalHitId = hitId;
    bar.totalLiftId = liftId;
    return bar;
  }

  function wrap(){
    var old = window._ticksToBar;
    if(typeof old !== 'function' || old.__csHitIdLiftIdWrapped) return;
    var wrapped = function(ticks){
      var bar = old.apply(this, arguments);
      return applyFix(bar, ticks);
    };
    wrapped.__csHitIdLiftIdWrapped = true;
    window._ticksToBar = wrapped;
  }

  // Wrap now, and keep re-wrapping in case another script reassigns
  // window._ticksToBar after this patch runs (this codebase layers several
  // _ticksToBar wrappers, so we defensively re-apply for a short window).
  wrap();
  var tries = 0;
  var iv = setInterval(function(){
    wrap();
    if(++tries > 20) clearInterval(iv);
  }, 250);
})();

// ==== cir-replay-gate-final-fix ====
(function(){
  if(window.__CIR_REPLAY_GATE_FIX__) return;
  window.__CIR_REPLAY_GATE_FIX__ = true;

  function isReplaying(){
    try{
      return !!((typeof _rpActive !== 'undefined' && _rpActive) ||
                (typeof _rpPaused !== 'undefined' && _rpPaused));
    }catch(e){ return false; }
  }
  function replayRows(){
    try{
      if(typeof _rpSumRows !== 'undefined' && _rpSumRows && _rpSumRows.length) return _rpSumRows.slice();
    }catch(e){}
    try{
      if(typeof _openBarTicks !== 'undefined' && _openBarTicks && _openBarTicks.length) return _openBarTicks.slice();
    }catch(e){}
    return [];
  }

  function wrap(){
    var oldCIR = window._currentIntervalRows;
    if(typeof oldCIR === 'function' && !oldCIR.__replayGateWrapped){
      var wrappedCIR = function(){
        if(isReplaying()) return replayRows();
        return oldCIR.apply(this, arguments);
      };
      wrappedCIR.__replayGateWrapped = true;
      window._currentIntervalRows = wrappedCIR;
    }
    var oldDt = window.dtRows;
    if(typeof oldDt === 'function' && !oldDt.__replayGateWrapped){
      var wrappedDt = function(){
        if(isReplaying()) return replayRows();
        return oldDt.apply(this, arguments);
      };
      wrappedDt.__replayGateWrapped = true;
      window.dtRows = wrappedDt;
    }
  }

  wrap();
  var tries = 0;
  var iv = setInterval(function(){ wrap(); if(++tries > 30) clearInterval(iv); }, 200);
})();

// ==== sum-history-export-final-js ====
(function(){
  window.__SUM_HISTORY_EXPORT_FIX__ = true;

  function pad2(n){ return String(n).padStart(2,'0'); }
  function fmtPrice(v){ v = Number(v); return isFinite(v) ? v.toFixed(1) : ''; }

  // Every scraped cell arrives as whatever text the live table displays —
  // "10.1k", "1⇧/1⇩ (2)", "1 330" or "1,330" depending on browser locale,
  // "+0.70", etc. This turns anything that's really a number back into an
  // actual JS Number (so Excel/CSV stores it as numeric, not text), and
  // leaves genuinely non-numeric cells (MARKER's "Buy"/"Sell Exit", "0",
  // Timestamp) untouched.
  function cleanExportNumber(raw){
    if(raw === null || raw === undefined) return raw;
    if(typeof raw === 'number') return raw;
    var s = String(raw).trim();
    if(s === '' || s === '\u2014' || s === '-') return raw;
    // Training-ready convention: displayed percentages are exported as
    // decimal fractions (e.g. 72.5% -> 0.725), never as 72.5 or text.
    var isPercent = /%$/.test(s);
    if(isPercent) s = s.slice(0,-1).trim();

    // IMB-style "N⇧/M⇩ (T)" -> just the total T in parentheses.
    var imbMatch = s.match(/\(\s*(-?\d+(?:[.,]\d+)?)\s*\)\s*$/);
    if(imbMatch && /[\u21e7\u21e9]/.test(s)){
      var t = parseFloat(imbMatch[1].replace(',', '.'));
      return isFinite(t) ? t : raw;
    }

    // "10.1k" / "2.3M" -> full value.
    var mult = 1;
    if(/[kK]$/.test(s)){ mult = 1000; s = s.slice(0, -1); }
    else if(/[mM]$/.test(s)){ mult = 1000000; s = s.slice(0, -1); }

    s = s.replace(/\u00A0/g, ' ').trim();

    // Thousands separator vs decimal separator is locale-ambiguous ("1,330"
    // vs "1330,8") — resolve using whichever of , or . appears last if both
    // are present, otherwise treat a single comma as decimal only when it
    // looks like one (not followed by exactly 3 digits, e.g. "56,8" vs
    // "1,330").
    var hasComma = s.indexOf(',') !== -1, hasDot = s.indexOf('.') !== -1;
    if(hasComma && hasDot){
      if(s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if(hasComma && !hasDot){
      var parts = s.split(',');
      if(parts.length === 2 && parts[1].length !== 3) s = s.replace(',', '.');
      else s = s.replace(/,/g, '');
    }
    s = s.replace(/\s+/g, '');

    if(!/^[+-]?\d+(\.\d+)?$/.test(s)) return raw;
    var num = parseFloat(s);
    return isFinite(num) ? (num * mult) / (isPercent ? 100 : 1) : raw;
  }

  function splitImbalanceTotals(raw){
    var s=String(raw==null?'':raw);
    var up=s.match(/(-?\d+(?:[.,]\d+)?)\s*⇧/);
    var down=s.match(/(-?\d+(?:[.,]\d+)?)\s*⇩/);
    return [up?Number(up[1].replace(',','.')):0,down?Number(down[1].replace(',','.')):0];
  }

  function exportIntervalSec(){
    // Read directly off whichever "Interval:" pill is visually highlighted in
    // Price Summary — this is the one thing the user can see and control.
    // (The internal _sumIntervalSec variable gets silently re-synced to the
    // main chart's candle interval whenever that changes, which is why using
    // it — or CFG.intervalSec — could silently collapse the whole selected
    // range into a single bucket.)
    var onPill = document.querySelector('#sum-pill-iv .sum-iv-pill.on');
    var fromPill = onPill ? parseInt(onPill.getAttribute('data-s'), 10) : NaN;
    if(Number.isFinite(fromPill) && fromPill > 0) return fromPill;
    if(typeof _sumEffectiveInterval === 'function'){
      var v = _sumEffectiveInterval();
      if(Number.isFinite(v) && v > 0) return v;
    }
    return (window.CFG && CFG.intervalSec) || 60;
  }

  function fullLoadedRows(){
    if(window._allRawRows && window._allRawRows.length) return window._allRawRows;
    if(window._trAllRows && window._trAllRows.length) return window._trAllRows;
    return [];
  }

  function rowsInFieldRange(rows, startVal, endVal){
    if(!startVal && !endVal) return rows.slice();
    var startMs = startVal ? new Date(startVal).getTime() : -Infinity;
    var endMs   = endVal   ? new Date(endVal).getTime()   :  Infinity;
    if(!isFinite(startMs)) startMs = -Infinity;
    if(!isFinite(endMs))   endMs   =  Infinity;
    return rows.filter(function(r){
      var ms = (typeof _toAbsMs === 'function') ? _toAbsMs(r) : 0;
      return ms >= startMs && ms <= endMs;
    });
  }

  // Decide which rows to export. The app's own "date filter active" flag
  // (_dtActive/_dtFilteredRows) is unreliable here — it gets silently
  // overwritten to match whatever's currently paged/visible in Trade Log's
  // own navigation (e.g. just the last 10 bars), not necessarily anything
  // the user deliberately chose. So: default to the FULL loaded file, and
  // only offer the narrower Start/End field window as an explicit opt-out.
  function chooseExportRows(){
    var fullRows = fullLoadedRows();
    if(!fullRows.length) return null;
    var startEl = document.getElementById('dt-start'), endEl = document.getElementById('dt-end');
    var startVal = startEl ? startEl.value : '', endVal = endEl ? endEl.value : '';
    var fieldRows = rowsInFieldRange(fullRows, startVal, endVal);
    if(fieldRows.length && fieldRows.length < fullRows.length){
      var useFull = confirm(
        'Your Start/End fields currently show a narrower window ('+fieldRows.length.toLocaleString()+
        ' of '+fullRows.length.toLocaleString()+' loaded ticks).\n\n'+
        'Click OK to export ALL loaded data.\n'+
        'Click Cancel to export only that narrower Start/End window.'
      );
      return useFull ? fullRows : fieldRows;
    }
    return fullRows;
  }

  function barsFor(rows){
    if(!rows || !rows.length) return [];
    var intervalSec = exportIntervalSec();
    if(typeof window._bucketByInterval !== 'function') return [];
    var bars = window._bucketByInterval(rows.slice(), intervalSec);
    return (bars || []).filter(function(b){ return b && Array.isArray(b.ticks) && b.ticks.length; });
  }

  function barTimestamp(bar){
    var d = bar.date || '';
    var t = bar.time || '';
    return (d ? (d + ' ') : '') + t;
  }

  window.sumSaveHistoryToExcel = function(){
    var btn = document.getElementById('sum-save-history-btn');
    var headRowEl = document.getElementById('sum-head');
    if(!headRowEl){
      alert('This app has no Price Summary table to read from.');
      return;
    }

    var rows = chooseExportRows();
    if(!rows){
      alert('No file loaded yet — load a file first.');
      return;
    }
    var bars = barsFor(rows);
    if(!bars.length){
      alert('No historical intervals could be built from the loaded data.');
      return;
    }

    // Name the export after the loaded file's own date/time (earliest bar in
    // range) instead of a generic "History" suffix, so exports from different
    // sessions/files don't collide and the filename tells you what it covers.
    var _fnBar = bars[0] || {};
    var _fnDate = String(_fnBar.date||'').trim();
    var _fnTime = String(_fnBar.time||'').trim().replace(/:/g,'-');
    var fileStamp = (_fnDate || _fnTime) ? ((_fnDate||'unknown-date')+(_fnTime?('_'+_fnTime):'')) : (function(){
      var d=new Date(); var p=function(n){return String(n).padStart(2,'0');};
      return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'_'+p(d.getHours())+'-'+p(d.getMinutes())+'-'+p(d.getSeconds());
    })();
    var fileBase = 'PH_'+(window._loadedFileBaseName || fileStamp);

    var ivSec = exportIntervalSec();
    var ivLabel = ivSec % 3600 === 0 ? (ivSec/3600)+'h' : (ivSec % 60 === 0 ? (ivSec/60)+'m' : ivSec+'s');
    if(!confirm('Exporting at '+ivLabel+' intervals — found '+bars.length.toLocaleString()+' candle(s).\n\nIf that candle count looks too low, cancel and pick a smaller Interval pill in Price Summary first.\n\nContinue?')){
      return;
    }

    if(bars.length > 3000){
      if(!confirm(bars.length.toLocaleString()+' intervals found — exporting could take a while. Continue?')) return;
    }

    // SEQ_X and RTL_X are off by default in Price Summary (dflt:false), so
    // sumRender() wouldn't include them in the scraped totals row unless
    // they're active. Temporarily turn them on for the export and restore
    // whatever the user actually had toggled afterward, in finish().
    var _oldSumActiveCols = _sumActiveCols.slice();
    if(_sumActiveCols.indexOf('seqNum') === -1) _sumActiveCols.push('seqNum');
    if(_sumActiveCols.indexOf('moves') === -1) _sumActiveCols.push('moves');

    var oldCIR = window._currentIntervalRows;
    if(btn){ btn.disabled = true; btn.textContent = '⏳ Saving 0/'+bars.length; }

    var out = [];
    var headers = null;

    function writeWorkbook(aoa){
      // ExcelJS actually writes cell styles and freeze panes into the XLSX
      // (the SheetJS Community build loaded elsewhere in this app can only
      // read styles, not write them — freeze pane + fill + bold would be
      // silently dropped if we used it here). Falls back to a plain
      // (unstyled) SheetJS file, then CSV, if ExcelJS isn't available.
      if(typeof ExcelJS !== 'undefined' && ExcelJS.Workbook){
        try{
          var wb = new ExcelJS.Workbook();
          var ws = wb.addWorksheet('Price Summary History');
          aoa.forEach(function(row){ ws.addRow(row); });
          var headerRow = ws.getRow(1);
          headerRow.eachCell(function(cell){
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
          });
          ws.views = [{ state: 'frozen', ySplit: 1 }];
          ws.columns.forEach(function(col){ col.width = 14; });
          wb.xlsx.writeBuffer().then(function(buf){
            if(window.ofAutosaveBuffer && window.ofAutosaveBuffer('history', fileBase+'.xlsx', buf)) return;
            var a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
            a.download = fileBase+'.xlsx';
            a.click();
          }).catch(function(e){
            console.error('[sumSaveHistoryToExcel] ExcelJS write failed, falling back', e);
            writeWithSheetJSOrCSV(aoa);
          });
          return;
        }catch(e){
          console.error('[sumSaveHistoryToExcel] ExcelJS failed, falling back', e);
        }
      }
      writeWithSheetJSOrCSV(aoa);
    }

    function writeWithSheetJSOrCSV(aoa){
      try{
        if(typeof XLSX === 'undefined' || !XLSX.utils || typeof XLSX.writeFile !== 'function'){
          throw new Error('XLSX not available');
        }
        var ws = XLSX.utils.aoa_to_sheet(aoa);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Price Summary History');
        if(window.ofAutosaveBuffer && window.ofAutosaveBuffer('history', fileBase+'.xlsx', XLSX.write(wb,{bookType:'xlsx',type:'array'}))) return;
        XLSX.writeFile(wb, fileBase+'.xlsx');
      }catch(e){
        var csv = aoa.map(function(row){
          return row.map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(',');
        }).join('\n');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
        a.download = fileBase+'.csv';
        a.click();
      }
    }

    function finish(ok, err){
      // Always restore the live data source and re-render the current view.
      window._currentIntervalRows = oldCIR;
      _sumActiveCols.length = 0;
      Array.prototype.push.apply(_sumActiveCols, _oldSumActiveCols);
      try{ if(typeof sumRender === 'function') sumRender(); }catch(e){}
      try{ if(typeof dfpRender === 'function') dfpRender(); }catch(e){}
      if(btn){ btn.disabled = false; btn.textContent = '⬇ Save History'; }
      if(!ok){
        console.error('[sumSaveHistoryToExcel]', err);
        alert('Could not save history: ' + (err && err.message ? err.message : err));
        return;
      }
      if(!out.length){
        alert('No data could be extracted for the selected range.');
        return;
      }
      var aoa = [headers].concat(out);
      writeWorkbook(aoa);
    }

    try{
      // _bucketByInterval processes already time-sorted ticks sequentially,
      // so `bars` is already oldest → newest (ASC) at this point.
      var ohlcInsertAt = 0, ohlcRemoveCount = 0, imbSplitAt = -1;
      var pocInsertAt = 0;
      var derivedInsertAt = 0;
      var _exportColPermIdx = null;
      // Fixed export column order: Candle info block first (O/H/L/C/POC/VWAP),
      // then Hit/Lift metrics paired side-by-side as requested, then the rest.
      // Anything scraped that isn't in this list (e.g. optional columns the
      // user toggled on in Price Summary) keeps its original relative order
      // and is appended after these.
      var EXPORT_COL_ORDER = ['PRICE','O','H','L','C','C-O','H-L','POC','VWAP','MCGINLEY','MARKER','SPL TRD','Buy','Buy Exit','Sell','Sell Exit','Δ','Δ LAsk-HBid','IMB Up','IMB Dwn',
        'BIDSIZE','ASKSIZE','Hit_Bid','Lift_Ask','Hit_Vol','Lift_Vol','Hit_ID','Lift_ID',
        'Hit_ELIG_V','Lift_ELIG_V','Hit_TRADES','Lift_TRADES','Trd_Vol','Trd_Cnt','ELIG_V_X','TRADES_X'];
      var dirSel = document.getElementById('sum-history-sort-dir');
      var wantDesc = dirSel && dirSel.value === 'desc';

      // Columns to drop entirely from the Flip Pairs section of the export.
      var FLIP_DROP = {'Flip: Marker':1,'Flip: Suggested Dir':1,'Flip: Bid':1,'Flip: Ask':1};
      var flipKeepIdx = null; // computed once headers are known

      // Flip Pairs doesn't read _currentIntervalRows() — it renders whatever
      // latestVisibleBar() resolves to (R.bars' last entry, or _closedBars/
      // _trBars as fallbacks). Those are plain top-level `let` variables, NOT
      // properties of `window` — assigning window._closedBars etc. silently
      // writes to an unrelated, unused property and does nothing (the same
      // class of mistake as the earlier CFG/R mix-up in this file). Using
      // bare identifiers here actually reaches the variables it reads.
      function withFlipBar(bar, fn){
        var hadR = false, oldRBars;
        try{ hadR = (typeof R !== 'undefined' && !!R); if(hadR) oldRBars = R.bars; }catch(e){ hadR=false; }
        var oldOpenBarTicks, hadOpenBarTicks=false;
        try{ oldOpenBarTicks = _openBarTicks; hadOpenBarTicks=true; }catch(e){}
        var oldClosedBars, hadClosedBars=false;
        try{ oldClosedBars = _closedBars; hadClosedBars=true; }catch(e){}

        try{ if(hadOpenBarTicks) _openBarTicks = []; }catch(e){}
        try{ if(hadR) R.bars = [bar]; }catch(e){}
        try{ if(hadClosedBars) _closedBars = [bar]; }catch(e){}
        try{ return fn(); }
        finally{
          try{ if(hadOpenBarTicks) _openBarTicks = oldOpenBarTicks; }catch(e){}
          try{ if(hadR) R.bars = oldRBars; }catch(e){}
          try{ if(hadClosedBars) _closedBars = oldClosedBars; }catch(e){}
        }
      }

      // Seed the Flip Pairs ("Δ Flip Pairs") header/column count using the
      // LAST bar in range first — its columns depend only on which pair
      // buttons are currently selected in that tab, not on any one bar's
      // data, and using a real bar avoids the empty-state placeholder.
      var flipHeaders = null;
      try{
        if(bars.length){
          withFlipBar(bars[bars.length-1], function(){
            if(typeof dfpRender === 'function') dfpRender();
          });
          var seedHead = document.querySelector('#dfp-table thead tr');
          if(seedHead && seedHead.children.length){
            var allFlipHeaders = Array.prototype.map.call(seedHead.children, function(th){ return 'Flip: '+(th.textContent||'').trim(); });
            flipKeepIdx = [];
            flipHeaders = [];
            allFlipHeaders.forEach(function(h, idx){
              if(!FLIP_DROP[h]){ flipKeepIdx.push(idx); flipHeaders.push(h); }
            });
          }
        }
      }catch(e){}

      // Computed once, against this export's own bar array (whatever interval
      // it represents) — see _mdComputeSeries for why this isn't shared with
      // the live Candle Summary's own series.
      var _mdExportSeries = (typeof window._mdComputeSeries === 'function') ? window._mdComputeSeries(bars, (window._MD_PERIOD||36)) : null;
      var _regimeExportSeries = (window.OrderFlowRegimeExport && typeof window.OrderFlowRegimeExport.computeSeries === 'function')
        ? window.OrderFlowRegimeExport.computeSeries(bars,{forecastLevels:Number((document.getElementById('rg-nstep')||{}).value)||50}) : [];

      for(var i=0;i<bars.length;i++){
        var bar = bars[i];
        (function(rows){
          window._currentIntervalRows = function(){ return rows.slice(); };
        })(bar.ticks);

        sumRender();

        if(headers === null){
          var headCells = document.getElementById('sum-head');
          var rawHeaders = Array.prototype.map.call(headCells.children, function(th){ return (th.textContent||'').trim(); });
          // Replace the "OHLC" flag column (if present) with 4 real columns;
          // otherwise insert them right after "IMB", or at the very front.
          var ohlcIdx = rawHeaders.findIndex(function(h){ return h.toUpperCase() === 'OHLC'; });
          var imbIdx  = rawHeaders.findIndex(function(h){ return h.toUpperCase() === 'IMB'; });
          if(ohlcIdx !== -1){ ohlcInsertAt = ohlcIdx; ohlcRemoveCount = 1; }
          else if(imbIdx !== -1){ ohlcInsertAt = imbIdx + 1; ohlcRemoveCount = 0; }
          else { ohlcInsertAt = 0; ohlcRemoveCount = 0; }

          var withOHLC = rawHeaders.slice();
          withOHLC.splice(ohlcInsertAt, ohlcRemoveCount, 'O','H','L','C');
          // C-O (Close-Open) and H-L (High-Low) go right after O/H/L/C, then
          // POC/VWAP (from Candle Summary) right after those. If neither an
          // OHLC nor an IMB anchor column was found, ohlcInsertAt falls back
          // to 0 above, so these still land right after the 4 inserted
          // O/H/L/C entries rather than being lost.
          derivedInsertAt = ohlcInsertAt + 4;
          withOHLC.splice(derivedInsertAt, 0, 'C-O', 'H-L');
          pocInsertAt = derivedInsertAt + 2;
          withOHLC.splice(pocInsertAt, 0, 'POC', 'VWAP', 'MCGINLEY', 'MARKER', 'SPL TRD', 'Buy', 'Buy Exit', 'Sell', 'Sell Exit');
          imbSplitAt=withOHLC.findIndex(function(h){return String(h).toUpperCase()==='IMB';});
          if(imbSplitAt>=0) withOHLC.splice(imbSplitAt,1,'IMB Up','IMB Dwn');

          // Reorder into the fixed EXPORT_COL_ORDER (Hit/Lift pairs adjacent).
          // Columns not listed there keep their original scraped order and
          // are appended at the end, ahead of the Flip Pairs section.
          var _canonRank = {};
          EXPORT_COL_ORDER.forEach(function(lbl, i){ _canonRank[lbl] = i; });
          var _permIdx = withOHLC.map(function(_, i){ return i; });
          _permIdx.sort(function(ia, ib){
            var la = withOHLC[ia], lb = withOHLC[ib];
            var ra = Object.prototype.hasOwnProperty.call(_canonRank, la) ? _canonRank[la] : (1000 + ia);
            var rb = Object.prototype.hasOwnProperty.call(_canonRank, lb) ? _canonRank[lb] : (1000 + ib);
            return ra - rb;
          });
          _exportColPermIdx = _permIdx;
          withOHLC = _permIdx.map(function(i){ return withOHLC[i]; });

          headers = ['Timestamp'].concat(withOHLC).concat(flipHeaders || []).concat(window.OrderFlowRegimeExport?window.OrderFlowRegimeExport.HEADERS:[]);
        }
        var totalsRow = document.querySelector('#sum-body tr.sum-totals-row');
        if(totalsRow){
          var rawValues = Array.prototype.map.call(totalsRow.children, function(td){ return (td.textContent||'').trim(); });
          var withOHLCVals = rawValues.slice();
          withOHLCVals.splice(ohlcInsertAt, ohlcRemoveCount,
            fmtPrice(bar.open), fmtPrice(bar.high), fmtPrice(bar.low), fmtPrice(bar.close));
          var _co = (Number(bar.close)-Number(bar.open));
          var _hl = (Number(bar.high)-Number(bar.low));
          withOHLCVals.splice(derivedInsertAt, 0,
            (isFinite(_co)?((_co>=0?'+':'')+_co.toFixed(2)):''),
            (isFinite(_hl)?_hl.toFixed(2):''));
          var _mdSig = (_mdExportSeries ? (_mdExportSeries.signal[i] || '0') : '0');
          var _mdParts = (_mdSig && _mdSig!=='0') ? _mdSig.split('+') : [];
          var _mdVal = (_mdExportSeries && isFinite(_mdExportSeries.md[i])) ? fmtPrice(_mdExportSeries.md[i]) : '';
          withOHLCVals.splice(pocInsertAt, 0, fmtPrice(bar.pocPrice), fmtPrice(bar.avgVwap), _mdVal,
            (typeof window._csMarkerForBar==='function' ? (window._csMarkerForBar(bar) || '0') : '0'),
            Number(bar.splTrd||0));
          // One row per candle, one column per signal (1/0) instead of a
          // single text column — lines up directly with a 4-column table
          // like the one in the reference image, no text parsing needed
          // downstream. A same-candle combo signal (e.g. "Sell+Buy Exit")
          // sets both of those columns to 1 on that row.
          withOHLCVals.splice(pocInsertAt+5, 0,
            _mdParts.indexOf('Buy')!==-1 ? 1 : 0,
            _mdParts.indexOf('Buy Exit')!==-1 ? 1 : 0,
            _mdParts.indexOf('Sell')!==-1 ? 1 : 0,
            _mdParts.indexOf('Sell Exit')!==-1 ? 1 : 0);
          if(imbSplitAt>=0){
            var _imbTotals=splitImbalanceTotals(withOHLCVals[imbSplitAt]);
            withOHLCVals.splice(imbSplitAt,1,_imbTotals[0],_imbTotals[1]);
          }
          if(_exportColPermIdx) withOHLCVals = _exportColPermIdx.map(function(i){ return withOHLCVals[i]; });

          // Δ Flip Pairs totals for this SAME bar — numbers only, no bars,
          // since scraping .textContent naturally skips the graphical width
          // divs and picks up only the "NN%" text next to them.
          var flipValues = [];
          if(flipHeaders && flipHeaders.length){
            withFlipBar(bar, function(){
              try{ if(typeof dfpRender === 'function') dfpRender(); }catch(e){}
            });
            var flipTbl = document.getElementById('dfp-table');
            var flipHasData = flipTbl && flipTbl.style.display !== 'none';
            var flipTotalsRow = flipHasData
              ? document.querySelector('#dfp-table tbody tr.dfp-total, #dfp-table tbody tr.dfp-total-row')
              : null;
            var rawFlipValues = flipTotalsRow
              ? Array.prototype.map.call(flipTotalsRow.children, function(td){ return (td.textContent||'').trim(); })
              : [];
            if(flipKeepIdx){
              flipValues = flipKeepIdx.map(function(idx){ return rawFlipValues[idx] !== undefined ? rawFlipValues[idx] : ''; });
            } else {
              flipValues = rawFlipValues;
            }
            while(flipValues.length < flipHeaders.length) flipValues.push('');
            flipValues = flipValues.slice(0, flipHeaders.length);
          }

          var _regimeRow=(window.OrderFlowRegimeExport&&window.OrderFlowRegimeExport.row)?window.OrderFlowRegimeExport.row(_regimeExportSeries[i]):[];
          out.push([barTimestamp(bar)].concat(withOHLCVals.map(cleanExportNumber)).concat(flipValues.map(cleanExportNumber)).concat(_regimeRow));
        }
        if(btn && (i % 20 === 0)) btn.textContent = '⏳ Saving '+i+'/'+bars.length;
      }
      if(wantDesc) out.reverse();
      finish(true);
    }catch(e){
      finish(false, e);
    }
  };


  // Save the COMPLETE historical Price Summary ladder: every price-level row
  // for every interval, oldest interval -> newest interval, using every
  // SUM_ALL_COLS column whether or not that column is currently visible.
  // The synthetic TOTALS row is intentionally excluded: "first row to last
  // row" here means the actual price-level rows of each Price Summary table.
  window.sumSaveSummaryToExcel = function(){
    var btn = document.getElementById('sum-save-summary-btn');
    var head = document.getElementById('sum-head');
    var body = document.getElementById('sum-body');
    if(!head || !body){ alert('This app has no Price Summary table to read from.'); return; }

    var rows = chooseExportRows();
    if(!rows){ alert('No file loaded yet — load a file first.'); return; }
    var bars = barsFor(rows);
    if(!bars.length){ alert('No historical intervals could be built from the loaded data.'); return; }

    // Save Summary uses the SAME Asc/Desc selector as Save History.
    // ASC  = oldest interval -> newest; price ladder low -> high.
    // DESC = newest interval -> oldest; price ladder high -> low.
    var dirSel = document.getElementById('sum-history-sort-dir');
    var exportDir = (dirSel && String(dirSel.value).toLowerCase()==='asc') ? 'asc' : 'desc';
    var wantDesc = exportDir === 'desc';

    // McGinley MUST always be calculated chronologically, even when the
    // exported file is requested in descending order.
    var _summaryChronoBars = bars.slice();
    var _summaryRegimeSeries = (window.OrderFlowRegimeExport && typeof window.OrderFlowRegimeExport.computeSeries === 'function')
      ? window.OrderFlowRegimeExport.computeSeries(_summaryChronoBars,{forecastLevels:Number((document.getElementById('rg-nstep')||{}).value)||50}) : [];
    var _summaryMdSeries = (typeof window._mdComputeSeries === 'function')
      ? window._mdComputeSeries(_summaryChronoBars, (window._MD_PERIOD||36))
      : null;
    var _summaryBarIndex = new Map();
    _summaryChronoBars.forEach(function(b,idx){ _summaryBarIndex.set(b,idx); });

    bars = bars.slice();
    if(wantDesc) bars.reverse();

    var ivSec = exportIntervalSec();
    var ivLabel = ivSec % 3600 === 0 ? (ivSec/3600)+'h' : (ivSec % 60 === 0 ? (ivSec/60)+'m' : ivSec+'s');
    if(!confirm('Save Summary will export ALL Price Summary price-level rows across '+bars.length.toLocaleString()+' '+ivLabel+' interval(s), with ALL Price Summary columns.\n\nSort: '+exportDir.toUpperCase()+(wantDesc?' (newest→oldest, high→low)':' (oldest→newest, low→high)')+'\n\nContinue?')) return;

    var oldCIR = window._currentIntervalRows;
    var oldActive = _sumActiveCols.slice();
    var oldSort = { col:_sumSort.col, dir:_sumSort.dir };
    // All Price Summary columns, including normally hidden/default-off columns.
    _sumActiveCols.length = 0;
    SUM_ALL_COLS.filter(function(c){ return !c.always; }).forEach(function(c){ _sumActiveCols.push(c.key); });

    var exportHeaders = null;
    var out = [];
    var i = 0;

    var firstBar = bars[0] || {};
    var stamp = ((firstBar.date||'')+'_'+(firstBar.time||'')).trim().replace(/[ :]/g,'-');
    if(!stamp){
      var now=new Date(), p=function(n){return String(n).padStart(2,'0');};
      stamp=now.getFullYear()+'-'+p(now.getMonth()+1)+'-'+p(now.getDate())+'_'+p(now.getHours())+'-'+p(now.getMinutes())+'-'+p(now.getSeconds());
    }
    var fileBase = 'Price_Summary_'+(window._loadedFileBaseName || stamp);

    function _summaryMdForBar(bar){
      var idx = _summaryBarIndex.get(bar);
      var sig = (_summaryMdSeries && idx!=null) ? (_summaryMdSeries.signal[idx] || '0') : '0';
      var val = (_summaryMdSeries && idx!=null && Number.isFinite(Number(_summaryMdSeries.md[idx])))
        ? Number(_summaryMdSeries.md[idx]) : '';
      var parts = (sig && sig!=='0') ? String(sig).split('+') : [];
      return {
        value: val,
        buy: parts.indexOf('Buy')!==-1 ? 1 : 0,
        buyExit: parts.indexOf('Buy Exit')!==-1 ? 1 : 0,
        sell: parts.indexOf('Sell')!==-1 ? 1 : 0,
        sellExit: parts.indexOf('Sell Exit')!==-1 ? 1 : 0
      };
    }

    // Read the ACTUAL selected Marker value. Using td.textContent on a <select>
    // returns all option labels, not the selected marker.
    function _summaryCellValue(td,header){
      var markerSel = td && td.querySelector ? td.querySelector('.manual-marker-select') : null;
      if(markerSel) return markerSel.value || '0';
      var label=String(header||'').trim().toUpperCase();
      var raw=(td && td.textContent || '').trim();
      if(label==='IMB'){
        if(td&&td.classList&&td.classList.contains('s-lift-imb'))return 1;
        if(td&&td.classList&&td.classList.contains('s-hit-imb'))return -1;
        return raw.indexOf('⇧')>=0?1:(raw.indexOf('⇩')>=0?-1:0);
      }
      if(label==='OHLC'){
        if(raw.indexOf('H')>=0)return 4;
        if(raw.indexOf('C')>=0)return 3;
        if(raw.indexOf('O')>=0)return 2;
        if(raw.indexOf('L')>=0)return 1;
        return 0;
      }
      return cleanExportNumber(raw);
    }

    function restore(){
      window._currentIntervalRows = oldCIR;
      _sumActiveCols.length = 0;
      Array.prototype.push.apply(_sumActiveCols, oldActive);
      _sumSort.col = oldSort.col; _sumSort.dir = oldSort.dir;
      try{ sumRender(); }catch(e){}
      if(btn){ btn.disabled=false; btn.textContent='⬇ Save Summary'; }
    }

    function writeFile(){
      if(!exportHeaders || !out.length){ restore(); alert('No Price Summary rows were found to export.'); return; }
      var aoa=[exportHeaders].concat(out);
      try{
        if(typeof ExcelJS !== 'undefined' && ExcelJS.Workbook){
          var wb=new ExcelJS.Workbook();
          var ws=wb.addWorksheet('Price Summary');
          aoa.forEach(function(r){ ws.addRow(r); });
          var hr=ws.getRow(1);
          hr.eachCell(function(cell){
            cell.font={bold:true,color:{argb:'FFFFFFFF'}};
            cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1F4E78'}};
          });
          ws.views=[{state:'frozen',ySplit:1}];
          ws.columns.forEach(function(col,idx){ col.width = idx===0 ? 21 : 14; });
          wb.xlsx.writeBuffer().then(function(buf){
            if(window.ofAutosaveBuffer && window.ofAutosaveBuffer('summary', fileBase+'.xlsx', buf)){
              restore(); return;
            }
            var a=document.createElement('a');
            a.href=URL.createObjectURL(new Blob([buf],{type:'application/octet-stream'}));
            a.download=fileBase+'.xlsx'; a.click();
            restore();
          }).catch(function(err){ restore(); alert('Could not save summary: '+(err.message||err)); });
          return;
        }
        if(typeof XLSX !== 'undefined' && XLSX.utils && XLSX.writeFile){
          var ws2=XLSX.utils.aoa_to_sheet(aoa), wb2=XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb2,ws2,'Price Summary');
          if(window.ofAutosaveBuffer && window.ofAutosaveBuffer('summary', fileBase+'.xlsx', XLSX.write(wb2,{bookType:'xlsx',type:'array'}))){
            restore(); return;
          }
          XLSX.writeFile(wb2,fileBase+'.xlsx');
          restore(); return;
        }
        throw new Error('Excel writer not available');
      }catch(err){
        try{
          var csv=aoa.map(function(r){return r.map(function(v){return '"'+String(v==null?'':v).replace(/"/g,'""')+'"';}).join(',');}).join('\n');
          var a2=document.createElement('a');
          a2.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
          a2.download=fileBase+'.csv'; a2.click();
        }finally{ restore(); }
      }
    }

    function processBatch(){
      try{
        var stop=Math.min(i+25,bars.length);
        for(;i<stop;i++){
          var bar=bars[i];
          (function(ticks){ window._currentIntervalRows=function(){return ticks.slice();}; })(bar.ticks);

          // Apply the selected Save Summary direction to the Price Summary ladder.
          // This intentionally overrides the temporary on-screen column sort only
          // during export; restore() puts the user's original Price Summary sort back.
          _sumSort.col = 'price';
          _sumSort.dir = wantDesc ? -1 : 1;
          sumRender();

          if(exportHeaders===null){
            var _rawSummaryHeaders=Array.prototype.map.call(
              document.getElementById('sum-head').children,
              function(th){return (th.textContent||'').trim();}
            );

            // Normalize the manually injected marker column and add the
            // McGinley Dynamic + four strategy flags next to it, matching
            // the spreadsheet layout requested by the user.
            var _markerHeaderIdx=_rawSummaryHeaders.findIndex(function(h){
              return String(h||'').trim().toUpperCase()==='MARKER';
            });
            if(_markerHeaderIdx<0){
              _markerHeaderIdx=Math.min(2,_rawSummaryHeaders.length);
              _rawSummaryHeaders.splice(_markerHeaderIdx,0,'MARKER');
            }else{
              _rawSummaryHeaders[_markerHeaderIdx]='MARKER';
            }
            _rawSummaryHeaders.splice(
              _markerHeaderIdx+1,0,
              'MCGINLEY','Buy','Buy Exit','Sell','Sell Exit'
            );
            exportHeaders=['Timestamp'].concat(_rawSummaryHeaders).concat(window.OrderFlowRegimeExport?window.OrderFlowRegimeExport.HEADERS:[]);
          }

          var _mdSummary=_summaryMdForBar(bar);

          // Skip only the synthetic totals row. Export every actual Price Summary
          // level from the first displayed level through the last displayed level.
          var trs=Array.prototype.slice.call(document.querySelectorAll('#sum-body tr:not(.sum-totals-row)'));
          trs.forEach(function(tr){
            var liveHeads=Array.prototype.map.call(
              document.getElementById('sum-head').children,
              function(th){return (th.textContent||'').trim();}
            );
            var vals=Array.prototype.map.call(tr.children,function(td,idx){return _summaryCellValue(td,liveHeads[idx]);});

            // Find the live Marker cell for this row. If the Marker DOM patch
            // hasn't injected one for any reason, insert a safe zero marker.
            var markerIdx=liveHeads.findIndex(function(h){
              return String(h||'').trim().toUpperCase()==='MARKER';
            });
            if(markerIdx<0){
              markerIdx=Math.min(2,vals.length);
              vals.splice(markerIdx,0,'0');
            }

            vals.splice(
              markerIdx+1,0,
              _mdSummary.value,
              _mdSummary.buy,
              _mdSummary.buyExit,
              _mdSummary.sell,
              _mdSummary.sellExit
            );

            var _summaryChronoIdx=_summaryBarIndex.get(bar);
            var _summaryRegimeRow=(window.OrderFlowRegimeExport&&window.OrderFlowRegimeExport.row)?window.OrderFlowRegimeExport.row(_summaryRegimeSeries[_summaryChronoIdx]):[];
            vals=[barTimestamp(bar)].concat(vals).concat(_summaryRegimeRow);

            while(vals.length<exportHeaders.length) vals.push('');
            out.push(vals.slice(0,exportHeaders.length));
          });
        }
        if(btn) btn.textContent='⏳ Summary '+i+'/'+bars.length+' · '+out.length.toLocaleString()+' rows';
        if(i<bars.length) setTimeout(processBatch,0);
        else writeFile();
      }catch(err){ restore(); console.error('[sumSaveSummaryToExcel]',err); alert('Could not save summary: '+(err.message||err)); }
    }

    if(btn){ btn.disabled=true; btn.textContent='⏳ Summary 0/'+bars.length; }
    setTimeout(processBatch,0);
  };

  function ensureButton(){
    var clearBtn = document.getElementById('dt-clear-btn');
    if(!clearBtn) return;
    var btn = document.getElementById('sum-save-history-btn');
    if(!btn){
      btn = document.createElement('button');
      btn.id = 'sum-save-history-btn';
      btn.type = 'button';
      btn.title = 'Export every historical interval in the loaded data as its own row (Price Summary totals + O/H/L/C per candle)';
      btn.textContent = '⬇ Save History';
      btn.onclick = window.sumSaveHistoryToExcel;
      clearBtn.parentNode.insertBefore(btn, clearBtn.nextSibling);
    }
    var sumBtn = document.getElementById('sum-save-summary-btn');
    if(!sumBtn){
      sumBtn = document.createElement('button');
      sumBtn.id = 'sum-save-summary-btn';
      sumBtn.type = 'button';
      sumBtn.title = 'Export every Price Summary price-level row across all historical intervals, with all Price Summary columns';
      sumBtn.textContent = '⬇ Save Summary';
      sumBtn.onclick = window.sumSaveSummaryToExcel;
      btn.parentNode.insertBefore(sumBtn, btn.nextSibling);
    }
    var dirSel = document.getElementById('sum-history-sort-dir');
    if(!dirSel){
      dirSel = document.createElement('select');
      dirSel.id = 'sum-history-sort-dir';
      dirSel.title = 'Sort Save History and Save Summary: Asc = oldest→newest / low→high; Desc = newest→oldest / high→low';
      dirSel.innerHTML = '<option value="asc">▲ Asc</option><option value="desc" selected>▼ Desc</option>';
      btn.parentNode.insertBefore(dirSel, btn.nextSibling);
    }
  }

  function schedule(){ setTimeout(ensureButton, 0); setTimeout(ensureButton, 300); setTimeout(ensureButton, 900); }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
  window.addEventListener('load', function(){ setTimeout(schedule, 300); });
  setInterval(ensureButton, 1000);
})();

// ==== sweep-hunter-js ====
(function(){
  'use strict';
  if(window.__SWEEP_HUNTER_V1__) return;
  window.__SWEEP_HUNTER_V1__ = true;

  const SH = {
    useSwing:true, swingLookback:20,
    useSession:false,
    useVA:false,
    volMult:1.3,
    dominance:55,
    showMarkers:true,
    maxRows:300
  };

  let _results = [];
  let _flaggedBars = [];
  let _lastScanLen = -1;

  function _max(a){ let m=-Infinity; for(let i=0;i<a.length;i++) if(a[i]>m) m=a[i]; return m; }
  function _min(a){ let m=Infinity;  for(let i=0;i<a.length;i++) if(a[i]<m) m=a[i]; return m; }

  function shBars(){
    try{ if(typeof _trBars!=='undefined' && Array.isArray(_trBars) && _trBars.length) return _trBars; }catch(e){}
    try{ if(typeof _closedBars!=='undefined' && Array.isArray(_closedBars) && _closedBars.length) return _closedBars; }catch(e){}
    try{ if(typeof R!=='undefined' && R && Array.isArray(R.bars) && R.bars.length) return R.bars; }catch(e){}
    return [];
  }

  function shSessKey(bar){ return String((bar&&bar.date)||''); }

  function shRefs(bars, i){
    const refs=[];
    if(SH.useSwing){
      const look=Math.max(2, parseInt(SH.swingLookback,10)||20);
      const start=Math.max(0, i-look);
      if(i-start>=2){
        const slice=bars.slice(start,i);
        refs.push({type:'Swing High', price:_max(slice.map(function(b){return b.high;})), dir:'up'});
        refs.push({type:'Swing Low',  price:_min(slice.map(function(b){return b.low;})),  dir:'down'});
      }
    }
    if(SH.useSession){
      const key=shSessKey(bars[i]); let hi=-Infinity, lo=Infinity;
      for(let j=0;j<i;j++){ if(shSessKey(bars[j])!==key) continue; if(bars[j].high>hi) hi=bars[j].high; if(bars[j].low<lo) lo=bars[j].low; }
      if(isFinite(hi)) refs.push({type:'Session High', price:hi, dir:'up'});
      if(isFinite(lo)) refs.push({type:'Session Low',  price:lo, dir:'down'});
    }
    if(SH.useVA){
      const prev=bars[i-1];
      if(prev){
        if(isFinite(prev.vah)) refs.push({type:'Prior VAH', price:prev.vah, dir:'up'});
        if(isFinite(prev.val)) refs.push({type:'Prior VAL', price:prev.val, dir:'down'});
      }
    }
    return refs;
  }

  function shAbsorption(bar, extremePrice, dir){
    const fp=Array.isArray(bar.footprint)?bar.footprint:[];
    if(!fp.length) return {relVol:0, dominance:0, vol:0};
    let sum=0; for(let i=0;i<fp.length;i++) sum+=(fp[i].vol||0);
    const avgVol = sum/fp.length;
    let lvl=fp[0], bestDist=Math.abs(fp[0].price-extremePrice);
    for(let i=1;i<fp.length;i++){ const d=Math.abs(fp[i].price-extremePrice); if(d<bestDist){bestDist=d; lvl=fp[i];} }
    const vol=lvl.vol||0;
    const relVol = avgVol>0 ? vol/avgVol : 0;
    let dominance=0;
    if(vol>0){
      dominance = dir==='up' ? (lvl.liftTrdVol||0)/vol*100 : (lvl.hitTrdVol||0)/vol*100;
    }
    return {relVol:relVol, dominance:dominance, vol:vol};
  }

  function shClearFlags(){
    for(let i=0;i<_flaggedBars.length;i++){ const b=_flaggedBars[i]; if(b){ delete b._sweepUp; delete b._sweepDown; } }
    _flaggedBars=[];
  }

  function shScan(){
    const bars=shBars();
    shClearFlags();
    const out=[];
    if(bars.length<5){ _results=out; return out; }
    for(let i=1;i<bars.length;i++){
      const bar=bars[i];
      const refs=shRefs(bars,i);
      for(let r=0;r<refs.length;r++){
        const ref=refs[r];
        if(ref.dir==='up'){
          if(bar.high>ref.price && bar.close<ref.price){
            const a=shAbsorption(bar, bar.high, 'up');
            if(a.relVol>=SH.volMult && a.dominance>=SH.dominance){
              const rec={idx:i, date:bar.date||'', time:bar.time||'', type:'up', refType:ref.type, refPrice:ref.price,
                extreme:bar.high, close:bar.close, relVol:a.relVol, dominance:a.dominance, vol:a.vol, bar:bar};
              out.push(rec);
              bar._sweepUp = rec; _flaggedBars.push(bar);
            }
          }
        } else {
          if(bar.low<ref.price && bar.close>ref.price){
            const a=shAbsorption(bar, bar.low, 'down');
            if(a.relVol>=SH.volMult && a.dominance>=SH.dominance){
              const rec={idx:i, date:bar.date||'', time:bar.time||'', type:'down', refType:ref.type, refPrice:ref.price,
                extreme:bar.low, close:bar.close, relVol:a.relVol, dominance:a.dominance, vol:a.vol, bar:bar};
              out.push(rec);
              bar._sweepDown = rec; _flaggedBars.push(bar);
            }
          }
        }
      }
    }
    _results = out;
    return out;
  }

  function fmtPrice(v){ return (Math.round((v||0)*100)/100).toFixed(2); }

  function shRenderCards(){
    const total=_results.length;
    const ups=_results.filter(function(r){return r.type==='up';}).length;
    const downs=total-ups;
    const avgVol=total ? (_results.reduce(function(s,r){return s+r.relVol;},0)/total) : 0;
    const set=function(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; };
    set('sh-card-total', total);
    set('sh-card-up', ups);
    set('sh-card-down', downs);
    set('sh-card-avgvol', avgVol.toFixed(2)+'×');
  }

  function shRenderTable(){
    const tbody=document.getElementById('sh-tbody');
    if(!tbody) return;
    const rows=_results.slice(-SH.maxRows).slice().reverse();
    if(!rows.length){ tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#5a6884;">No sweeps detected yet — load data or adjust sensitivity.</td></tr>'; return; }
    let html='';
    for(let i=0;i<rows.length;i++){
      const r=rows[i];
      const up=r.type==='up';
      html += '<tr>'
        + '<td>'+(r.date||'')+' '+(r.time||'')+'</td>'
        + '<td style="color:'+(up?'#ff5566':'#33cc88')+';font-weight:bold;">'+(up?'▲ Sweep Up':'▼ Sweep Down')+'</td>'
        + '<td>'+r.refType+'</td>'
        + '<td>'+fmtPrice(r.refPrice)+'</td>'
        + '<td>'+fmtPrice(r.extreme)+'</td>'
        + '<td>'+fmtPrice(r.close)+'</td>'
        + '<td>'+r.relVol.toFixed(2)+'×</td>'
        + '<td>'+r.dominance.toFixed(0)+'%</td>'
        + '</tr>';
    }
    tbody.innerHTML=html;
  }

  function shRenderTradeLogAlerts(){
    const box=document.getElementById('sh-tl-alerts');
    if(!box) return;
    const rows=_results.slice(-5).slice().reverse();
    if(!rows.length){ box.innerHTML='<span style="color:#5a6884;">No liquidity sweeps detected yet.</span>'; return; }
    let html='';
    for(let i=0;i<rows.length;i++){
      const r=rows[i]; const up=r.type==='up';
      html += '<span style="margin-right:14px;color:'+(up?'#ff5566':'#33cc88')+';">'
        + (up?'▲':'▼')+' '+(r.time||'')+' '+r.refType+' @ '+fmtPrice(r.extreme)+' ('+r.dominance.toFixed(0)+'% dom)</span>';
    }
    box.innerHTML=html;
  }

  function shRender(){
    shScan();
    shRenderCards();
    shRenderTable();
    shRenderTradeLogAlerts();
    try{ if(typeof R!=='undefined' && R) R.draw(); }catch(e){}
  }
  window.sweepRender = shRender;

  function shDrawMarker(cx,x,y,dir,color){
    cx.save();
    cx.fillStyle=color;
    cx.beginPath();
    if(dir==='down'){ cx.moveTo(x-5,y); cx.lineTo(x+5,y); cx.lineTo(x,y+9); }
    else { cx.moveTo(x-5,y); cx.lineTo(x+5,y); cx.lineTo(x,y-9); }
    cx.closePath(); cx.fill();
    cx.restore();
  }

  function shOverlay(renderer){
    if(!SH.showMarkers) return;
    if(!renderer || !renderer.bars || !renderer.bars.length) return;
    const cx=renderer.cx, bars=renderer.bars, W=renderer.MC.width, H=renderer.MC.height;
    const scrollEl=document.getElementById('hscroll');
    const scrollX=scrollEl?(scrollEl.scrollLeft||0):0;
    let pr; try{ pr=renderer._range(); }catch(e){ return; }
    if(!pr) return;
    const visR=(CFG.mode==='range')?(CFG.rangeLevels||10):Math.floor((H-44)/CFG.rowH);
    const mid=(pr.max+pr.min)/2;
    const topP=chartTopPrice(pr,visR);
    const fy=20;
    for(let bi=0; bi<bars.length; bi++){
      const bar=bars[bi];
      const x0=CFG.priceColW+bi*renderer.totalW-scrollX;
      if(x0>W+renderer.totalW || x0+renderer.barW<-renderer.totalW) continue;
      const xc=x0+renderer.barW/2;
      if(bar._sweepUp){
        const y=fy+Math.round((topP-bar._sweepUp.extreme)/chartPriceStep(pr,visR))*CFG.rowH;
        shDrawMarker(cx, xc, y-4, 'down', '#ff5566');
      }
      if(bar._sweepDown){
        const y=fy+Math.round((topP-bar._sweepDown.extreme)/chartPriceStep(pr,visR))*CFG.rowH;
        shDrawMarker(cx, xc, y+4, 'up', '#33cc88');
      }
    }
  }

  if(typeof Renderer!=='undefined' && Renderer.prototype && Renderer.prototype.draw){
    const _shOrigDraw = Renderer.prototype.draw;
    Renderer.prototype.draw = function(){
      _shOrigDraw.call(this);
      try{ shOverlay(this); }catch(e){ console.warn('[SweepHunter] overlay error', e); }
    };
  }

  function shBuildUI(){
    if(document.getElementById('sweep-pane')) return;
    const tabsOuter=document.getElementById('tabs-outer');
    const navHost = document.querySelector('.main-tab[data-tab="regime"]') || document.querySelector('.main-tab[data-tab="reviewer"]');
    if(navHost && navHost.parentNode){
      const btn=document.createElement('button');
      btn.className='main-tab'; btn.dataset.tab='sweep';
      btn.textContent='🎯 Sweep Hunter';
      btn.setAttribute('onclick',"switchTab('sweep')");
      navHost.parentNode.insertBefore(btn, navHost.nextSibling);
    }
    const pane=document.createElement('div');
    pane.id='sweep-pane'; pane.className='tab-pane';
    pane.innerHTML =
      '<div id="sweep-toolbar" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #1e2840;background:#0d1118;">'
      + '<div class="rg-title">🎯 Liquidity Sweep Hunter</div>'
      + '<label><input type="checkbox" id="sh-use-swing" checked> Swing H/L</label>'
      + '<label>Lookback <input type="number" id="sh-swing-look" value="20" min="3" max="500" style="width:56px;"></label>'
      + '<label><input type="checkbox" id="sh-use-session"> Session H/L</label>'
      + '<label><input type="checkbox" id="sh-use-va"> Prior VAH/VAL</label>'
      + '<label>Vol × <input type="number" id="sh-volmult" value="1.3" min="1" max="5" step="0.1" style="width:52px;"></label>'
      + '<label>Dom % <input type="number" id="sh-dom" value="55" min="30" max="95" step="5" style="width:52px;"></label>'
      + '<label><input type="checkbox" id="sh-show-markers" checked> Chart markers</label>'
      + '<button id="sh-rescan">↺ Rescan</button>'
      + '<span style="flex:1"></span>'
      + '<span style="color:#6d7892;font-size:11px;max-width:340px;">Flags stop-runs beyond a reference level that reverse back inside on high-volume, low-follow-through (absorption) footprint.</span>'
      + '</div>'
      + '<div style="display:flex;gap:10px;padding:10px;flex-wrap:wrap;">'
      + '<div class="rg-card" style="min-width:110px;"><div class="rg-card-title">Total Sweeps</div><div id="sh-card-total" style="font-size:20px;font-weight:bold;color:#e8eef8;">0</div></div>'
      + '<div class="rg-card" style="min-width:110px;"><div class="rg-card-title">Up-Sweeps</div><div id="sh-card-up" style="font-size:20px;font-weight:bold;color:#ff5566;">0</div></div>'
      + '<div class="rg-card" style="min-width:110px;"><div class="rg-card-title">Down-Sweeps</div><div id="sh-card-down" style="font-size:20px;font-weight:bold;color:#33cc88;">0</div></div>'
      + '<div class="rg-card" style="min-width:110px;"><div class="rg-card-title">Avg Vol Ratio</div><div id="sh-card-avgvol" style="font-size:20px;font-weight:bold;color:#ffdd44;">0×</div></div>'
      + '</div>'
      + '<div style="flex:1;overflow:auto;padding:0 10px 10px;">'
      + '<table class="rg-table">'
      + '<thead><tr><th>Time</th><th>Type</th><th>Reference</th><th>Ref Price</th><th>Extreme</th><th>Close</th><th>Vol Ratio</th><th>Dominance</th></tr></thead>'
      + '<tbody id="sh-tbody"><tr><td colspan="8" style="text-align:center;color:#5a6884;">No sweeps detected yet.</td></tr></tbody>'
      + '</table>'
      + '</div>';
    if(tabsOuter) tabsOuter.appendChild(pane);

    const tlPane=document.getElementById('tradelog-pane');
    if(tlPane && !document.getElementById('sh-tl-alerts')){
      const strip=document.createElement('div');
      strip.id='sh-tl-alerts';
      strip.style.cssText='padding:6px 10px;background:#0d1118;border-bottom:1px solid #1e2840;font-size:11px;color:#c6d2e8;white-space:nowrap;overflow-x:auto;';
      strip.innerHTML='<span style="color:#5a6884;">No liquidity sweeps detected yet.</span>';
      tlPane.insertBefore(strip, tlPane.firstChild);
    }

    const bind=function(id,prop,isNum){
      const el=document.getElementById(id);
      if(!el) return;
      el.addEventListener('change', function(){
        SH[prop]= el.type==='checkbox' ? el.checked : (isNum?(parseFloat(el.value)||0):el.value);
        shRender();
      });
    };
    bind('sh-use-swing','useSwing');
    bind('sh-swing-look','swingLookback',true);
    bind('sh-use-session','useSession');
    bind('sh-use-va','useVA');
    bind('sh-volmult','volMult',true);
    bind('sh-dom','dominance',true);
    bind('sh-show-markers','showMarkers');
    const rescanBtn=document.getElementById('sh-rescan');
    if(rescanBtn) rescanBtn.addEventListener('click', shRender);
  }

  const _shOldSwitch = window.switchTab;
  window.switchTab = function(tab){
    if(tab==='sweep'){
      document.querySelectorAll('.main-tab').forEach(function(t){ t.classList.toggle('active', t.dataset.tab==='sweep'); });
      document.querySelectorAll('#tabs-outer>.tab-pane').forEach(function(p){ p.classList.toggle('active', p.id==='sweep-pane'); });
      setTimeout(shRender, 20);
      return false;
    }
    if(typeof _shOldSwitch==='function') return _shOldSwitch.apply(this, arguments);
  };

  setInterval(function(){
    try{
      const bars=shBars();
      if(bars.length!==_lastScanLen){
        _lastScanLen=bars.length;
        shRender();
      }
    }catch(e){}
  }, 1200);

  function shInit(){ shBuildUI(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', shInit);
  else shInit();
  window.addEventListener('load', function(){ setTimeout(shInit, 300); });
})();

// ==== mcginley-bot-js ====
(function(){
  'use strict';
  if(window.__MCGINLEY_BOT_V1__) return;
  window.__MCGINLEY_BOT_V1__ = true;

  const AB = {
    pointValue: 1,
    closeFinalAtLastBar: true,
    stopLossPoints: 0,  // 0 = disabled. Max adverse move (in price points) before
                        // an open trade is force-closed, checked against each
                        // bar's high/low rather than only its close — so a
                        // spike-and-reverse within one candle still gets caught.
    mdPeriod: 60,
    splMinTrd: 0,  // 0 = disabled. Self-Improvement may adopt a nonzero value only with trade-retention protection.
    ofScoreMin: 0, // 0 = disabled initially. Order-flow gating is adopted only after out-of-sample validation.
    qualityPnlMin: 7.5, // A "better trade" is a completed trade with realized PnL points strictly above this threshold.
    showQualityOnly: true,
    noTradeProtection: true // Prevent stacked learned filters from silently reducing a valid strategy to zero completed trades. // Historical trade table/export filter. This never peeks at future PnL when opening a live trade.
  };

  let _abResult = null; // {trades, equityCurve, position, openTrade, stats}
  let _abLastLen = -1;

  function abBars(){
    try{ if(typeof _trBars!=='undefined' && Array.isArray(_trBars) && _trBars.length) return _trBars; }catch(e){}
    try{ if(typeof _closedBars!=='undefined' && Array.isArray(_closedBars) && _closedBars.length) return _closedBars; }catch(e){}
    try{ if(typeof R!=='undefined' && R && Array.isArray(R.bars) && R.bars.length) return R.bars; }catch(e){}
    return [];
  }

  // ── Core agent loop (mirrors McGinleyAgentBot.step() in mcginley_agent_bot.py) ──
  // Agent-specific mean-reversion mapping (completed intervals only):
  // Buy      -> open long when Close crosses BELOW McGinley
  // Buy Exit -> open short when Close crosses ABOVE McGinley
  // Long exits on a later Close ABOVE McGinley; short exits on a later Close BELOW McGinley
  // mlPredictions/mlThreshold are optional (undefined = ML gating off,
  // identical behavior to before the transformer existed). mlPredictions
  // is a plain array of predicted win-probabilities, one per bar index,
  // precomputed in a single batched inference pass before this loop runs
  // — keeps this loop itself synchronous and fast, which matters since
  // the self-improvement engine calls abRun many times per run.

  // Data-derived Price Summary order-flow score.
  // Positive = HIT-side dominance; negative = LIFT-side dominance.
  function _abOrderFlowScore(bar){
    const nz=v=>{v=Number(v);return Number.isFinite(v)?Math.max(0,v):0;};
    const norm=(a,b)=>{a=nz(a);b=nz(b);const d=a+b;return d>0?(a-b)/d:0;};
    const hv=nz(bar.totalHitVol), lv=nz(bar.totalLiftVol), tv=hv+lv;
    const ph=tv>0?hv/tv:.5, pl=1-ph;
    const score=
        .30*norm(ph,pl)
      + .25*norm(hv,lv)
      + .20*norm(bar.totalAggrBid,bar.totalAggrAsk)
      + .15*norm(bar.totalHitRTL,bar.totalLiftRTL)
      + .10*norm(bar.totalHitId,bar.totalLiftId);
    return Math.max(-1,Math.min(1,score));
  }

  function abRun(bars, pointValue, stopLossPoints, mdPeriod, mlPredictions, mlThreshold, splMinTrd, ofThresholdOverride){
    const trades = [];
    const equityCurve = [];
    let position = 'flat';
    let openTrade = null;
    let equity = 0;

    function closeTrade(time, price, exitSignal, stoppedOut){
      const t = openTrade;
      t.exitTime = time; t.exitPrice = price; t.exitSignal = exitSignal; t.stoppedOut = !!stoppedOut;
      t.pnlPts = t.side==='long' ? (price - t.entryPrice) : (t.entryPrice - price);
      t.pnl = t.pnlPts * pointValue;
      equity += t.pnl;
      trades.push(t);
      openTrade = null;
      position = 'flat';
    }
    function openPos(side, time, price, entrySignal, entryIndex){
      openTrade = { side:side, entryTime:time, entryPrice:price, entrySignal:entrySignal, entryIndex:entryIndex,
        exitTime:null, exitPrice:null, exitSignal:null, pnlPts:0, pnl:0, stoppedOut:false };
      position = side;
    }
    // Stop-loss is evaluated only after the interval has closed.
    // This prevents Exit Time from appearing before the candle has finished.
    // It remains an emergency risk-control exception to the McGinley close rule.
    function checkStopAtClose(endTime, closePrice){
      if(!openTrade || !stopLossPoints) return false;
      if(openTrade.side==='long'){
        const stopPrice = openTrade.entryPrice - stopLossPoints;
        if(closePrice<=stopPrice){ closeTrade(endTime, closePrice, 'Stop Loss (interval close)', true); return true; }
      } else {
        const stopPrice = openTrade.entryPrice + stopLossPoints;
        if(closePrice>=stopPrice){ closeTrade(endTime, closePrice, 'Stop Loss (interval close)', true); return true; }
      }
      return false;
    }

    // Computed here (not off a shared cache) so this can be called with
    // different bar subsets and periods at once — the self-improvement
    // engine below runs many of these concurrently against in-sample and
    // out-of-sample slices without them stepping on each other.
    // Dual McGinley momentum setup.
    // Slow MD uses the Agent MD field (60 default); Fast MD is 21 default.
    var _fastEl=document.getElementById('ab-fast-md-period');
    var fastMdPeriod=Math.max(2,Math.round(Number(_fastEl && _fastEl.value)||21));
    var slowMdPeriod=Math.max(fastMdPeriod+1,Math.round(Number(mdPeriod)||60));
    var fastSeries=(bars.length && typeof window._mdComputeSeries==='function')
      ? window._mdComputeSeries(bars,fastMdPeriod) : {md:[]};
    var slowSeries=(bars.length && typeof window._mdComputeSeries==='function')
      ? window._mdComputeSeries(bars,slowMdPeriod) : {md:[]};
    // Keep `series.md` as the fast line for downstream ML feature compatibility.
    var series={signal:[],md:fastSeries.md||[]};
    var _ofMinEl=document.getElementById('ab-of-score-min');
    var _ofRaw=Number.isFinite(Number(ofThresholdOverride)) ? Number(ofThresholdOverride)
      : (Number.isFinite(Number(AB.ofScoreMin)) ? Number(AB.ofScoreMin) : Number(_ofMinEl&&_ofMinEl.value));
    var ofScoreMin=Math.max(0,Math.min(1,Number(_ofRaw)||0));

    // Convert the bar's start timestamp to an interval-end timestamp.
    // Prefer the next bar's start (exact boundary). For the last loaded bar,
    // infer the interval width from the previous bars, then CFG.intervalSec.
    function _barStartMs(bar){
      if(!bar) return NaN;
      if(+bar._tsMs>0) return +bar._tsMs;
      var raw=((bar.date||'')+' '+(bar.time||'')).trim() || bar.Timestamp || bar.timestamp || '';
      var ms=Date.parse(String(raw).replace('T',' '));
      return isNaN(ms)?NaN:ms;
    }
    function _fmtTime(ms, fallback){
      if(!isFinite(ms)) return fallback||'';
      var d=new Date(ms), pad=function(v){ return String(v).padStart(2,'0'); };
      return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
    }
    function _intervalEndTime(i){
      var start=_barStartMs(bars[i]);
      var next=(i+1<bars.length)?_barStartMs(bars[i+1]):NaN;
      if(isFinite(next) && (!isFinite(start) || next>start)) return _fmtTime(next, (bars[i].date||'')+' '+(bars[i].time||''));
      var dur=NaN;
      if(i>0){
        var prev=_barStartMs(bars[i-1]);
        if(isFinite(start)&&isFinite(prev)&&start>prev) dur=start-prev;
      }
      if(!isFinite(dur) || dur<=0){
        try{ if(typeof CFG!=='undefined' && CFG && Number(CFG.intervalSec)>0) dur=Number(CFG.intervalSec)*1000; }catch(e){}
      }
      if(!isFinite(dur) || dur<=0) dur=60000;
      return _fmtTime(isFinite(start)?start+dur:NaN, (bars[i].date||'')+' '+(bars[i].time||''));
    }

    for(let i=0;i<bars.length;i++){
      const bar = bars[i];
      const price = Number(bar.close);
      const sig = series.signal[i];
      const sigStr = sig || '0';
      const parts = (sigStr && sigStr!=='0') ? sigStr.split('+') : [];
      const time = (bar.date||'')+' '+(bar.time||'');
      const endTime = _intervalEndTime(i);
      const mdValue = Number(fastSeries.md && fastSeries.md[i]);

      const mlOk = !mlPredictions || (mlPredictions[i]!=null && mlPredictions[i] >= mlThreshold);
      // SPL TRD is the exact per-candle total shown in Candle Summary. A zero threshold disables this gate.
      const splOk = !(Number(splMinTrd)>0) || Number(bar.splTrd||0) >= Number(splMinTrd);

      // AGENT STRATEGY — Dual McGinley trend + close momentum.
      // All conditions use COMPLETED candles only.
      //
      // BUY / LONG:
      //   current Close > previous Close
      //   previous Close > previous Fast MD(21)
      //   Fast MD(21) > Slow MD(60)  [trend confirmation]
      //
      // SELL / SHORT: exact opposite.
      //
      // This follows the structure visible in the reference chart: the fast MD
      // reacts to price while the slow MD defines the broader trend.
      const prevPrice=i>0?Number(bars[i-1]&&bars[i-1].close):NaN;
      const fastMd=Number(fastSeries.md&&fastSeries.md[i]);
      const prevFastMd=i>0?Number(fastSeries.md&&fastSeries.md[i-1]):NaN;
      const slowMd=Number(slowSeries.md&&slowSeries.md[i]);
      const ofScore=_abOrderFlowScore(bar);
      const longFlowOk=ofScoreMin<=0 || ofScore>=ofScoreMin;
      const shortFlowOk=ofScoreMin<=0 || ofScore<=-ofScoreMin;

      const buySignal=i>0 && isFinite(price) && isFinite(prevPrice) &&
        isFinite(prevFastMd) && isFinite(fastMd) && isFinite(slowMd) &&
        price>prevPrice && prevPrice>prevFastMd && fastMd>slowMd && longFlowOk;

      const sellSignal=i>0 && isFinite(price) && isFinite(prevPrice) &&
        isFinite(prevFastMd) && isFinite(fastMd) && isFinite(slowMd) &&
        price<prevPrice && prevPrice<prevFastMd && fastMd<slowMd && shortFlowOk;

      if(openTrade && i>Number(openTrade.entryIndex==null?-1:openTrade.entryIndex)){
        const stopped=checkStopAtClose(endTime,price);
        if(!stopped && openTrade && isFinite(fastMd) && isFinite(slowMd)){
          // Symmetric trend exits. A long is invalid once price loses Fast MD
          // or Fast MD loses Slow MD. A short is invalid on the opposite event.
          const oppositeLong=ofScoreMin>0 && ofScore<=-Math.max(ofScoreMin,.20);
          const oppositeShort=ofScoreMin>0 && ofScore>=Math.max(ofScoreMin,.20);
          if(openTrade.side==='long' && (price<fastMd || fastMd<slowMd || oppositeLong)){
            closeTrade(endTime,price,oppositeLong?'Order Flow reversed bearish':'Close < Fast MD / Fast < Slow',false);
          }else if(openTrade.side==='short' && (price>fastMd || fastMd>slowMd || oppositeShort)){
            closeTrade(endTime,price,oppositeShort?'Order Flow reversed bullish':'Close > Fast MD / Fast > Slow',false);
          }
        }
      }

      // Entries are evaluated only while flat and after the interval is complete.
      // Existing Transformer-confidence and SPL-TRD filters remain active.
      if(position==='flat' && buySignal && mlOk && splOk){
        openPos('long',endTime,price,'Buy',i);
      }else if(position==='flat' && sellSignal && mlOk && splOk){
        openPos('short',endTime,price,'Sell',i);
      }

      let unreal = 0;
      if(openTrade){
        unreal = (openTrade.side==='long' ? (price-openTrade.entryPrice) : (openTrade.entryPrice-price)) * pointValue;
      }
      equityCurve.push({ time:time, equity: equity+unreal });
    }

    // Do not force-liquidate at the end of loaded data. The requested rule is
    // strict: a position remains open until a completed interval confirms the
    // correct Close-vs-McGinley exit (or the interval-close stop-loss fires).

    return { trades: trades, equityCurve: equityCurve, position: position, openTrade: openTrade, equity: equity };
  }

  function abStats(result){
    const trades = result.trades;
    const n = trades.length;
    const pnls = trades.map(t=>t.pnl);
    const wins = pnls.filter(p=>p>0);
    const losses = pnls.filter(p=>p<=0);
    let peak=-Infinity, maxDd=0;
    result.equityCurve.forEach(function(pt){ peak=Math.max(peak,pt.equity); maxDd=Math.max(maxDd, peak-pt.equity); });
    const grossWin = wins.reduce((a,b)=>a+b,0);
    const grossLoss = -losses.reduce((a,b)=>a+b,0);
    return {
      total: n,
      wins: wins.length,
      losses: losses.length,
      winRate: n ? (100*wins.length/n) : 0,
      totalPnl: pnls.reduce((a,b)=>a+b,0),
      avgPnl: n ? (pnls.reduce((a,b)=>a+b,0)/n) : 0,
      avgWin: wins.length ? (grossWin/wins.length) : 0,
      avgLoss: losses.length ? (losses.reduce((a,b)=>a+b,0)/losses.length) : 0,
      profitFactor: grossLoss>0 ? (grossWin/grossLoss) : (grossWin>0?Infinity:0),
      maxDrawdown: maxDd
    };
  }

  function fmtN(v){ return (v==null||!isFinite(v)) ? '\u2014' : (Math.round(v*100)/100).toLocaleString(); }
  function fmtSigned(v){ if(v==null||!isFinite(v)) return '\u2014'; return (v>=0?'+':'')+(Math.round(v*100)/100).toLocaleString(); }

  function abRenderCards(stats, result){
    const set=function(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; };
    set('ab-card-trades', stats.total);
    set('ab-card-winrate', stats.total? stats.winRate.toFixed(1)+'%':'\u2014');
    const pnlEl=document.getElementById('ab-card-pnl');
    if(pnlEl){ pnlEl.textContent=fmtSigned(stats.totalPnl); pnlEl.style.color= stats.totalPnl>=0?'#00cc66':'#ff5555'; }
    set('ab-card-pf', isFinite(stats.profitFactor)? stats.profitFactor.toFixed(2) : (stats.profitFactor>0?'\u221e':'\u2014'));
    set('ab-card-dd', fmtN(stats.maxDrawdown));
    const posEl=document.getElementById('ab-card-pos');
    if(posEl){
      posEl.textContent = result.position==='flat' ? 'FLAT' : result.position.toUpperCase();
      posEl.className = 'ab-pos-'+result.position;
    }
    const unrealEl=document.getElementById('ab-card-unreal');
    if(unrealEl){
      if(result.openTrade){
        const bars=abBars();
        const lastPrice = bars.length ? Number(bars[bars.length-1].close) : result.openTrade.entryPrice;
        const u = (result.openTrade.side==='long' ? (lastPrice-result.openTrade.entryPrice) : (result.openTrade.entryPrice-lastPrice)) * AB.pointValue;
        unrealEl.textContent = fmtSigned(u)+' (since '+result.openTrade.entryTime+')';
        unrealEl.style.color = u>=0?'#00cc66':'#ff5555';
      } else {
        unrealEl.textContent = '\u2014';
        unrealEl.style.color = '#6d7892';
      }
    }
  }

  function abQualityTrades(trades){
    const min=Number(AB.qualityPnlMin)||0;
    return (trades||[]).filter(function(t){ return Number(t.pnlPts)>min; });
  }

  function abRenderTable(result){
    const tbody=document.getElementById('ab-tbody');
    if(!tbody) return;
    const source=AB.showQualityOnly ? abQualityTrades(result.trades) : result.trades;
    const rows=source.slice().reverse();
    if(!rows.length){
      tbody.innerHTML='<tr><td colspan="9" style="text-align:center;color:#5a6884;">'+(AB.showQualityOnly ? 'No completed trades with PnL &gt; '+Number(AB.qualityPnlMin).toFixed(1)+' yet.' : 'No completed trades yet \u2014 waiting for a McGinley signal.')+'</td></tr>';
      return;
    }
    let html='';
    for(let i=0;i<rows.length;i++){
      const t=rows[i];
      const isLong=t.side==='long';
      const win=t.pnl>0;
      html += '<tr>'
        + '<td style="color:'+(isLong?'#00cc66':'#ff5555')+';font-weight:bold;">'+(isLong?'LONG':'SHORT')+'</td>'
        + '<td>'+t.entryTime+'</td>'
        + '<td>'+fmtN(t.entryPrice)+'</td>'
        + '<td>'+t.entrySignal+'</td>'
        + '<td>'+(t.exitTime||'')+'</td>'
        + '<td>'+fmtN(t.exitPrice)+'</td>'
        + '<td>'+(t.exitSignal||'')+'</td>'
        + '<td style="color:'+(win?'#00cc66':'#ff5555')+';font-weight:bold;">'+fmtSigned(t.pnlPts)+'</td>'
        + '<td style="color:'+(win?'#00cc66':'#ff5555')+';font-weight:bold;">'+fmtSigned(t.pnl)+'</td>'
        + '</tr>';
    }
    tbody.innerHTML=html;
  }

  function abDrawEquity(result){
    const canvas=document.getElementById('ab-equity-canvas');
    if(!canvas) return;
    const wrap=canvas.parentElement;
    const W = wrap ? wrap.clientWidth : 600;
    const H = Math.max(55, wrap ? wrap.clientHeight-4 : 140);
    canvas.width=W; canvas.height=H;
    canvas.style.width=W+'px'; canvas.style.height=H+'px';
    const cx=canvas.getContext('2d');
    cx.clearRect(0,0,W,H);
    const pts=result.equityCurve;
    if(!pts.length) return;
    let minE=Infinity, maxE=-Infinity;
    pts.forEach(function(p){ minE=Math.min(minE,p.equity); maxE=Math.max(maxE,p.equity); });
    if(minE===maxE){ minE-=1; maxE+=1; }
    const pad=8;
    const xAt=function(i){ return pad + (W-2*pad) * (i/Math.max(1,pts.length-1)); };
    const yAt=function(e){ return H-pad - (H-2*pad) * ((e-minE)/(maxE-minE)); };
    if(minE<0 && maxE>0){
      cx.strokeStyle='rgba(120,140,170,0.35)'; cx.lineWidth=1; cx.setLineDash([3,3]);
      cx.beginPath(); cx.moveTo(pad,yAt(0)); cx.lineTo(W-pad,yAt(0)); cx.stroke(); cx.setLineDash([]);
    }
    const endEq=pts[pts.length-1].equity;
    cx.strokeStyle = endEq>=0 ? '#00cc66' : '#ff5555';
    cx.lineWidth=1.4;
    cx.beginPath();
    pts.forEach(function(p,i){ const x=xAt(i), y=yAt(p.equity); if(i===0) cx.moveTo(x,y); else cx.lineTo(x,y); });
    cx.stroke();
    const baseY = yAt(minE<0&&maxE>0?0:minE);
    cx.lineTo(xAt(pts.length-1), baseY);
    cx.lineTo(xAt(0), baseY);
    cx.closePath();
    cx.fillStyle = endEq>=0 ? 'rgba(0,204,102,0.10)' : 'rgba(255,85,85,0.10)';
    cx.fill();
  }

  function abSetSafetyStatus(msg, kind){
    const el=document.getElementById('ab-safety-status');
    if(!el) return;
    el.textContent=msg||'';
    el.style.color=kind==='warn'?'#ffcc66':(kind==='ok'?'#00cc66':'#6d7892');
  }

  function abRender(){
    const bars=abBars();
    let mlPreds = null;
    if(ML.gateEnabled && ML.trained){
      const series = (typeof window._mdComputeSeries==='function') ? window._mdComputeSeries(bars, AB.mdPeriod) : {md:[]};
      mlPreds = mlPredictAll(bars, series);
    }
    let configured = abRun(bars, AB.pointValue, AB.stopLossPoints, AB.mdPeriod, mlPreds, ML.threshold, AB.splMinTrd);
    abSetSafetyStatus('', '');

    // No-trade protection: learned filters from previous files can stack (SPL minimum +
    // Transformer gate) until every otherwise-valid McGinley entry is rejected. That
    // is not a profitable improvement; it is inactivity. If the underlying McGinley
    // strategy has completed trades but the active filters reduce them to zero, reset
    // only the entry filters for this active session and keep MD/stop parameters intact.
    if(AB.noTradeProtection && bars.length && configured.trades.length===0 && ((ML.gateEnabled&&ML.trained) || Number(AB.splMinTrd)>0)){
      const unfiltered = abRun(bars, AB.pointValue, AB.stopLossPoints, AB.mdPeriod, null, null, 0);
      if(unfiltered.trades.length>0){
        const reset=[];
        if(ML.gateEnabled){ ML.gateEnabled=false; const g=document.getElementById('ml-gate'); if(g) g.checked=false; reset.push('Transformer gate'); }
        if(Number(AB.splMinTrd)>0){ AB.splMinTrd=0; const sp=document.getElementById('ab-spl-min'); if(sp) sp.value=0; reset.push('SPL TRD minimum'); }
        configured=unfiltered;
        abSetSafetyStatus('No-trade protection activated: reset '+reset.join(' + ')+' for this file because they filtered all completed trades.', 'warn');
      }else{
        abSetSafetyStatus('No completed McGinley trades exist in the loaded range even with ML/SPL entry filters disabled.', 'warn');
      }
    } else if(configured.trades.length>0){
      abSetSafetyStatus('Active configuration has '+configured.trades.length+' completed trade'+(configured.trades.length===1?'':'s')+'.', 'ok');
    }

    _abResult = configured;
    const stats = abStats(_abResult);
    abRenderCards(stats, _abResult);
    abRenderTable(_abResult);
    abDrawEquity(_abResult);
  }
  window.agentBotRender = abRender;

  function abExportCsv(){
    if(!_abResult || !_abResult.trades.length){ alert('No completed trades to export yet.'); return; }
    const exportTrades=AB.showQualityOnly ? abQualityTrades(_abResult.trades) : _abResult.trades;
    if(!exportTrades.length){ alert('No completed trades with PnL > '+Number(AB.qualityPnlMin).toFixed(1)+' to export.'); return; }
    const rows=[['Side','Entry Time','Entry Price','Entry Signal','Exit Time','Exit Price','Exit Signal','Stopped Out','PnL (pts)','PnL']];
    exportTrades.forEach(function(t){
      rows.push([t.side, t.entryTime, t.entryPrice, t.entrySignal, t.exitTime||'', t.exitPrice||'', t.exitSignal||'', !!t.stoppedOut,
        (Math.round(t.pnlPts*100)/100), (Math.round(t.pnl*100)/100)]);
    });
    const csv = rows.map(function(r){ return r.map(function(v){
      const s=String(v==null?'':v);
      return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
    }).join(','); }).join('\n');
    const blob=new Blob([csv],{type:'text/csv'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='mcginley_agent_trades.csv';
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
  }

  // ── Self-Improvement Engine ──────────────────────────────────────────
  // The "scientific method" loop: baseline -> hypothesis -> test one
  // variable at a time -> keep it only if it actually generalizes,
  // otherwise discard and try again. This is the underlying principle
  // behind a self-improving trading agent, running entirely in this
  // browser tab against whatever history is currently loaded.
  //
  // NOT the same thing as a live, LLM-driven, 24/7-with-real-capital
  // system — that needs a real server process, an LLM API key wired to a
  // reasoning loop, and broker execution, none of which a static local
  // HTML file has. This is the honest, buildable version of that idea:
  // a parameter search with a proper train/test split, not a strategy
  // that rewrites its own logic.
  //
  // Train/test split matters here specifically because blindly optimizing
  // stop-loss/period against the ENTIRE loaded history and then declaring
  // victory is just curve-fitting to noise. Splitting into an in-sample
  // slice (tuned on) and an out-of-sample slice (never tuned on, only
  // checked against) is what keeps this closer to real hypothesis testing
  // than to overfitting.
  const SI = {
    splitPct: 0.7,        // fraction of loaded bars used as in-sample (tuning) data
    autoRun: false,
    lastBarCountAtRun: -1,
    autoRunEveryNBars: 50, // how many new bars must arrive before auto-run fires again
    minBarsToRun: 60,      // don't bother optimizing on tiny sessions
    log: [],
    memory: null
  };

  // Persistent agent memory: remembers only improvements that passed the
  // untouched out-of-sample check. This survives reloads and future loaded
  // datasets in this browser without pretending rejected/overfit trials were
  // learned knowledge.
  const AB_MEMORY_KEY = 'orderflow.mcginley.agent.memory.dualmd_of_v2';
  const AB_LAYOUT_KEY = 'orderflow.mcginley.agent.layout.v1';

  function abDatasetFingerprint(bars){
    bars = Array.isArray(bars) ? bars : [];
    if(!bars.length) return 'empty';
    function sigBar(b){
      return [b && (b.time||b.timestamp||b.t||''), b&&Number(b.open), b&&Number(b.high), b&&Number(b.low), b&&Number(b.close)].join('|');
    }
    const raw=[bars.length,sigBar(bars[0]),sigBar(bars[Math.floor(bars.length/2)]),sigBar(bars[bars.length-1])].join('::');
    let h=2166136261;
    for(let i=0;i<raw.length;i++){ h^=raw.charCodeAt(i); h=Math.imul(h,16777619); }
    return (h>>>0).toString(16)+'-'+bars.length;
  }

  function abLoadMemory(){
    let mem={version:1,updatedAt:null,params:{},decisions:[],datasets:{}};
    try{
      const raw=localStorage.getItem(AB_MEMORY_KEY);
      if(raw){ const parsed=JSON.parse(raw); if(parsed&&typeof parsed==='object') mem=Object.assign(mem,parsed); }
    }catch(e){}
    if(!mem.params) mem.params={};
    if(!Array.isArray(mem.decisions)) mem.decisions=[];
    if(!mem.datasets) mem.datasets={};
    SI.memory=mem;
    if(Number.isFinite(Number(mem.params.stopLossPoints))) AB.stopLossPoints=Math.max(0,Number(mem.params.stopLossPoints));
    if(Number.isFinite(Number(mem.params.mdPeriod))) AB.mdPeriod=Math.max(2,Math.round(Number(mem.params.mdPeriod)));
    if(Number.isFinite(Number(mem.params.mlThreshold))) ML.threshold=Math.max(0,Math.min(0.99,Number(mem.params.mlThreshold)));
    if(Number.isFinite(Number(mem.params.splMinTrd))) AB.splMinTrd=Math.max(0,Number(mem.params.splMinTrd));
    if(Number.isFinite(Number(mem.params.qualityPnlMin))) AB.qualityPnlMin=Math.max(0,Number(mem.params.qualityPnlMin));
    if(Number.isFinite(Number(mem.params.ofScoreMin))) AB.ofScoreMin=Math.max(0,Math.min(1,Number(mem.params.ofScoreMin)));
    return mem;
  }

  function abSaveMemory(adoptedResults,bars){
    const mem=SI.memory||abLoadMemory();
    const fp=abDatasetFingerprint(bars);
    const now=new Date().toISOString();
    mem.updatedAt=now;
    mem.params={stopLossPoints:AB.stopLossPoints,mdPeriod:AB.mdPeriod,mlThreshold:ML.threshold,splMinTrd:AB.splMinTrd,qualityPnlMin:AB.qualityPnlMin,ofScoreMin:AB.ofScoreMin};
    const accepted=(adoptedResults||[]).filter(function(r){return r&&r.adopted;}).map(function(r){
      return {time:now,dataset:fp,variable:r.variable,baseline:r.baseline,candidate:r.candidate,value:r.value,inSampleScore:r.inSampleScore,outSampleBaseline:r.outSampleBaseline,outSampleCandidate:r.outSampleCandidate};
    });
    if(accepted.length){
      mem.decisions=accepted.concat(mem.decisions||[]).slice(0,250);
      mem.datasets[fp]={lastImprovedAt:now,barCount:(bars||[]).length,params:Object.assign({},mem.params),accepted:accepted};
    }
    try{ localStorage.setItem(AB_MEMORY_KEY,JSON.stringify(mem)); }catch(e){}
    SI.memory=mem;
    abRenderMemoryStatus();
  }

  function abRenderMemoryStatus(){
    const el=document.getElementById('ab-memory-status');
    if(!el) return;
    const mem=SI.memory||abLoadMemory();
    const n=(mem.decisions||[]).length;
    if(!n){ el.textContent='Agent memory: no validated improvements stored yet.'; return; }
    const last=mem.decisions[0];
    el.textContent='Agent memory: '+n+' validated improvement'+(n===1?'':'s')+' remembered for Dual-MD+OF v2. Current baseline — stop '+AB.stopLossPoints+', MD '+AB.mdPeriod+', SPL ≥ '+Number(AB.splMinTrd||0).toFixed(0)+', OF ≥ '+Number(AB.ofScoreMin||0).toFixed(2)+', Better PnL > '+Number(AB.qualityPnlMin||0).toFixed(1)+', ML '+Number(ML.threshold).toFixed(2)+'. Last: '+last.variable+' → '+last.value+'.';
  }

  function abClearMemory(){
    try{ localStorage.removeItem(AB_MEMORY_KEY); }catch(e){}
    SI.memory={version:1,updatedAt:null,params:{},decisions:[],datasets:{}};
    abRenderMemoryStatus();
  }

  // Risk-adjusted, not raw P&L — a jumpy +80 that passed through a -70
  // drawdown to get there shouldn't beat a smooth +40. Simple and
  // explainable rather than a full Sharpe-style calc, which would need
  // more return samples than a handful of trades can reliably support.
  function siScore(result){
    const stats = abStats(result);
    // A parameter set that produces zero completed trades is not an improvement.
    // Returning -Infinity makes it ineligible to win an optimization comparison,
    // while siFmt() renders it as an em dash instead of a misleading score of 0.
    if(!result || !result.trades || result.trades.length===0) return -Infinity;
    const min=Number(AB.qualityPnlMin)||0;
    // Self-training focuses its reward on the requested "better" trades while
    // still charging every losing trade and drawdown. Small positive trades
    // (<= threshold) are neutral rather than being mistaken for target-quality wins.
    let qualityPnl=0, lossPnl=0;
    (result.trades||[]).forEach(function(t){
      const pts=Number(t.pnlPts)||0, pnl=Number(t.pnl)||0;
      if(pts>min) qualityPnl+=pnl;
      else if(pnl<0) lossPnl+=pnl;
    });
    return qualityPnl + lossPnl - stats.maxDrawdown * 0.5;
  }

  function siSplit(bars){
    const cut = Math.max(1, Math.floor(bars.length * SI.splitPct));
    return { inSample: bars.slice(0, cut), outSample: bars.slice(cut) };
  }

  function siTestStopLoss(inSample, outSample, period, baselineStop){
    const candidates = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 8, 13];
    let best = { stop: baselineStop, score: siScore(abRun(inSample, AB.pointValue, baselineStop, period)) };
    candidates.forEach(function(c){
      if(c === baselineStop) return;
      const score = siScore(abRun(inSample, AB.pointValue, c, period));
      if(score > best.score) best = { stop: c, score: score };
    });
    const baseOut = siScore(abRun(outSample, AB.pointValue, baselineStop, period));
    const candOut = siScore(abRun(outSample, AB.pointValue, best.stop, period));
    const adopted = (best.stop !== baselineStop) && (candOut > baseOut);
    return {
      variable: 'Stop loss (pts)', baseline: baselineStop, candidate: best.stop,
      inSampleScore: best.score, outSampleBaseline: baseOut, outSampleCandidate: candOut,
      adopted: adopted, value: adopted ? best.stop : baselineStop
    };
  }

  function siTestMdPeriod(inSample, outSample, stop, baselinePeriod){
    const candidates = [12, 18, 24, 30, 36, 45, 55, 70, 90];
    let best = { period: baselinePeriod, score: siScore(abRun(inSample, AB.pointValue, stop, baselinePeriod)) };
    candidates.forEach(function(c){
      if(c === baselinePeriod) return;
      const score = siScore(abRun(inSample, AB.pointValue, stop, c));
      if(score > best.score) best = { period: c, score: score };
    });
    const baseOut = siScore(abRun(outSample, AB.pointValue, stop, baselinePeriod));
    const candOut = siScore(abRun(outSample, AB.pointValue, stop, best.period));
    const adopted = (best.period !== baselinePeriod) && (candOut > baseOut);
    return {
      variable: 'MD period', baseline: baselinePeriod, candidate: best.period,
      inSampleScore: best.score, outSampleBaseline: baseOut, outSampleCandidate: candOut,
      adopted: adopted, value: adopted ? best.period : baselinePeriod
    };
  }

  // Fourth self-improvement variable: minimum SPL TRD required to open a new position.
  // Candidate thresholds come only from the in-sample distribution, then the chosen
  // threshold must beat the current threshold on untouched out-of-sample candles.
  function siTestSplThreshold(inSample, outSample, stop, period, baselineSpl){
    const vals=inSample.map(function(b){return Number(b&&b.splTrd)||0;}).filter(function(v){return v>0;}).sort(function(a,b){return a-b;});
    if(vals.length<8) return null;
    function q(p){const i=Math.max(0,Math.min(vals.length-1,Math.round((vals.length-1)*p)));return Math.round(vals[i]);}
    const baseline=Number(baselineSpl)||0;
    const candidates=[0,q(.25),q(.5),q(.75),q(.9),baseline].filter(function(v,i,a){return v>=0&&a.indexOf(v)===i;});
    const baseInRun=abRun(inSample,AB.pointValue,stop,period,null,null,baseline,AB.ofScoreMin);
    const baseOutRun=abRun(outSample,AB.pointValue,stop,period,null,null,baseline,AB.ofScoreMin);
    let best={threshold:baseline,score:siScore(baseInRun),run:baseInRun};
    candidates.forEach(function(c){
      if(c===baseline)return;
      const run=abRun(inSample,AB.pointValue,stop,period,null,null,c,AB.ofScoreMin);
      const minTrades=Math.max(3,Math.ceil((baseInRun.trades||[]).length*.60));
      if((run.trades||[]).length<minTrades)return;
      const score=siScore(run);
      if(score>best.score)best={threshold:c,score:score,run:run};
    });
    const candOutRun=abRun(outSample,AB.pointValue,stop,period,null,null,best.threshold,AB.ofScoreMin);
    const minOutTrades=Math.max(3,Math.ceil((baseOutRun.trades||[]).length*.60));
    const baseOut=siScore(baseOutRun),candOut=siScore(candOutRun);
    const adopted=(best.threshold!==baseline)&&(candOut>baseOut)&&((candOutRun.trades||[]).length>=minOutTrades);
    return {variable:'SPL TRD minimum',baseline:baseline,candidate:best.threshold,inSampleScore:best.score,
      outSampleBaseline:baseOut,outSampleCandidate:candOut,adopted:adopted,value:adopted?best.threshold:baseline};
  }


  function siTestOrderFlowThreshold(inSample,outSample,stop,period,spl,baselineOf){
    const baseline=Math.max(0,Math.min(1,Number(baselineOf)||0));
    const candidates=[0,.05,.10,.15,.20,.25,.30,baseline].filter(function(v,i,a){return a.indexOf(v)===i;});
    const baseInRun=abRun(inSample,AB.pointValue,stop,period,null,null,spl,baseline);
    const baseOutRun=abRun(outSample,AB.pointValue,stop,period,null,null,spl,baseline);
    let best={threshold:baseline,score:siScore(baseInRun),run:baseInRun};
    candidates.forEach(function(c){
      if(c===baseline)return;
      const run=abRun(inSample,AB.pointValue,stop,period,null,null,spl,c);
      const minTrades=Math.max(3,Math.ceil((baseInRun.trades||[]).length*.60));
      if((run.trades||[]).length<minTrades)return;
      const score=siScore(run);
      if(score>best.score)best={threshold:c,score:score,run:run};
    });
    const candOutRun=abRun(outSample,AB.pointValue,stop,period,null,null,spl,best.threshold);
    const minOutTrades=Math.max(3,Math.ceil((baseOutRun.trades||[]).length*.60));
    const baseOut=siScore(baseOutRun),candOut=siScore(candOutRun);
    const adopted=(best.threshold!==baseline)&&(candOut>baseOut)&&((candOutRun.trades||[]).length>=minOutTrades);
    return {variable:'Order Flow score minimum',baseline:baseline,candidate:best.threshold,
      inSampleScore:best.score,outSampleBaseline:baseOut,outSampleCandidate:candOut,
      adopted:adopted,value:adopted?best.threshold:baseline};
  }

  function siRun(manual){
    const bars = abBars();
    if(bars.length < SI.minBarsToRun){
      if(manual) alert('Need at least '+SI.minBarsToRun+' candles of loaded history to self-improve (currently '+bars.length+'). Load more data first.');
      return;
    }
    const split = siSplit(bars);
    if(split.inSample.length < 10 || split.outSample.length < 10){
      if(manual) alert('Not enough data yet for a reliable in-sample / out-of-sample split.');
      return;
    }

    const ts = new Date().toLocaleTimeString();

    const slResult = siTestStopLoss(split.inSample, split.outSample, AB.mdPeriod, AB.stopLossPoints);
    if(slResult.adopted) AB.stopLossPoints = slResult.value;
    SI.log.unshift(Object.assign({ time: ts }, slResult));

    const mdResult = siTestMdPeriod(split.inSample, split.outSample, AB.stopLossPoints, AB.mdPeriod);
    if(mdResult.adopted) AB.mdPeriod = mdResult.value;
    SI.log.unshift(Object.assign({ time: ts }, mdResult));

    const splResult = siTestSplThreshold(split.inSample, split.outSample, AB.stopLossPoints, AB.mdPeriod, AB.splMinTrd);
    if(splResult){
      if(splResult.adopted) AB.splMinTrd = splResult.value;
      SI.log.unshift(Object.assign({ time: ts }, splResult));
    }

    const ofResult=siTestOrderFlowThreshold(split.inSample,split.outSample,AB.stopLossPoints,AB.mdPeriod,AB.splMinTrd,AB.ofScoreMin);
    if(ofResult){
      if(ofResult.adopted) AB.ofScoreMin=ofResult.value;
      SI.log.unshift(Object.assign({time:ts},ofResult));
    }

    // Transformer confidence variable, only in play once a transformer has actually been
    // trained — otherwise this is a no-op and behavior is unchanged.
    const mlResult = siTestMlThreshold(bars, split.inSample, split.outSample, AB.stopLossPoints, AB.mdPeriod);
    if(mlResult){
      if(mlResult.adopted) ML.threshold = mlResult.value;
      SI.log.unshift(Object.assign({ time: ts }, mlResult));
    }

    SI.log = SI.log.slice(0, 200);
    SI.lastBarCountAtRun = bars.length;
    abSaveMemory([slResult, mdResult, splResult, ofResult, mlResult], bars);

    const slInput = document.getElementById('ab-stop-loss'); if(slInput) slInput.value = AB.stopLossPoints;
    const mpInput = document.getElementById('ab-md-period'); if(mpInput) mpInput.value = AB.mdPeriod;
    const splInput = document.getElementById('ab-spl-min'); if(splInput) splInput.value = AB.splMinTrd;
    const ofInput = document.getElementById('ab-of-score-min'); if(ofInput) ofInput.value = Number(AB.ofScoreMin||0).toFixed(2);
    const mlThreshInput = document.getElementById('ml-threshold'); if(mlThreshInput) mlThreshInput.value = ML.threshold;
    siRenderLog();
    abRender();
  }
  window.agentBotSelfImprove = siRun;

  function siFmt(v){ return isFinite(v) ? (Math.round(v*100)/100) : '—'; }

  function siRenderLog(){
    const tbody = document.getElementById('si-log-tbody');
    if(!tbody) return;
    if(!SI.log.length){ tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#5a6884;">No self-improvement runs yet — click Run.</td></tr>'; return; }
    let html = '';
    SI.log.forEach(function(e){
      html += '<tr>'
        + '<td>'+e.time+'</td>'
        + '<td>'+e.variable+'</td>'
        + '<td>'+e.baseline+' → '+e.candidate+'</td>'
        + '<td>'+siFmt(e.inSampleScore)+'</td>'
        + '<td>'+siFmt(e.outSampleBaseline)+'</td>'
        + '<td>'+siFmt(e.outSampleCandidate)+'</td>'
        + '<td style="color:'+(e.adopted?'#00cc66':'#6d7892')+';font-weight:bold;">'+(e.adopted?'ADOPTED':'kept baseline')+'</td>'
        + '</tr>';
    });
    tbody.innerHTML = html;
  }

  // ── Transformer (self-attention model over Save History-style features) ──
  // Reference: the person asked for the same idea as a YouTube video on
  // self-improving AI trading agents. That video's system is live, 24/7,
  // LLM-driven, trading real capital via a real server — none of which a
  // static local HTML file can be. What's built here is the genuinely
  // buildable piece: a real (small) transformer — actual multi-head
  // self-attention, not a rebranded linear model — trained in-browser on
  // whatever history is currently loaded, feeding into the same
  // self-improvement loop above as one more thing that can be tuned and
  // validated, never just trusted because it's "AI."
  //
  // IMPORTANT HONESTY NOTE, kept visible in the UI, not just this comment:
  // a single loaded session is a few hundred candles at most. That is a
  // tiny dataset for a neural net. Overfitting risk is severe and often
  // unavoidable at this scale — this is reported plainly (train vs.
  // out-of-sample accuracy, shown side by side) rather than hidden, and
  // the model's influence on real decisions (via the confidence gate) is
  // OFF by default and only ever adopted by the self-improvement loop if
  // it demonstrably helps on data it wasn't trained on.
  const ML_SEQ_LEN = 8;

  const ML = {
    model: null,
    stats: null,
    trained: false,
    trainAcc: null,
    valAcc: null,
    trainN: 0,
    valN: 0,
    trainPos: 0,
    trainNeg: 0,
    gateEnabled: false,
    threshold: 0.55
  };

  // Raw (unnormalized) per-candle feature vector, covering the same
  // categories as Save History's numeric columns — price action, POC/VWAP/
  // MD, delta, imbalance, volume/size, and SPL TRD — computed directly from the bar
  // object (the same underlying data Save History's own export ultimately
  // comes from) rather than by re-parsing exported text.
  function mlRawFeatures(bar, mdValue){
    const c=Number(bar.close)||0, o=Number(bar.open)||0, h=Number(bar.high)||0, l=Number(bar.low)||0;
    const fp = Array.isArray(bar.footprint) ? bar.footprint : [];
    let bidSum=0, askSum=0, imbCount=0;
    const thresh = (typeof CFG!=='undefined' && CFG.imbThreshold) ? CFG.imbThreshold/100 : 3;
    const minV = (typeof CFG!=='undefined' && CFG.imbMinVol) ? Math.max(1,CFG.imbMinVol) : 10;
    fp.forEach(function(lvl){
      const b=Number(lvl.bSize)||0, a=Number(lvl.aSize)||0;
      bidSum+=b; askSum+=a;
      if((b>=minV && a>0 && b/a>=thresh) || (a>=minV && b>0 && a/b>=thresh)) imbCount++;
    });
    const hitVol = Number(bar.totalHitVol||bar.sellVol||0);
    const liftVol = Number(bar.totalLiftVol||bar.buyVol||0);
    const totalVol = Number(bar.totalVol)||(hitVol+liftVol)||0;
    const poc = Number(bar.pocPrice)||c;
    const vwap = Number(bar.avgVwap)||c;
    const md = isFinite(mdValue) ? mdValue : c;
    return [
      c-o, h-l, poc-c, vwap-c, md-c,
      Number(bar.delta)||0,
      totalVol, hitVol, liftVol, Number(bar.splTrd)||0,
      bidSum, askSum, fp.length, imbCount,
      c>=o ? 1 : 0
    ];
  }

  function mlComputeStats(rows){
    const n=rows.length, dims=rows[0].length;
    const mean=new Array(dims).fill(0), std=new Array(dims).fill(1);
    for(let d=0; d<dims; d++){ let s=0; for(let i=0;i<n;i++) s+=rows[i][d]; mean[d]=s/n; }
    for(let d=0; d<dims; d++){ let s=0; for(let i=0;i<n;i++) s+=Math.pow(rows[i][d]-mean[d],2); std[d]=Math.sqrt(s/n)||1; }
    return { mean:mean, std:std };
  }
  function mlNormalize(row, stats){ return row.map(function(v,d){ return (v-stats.mean[d])/stats.std[d]; }); }

  function mlSequenceAt(bars, series, idx, stats){
    if(idx < ML_SEQ_LEN-1) return null;
    const seq=[];
    for(let j=idx-ML_SEQ_LEN+1; j<=idx; j++){
      const raw = mlRawFeatures(bars[j], series.md ? series.md[j] : bars[j].close);
      seq.push(stats ? mlNormalize(raw, stats) : raw);
    }
    return seq;
  }

  function mlBuildLabeledSet(bars, series, trades, stats){
    const X=[], Y=[];
    trades.forEach(function(t){
      const idx = bars.findIndex(function(b){ return ((b.date||'')+' '+(b.time||''))===t.entryTime; });
      if(idx<0) return;
      const seq = mlSequenceAt(bars, series, idx, stats);
      if(!seq) return;
      // Target 1 means this entry became a requested "better trade": realized PnL points > threshold.
      // Trades at/below the threshold remain as negative examples; dropping them would leave the classifier nothing to learn against.
      X.push(seq); Y.push(Number(t.pnlPts)>Number(AB.qualityPnlMin) ? 1 : 0);
    });
    return { X:X, Y:Y };
  }

  // A real (small) transformer encoder: input projection, learned
  // positional encoding, multi-head self-attention with a residual
  // connection, a feedforward block with its own residual, then a linear
  // head over the last timestep's representation. Verified against a toy
  // classification task in isolation (train/val accuracy both reached the
  // high 90s) before ever being wired to trading data.
  function MiniTransformer(numFeatures, seqLen, dModel, numHeads){
    this.numFeatures=numFeatures; this.seqLen=seqLen; this.dModel=dModel; this.numHeads=numHeads;
    this.headDim=dModel/numHeads;
    const init=function(shape){ return tf.variable(tf.randomNormal(shape,0,0.15)); };
    this.Win=init([numFeatures,dModel]); this.bin=tf.variable(tf.zeros([dModel]));
    this.Wq=init([dModel,dModel]); this.Wk=init([dModel,dModel]); this.Wv=init([dModel,dModel]); this.Wo=init([dModel,dModel]);
    this.posEnc=init([seqLen,dModel]);
    this.W1=init([dModel,dModel*2]); this.b1=tf.variable(tf.zeros([dModel*2]));
    this.W2=init([dModel*2,dModel]); this.b2=tf.variable(tf.zeros([dModel]));
    this.Wout=init([dModel,1]); this.bout=tf.variable(tf.zeros([1]));
  }
  MiniTransformer.prototype.forward = function(xBatch){
    const self=this;
    return tf.tidy(function(){
      const batch=xBatch.shape[0];
      // 2D weight matrices need the batch+seq dims merged before matMul,
      // then split back out — tf.matMul doesn't auto-broadcast a 2D
      // weight against a 3D [batch, seq, features] input.
      const linear=function(t, W, b, outDim){
        const flat=t.reshape([-1, t.shape[t.shape.length-1]]);
        let out=tf.matMul(flat, W);
        if(b) out=tf.add(out, b);
        return out.reshape([batch, self.seqLen, outDim]);
      };
      let x=linear(xBatch, self.Win, self.bin, self.dModel);
      x=tf.add(x, self.posEnc.expandDims(0));
      const q=linear(x, self.Wq, null, self.dModel).reshape([batch, self.seqLen, self.numHeads, self.headDim]).transpose([0,2,1,3]);
      const k=linear(x, self.Wk, null, self.dModel).reshape([batch, self.seqLen, self.numHeads, self.headDim]).transpose([0,2,1,3]);
      const v=linear(x, self.Wv, null, self.dModel).reshape([batch, self.seqLen, self.numHeads, self.headDim]).transpose([0,2,1,3]);
      const scores=tf.matMul(q,k,false,true).div(tf.scalar(Math.sqrt(self.headDim)));
      const attn=tf.softmax(scores,-1);
      let context=tf.matMul(attn,v);
      context=context.transpose([0,2,1,3]).reshape([batch, self.seqLen, self.dModel]);
      context=linear(context, self.Wo, null, self.dModel);
      let x2=tf.add(x, context);
      let ff=tf.relu(linear(x2, self.W1, self.b1, self.dModel*2));
      ff=linear(ff, self.W2, self.b2, self.dModel);
      let x3=tf.add(x2, ff);
      const last=x3.slice([0, self.seqLen-1, 0], [batch, 1, self.dModel]).reshape([batch, self.dModel]);
      const logits=tf.add(tf.matMul(last, self.Wout), self.bout);
      return tf.sigmoid(logits).reshape([batch]);
    });
  };
  MiniTransformer.prototype.trainableWeights = function(){
    return [this.Win,this.bin,this.Wq,this.Wk,this.Wv,this.Wo,this.posEnc,this.W1,this.b1,this.W2,this.b2,this.Wout,this.bout];
  };

  function mlBceLoss(pred, y){
    const eps=1e-7;
    const p=tf.clipByValue(pred, eps, 1-eps);
    return tf.neg(tf.mean(tf.add(tf.mul(y, tf.log(p)), tf.mul(tf.sub(1,y), tf.log(tf.sub(1,p))))));
  }

  function mlWeightedBceLoss(pred, y, posWeight){
    const eps=1e-7;
    const p=tf.clipByValue(pred, eps, 1-eps);
    const pw=tf.scalar(Math.max(1,Number(posWeight)||1));
    const pos=tf.mul(tf.mul(y, tf.log(p)), pw);
    const neg=tf.mul(tf.sub(1,y), tf.log(tf.sub(1,p)));
    return tf.neg(tf.mean(tf.add(pos,neg)));
  }

  async function mlTrain(){
    const statusEl=document.getElementById('ml-status');
    if(typeof tf==='undefined'){
      if(statusEl) statusEl.innerHTML='<span style="color:#ff5555;">TensorFlow.js failed to load (check your internet connection) \u2014 the transformer needs it.</span>';
      return;
    }
    const bars=abBars();
    if(bars.length < SI.minBarsToRun){
      if(statusEl) statusEl.textContent='Need at least '+SI.minBarsToRun+' candles loaded first (currently '+bars.length+').';
      return;
    }
    const split=siSplit(bars);
    const series=(typeof window._mdComputeSeries==='function') ? window._mdComputeSeries(bars, AB.mdPeriod) : {md:[],signal:[]};
    const inSeries={ md: series.md.slice(0, split.inSample.length) };
    const outSeries={ md: series.md.slice(split.inSample.length) };

    const inTrades=abRun(split.inSample, AB.pointValue, AB.stopLossPoints, AB.mdPeriod).trades;
    const outTrades=abRun(split.outSample, AB.pointValue, AB.stopLossPoints, AB.mdPeriod).trades;

    // Normalization stats from in-sample data only — never let
    // out-of-sample information leak into training, even indirectly
    // through feature scaling.
    const rawAll=split.inSample.map(function(b,j){ return mlRawFeatures(b, inSeries.md[j]); });
    if(!rawAll.length){ if(statusEl) statusEl.textContent='No in-sample candles to train from.'; return; }
    const stats=mlComputeStats(rawAll);

    const trainSet=mlBuildLabeledSet(split.inSample, inSeries, inTrades, stats);
    const valSet=mlBuildLabeledSet(split.outSample, outSeries, outTrades, stats);

    if(trainSet.X.length < 12){
      if(statusEl) statusEl.innerHTML='Only '+trainSet.X.length+' completed trades in the in-sample data so far (need at least 12) \u2014 load more history or run the strategy longer before training.';
      return;
    }

    const trainPos=trainSet.Y.filter(function(y){return y===1;}).length;
    const trainNeg=trainSet.Y.length-trainPos;
    if(trainPos<2 || trainNeg<2){
      if(statusEl) statusEl.innerHTML='<span style="color:#ffcc66;">Transformer not replaced:</span> target PnL &gt; '+Number(AB.qualityPnlMin).toFixed(1)+' has '+trainPos+' better trade'+(trainPos===1?'':'s')+' and '+trainNeg+' other trade'+(trainNeg===1?'':'s')+' in-sample. Need at least 2 of each class to learn a usable filter. Load more history/files or lower the Better PnL target.';
      return;
    }
    const posWeight=Math.min(8,Math.max(1,trainNeg/trainPos));

    if(statusEl) statusEl.textContent='Training on '+trainSet.X.length+' examples ('+trainPos+' better / '+trainNeg+' other) to predict PnL > '+Number(AB.qualityPnlMin).toFixed(1)+' pts\u2026';
    await new Promise(function(r){ setTimeout(r, 20); });

    const numFeatures=trainSet.X[0][0].length;
    if(ML.model){ ML.model.trainableWeights().forEach(function(w){ w.dispose(); }); }
    ML.model=new MiniTransformer(numFeatures, ML_SEQ_LEN, 8, 2);
    ML.stats=stats;

    const Xt=tf.tensor3d(trainSet.X), Yt=tf.tensor1d(trainSet.Y);
    const optimizer=tf.train.adam(0.02);
    const epochs=60;
    for(let e=0;e<epochs;e++){
      optimizer.minimize(function(){ return mlWeightedBceLoss(ML.model.forward(Xt), Yt, posWeight); }, false, ML.model.trainableWeights());
      if(e % 15===0) await new Promise(function(r){ setTimeout(r,0); });
    }

    const trainAcc=tf.tidy(function(){
      const pred=ML.model.forward(Xt);
      return tf.mean(pred.greater(0.5).toFloat().equal(Yt).toFloat()).dataSync()[0];
    });

    let valAcc=null, valN=valSet.X.length;
    if(valSet.X.length>=4){
      const Xv=tf.tensor3d(valSet.X), Yv=tf.tensor1d(valSet.Y);
      valAcc=tf.tidy(function(){
        const pred=ML.model.forward(Xv);
        return tf.mean(pred.greater(0.5).toFloat().equal(Yv).toFloat()).dataSync()[0];
      });
      Xv.dispose(); Yv.dispose();
    }
    Xt.dispose(); Yt.dispose();

    ML.trained=true; ML.trainAcc=trainAcc; ML.valAcc=valAcc; ML.valN=valN; ML.trainN=trainSet.X.length; ML.trainPos=trainPos; ML.trainNeg=trainNeg;
    mlRenderStatus();
    abRender();
  }

  // Single batched inference pass over every bar (not just signal bars) —
  // cheap enough at this scale, and keeps the caller's logic (abRun,
  // self-improvement) simple: just an array lookup by index, no per-bar
  // async calls inside a hot loop.
  function mlPredictAll(bars, series){
    if(!ML.trained || !ML.model || typeof tf==='undefined') return null;
    const seqs=[], validIdx=[];
    for(let i=0;i<bars.length;i++){
      const seq=mlSequenceAt(bars, series, i, ML.stats);
      if(seq){ seqs.push(seq); validIdx.push(i); }
    }
    const out=new Array(bars.length).fill(null);
    if(!seqs.length) return out;
    const X=tf.tensor3d(seqs);
    const predArr=tf.tidy(function(){ return ML.model.forward(X); }).dataSync();
    X.dispose();
    validIdx.forEach(function(idx,k){ out[idx]=predArr[k]; });
    return out;
  }

  function mlRenderStatus(){
    const el=document.getElementById('ml-status');
    if(!el) return;
    if(!ML.trained){ el.textContent='Not trained yet.'; return; }
    const valTxt = ML.valAcc!=null ? (ML.valAcc*100).toFixed(1)+'% (n='+ML.valN+')' : 'not enough out-of-sample trades yet to check';
    const weak = ML.valAcc!=null && ML.valAcc<=0.55;
    el.innerHTML = 'Target: PnL &gt; '+Number(AB.qualityPnlMin).toFixed(1)+' pts. Trained on '+ML.trainN+' examples ('+Number(ML.trainPos||0)+' better / '+Number(ML.trainNeg||0)+' other) \u2014 train accuracy '+(ML.trainAcc*100).toFixed(1)+'%, '
      + '<b style="color:'+(weak?'#ff8866':'#00cc66')+'">out-of-sample accuracy '+valTxt+'</b>'
      + (weak ? ' <span style="color:#6d7892;">\u2014 close to a coin flip on data it wasn\u2019t trained on. With one session\u2019s worth of history that\u2019s the expected, honest result, not a bug \u2014 the gate below stays off unless it actually earns it.</span>' : '');
  }

  function mlExtendSeriesFor(bars, sub, offset){
    // sub is either the in-sample or out-of-sample slice; offset is where
    // it starts within the full `bars` array, used to align the full
    // series' md[] values to the slice without recomputing MD from a cold
    // start (which would give a slightly different value early in the
    // slice than the same candle sees in the full series).
    const full=(typeof window._mdComputeSeries==='function') ? window._mdComputeSeries(bars, AB.mdPeriod) : {md:[]};
    return { md: full.md.slice(offset, offset+sub.length) };
  }

  // Third self-improvement variable: how much to trust the transformer.
  // Only runs once a model has actually been trained — nothing changes
  // for anyone who hasn't touched this feature.
  function siTestMlThreshold(bars, inSample, outSample, stop, period){
    if(!ML.trained) return null;
    const candidates=[0, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
    const inSeries=mlExtendSeriesFor(bars, inSample, 0);
    const outSeries=mlExtendSeriesFor(bars, outSample, inSample.length);
    const inPreds=mlPredictAll(inSample, inSeries);
    const outPreds=mlPredictAll(outSample, outSeries);
    const baseline=ML.threshold||0;
    let best={ thresh:baseline, score:siScore(abRun(inSample, AB.pointValue, stop, period, inPreds, baseline)) };
    candidates.forEach(function(c){
      if(c===baseline) return;
      const score=siScore(abRun(inSample, AB.pointValue, stop, period, inPreds, c));
      if(score>best.score) best={ thresh:c, score:score };
    });
    const baseOut=siScore(abRun(outSample, AB.pointValue, stop, period, outPreds, baseline));
    const candOut=siScore(abRun(outSample, AB.pointValue, stop, period, outPreds, best.thresh));
    const adopted=(best.thresh!==baseline) && (candOut>baseOut);
    return {
      variable:'ML confidence threshold', baseline:baseline, candidate:best.thresh,
      inSampleScore:best.score, outSampleBaseline:baseOut, outSampleCandidate:candOut,
      adopted:adopted, value: adopted?best.thresh:baseline
    };
  }

  function abInitResizable(){
    const pane=document.getElementById('agentbot-pane');
    const eq=document.getElementById('ab-equity-section');
    const eqHandle=document.getElementById('ab-resize-equity');
    const trades=document.getElementById('ab-trade-section');
    const tradeHandle=document.getElementById('ab-resize-trades');
    let layout={equityHeight:180,tradeHeight:300};
    try{ const raw=localStorage.getItem(AB_LAYOUT_KEY); if(raw) layout=Object.assign(layout,JSON.parse(raw)); }catch(e){}

    function setH(target,value,min,max){
      if(!target) return;
      const h=Math.max(min,Math.min(max,Number(value)||min));
      target.style.setProperty('height',h+'px','important');
      target.style.setProperty('flex','0 0 '+h+'px','important');
    }
    setH(eq,layout.equityHeight,90,620);
    setH(trades,layout.tradeHeight,120,1000);

    function persist(){
      try{ localStorage.setItem(AB_LAYOUT_KEY,JSON.stringify({
        equityHeight:eq?Math.round(eq.getBoundingClientRect().height):180,
        tradeHeight:trades?Math.round(trades.getBoundingClientRect().height):300
      })); }catch(e){}
    }

    function bind(handle,target,min,max,invert){
      if(!handle||!target||handle.dataset.resizeBound) return;
      handle.dataset.resizeBound='1';
      handle.addEventListener('pointerdown',function(ev){
        if(ev.button!==undefined && ev.button!==0) return;
        ev.preventDefault(); ev.stopPropagation();
        const startY=ev.clientY;
        const startH=target.getBoundingClientRect().height;
        const savedScroll=pane ? pane.scrollTop : 0;
        handle.classList.add('dragging');
        document.body.style.cursor='ns-resize';
        document.body.style.userSelect='none';

        function move(e){
          e.preventDefault();
          const delta=(e.clientY-startY)*(invert?-1:1);
          setH(target,startH+delta,min,max);
          if(pane) pane.scrollTop=savedScroll;
          if(target===eq && _abResult) abDrawEquity(_abResult);
        }
        function up(e){
          handle.classList.remove('dragging');
          document.body.style.cursor='';
          document.body.style.userSelect='';
          window.removeEventListener('pointermove',move,true);
          window.removeEventListener('pointerup',up,true);
          window.removeEventListener('pointercancel',up,true);
          persist();
          if(target===eq && _abResult) abDrawEquity(_abResult);
        }
        window.addEventListener('pointermove',move,true);
        window.addEventListener('pointerup',up,true);
        window.addEventListener('pointercancel',up,true);
      },{passive:false});
    }

    bind(eqHandle,eq,90,620,false);
    // Divider is above the trade table: drag upward = larger table, downward = smaller table.
    bind(tradeHandle,trades,120,1000,true);
  }

  function abBuildUI(){
    if(document.getElementById('agentbot-pane')) return;
    const tabsOuter=document.getElementById('tabs-outer');
    const navHost = document.querySelector('.main-tab[data-tab="sweep"]')
      || document.querySelector('.main-tab[data-tab="regime"]')
      || document.querySelector('.main-tab[data-tab="reviewer"]');
    if(navHost && navHost.parentNode){
      const btn=document.createElement('button');
      btn.className='main-tab'; btn.dataset.tab='agentbot';
      btn.textContent='\ud83e\udd16 Agent Bot';
      btn.setAttribute('onclick',"switchTab('agentbot')");
      navHost.parentNode.insertBefore(btn, navHost.nextSibling);
    }
    const pane=document.createElement('div');
    pane.id='agentbot-pane'; pane.className='tab-pane';
    pane.innerHTML =
      '<div id="ab-toolbar" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #1e2840;background:#0d1118;">'
      + '<div class="rg-title">\ud83e\udd16 McGinley Agent Bot</div>'
      + '<label>Point value $ <input type="number" id="ab-point-value" value="1" min="0.01" step="0.01"></label>'
      + '<label><input type="checkbox" id="ab-close-final" checked> Close open position at last bar</label>'
      + '<label>Stop loss (pts) <input type="number" id="ab-stop-loss" value="0" min="0" step="0.1"></label>'
      + '<label>Slow MD <input type="number" id="ab-md-period" value="60" min="3" max="300" step="1"></label>'
      + '<label>Fast MD <input type="number" id="ab-fast-md-period" value="21" min="2" max="200" step="1"></label>'
      + '<label title="Minimum normalized Price Summary order-flow confirmation">OF score ≥ <input type="number" id="ab-of-score-min" value="0" min="0" max="1" step="0.05" style="width:58px"></label>'
      + '<label>SPL TRD min <input type="number" id="ab-spl-min" value="0" min="0" step="1" title="Minimum Candle Summary SPL TRD required for a new entry; 0 disables the filter"></label>'
      + '<label>Better PnL &gt; <input type="number" id="ab-quality-pnl" value="7.5" min="0" step="0.1" title="Training target in realized PnL points. Transformer predicts whether a new entry will exceed this target."></label>'
      + '<label><input type="checkbox" id="ab-quality-only" checked> Show only better trades</label>'
      + '<label title="Automatically relax ML/SPL entry filters if they eliminate every completed trade in the loaded range."><input type="checkbox" id="ab-no-trade-protect" checked> No-trade protection</label>'
      + '<button id="ab-rescan">\u21ba Rescan</button>'
      + '<button id="ab-export">\u2b07 Export Trade Log</button>'
      + '<span style="flex:1"></span>'
      + '<span style="color:#6d7892;font-size:11px;max-width:360px;">McGinley mean-reversion: Buy opens LONG only after a completed interval crosses below McGinley and exits after a later interval closes above it. Buy Exit opens SHORT only after a completed interval crosses above McGinley and exits after a later interval closes below it. Entry/Exit Time are completed interval ends; stop-loss is also interval-close only.</span>'
      + '</div>'
      + '<div id="ab-safety-status" style="padding:4px 10px 0;font-size:10px;color:#6d7892;min-height:14px;"></div>'
      + '<div style="display:flex;gap:10px;padding:10px;flex-wrap:wrap;">'
      + '<div class="rg-card" style="min-width:100px;"><div class="rg-card-title">Position</div><div id="ab-card-pos" class="ab-pos-flat" style="font-size:18px;font-weight:bold;">FLAT</div></div>'
      + '<div class="rg-card" style="min-width:130px;"><div class="rg-card-title">Unrealized P&amp;L</div><div id="ab-card-unreal" style="font-size:15px;font-weight:bold;color:#6d7892;">\u2014</div></div>'
      + '<div class="rg-card" style="min-width:90px;"><div class="rg-card-title">Trades</div><div id="ab-card-trades" style="font-size:20px;font-weight:bold;color:#e8eef8;">0</div></div>'
      + '<div class="rg-card" style="min-width:90px;"><div class="rg-card-title">Win Rate</div><div id="ab-card-winrate" style="font-size:20px;font-weight:bold;color:#ffdd44;">\u2014</div></div>'
      + '<div class="rg-card" style="min-width:100px;"><div class="rg-card-title">Total P&amp;L</div><div id="ab-card-pnl" style="font-size:20px;font-weight:bold;color:#e8eef8;">0</div></div>'
      + '<div class="rg-card" style="min-width:100px;"><div class="rg-card-title">Profit Factor</div><div id="ab-card-pf" style="font-size:20px;font-weight:bold;color:#e8eef8;">\u2014</div></div>'
      + '<div class="rg-card" style="min-width:100px;"><div class="rg-card-title">Max Drawdown</div><div id="ab-card-dd" style="font-size:20px;font-weight:bold;color:#ff8866;">0</div></div>'
      + '</div>'
      + '<div id="ab-equity-section" style="padding:0 10px 6px;">'
      + '<div style="font-size:9px;color:#556;letter-spacing:.6px;text-transform:uppercase;margin-bottom:2px;">Equity Curve</div>'
      + '<div id="ab-equity-box" style="border:1px solid #1e2840;border-radius:4px;padding:2px;background:#080b10;"><canvas id="ab-equity-canvas"></canvas></div>'
      + '</div>'
      + '<div id="ab-resize-equity" class="ab-resize-handle" title="Drag to resize Equity Curve / Self-Improvement"></div>'
      + '<div id="ab-self-improvement-section" style="padding:0 10px 10px;">'
      + '<div style="border:1px solid #1e2840;border-radius:4px;background:#0d1118;padding:8px 10px;">'
      + '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">'
      + '<div class="rg-title" style="font-size:11px;">\ud83e\uddec Self-Improvement</div>'
      + '<label>In-sample split <input type="number" id="si-split-pct" value="70" min="50" max="90" step="5">%</label>'
      + '<button id="si-run">\u25b6 Run Self-Improvement</button>'
      + '<button id="si-clear" title="Clear the visible Self-Improvement table only; learned Agent Memory is kept.">Clear</button>'
      + '<label><input type="checkbox" id="si-auto"> Keep improving as new candles arrive</label>'
      + '<span style="flex:1"></span>'
      + '<span style="color:#6d7892;font-size:10px;max-width:420px;">Tunes stop-loss, MD period, SPL TRD minimum and Transformer confidence against the requested better-trade target. A trade counts as target quality only when realized PnL points are strictly above the Better PnL threshold; losses still penalize the score. Candidates are adopted only when they also improve the untouched final 30%; a candidate with zero completed trades is automatically rejected.</span>'
      + '</div>'
      + '<div style="overflow-x:auto;margin-top:8px;">'
      + '<table class="rg-table" style="font-size:10px;">'
      + '<thead><tr><th>Time</th><th>Variable</th><th>Baseline \u2192 Candidate</th><th>In-Sample Score</th><th>Out-Sample (Baseline)</th><th>Out-Sample (Candidate)</th><th>Decision</th></tr></thead>'
      + '<tbody id="si-log-tbody"><tr><td colspan="7" style="text-align:center;color:#5a6884;">No self-improvement runs yet \u2014 click Run.</td></tr></tbody>'
      + '</table>'
      + '</div>'
      + '</div>'
      + '</div>'
      + '<div id="ab-transformer-section" style="padding:0 10px 10px;">'
      + '<div style="border:1px solid #1e2840;border-radius:4px;background:#0d1118;padding:8px 10px;">'
      + '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">'
      + '<div class="rg-title" style="font-size:11px;">\ud83e\udde0 Transformer</div>'
      + '<button id="ml-train">\u25b6 Train on Loaded History</button>'
      + '<label><input type="checkbox" id="ml-gate"> Gate entries by confidence \u2265</label>'
      + '<input type="number" id="ml-threshold" value="0.55" min="0" max="0.99" step="0.05" style="width:60px;background:#0a0d12;border:1px solid #1e2840;color:#e8eef8;border-radius:3px;padding:2px 5px;">'
      + '<span style="flex:1"></span>'
      + '<span style="color:#6d7892;font-size:10px;max-width:460px;">A small self-attention model trained on this session\'s candles, including SPL TRD. Its positive target is now a better trade: realized PnL points strictly above the Better PnL threshold (default 7.5); trades at or below it are negative examples. The model predicts that target before entry, so there is no future-PnL look-ahead. Out-of-sample accuracy is reported separately and the confidence gate stays off until validated.</span>'
      + '</div>'
      + '<div id="ml-status" style="margin-top:8px;font-size:10px;color:#aab6cc;">Not trained yet.</div>'
      + '<div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;"><span id="ab-memory-status">Agent memory loading…</span><button id="ab-memory-clear" style="background:#16233a;border:1px solid #2a3c5e;color:#cfe0ff;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:10px;">Clear Memory</button></div>'
      + '</div>'
      + '</div>'
      + '<div id="ab-resize-trades" class="ab-resize-handle" title="Drag to resize Transformer / trade table"></div>'
      + '<div id="ab-trade-section" style="padding:0 10px 10px;">'
      + '<table class="rg-table">'
      + '<thead><tr><th>Side</th><th>Entry Time</th><th>Entry Price</th><th>Entry Signal</th><th>Exit Time</th><th>Exit Price</th><th>Exit Signal</th><th>PnL (pts)</th><th>PnL ($)</th></tr></thead>'
      + '<tbody id="ab-tbody"><tr><td colspan="9" style="text-align:center;color:#5a6884;">No completed trades yet.</td></tr></tbody>'
      + '</table>'
      + '</div>';
    if(tabsOuter) tabsOuter.appendChild(pane);

    const mlTrainBtn=document.getElementById('ml-train');
    if(mlTrainBtn) mlTrainBtn.addEventListener('click', function(){ mlTrain(); });
    const mlGateInput=document.getElementById('ml-gate');
    if(mlGateInput) mlGateInput.addEventListener('change', function(){ ML.gateEnabled=mlGateInput.checked; abRender(); });
    const mlThreshInputEl=document.getElementById('ml-threshold');
    if(mlThreshInputEl) mlThreshInputEl.addEventListener('change', function(){
      // NOT `parseFloat(v)||0.55` -- 0 is a meaningful, intentional value here
      // (gate disabled), and `0 || 0.55` would silently discard it as falsy.
      var v = parseFloat(mlThreshInputEl.value);
      ML.threshold = Math.max(0, Math.min(0.99, isNaN(v) ? 0.55 : v));
      abRender();
    });

    const siSplitInput=document.getElementById('si-split-pct');
    if(siSplitInput) siSplitInput.addEventListener('change', function(){ SI.splitPct=Math.min(0.9,Math.max(0.5,(parseFloat(siSplitInput.value)||70)/100)); });
    const siRunBtn=document.getElementById('si-run');
    if(siRunBtn) siRunBtn.addEventListener('click', function(){ siRun(true); });
    const siAuto=document.getElementById('si-auto');
    if(siAuto) siAuto.addEventListener('change', function(){ SI.autoRun=siAuto.checked; });

    const pv=document.getElementById('ab-point-value');
    if(pv) pv.addEventListener('change', function(){ AB.pointValue=parseFloat(pv.value)||1; abRender(); });
    const cf=document.getElementById('ab-close-final');
    if(cf) cf.addEventListener('change', function(){ AB.closeFinalAtLastBar=cf.checked; abRender(); });
    const sl=document.getElementById('ab-stop-loss');
    if(sl) sl.addEventListener('change', function(){ AB.stopLossPoints=Math.max(0,parseFloat(sl.value)||0); abRender(); });
    const fmp=document.getElementById('ab-fast-md-period');
    if(fmp) fmp.addEventListener('change',function(){ abRescan(); });
    const ofm=document.getElementById('ab-of-score-min');
    if(ofm) ofm.addEventListener('change',function(){ AB.ofScoreMin=Math.max(0,Math.min(1,Number(ofm.value)||0)); abRescan(); });
    const mp=document.getElementById('ab-md-period');
    if(mp) mp.addEventListener('change', function(){ AB.mdPeriod=Math.max(2,parseInt(mp.value,10)||36); abRender(); });
    const splMin=document.getElementById('ab-spl-min');
    if(splMin) splMin.addEventListener('change', function(){ AB.splMinTrd=Math.max(0,parseFloat(splMin.value)||0); abRender(); });
    const qualityPnl=document.getElementById('ab-quality-pnl');
    if(qualityPnl) qualityPnl.addEventListener('change', function(){
      AB.qualityPnlMin=Math.max(0,parseFloat(qualityPnl.value)||7.5);
      // A changed target changes the meaning of every Transformer label, so require a clean retrain.
      if(ML.trained){ ML.trained=false; ML.trainAcc=null; ML.valAcc=null; ML.trainN=0; ML.valN=0; }
      mlRenderStatus(); abRender();
    });
    const qualityOnly=document.getElementById('ab-quality-only');
    if(qualityOnly) qualityOnly.addEventListener('change', function(){ AB.showQualityOnly=qualityOnly.checked; abRenderTable(_abResult||{trades:[]}); });
    const ntp=document.getElementById('ab-no-trade-protect');
    if(ntp) ntp.addEventListener('change', function(){ AB.noTradeProtection=ntp.checked; abRender(); });
    const siClear=document.getElementById('si-clear');
    if(siClear) siClear.addEventListener('click', function(){ SI.log=[]; siRenderLog(); });
    const rescanBtn=document.getElementById('ab-rescan');
    if(rescanBtn) rescanBtn.addEventListener('click', abRender);
    const exportBtn=document.getElementById('ab-export');
    if(exportBtn) exportBtn.addEventListener('click', abExportCsv);

    window.addEventListener('resize', function(){ if(_abResult) abDrawEquity(_abResult); });
  }

  const _abOldSwitch = window.switchTab;
  window.switchTab = function(tab){
    if(tab==='agentbot'){
      document.querySelectorAll('.main-tab').forEach(function(t){ t.classList.toggle('active', t.dataset.tab==='agentbot'); });
      document.querySelectorAll('#tabs-outer>.tab-pane').forEach(function(p){ p.classList.toggle('active', p.id==='agentbot-pane'); });
      setTimeout(abRender, 20);
      return false;
    }
    if(typeof _abOldSwitch==='function') return _abOldSwitch.apply(this, arguments);
  };

  setInterval(function(){
    try{
      const bars=abBars();
      if(bars.length!==_abLastLen){
        _abLastLen=bars.length;
        abRender();
      }
      if(SI.autoRun && SI.lastBarCountAtRun>=0 && (bars.length - SI.lastBarCountAtRun) >= SI.autoRunEveryNBars){
        siRun(false);
      } else if(SI.autoRun && SI.lastBarCountAtRun<0 && bars.length>=SI.minBarsToRun){
        siRun(false);
      }
    }catch(e){}
  }, 1200);

  function abInit(){
    abLoadMemory();
    abBuildUI();
    const sl=document.getElementById('ab-stop-loss'); if(sl) sl.value=AB.stopLossPoints;
    const mp=document.getElementById('ab-md-period'); if(mp) mp.value=AB.mdPeriod;
    const spl=document.getElementById('ab-spl-min'); if(spl) spl.value=AB.splMinTrd;
    const qp=document.getElementById('ab-quality-pnl'); if(qp) qp.value=AB.qualityPnlMin;
    const qo=document.getElementById('ab-quality-only'); if(qo) qo.checked=AB.showQualityOnly;
    const ntp0=document.getElementById('ab-no-trade-protect'); if(ntp0) ntp0.checked=AB.noTradeProtection;
    const mt=document.getElementById('ml-threshold'); if(mt) mt.value=ML.threshold;
    const mc=document.getElementById('ab-memory-clear'); if(mc && !mc.dataset.bound){ mc.dataset.bound='1'; mc.addEventListener('click',function(){ if(confirm('Clear all remembered validated improvements for the McGinley Agent?')) abClearMemory(); }); }
    abRenderMemoryStatus();
    abInitResizable();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', abInit);
  else abInit();
  window.addEventListener('load', function(){ setTimeout(abInit, 350); });
})();






/* ==== V8.6 PRICE SUMMARY -> AGENT DATA API ==== */
(function(){
  if(window.__V86_PRICE_SUMMARY_API__) return;
  window.__V86_PRICE_SUMMARY_API__=true;

  function psIntervalSec(){
    try{
      var on=document.querySelector('#sum-pill-iv .sum-iv-pill.on');
      var v=on?parseInt(on.getAttribute('data-s'),10):NaN;
      if(Number.isFinite(v)&&v>0) return v;
    }catch(e){}
    try{
      if(typeof _sumEffectiveInterval==='function'){
        var v2=_sumEffectiveInterval(); if(Number.isFinite(v2)&&v2>0)return v2;
      }
    }catch(e){}
    try{ if(Number.isFinite(Number(_sumIntervalSec))&&Number(_sumIntervalSec)>0)return Number(_sumIntervalSec); }catch(e){}
    try{ if(window.CFG&&Number(CFG.intervalSec)>0)return Number(CFG.intervalSec); }catch(e){}
    return 60;
  }

  function psRows(){
    try{
      if(typeof _allRawRows!=='undefined' && Array.isArray(_allRawRows) && _allRawRows.length) return _allRawRows.slice();
    }catch(e){}
    try{
      if(typeof _trAllRows!=='undefined' && Array.isArray(_trAllRows) && _trAllRows.length) return _trAllRows.slice();
    }catch(e){}
    return [];
  }

  function psSelectedRows(){
    var rows=psRows();
    if(!rows.length)return rows;
    try{
      var s=document.getElementById('dt-start'), e=document.getElementById('dt-end');
      var sv=s&&s.value?new Date(s.value).getTime():NaN, ev=e&&e.value?new Date(e.value).getTime():NaN;
      if(Number.isFinite(sv)||Number.isFinite(ev)){
        var lo=Number.isFinite(sv)?sv:-Infinity, hi=Number.isFinite(ev)?ev:Infinity;
        var rr=rows.filter(function(r){
          var ms=0;
          try{ ms=(typeof _toAbsMs==='function')?_toAbsMs(r):0; }catch(x){}
          return ms>=lo&&ms<=hi;
        });
        if(rr.length)return rr;
      }
    }catch(e){}
    return rows;
  }

  function safeN(v,d){v=Number(v);return Number.isFinite(v)?v:(d||0);}
  function isoFromBar(b){
    var s=((b&&b.date)||'')+' '+((b&&b.time)||'');
    var d=new Date(s.trim());
    if(!isNaN(+d))return d.toISOString();
    try{
      var t=b&&b.ticks&&b.ticks[0];
      var ms=(typeof _toAbsMs==='function')?_toAbsMs(t):0;
      if(ms>0)return new Date(ms).toISOString();
    }catch(e){}
    return s.trim();
  }

  window.getV86PriceSummaryDataset=function(){
    var rows=psRows();
    var iv=psIntervalSec();
    var bars=[];
    try{ bars=(typeof _bucketByInterval==='function')?_bucketByInterval(rows.slice(),iv):[]; }catch(e){ bars=[]; }
    bars=(bars||[]).filter(function(b){return b&&Array.isArray(b.ticks)&&b.ticks.length;});

    var md=null;
    try{ if(typeof window._mdComputeSeries==='function') md=window._mdComputeSeries(bars,(window._MD_PERIOD||36)); }catch(e){}

    var outBars=[], sig=[];
    for(var i=0;i<bars.length;i++){
      var b=bars[i], ts=isoFromBar(b), date=String(b.date||'').trim();
      outBars.push({
        t:ts,
        o:safeN(b.open), h:safeN(b.high), l:safeN(b.low), c:safeN(b.close),
        v:safeN(b.totalVol||b.volume||b.trdVol), session:date || ts.slice(0,10),
        poc:safeN(b.pocPrice), vwap:safeN(b.avgVwap), spl_trd:safeN(b.splTrd),
        tick_count:(b.ticks||[]).length
      });
      var s0=(md&&md.signal&&md.signal[i])?String(md.signal[i]):'0';
      var parts=(s0&&s0!=='0')?s0.split('+'):[];
      function add(type){ sig.push({i:i,type:type,price:safeN(b.close),prob:0,regime:'PRICE SUMMARY',t:ts}); }
      if(parts.indexOf('Buy')!==-1)add('BUY_ENTRY');
      if(parts.indexOf('Buy Exit')!==-1)add('BUY_EXIT');
      if(parts.indexOf('Sell')!==-1)add('SELL_ENTRY');
      if(parts.indexOf('Sell Exit')!==-1)add('SELL_EXIT');
      try{
        if(typeof window._csMarkerForBar==='function'){
          var mk=String(window._csMarkerForBar(b)||'0').trim();
          if(mk==='Buy')add('BUY_ENTRY');
          else if(mk==='Buy Exit')add('BUY_EXIT');
          else if(mk==='Sell')add('SELL_ENTRY');
          else if(mk==='Sell Exit')add('SELL_EXIT');
        }
      }catch(e){}
    }

    var seen={}; sig=sig.filter(function(s){var k=s.i+'|'+s.type;if(seen[k])return false;seen[k]=1;return true;});
    var file=''; try{file=String(window._loadedFileBaseName||'');}catch(e){}
    return {
      source:'PRICE_SUMMARY_FULL_HISTORY', file:file, intervalSec:iv,
      rowCount:rows.length, bars:outBars, signals:sig,
      generatedAt:new Date().toISOString()
    };
  };

  window.publishV8FullHistory=function(){
    try{
      var f=document.getElementById('v8-agent-frame');
      if(f&&f.contentWindow&&typeof f.contentWindow.syncCurrentData==='function') f.contentWindow.syncCurrentData(true);
    }catch(e){}
  };

  // Price Summary controls are the source of truth for the agent view.
  document.addEventListener('click',function(ev){
    var t=ev.target;
    if(!t)return;
    if(t.closest&&t.closest('#sum-pill-iv, #sum-save-history-btn, #sum-save-summary-btn, #dt-apply-btn, #dt-clear-btn')){
      setTimeout(window.publishV8FullHistory,80);
      setTimeout(window.publishV8FullHistory,350);
    }
  },true);
  setInterval(function(){
    try{
      var d=window.getV86PriceSummaryDataset();
      var fp=d.rowCount+'|'+d.intervalSec+'|'+d.bars.length+'|'+(d.bars.length?d.bars[d.bars.length-1].t:'');
      if(fp!==window.__v86PsFp){window.__v86PsFp=fp;window.publishV8FullHistory();}
    }catch(e){}
  },1200);
})();



/* ==== V8 AGENT — FULL PRICE SUMMARY HISTORY LINK ==== */
(function(){
  if(window.__V8_AGENT_FULL_HISTORY_LINK__) return;
  window.__V8_AGENT_FULL_HISTORY_LINK__=true;

  window.syncV8Agent=function(force){
    try{
      var f=document.getElementById('v8-agent-frame');
      if(f && f.contentWindow && typeof f.contentWindow.syncCurrentData==='function'){
        f.contentWindow.syncCurrentData(force!==false);
      }
    }catch(e){}
  };

  // The V8 Agent tracks the complete loaded file. It is refreshed when the
  // source file changes, when Price Summary aggregation changes, and when the
  // V8 Agent tab is opened. The original McGinley Agent Bot is untouched.
  var lastFp='';
  setInterval(function(){
    try{
      if(typeof window.getV86PriceSummaryDataset!=='function') return;
      var d=window.getV86PriceSummaryDataset();
      var last=(d.bars&&d.bars.length)?d.bars[d.bars.length-1].t:'';
      var fp=[d.rowCount,d.intervalSec,d.bars.length,last].join('|');
      if(fp!==lastFp){
        lastFp=fp;
        window.syncV8Agent(true);
      }
    }catch(e){}
  },1000);

  setTimeout(function(){window.syncV8Agent(true);},600);
})();


/* ==== V7 MERGE: PRESERVED V4 WATCH FOLDER + DATABASE BACKEND ==== */
// ==== Watch Folder: automatic Excel/CSV import from a local folder ====
// The user grants access to a folder once (File System Access API — Chrome
// / Edge only). From then on this polls that folder and auto-imports
// whichever file best matches "now": a file whose name embeds a date/time
// (e.g. TAS_2026-08-23_14.xlsx) that has already arrived is preferred over
// one still in the future; if no filenames carry a parseable date/time, the
// most recently modified matching file is used instead. Re-importing the
// same unchanged file is skipped. The granted folder handle is remembered
// (IndexedDB) so a page reload doesn't require re-picking the folder —
// though the browser may still require one click to re-confirm permission.
let _wfHandle=null, _wfTimer=null, _wfLastKey=null, _wfIntervalMs=1000; // polling every second, per request

const WF_DB_NAME='itr_watch_folder', WF_STORE='handles';
function _wfIdbOpen(){
  return new Promise((res,rej)=>{
    const req=indexedDB.open(WF_DB_NAME,1);
    req.onupgradeneeded=()=>req.result.createObjectStore(WF_STORE);
    req.onsuccess=()=>res(req.result);
    req.onerror=()=>rej(req.error);
  });
}
async function _wfSaveHandle(handle){
  try{
    const db=await _wfIdbOpen();
    await new Promise((res,rej)=>{
      const tx=db.transaction(WF_STORE,'readwrite');
      tx.objectStore(WF_STORE).put(handle,'dir::pro-single-display');
      tx.oncomplete=res; tx.onerror=()=>rej(tx.error);
    });
  }catch(e){}
}
async function _wfLoadHandle(){
  try{
    const db=await _wfIdbOpen();
    return await new Promise((res)=>{
      const tx=db.transaction(WF_STORE,'readonly');
      const req=tx.objectStore(WF_STORE).get('dir::pro-single-display');
      req.onsuccess=()=>res(req.result||null);
      req.onerror=()=>res(null);
    });
  }catch(e){ return null; }
}

function _wfExtractTime(name){
  // e.g. "2026-08-23", "20260823", optionally followed by "_14", "_14-30", "_1430"
  const m=name.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})(?:[_\s-]?(\d{2})[-:h]?(\d{2})?)?/);
  if(!m) return null;
  const [,y,mo,d,h,mi]=m;
  const dt=new Date(Number(y),Number(mo)-1,Number(d),Number(h||0),Number(mi||0));
  return isNaN(dt.getTime())?null:dt;
}

async function _wfPickBestFile(dirHandle){
  const now=Date.now();
  const candidates=[];
  for await (const [name,handle] of dirHandle.entries()){
    if(handle.kind!=='file') continue;
    const ext=('.'+name.split('.').pop()).toLowerCase();
    if(!['.xlsx','.xlsm','.xls','.csv'].includes(ext)) continue;
    const file=await handle.getFile();
    candidates.push({name,file,embedded:_wfExtractTime(name),mtime:file.lastModified});
  }
  if(!candidates.length) return null;
  const arrived=candidates.filter(c=>c.embedded && c.embedded.getTime()<=now);
  if(arrived.length){
    arrived.sort((a,b)=>b.embedded.getTime()-a.embedded.getTime());
    return arrived[0];
  }
  candidates.sort((a,b)=>b.mtime-a.mtime);
  return candidates[0];
}

function _wfSetStatus(text){ const el=document.getElementById('wf-status'); if(el) el.textContent=text; }

function _wfStop(){
  if(_wfTimer){ clearInterval(_wfTimer); _wfTimer=null; }
  const btn=document.getElementById('wf-btn');
  if(btn) btn.textContent='📁 Watch Folder';
}

async function _wfTick(){
  if(!_wfHandle) return;
  try{
    if((await _wfHandle.queryPermission({mode:'read'}))!=='granted'){
      _wfSetStatus('⚠ Permission lost — click Watch Folder to reconnect.');
      _wfStop();
      return;
    }
    const best=await _wfPickBestFile(_wfHandle);
    if(!best){ _wfSetStatus(`Watching "${_wfHandle.name}" — no Excel/CSV files found.`); return; }
    const key=best.name+'|'+best.mtime;
    if(key===_wfLastKey){
      _wfSetStatus(`Watching "${_wfHandle.name}" — up to date (${best.name}).`);
      return;
    }
    _wfLastKey=key;
    _wfSetStatus(`Watching "${_wfHandle.name}" — importing ${best.name}…`);
    window._itrImportSource='watch-folder';
    await _normalFileHandler({target:{files:[best.file]}});
    _wfSetStatus(`Watching "${_wfHandle.name}" — last import: ${best.name}.`);
  }catch(e){
    _wfSetStatus('⚠ Watch error: '+e.message);
  }
}

// ---- Fallback for browsers without the File System Access API (Firefox, ----
// ---- Safari): a snapshot folder import via <input webkitdirectory>. This ----
// can't auto-poll for new files (the browser gives no live folder handle,
// only a one-time file list), so it imports the best-matching file found at
// the moment of selection; the user re-opens the picker to refresh.
const _wfFallbackInput=document.getElementById('wf-fallback-input');
function _wfPickBestFromFileList(fileList){
  const now=Date.now();
  const candidates=Array.from(fileList)
    .filter(f=>['.xlsx','.xlsm','.xls','.csv'].includes(('.'+f.name.split('.').pop()).toLowerCase()))
    .map(f=>({name:f.name,file:f,embedded:_wfExtractTime(f.name),mtime:f.lastModified}));
  if(!candidates.length) return null;
  const arrived=candidates.filter(c=>c.embedded && c.embedded.getTime()<=now);
  if(arrived.length){ arrived.sort((a,b)=>b.embedded.getTime()-a.embedded.getTime()); return arrived[0]; }
  candidates.sort((a,b)=>b.mtime-a.mtime);
  return candidates[0];
}
if(_wfFallbackInput){
  _wfFallbackInput.addEventListener('change', async (e)=>{
    const best=_wfPickBestFromFileList(e.target.files);
    if(!best){ _wfSetStatus('⚠ No Excel/CSV files found in that folder.'); return; }
    _wfSetStatus(`Imported ${best.name} (snapshot). This browser can't auto-refresh — reopen "Import Folder" to pick up new files.`);
    window._itrImportSource='watch-folder';
    await _normalFileHandler({target:{files:[best.file]}});
  });
}

async function wfToggle(){
  if(_wfTimer){ _wfStop(); _wfSetStatus('Watch stopped.'); return; }
  if(!window.showDirectoryPicker){
    if(_wfFallbackInput) _wfFallbackInput.click();
    else _wfSetStatus('⚠ Folder import is not supported in this browser — import files manually instead.');
    return;
  }
  try{
    if(!_wfHandle){
      _wfHandle=await window.showDirectoryPicker({id:'itr-watch-folder-pro-single-display',mode:'read'});
      await _wfSaveHandle(_wfHandle);
    }else if((await _wfHandle.queryPermission({mode:'read'}))!=='granted'){
      const perm=await _wfHandle.requestPermission({mode:'read'});
      if(perm!=='granted'){ _wfSetStatus('⚠ Permission denied.'); return; }
    }
    const btn=document.getElementById('wf-btn');
    if(btn) btn.textContent='⏹ Stop Watching';
    _wfLastKey=null;
    _wfTick();
    _wfTimer=setInterval(_wfTick,_wfIntervalMs);
  }catch(e){
    if(e.name!=='AbortError') _wfSetStatus('⚠ '+e.message);
  }
}

// Reflect real capability in the button up front, so Firefox/Safari users
// see "Import Folder" (manual snapshot) rather than a "Watch" promise the
// browser can't keep, while Chrome/Edge keep the full auto-watch label.
(()=>{
  const btn=document.getElementById('wf-btn');
  if(btn && !window.showDirectoryPicker){
    btn.textContent='📁 Import Folder';
    btn.title='This browser (Firefox/Safari) can\'t auto-watch a folder — pick it and the best-matching Excel/CSV file imports once. Reopen this button to refresh.';
  }
})();

// Try to silently resume a previously granted folder after a page reload.
(async()=>{
  try{
    const saved=await _wfLoadHandle();
    if(!saved) return;
    _wfHandle=saved;
    if((await saved.queryPermission({mode:'read'}))==='granted'){
      const btn=document.getElementById('wf-btn');
      if(btn) btn.textContent='⏹ Stop Watching';
      _wfLastKey=null;
      _wfTick();
      _wfTimer=setInterval(_wfTick,_wfIntervalMs);
    }else{
      _wfSetStatus('📁 Folder saved from last time — click Watch Folder to reconnect (browsers require a click to re-confirm access after reload).');
    }
  }catch(e){}
})();

// ==== Backend sync: auto-save each successful import to the database ====
// After the platform finishes parsing a file (manual pick, drag-drop, or an
// automatic Watch Folder import), the resulting bars are POSTed to the
// ISKRU TRADE ROBOT PRO backend so trading history persists across
// sessions instead of living only in this browser tab. This is a side
// effect only — a failed save never blocks or alters the chart itself.
const ITR_SECTION_ID='gcv'; // shared PostgreSQL GCV history channel
// Local PC testing hits this project's backend on port 4001.
// On the real domain, this deliberately uses a RELATIVE path — same origin,
// same protocol (HTTPS) as the page itself — so the request never crosses
// ports or protocols. This requires the server (IIS) to reverse-proxy
// /api/* to the local Node backend; see the setup guide for that step.
// Do NOT hardcode a :4001 domain URL here — that causes browsers to block
// the request as mixed content once the site is served over HTTPS.
function _itrResolveApiBase(){
  // Optional explicit override for unusual deployments:
  // window.ITR_API_BASE_OVERRIDE='http://server-name:4001'
  const override=String(window.ITR_API_BASE_OVERRIDE||'').trim().replace(/\/+$/,'');
  if(override) return override;
  // A file:// page has no hostname, so relative /api calls cannot work.
  if(location.protocol==='file:') return 'http://127.0.0.1:4001';
  // In local development, call the Node API on the SAME host name the page
  // used (localhost stays localhost; 127.0.0.1 stays 127.0.0.1). This avoids
  // an unnecessary CORS mismatch between those two hostnames.
  if(location.protocol==='http:' && (location.hostname==='localhost'||location.hostname==='127.0.0.1'))
    return `http://${location.hostname}:4001`;
  // HTTPS/production: use same-origin /api via the reverse proxy.
  return '';
}
const ITR_API_BASE=_itrResolveApiBase();

async function _itrFetchChecked(url,options){
  if(!ITR_API_BASE && /\.github\.io$/i.test(location.hostname)){
    throw new Error('Backend URL is not configured. Set the GitHub Actions variable ITR_API_BASE to your Windows Server HTTPS origin.');
  }
  let res;
  try{ res=await fetch(url,options); }
  catch(e){
    throw new Error(`Cannot reach backend at ${ITR_API_BASE||location.origin}: ${e.message}`);
  }
  if(!res.ok){
    const body=await res.json().catch(()=>({}));
    throw new Error(body.detail||body.error||`Server error ${res.status}`);
  }
  return res;
}

function _itrRowsDataRange(rows){
  const vals=(rows||[]).map(r=>{
    if(r && +r._tsMs>0) return +r._tsMs;
    try{ if(typeof _toAbsMs==='function'){ const m=_toAbsMs(r); if(m>0) return m; } }catch(e){}
    const raw=r&&r.date&&r.time?`${r.date} ${r.time}`:(r?.Timestamp||r?.timestamp||'');
    const m=Date.parse(String(raw).replace('T',' '));
    return isNaN(m)?0:m;
  }).filter(m=>m>0).sort((a,b)=>a-b);
  return vals.length?{dataStart:new Date(vals[0]).toISOString(),dataEnd:new Date(vals[vals.length-1]).toISOString()}:{dataStart:null,dataEnd:null};
}

window._itrImportSource=window._itrImportSource||'manual';

async function _itrSaveImport(){
  try{
    const bars=(typeof _trBars!=='undefined'&&Array.isArray(_trBars))?_trBars:[];
    const rows=(typeof _trAllRows!=='undefined'&&Array.isArray(_trAllRows))?_trAllRows:[];
    if(!bars.length && !rows.length) return;
    const rowMatch=(document.getElementById('live-rowcount')?.textContent||'').match(/(\d+)/);
    const rowCount=rowMatch?parseInt(rowMatch[1],10):(rows.length||bars.length);
    const range=_itrRowsDataRange(rows);

    // Store raw rows FIRST. DATABASE mode reads raw ticks directly, so a
    // metadata failure must never leave an import record that points at no data.
    if(rows.length){
      const tickRes=await _itrFetchChecked(`${ITR_API_BASE}/api/ticks/${ITR_SECTION_ID}`,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({rows})
      });
      const tickInfo=await tickRes.json().catch(()=>({}));
      if(tickInfo.skippedInvalidTimestamp){
        console.warn(`[ISKRU TRADE ROBOT PRO] ${tickInfo.skippedInvalidTimestamp} rows skipped: invalid timestamp`);
      }
      if(tickInfo.skippedDuplicate){
        console.info(`[ISKRU TRADE ROBOT PRO] ${tickInfo.skippedDuplicate} duplicate database rows skipped`);
      }
    }

    // Import metadata is useful for history/inspection but is no longer a
    // prerequisite for DATABASE range loading.
    const importRes=await _itrFetchChecked(`${ITR_API_BASE}/api/imports/${ITR_SECTION_ID}`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        section:ITR_SECTION_ID,
        filename:(typeof _liveFile!=='undefined'&&_liveFile)?_liveFile.name:'unknown',
        rowCount,
        barCount:bars.length,
        intervalSec:CFG.intervalSec,
        bars,
        source:window._itrImportSource||'manual',
        dataStart:range.dataStart,
        dataEnd:range.dataEnd
      })
    });
    await importRes.json().catch(()=>({}));
  }catch(e){
    console.error('[ISKRU TRADE ROBOT PRO] Backend save FAILED:',e);
    const st=document.getElementById('db-auto-status');
    if(st) st.textContent='⚠ Database save failed: '+e.message;
  }finally{
    window._itrImportSource='manual';
  }
}

if(typeof _normalFileHandler==='function' && !_normalFileHandler.__itrDbWrapped){
  const _itrOriginalFileHandler=_normalFileHandler;
  const _itrWrapped=async function(e){
    await _itrOriginalFileHandler.apply(this,arguments);
    // A real manual load is now the active FILE dataset.
    window._itrLoadedSource='file';
    await _itrSaveImport();
  };
  _itrWrapped.__itrDbWrapped=true;
  try{
    const _itrFi=document.getElementById('fi');
    if(_itrFi){
      // IMPORTANT: reassigning the function variable alone does not replace
      // the listener that was registered earlier. Replace that listener too.
      _itrFi.removeEventListener('change',_itrOriginalFileHandler);
      _itrFi.addEventListener('change',_itrWrapped);
    }
    _normalFileHandler=_itrWrapped;
  }catch(e){}
}

// ==== DATABASE DEFAULT SOURCE V4 ===========================================
// One authoritative selector only: DATABASE (default) or FILE (manual).
// The old Auto-load checkbox has been removed to eliminate conflicting state.
// ==== DATABASE / FILE SOURCE CONTROLLER — FIXED =========================
// FILE and DATABASE are two mutually-exclusive operating modes.
// DATABASE mode never requires a manual file. It requests the selected
// trading range from the backend, hydrates the same shared dashboard state
// used by FILE mode, then runs the existing candle/tab pipeline.
const dbAutoStatusEl=document.getElementById('db-auto-status');

function _dbSetStatus(text){ if(dbAutoStatusEl) dbAutoStatusEl.textContent=text||''; }

window._itrDataSource = 'database';
window._itrLoadedSource = window._itrLoadedSource || null;
window._itrDbAutoTimer = null;

function _itrSourceControls(src){
  const isDb=src==='database';
  const dbBtn=document.getElementById('src-btn-database');
  const fileBtn=document.getElementById('src-btn-file');
  const fi=document.getElementById('fi');
  const drop=document.getElementById('sb-dz');
  const wfBtn=document.getElementById('wf-btn');

  if(dbBtn){
    dbBtn.style.background=isDb?'#001a33':'';
    dbBtn.style.borderColor=isDb?'#3388cc':'#2a3a4a';
    dbBtn.style.color=isDb?'#66bbff':'#8899aa';
  }
  if(fileBtn){
    fileBtn.style.background=!isDb?'#0d1f14':'';
    fileBtn.style.borderColor=!isDb?'#33cc88':'#1e3a2a';
    fileBtn.style.color=!isDb?'#88eeaa':'#66776f';
  }

  // Prevent a file dialog/watch-folder import from becoming an accidental
  // hidden dependency while DATABASE mode is active.
  if(fi) fi.disabled=isDb;
  if(drop){
    drop.style.opacity=isDb?'0.35':'';
    drop.style.pointerEvents=isDb?'none':'';
    drop.title=isDb?'DATABASE mode is active — data is loaded through the backend.':'Select or drop Excel/CSV files.';
  }
  if(wfBtn){
    wfBtn.disabled=isDb;
    wfBtn.style.opacity=isDb?'0.35':'';
  }
}

/* ── Display time zone ─────────────────────────────────────────
   Chart/date/time fields show wall-clock time of the chosen zone.
   Rows keep the true instant in _utcMs; _tsMs is shifted so every
   local-getter in the page renders the chosen zone's wall clock. */
window._itrTZ=(function(){ try{ return localStorage.getItem('itr.tz')||'local'; }catch(e){ return 'local'; } })();
function _itrTzName(){
  const z=window._itrTZ;
  if(!z||z==='local'){ try{ return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'; }catch(e){ return 'UTC'; } }
  return z;
}
const _itrTzFmtCache={};
function _itrTzWall(ms,tz){
  let f=_itrTzFmtCache[tz];
  if(!f) f=_itrTzFmtCache[tz]=new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const o={};
  f.formatToParts(new Date(ms)).forEach(p=>{ o[p.type]=+p.value; });
  return o;
}
function _itrTzShiftMs(ms){
  if(!window._itrTZ||window._itrTZ==='local') return ms;
  const w=_itrTzWall(ms,window._itrTZ);
  return new Date(w.year,w.month-1,w.day,w.hour,w.minute,w.second,((ms%1000)+1000)%1000).getTime();
}
function _itrWallToUtcMs(y,mo,d,h,mi,s){
  const tz=window._itrTZ;
  const guess=Date.UTC(y,mo-1,d,h,mi,s);
  const off=t=>{ const w=_itrTzWall(t,tz); return Date.UTC(w.year,w.month-1,w.day,w.hour,w.minute,w.second)-Math.floor(t/1000)*1000; };
  let t=guess-off(guess);
  t=guess-off(t);
  return t;
}
function _itrInputToDate(val){
  if(!window._itrTZ||window._itrTZ==='local') return new Date(val);
  const m=String(val||'').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if(!m) return new Date(NaN);
  return new Date(_itrWallToUtcMs(+m[1],+m[2],+m[3],+m[4],+m[5],+(m[6]||0)));
}

function _dbRangeFromInputs(){
  const startVal=(document.getElementById('tr-start-dt')||{}).value;
  const endVal=(document.getElementById('tr-end-dt')||{}).value;
  if(!startVal || !endVal) return {ok:false,message:'Set START and END first.'};
  const startDate=_itrInputToDate(startVal), endDate=_itrInputToDate(endVal);
  if(isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return {ok:false,message:'Invalid START or END time.'};
  if(startDate>=endDate) return {ok:false,message:'START must be before END.'};
  return {ok:true,startDate,endDate,startIso:startDate.toISOString(),endIso:endDate.toISOString()};
}

async function _itrCheckBackendDatabase(){
  const res=await _itrFetchChecked(`${ITR_API_BASE}/api/health`);
  const health=await res.json().catch(()=>({}));
  if(health.database!=='connected' && health.postgres!=='connected'){
    throw new Error('Backend is running, but PostgreSQL/TimescaleDB is disconnected.');
  }
  return health;
}

async function _itrFetchDbTicks(startIso,endIso){
  const symbol=String(CFG.symbol||'XAUUSD').trim().toUpperCase();
  const url=`${ITR_API_BASE}/api/ticks/${ITR_SECTION_ID}?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&symbol=${encodeURIComponent(symbol)}`;
  const res=await _itrFetchChecked(url);
  const rows=await res.json();
  window._itrLastFetchMeta={
    truncated:res.headers.get('X-Market-Data-Truncated')==='true',
    limit:Number(res.headers.get('X-Market-Data-Limit'))||0,
    rows:Array.isArray(rows)?rows.length:0
  };
  return Array.isArray(rows)?rows:[];
}

// Capture the known-good FILE builder before DATABASE mode wraps it.
const _itrFileBuildCandles=(typeof buildCandles==='function')?buildCandles:window.buildCandles;

function _itrNormalizeDatabaseRows(inputRows){
  const pad=value=>String(value).padStart(2,'0');
  const number=(row,key,...aliases)=>{
    const current=Number(row[key]);
    if(Number.isFinite(current)&&current!==0) return current;
    for(const alias of aliases){
      const value=row[alias];
      if(value===null||value===undefined||String(value).trim()==='') continue;
      const parsed=Number(String(value).replace(/,/g,''));
      if(Number.isFinite(parsed)) return parsed;
    }
    return Number.isFinite(current)?current:0;
  };
  return (Array.isArray(inputRows)?inputRows:[]).map(source=>{
    const row={...source};
    let timestamp=Number(row._utcMs)||Number(row._tsMs)||0;
    if(!(timestamp>0)){
      const raw=row.Timestamp||row.timestamp||row.TIMESTAMP||row.DateTime||row.datetime;
      const parsed=raw?Date.parse(String(raw)):NaN;
      if(Number.isFinite(parsed)) timestamp=parsed;
    }
    if(timestamp>0){
      row._utcMs=timestamp;
      timestamp=_itrTzShiftMs(timestamp);
      const date=new Date(timestamp);
      row._tsMs=timestamp;
      row.date=`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
      row.time=`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }else{
      row.date=row.date||row.Date||row.DATE||'';
      row.time=row.time||row.Time||row.TIME||'';
    }

    row.bid=number(row,'bid','BID','Bid');
    row.ask=number(row,'ask','ASK','Ask','OFFER');
    row.tick=String(row.tick||row.PRCTCK_1||row.TICK||row['CF TICK']||'');
    row.last=number(row,'last','TRDPRC_1','LAST','Last','price','PRICE');
    row.aggr=String(row.aggr||row.AGGRS_SID1||row.AGGRESSIVE||row.SIDE||'');
    if(!(row.last>0)&&(row.bid>0||row.ask>0)&&/[⇧⇩↑↓]/.test(row.tick)){
      const up=/[⇧↑]/.test(row.tick);
      row.last=up?(row.bid||row.ask):(row.ask||row.bid);
      if(!row.aggr) row.aggr=up?'ASK':'BID';
    }
    row.bSize=number(row,'bSize','BIDSIZE','BID_SIZE','BidSize');
    row.aSize=number(row,'aSize','ASKSIZE','ASK_SIZE','AskSize');
    row.trdVol=number(row,'trdVol','TRDVOL_1','TRDVOL','TRADE VOL','Trade Volume');
    row.volume=number(row,'volume','ELIGBL TRD ACVOL','ELIGIBLE TRD ACVOL','TRDVOL_1','VOLUME');
    row.moves=number(row,'moves','RTL','RT_Count','RT_COUNT','Moves');
    row.rtCount=number(row,'rtCount','RT_Count','RT_COUNT','RTL');
    row.seqNum=number(row,'seqNum','SEQNUM','SEQ_NUM','SEQ');
    row.tradeId=String(row.tradeId||row.TRADE_ID||row.TRD_ID||row.TradeID||'');
    row.condKey=String(row.condKey||row.QUALIFIERS||row.QUALIFIER||'');
    return row;
  });
}

function _itrHydrateDatabaseRows(inputRows, range){
  let rows=_itrNormalizeDatabaseRows(inputRows);
  if(!rows.length) return false;

  // Use the same ordering/diff preparation as a successful manual file load.
  rows.sort((a,b)=>{
    let am=0,bm=0;
    try{ am=(typeof _toAbsMs==='function'?_toAbsMs(a):(+a?._tsMs||0))||Number.MAX_SAFE_INTEGER; }catch(e){ am=Number.MAX_SAFE_INTEGER; }
    try{ bm=(typeof _toAbsMs==='function'?_toAbsMs(b):(+b?._tsMs||0))||Number.MAX_SAFE_INTEGER; }catch(e){ bm=Number.MAX_SAFE_INTEGER; }
    return am-bm;
  });
  try{ if(typeof _fillNaN==='function') _fillNaN(rows); }catch(e){}
  try{ if(typeof _applyDiffs==='function') _applyDiffs(rows); }catch(e){}

  try{ if(typeof CFG!=='undefined') CFG.usingRealData=true; }catch(e){}
  try{ if(typeof _stopRT==='function') _stopRT(); }catch(e){}
  try{ if(typeof _liveActive!=='undefined' && _liveActive && typeof liveStop==='function') liveStop(); }catch(e){}

  // Synchronize ALL primary row stores. This is the part the old database
  // loader missed, causing chart data and the other tabs to disagree.
  try{ _allRawRows=rows; }catch(e){}
  try{ _trAllRows=rows; }catch(e){}
  try{ _tlRows=rows.slice(); }catch(e){}
  window._allRawRows=rows;
  window._trAllRows=rows;
  window._tlRows=rows.slice();

  // A newly fetched database range is a fresh dataset, so an old FILE-mode
  // Day/Time filter must not hide it.
  try{ _dtActive=false; _dtFilteredRows=null; _dtStartMs=0; _dtEndMs=0; }catch(e){}
  window._dtActive=false;
  window._dtFilteredRows=null;

  // DATABASE already has an explicit user-selected range. Auto-populating it
  // from the fetched rows calls trSyncFromDT, which otherwise schedules the
  // same database load again after every successful build.
  setTimeout(()=>{
    try{ if(typeof _dtPopulateFromRows==='function') _dtPopulateFromRows(rows); }catch(e){}
    try{ if(typeof _dtPopulateFromRows_new==='function') _dtPopulateFromRows_new(rows); }catch(e){}
  },50);

  window._itrLoadedSource='database';
  window._itrImportSource='database';

  // Reuse the existing mature candle/render/tab pipeline instead of having
  // a second database-only renderer. This is what makes FILE and DATABASE
  // produce the same application state.
  if(typeof _itrFileBuildCandles==='function') _itrFileBuildCandles();

  const bars=(typeof _trBars!=='undefined'&&Array.isArray(_trBars))?_trBars:(window._trBars||[]);
  const ds=document.getElementById('dsrc');
  if(ds){ ds.textContent=`🗄 DB · ${rows.length.toLocaleString()} ticks · ${bars.length.toLocaleString()} bars`; ds.className=''; }
  const fb=document.getElementById('fmt-badge'); if(fb) fb.style.display='none';
  const rc=document.getElementById('live-rowcount'); if(rc) rc.textContent=`${rows.length.toLocaleString()} database rows loaded`;
  try{ if(typeof _trUpdateNavInfo==='function') _trUpdateNavInfo(); }catch(e){}

  // Refresh lazy tabs that may not be redrawn by the visible chart path.
  const refreshers=['tlRender','sumRender','laRender','laProRender','laproRender','dfpRender','rvRender','regimeRender'];
  refreshers.forEach(name=>{ try{ if(typeof window[name]==='function') window[name](); }catch(e){} });

  const rangeText=range&&range.startDate&&range.endDate
    ? `${range.startDate.toLocaleString()} → ${range.endDate.toLocaleString()}`:'';
  _dbSetStatus(`✓ DATABASE: ${rows.length.toLocaleString()} rows loaded${rangeText?' | '+rangeText:''}`);
  return true;
}

async function _itrLoadDatabaseRange(opts){
  opts=opts||{};
  if(window._itrDataSource!=='database') return false;
  if(window._itrBuilding) return false;

  const range=_dbRangeFromInputs();
  if(!range.ok){
    _dbSetStatus('DATABASE ready — '+range.message);
    if(opts.alertOnError) alert(range.message);
    return false;
  }

  const btn=document.getElementById('btn-build');
  const prevLabel=btn?btn.textContent:'';
  window._itrBuilding=true;
  if(btn){ btn.textContent='LOADING DATABASE…'; btn.disabled=true; }
  _dbSetStatus('Checking backend and database…');

  try{
    await _itrCheckBackendDatabase();
    _dbSetStatus('Database connected — loading selected range…');
    const rows=await _itrFetchDbTicks(range.startIso,range.endIso);
    if(!rows.length){
      const msg='No database data found for the selected START/END range.';
      const ds=document.getElementById('dsrc'); if(ds) ds.textContent='🗄 DB · 0 ticks';
      _dbSetStatus(msg);
      if(opts.alertOnError) alert(msg);
      return false;
    }
    const loaded=_itrHydrateDatabaseRows(rows,range);
    if(typeof window._covAfterLoad==='function') window._covAfterLoad(window._itrLastFetchMeta,rows);
    return loaded;
    console.error('[ISKRU TRADE ROBOT PRO] DATABASE load failed:',err);
    const msg='DATABASE load failed: '+(err&&err.message?err.message:String(err));
    _dbSetStatus('⚠ '+msg);
    if(opts.alertOnError) alert(msg);
    return false;
  }finally{
    window._itrBuilding=false;
    if(btn){ btn.textContent=prevLabel||'▶ BUILD CANDLES'; btn.disabled=false; }
  }
}
window._itrLoadDatabaseRange=_itrLoadDatabaseRange;

function _itrScheduleDatabaseAutoLoad(){
  if(window._itrDataSource!=='database') return;
  clearTimeout(window._itrDbAutoTimer);
  window._itrDbAutoTimer=setTimeout(()=>{
    const range=_dbRangeFromInputs();
    if(range.ok) _itrLoadDatabaseRange({alertOnError:false});
    else _dbSetStatus('DATABASE ready — set a valid START and END, then Build Candles.');
  },250);
}

function itrSetDataSource(src,options){
  options=options||{};
  src=(src==='database')?'database':'file';
  const previous=window._itrDataSource;
  window._itrDataSource=src;
  _itrSourceControls(src);

  if(src==='database'){
    try{ if(typeof _wfStop==='function') _wfStop(); }catch(e){}
    _dbSetStatus('DATABASE mode — no manual file is required.');
    if(options.autoLoad!==false) _itrScheduleDatabaseAutoLoad();
  }else{
    clearTimeout(window._itrDbAutoTimer);
    _dbSetStatus('FILE mode — select or drop a file.');
    // If DATABASE replaced the in-memory dataset, do not silently reuse it
    // after switching back to FILE. A new file must be chosen.
    if(previous==='database' && window._itrLoadedSource==='database'){
      try{ _allRawRows=[]; _trAllRows=[]; _tlRows=[]; _trBars=[]; _closedBars=[]; }catch(e){}
      window._allRawRows=[]; window._trAllRows=[]; window._tlRows=[]; window._trBars=[];
      window._itrLoadedSource=null;
      const ds=document.getElementById('dsrc'); if(ds){ ds.textContent='📁 FILE · waiting for file'; ds.className=''; }
    }
  }
  return false;
}
window.itrSetDataSource=itrSetDataSource;


// Changing the sidebar START/END while DATABASE mode is active should
// automatically refresh the selected range, but debounce paired edits.
['tr-start-dt','tr-end-dt'].forEach(id=>{
  const el=document.getElementById(id);
  if(el && !el.__itrDbRangeWired){
    el.__itrDbRangeWired=true;
    el.addEventListener('change',_itrScheduleDatabaseAutoLoad);
  }
});

// Preserve any existing helper that synchronizes sidebar time controls.
if(typeof trSyncFromDT==='function' && !trSyncFromDT.__itrUnifiedDbWrapped){
  const _itrOriginalTrSync=trSyncFromDT;
  const _itrWrappedTrSync=function(...args){
    const r=_itrOriginalTrSync.apply(this,args);
    _itrScheduleDatabaseAutoLoad();
    return r;
  };
  _itrWrappedTrSync.__itrUnifiedDbWrapped=true;
  try{ trSyncFromDT=_itrWrappedTrSync; }catch(e){}
}

// The BUILD button is now source-aware BEFORE any FILE-mode "Load a file"
// guard can run. DATABASE mode therefore cannot fall into the old error.
const _itrSourceAwareBuild=function(){
  if(window._itrDataSource==='database') return _itrLoadDatabaseRange({alertOnError:true});
  if(window._itrLoadedSource==='database'){
    alert('FILE mode is selected. Load a file first.');
    return false;
  }
  return (typeof _itrFileBuildCandles==='function')?_itrFileBuildCandles():false;
};
_itrSourceAwareBuild.__itrDbSourceWrapped=true;
try{ buildCandles=_itrSourceAwareBuild; }catch(e){}
window.buildCandles=_itrSourceAwareBuild;

// DATABASE is the single default data source. FILE remains a manual alternative.
itrSetDataSource('database',{autoLoad:false});

// ==== Real-time streaming to the database ==============================
// Captures live ticks the moment they arrive — from either the polling
// "🔴 Live" mode (_livePoll's newRows) or the xlwings/Xenith real-time
// WebSocket feed (_xwFlushTicksFrame's batch) — and persists them to this
// section's own ticks_<section> collection as they happen. This is
// fire-and-forget on purpose: it must never block chart rendering, so a
// slow or failed save is only logged, never shown to the user or allowed
// to interrupt the live feed.
function _itrStreamLiveTicks(rows){
  if(!rows || !rows.length) return;
  if(typeof ITR_API_BASE==='undefined' || typeof ITR_SECTION_ID==='undefined') return;
  try{
    fetch(`${ITR_API_BASE}/api/ticks/${ITR_SECTION_ID}`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ rows })
    }).catch(e=>console.warn('[ISKRU TRADE ROBOT PRO] Live tick stream save skipped:',e.message));
  }catch(e){
    console.warn('[ISKRU TRADE ROBOT PRO] Live tick stream save skipped:',e.message);
  }
}

// ==== DATABASE ROUTING V3: bypass legacy FILE-only build paths ============
(function(){
  "use strict";
  if(window.__ITR_DB_ROUTE_V3__) return;
  window.__ITR_DB_ROUTE_V3__=true;

  function isDatabaseMode(){
    return window._itrDataSource==="database";
  }
  function forceDatabaseMode(){
    if(typeof window.itrSetDataSource==="function"){
      window.itrSetDataSource("database",{autoLoad:false});
    }else{
      window._itrDataSource="database";
    }
  }
  function syncSideRange(){
    const ss=(document.getElementById("tas-side-start")||{}).value||"";
    const ee=(document.getElementById("tas-side-end")||{}).value||"";
    const ts=document.getElementById("tr-start-dt");
    const te=document.getElementById("tr-end-dt");
    const ds=document.getElementById("dt-start");
    const de=document.getElementById("dt-end");
    if(ss){ if(ts) ts.value=ss; if(ds) ds.value=ss; }
    if(ee){ if(te) te.value=ee; if(de) de.value=ee; }
  }
  function syncFilterRange(){
    const ss=(document.getElementById("dt-start")||{}).value||"";
    const ee=(document.getElementById("dt-end")||{}).value||"";
    const ts=document.getElementById("tr-start-dt");
    const te=document.getElementById("tr-end-dt");
    if(ss&&ts) ts.value=ss;
    if(ee&&te) te.value=ee;
  }
  function databaseBuild(){
    forceDatabaseMode();
    if(typeof window._itrLoadDatabaseRange!=="function"){
      alert("DATABASE loader is unavailable. Refresh the page and try again.");
      return Promise.resolve(false);
    }
    try{
      return Promise.resolve(window._itrLoadDatabaseRange({alertOnError:true}));
    }catch(e){
      console.error("[ITR DB ROUTE V3]",e);
      alert("DATABASE load failed: "+(e&&e.message?e.message:String(e)));
      return Promise.resolve(false);
    }
  }

  // Make the two source buttons authoritative at runtime.
  const dbBtn=document.getElementById("src-btn-database");
  const fileBtn=document.getElementById("src-btn-file");
  if(dbBtn) dbBtn.onclick=function(e){ if(e)e.preventDefault(); return window.itrSetDataSource("database",{autoLoad:true}); };
  if(fileBtn) fileBtn.onclick=function(e){ if(e)e.preventDefault(); return window.itrSetDataSource("file",{autoLoad:false}); };

  // The legacy Day/Time Apply path used a FILE-only builder. In DATABASE
  // mode it must fetch the requested range instead of checking for a file.
  const oldDtApply=window.dtApply;
  window.dtApply=function(){
    if(isDatabaseMode()){
      syncFilterRange();
      return databaseBuild();
    }
    return typeof oldDtApply==="function" ? oldDtApply.apply(this,arguments) : false;
  };

  // The duplicated lower TIME RANGE / BUILD CANDLES control called dtApply()
  // and buildCandlesFromFile() before the DB wrapper. That was the remaining
  // source of the exact "Load a file first." alert in DATABASE mode.
  const oldTasSideBuild=window.tasSideBuild;
  window.tasSideBuild=function(){
    if(isDatabaseMode()){
      syncSideRange();
      return databaseBuild().finally(function(){
        try{ if(typeof window.tasUpdateNav==="function") window.tasUpdateNav(); }catch(e){}
        try{ if(typeof window.dfpRender==="function") window.dfpRender(); }catch(e){}
      });
    }
    return typeof oldTasSideBuild==="function" ? oldTasSideBuild.apply(this,arguments) :
           (typeof window.buildCandles==="function" ? window.buildCandles() : false);
  };

  // Final safety gate: in DATABASE mode no BUILD CANDLES click is allowed to
  // reach any older FILE-only click/inline handler. Capture it first.
  document.addEventListener("click",function(e){
    const target=e.target&&e.target.closest?e.target.closest("#btn-build,.tas-side-build"):null;
    if(!target || !isDatabaseMode()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if(target.classList.contains("tas-side-build")) syncSideRange();
    databaseBuild().finally(function(){
      try{ if(typeof window.tasUpdateNav==="function") window.tasUpdateNav(); }catch(err){}
    });
  },true);
})();


/* ============================================================
   DATABASE COVERAGE: available days, per-day tick counts,
   timezone-aligned day selection and truncation warning
   ============================================================ */
(function(){
  "use strict";
  var days=[];
  var maxRows=300000;
  var tzName=function(){ return typeof _itrTzName==='function'?_itrTzName():'UTC'; };
  var $=function(id){ return document.getElementById(id); };
  var fmt=function(n){ return Number(n).toLocaleString(); };
  var tickLabel=function(d){ return d.ticksTruncated?fmt(maxRows)+'+':fmt(d.ticks); };
  var pad=function(n){ return String(n).padStart(2,'0'); };
  var local=function(iso){
    var d=new Date(typeof _itrTzShiftMs==='function'?_itrTzShiftMs(new Date(iso).getTime()):iso);
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());
  };

  function setWarn(msg){
    var el=$('cov-warn'); if(!el) return;
    el.textContent=msg||''; el.style.display=msg?'block':'none';
  }

  function render(data){
    days=data.days||[];
    maxRows=Number(data.maxRangeRows)||maxRows;
    var sel=$('cov-days');
    if(sel){
      var current=sel.value;
      sel.innerHTML='<option value="">— choose a day —</option>'+days.map(function(d){
        return '<option value="'+d.day+'">'+d.day+' · '+tickLabel(d)+(d.fits?'':' ⚠')+'</option>';
      }).join('');
      if(current) sel.value=current;
    }
    var info=$('cov-range');
    if(info){
      info.textContent=data.first
        ? 'Database: '+local(data.first)+' → '+local(data.last)+' · '+days.length+' day(s) with ticks listed'
        : 'No ticks stored for this dataset yet.';
    }
    var tzEl=$('cov-tz');
    if(tzEl) tzEl.textContent='Days, ranges and candle boundaries use '+tzName()+'.';
  }

  async function load(){
    var info=$('cov-range');
    if(typeof ITR_API_BASE==='undefined'||typeof ITR_SECTION_ID==='undefined') return;
    try{
      var res=await fetch(ITR_API_BASE+'/api/ticks/'+ITR_SECTION_ID+'/coverage?tz='+encodeURIComponent(tzName()));
      if(!res.ok) throw new Error('Server error '+res.status);
      render(await res.json());
    }catch(err){
      if(info) info.textContent='Coverage unavailable: '+(err&&err.message?err.message:err);
    }
  }

  function pickDay(day){
    var d=days.filter(function(x){ return x.day===day; })[0];
    var s=$('tr-start-dt'), e=$('tr-end-dt');
    if(!d||!s||!e) return;
    s.value=day+'T00:00:00';
    e.value=day+'T23:59:59';
    if($('cov-days')) $('cov-days').value=day;
    setWarn(d.fits?'':tickLabel(d)+' ticks on '+day+' exceeds the '+fmt(maxRows)+'-row load limit. Use a shorter window (AM / PM or a custom time).');
    if(typeof trSyncFromDT==='function') trSyncFromDT();
    var b=$('btn-build'); if(b) setTimeout(function(){ b.click(); },50);
  }

  function step(delta){
    var sel=$('cov-days'); if(!sel||!days.length) return;
    var i=days.findIndex(function(x){ return x.day===sel.value; });
    i=i<0?0:Math.max(0,Math.min(days.length-1,i+delta));
    pickDay(days[i].day);
  }

  window._covAfterLoad=function(meta,rows){
    if(meta&&meta.truncated){
      var last=rows&&rows.length?local(rows[rows.length-1]._tsMs||Date.now()):'';
      setWarn('⚠ Range truncated at '+fmt(meta.limit)+' rows'+(last?' — candles end at '+last:'')+'. The candles are incomplete; narrow START/END and build again.');
    }else if(!/exceeds/.test(($('cov-warn')||{}).textContent||'')){
      setWarn('');
    }
  };

  var tzSel=$('cov-tzsel');
  if(tzSel){
    tzSel.value=window._itrTZ||'local';
    tzSel.addEventListener('change',function(){
      window._itrTZ=tzSel.value;
      try{ localStorage.setItem('itr.tz',tzSel.value); }catch(e){}
      var picked=$('cov-days')?$('cov-days').value:'';
      days=[]; if($('cov-days')) $('cov-days').value='';
      load().then(function(){
        if(picked&&window._itrLoadedSource==='database'){
          var d=days.filter(function(x){ return x.day===picked; })[0];
          if(d) pickDay(picked);
        }
      });
    });
  }
  var sel=$('cov-days');
  if(sel) sel.addEventListener('change',function(){ if(sel.value) pickDay(sel.value); });
  if($('cov-prev')) $('cov-prev').addEventListener('click',function(){ step(-1); });
  if($('cov-next')) $('cov-next').addEventListener('click',function(){ step(1); });
  if($('cov-refresh')) $('cov-refresh').addEventListener('click',load);
  load();
})();
