(function(){
  'use strict';
  if(window.__ORDERFLOW_DB_ADAPTER_V7__) return;
  window.__ORDERFLOW_DB_ADAPTER_V7__=true;

  const path=String(location.pathname||'').toLowerCase();
  const section=path.includes('/taq-pro/')?'taq-pro':path.includes('/tas-regime/')?'tas-regime':'gcv';

  function apiBase(){
    const override=String(window.ITR_API_BASE_OVERRIDE||'').trim().replace(/\/+$/,'');
    if(override) return override;
    if(location.protocol==='file:') return 'http://127.0.0.1:4001';
    if(location.protocol==='http:' && (location.hostname==='localhost'||location.hostname==='127.0.0.1')){
      return `http://${location.hostname}:4001`;
    }
    return '';
  }
  const base=apiBase();

  async function post(kind,payload){
    if(!payload) return null;
    try{
      const res=await fetch(`${base}/api/orderflow/${kind}/${section}`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({payload})
      });
      if(!res.ok){
        const body=await res.json().catch(()=>({}));
        throw new Error(body.detail||body.error||`HTTP ${res.status}`);
      }
      return await res.json().catch(()=>({ok:true}));
    }catch(err){
      console.warn(`[OrderFlow DB] ${kind} save skipped:`,err&&err.message?err.message:err);
      return null;
    }
  }

  async function saveTPResult(result){ return post('tp',result); }
  async function saveRegimeResult(result){ return post('regime',result); }
  async function saveAgentResult(result){ return post('agent',result); }

  window.OrderFlowDatabase=Object.assign(window.OrderFlowDatabase||{}, {
    version:'7.0-merged',section,apiBase:base,saveTPResult,saveRegimeResult,saveAgentResult
  });
  window.__ORDERFLOW_DB_ADAPTER__=window.OrderFlowDatabase;

  // Persist one Regime/Markov snapshot per completed candle. The route is
  // idempotent, so repeated renders/reconnects do not create duplicate records.
  let lastRegimeKey='';
  setInterval(function(){
    try{
      if(!window.OrderFlowRegimeExport || typeof window.OrderFlowRegimeExport.computeSeries!=='function') return;
      let bars=[];
      if(window.R&&Array.isArray(window.R.bars)&&window.R.bars.length) bars=window.R.bars.filter(b=>b&&!b.isOpen);
      if(!bars.length && Array.isArray(window._closedBars)) bars=window._closedBars.slice();
      if(bars.length<21) return;
      const series=window.OrderFlowRegimeExport.computeSeries(bars);
      const result=series[series.length-1];
      const bar=bars[bars.length-1]||{};
      if(!result) return;
      const key=[result.method,bar.date||'',bar.time||bar.timestamp||'',bar.close||'',result.regime,result.forecast].join('|');
      if(!key || key===lastRegimeKey) return;
      lastRegimeKey=key;
      saveRegimeResult({
        engineVersion:window.OrderFlowRegimeExport.VERSION||'Markov20',
        source:section,
        timestamp:bar.timestamp||((bar.date&&bar.time)?`${bar.date} ${bar.time}`:(bar.time||'')),
        close:bar.close,
        result:result,
        exportRow:typeof window.OrderFlowRegimeExport.row==='function'?window.OrderFlowRegimeExport.row(result):null
      });
    }catch(err){ /* dashboard rendering must never be blocked by persistence */ }
  },2000);
})();
