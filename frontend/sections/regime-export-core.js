(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.OrderFlowRegimeExport=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const STATES=['BULL','SIDE','BEAR'],IDX={BULL:0,SIDE:1,BEAR:2};
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d, clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const std=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(mean(a.map(v=>(v-m)*(v-m))));};
function md(closes,period){const out=[];for(let i=0;i<closes.length;i++){const p=closes[i];if(!i){out.push(p);continue;}const prev=out[i-1]||p,ratio=prev?p/prev:1,den=period*Math.pow(Math.max(.25,Math.min(4,ratio)),4);out.push(prev+(p-prev)/(den||period));}return out;}
function normRows(m){return m.map(r=>{const s=r.reduce((a,b)=>a+b,0)||1;return r.map(v=>v/s);});}
function stationary(m){let v=[1/3,1/3,1/3];for(let k=0;k<200;k++){const nv=[0,0,0];for(let i=0;i<3;i++)for(let j=0;j<3;j++)nv[j]+=v[i]*m[i][j];v=nv;}return v;}
function matMul(a,b){const r=[[0,0,0],[0,0,0],[0,0,0]];for(let i=0;i<3;i++)for(let j=0;j<3;j++)for(let k=0;k<3;k++)r[i][j]+=a[i][k]*b[k][j];return r;}
function matPow(m,n){let r=[[1,0,0],[0,1,0],[0,0,1]],b=m;while(n>0){if(n&1)r=matMul(r,b);b=matMul(b,b);n>>=1;}return r;}
function computeSeries(bars,options={}){
 const b=(bars||[]).filter(x=>x&&Number.isFinite(Number(x.close))),cl=b.map(x=>num(x.close)),m21=md(cl,21),m60=md(cl,60),out=[];
 const look=20,block=1,volwin=20,horizon=clamp(num(options.forecastLevels,50),1,1000),threshold=.05;
 const rets=cl.map((v,i)=>i?(v-cl[i-1])/(cl[i-1]||v||1):0),features=[];
 for(let i=0;i<b.length;i++){
  // Twenty changes require 21 closes. Therefore the first non-blank result
  // belongs to candle index 20 (the 21st spreadsheet data row).
  if(i<look){features.push(null);continue;}
  const wr=rets.slice(i-look+1,i+1).reduce((s,v)=>s+v,0),windowRets=rets.slice(i-look+1,i+1),vol=std(windowRets)||mean(windowRets.map(Math.abs))||0;
  const fast=mean(cl.slice(i-6,i+1)),slow=mean(cl.slice(i-look+1,i+1)),trend=(fast-slow)/(cl[i]||1),range=Math.max(Math.abs(num(b[i].high)-num(b[i].low)),1e-9),body=(cl[i]-num(b[i].open,cl[i]))/range,loc=((cl[i]-num(b[i].low,cl[i]))/range)-.5,volume=num(b[i].totalVol,num(b[i].volume,num(b[i].vol))),delta=num(b[i].delta,num(b[i].totalDelta)),of=volume?delta/volume:0;
  features.push({score:wr,retScore:clamp(wr/threshold,-1,1),trendScore:clamp(trend/threshold,-1,1),bodyScore:clamp(body,-1,1),locScore:clamp(loc*2,-1,1),ofScore:clamp(of,-1,1),volatility:vol,threshold,state:wr>=threshold?'BULL':wr<=-threshold?'BEAR':'SIDE'});
 }
 const counts=[[1,1,1],[1,1,1],[1,1,1]];let previous=null;
 for(let i=0;i<b.length;i++){
  const f=features[i];if(!f){out.push(null);continue;}
  if(previous)counts[IDX[previous]][IDX[f.state]]++;previous=f.state;
  const M=normRows(counts),stat=stationary(M),fc=matPow(M,horizon)[IDX[f.state]],best=fc.indexOf(Math.max(...fc)),forecast=STATES[best],signal=fc[0]-fc[2],confidence=Math.max(...fc)-Math.min(...fc);
  const slope21=i?m21[i]-m21[i-1]:0,slope60=i?m60[i]-m60[i-1]:0,mdCode=m21[i]>m60[i]&&slope21>0&&slope60>=0?1:m21[i]<m60[i]&&slope21<0&&slope60<=0?-1:0,dirCode=forecast==='BULL'&&f.score>0?1:forecast==='BEAR'&&f.score<0?-1:signal>0?1:signal<0?-1:0;
  out.push({method:'MARKOV_3_STATE_20_CANDLE',regime:f.state,stateCode:f.state==='BULL'?1:f.state==='BEAR'?-1:0,score:f.score,confidence,forecast,forecastCode:forecast==='BULL'?1:forecast==='BEAR'?-1:0,probabilities:fc,features:f,stationary:stat,matrix:M,suggestedDirection:dirCode>0?(confidence>.15?'BUY':'BUY WATCH'):dirCode<0?(confidence>.15?'SELL':'SELL WATCH'):'NEUTRAL',suggestedDirectionCode:dirCode,lookback:look,blockLevels:block,volatilityWindow:volwin,forecastLevels:horizon,threshold,mcginley21:m21[i],mcginley60:m60[i],mcginley21Slope:slope21,mcginley60Slope:slope60,mcginleyAgreement:mdCode});
 }
 return out;
}
const HEADERS=['Regime_Method','Regime_State','Regime_State_Code','Regime_Score','Regime_Confidence_Decimal','Forecast_State','Forecast_State_Code','Prob_Bull_Decimal','Prob_Side_Decimal','Prob_Bear_Decimal','Feature_Return','Feature_Trend','Feature_Body','Feature_Close_Location','Feature_OrderFlow','Feature_Volatility','Stationary_Bull_Decimal','Stationary_Side_Decimal','Stationary_Bear_Decimal','Trans_Bull_Bull_Decimal','Trans_Bull_Side_Decimal','Trans_Bull_Bear_Decimal','Trans_Side_Bull_Decimal','Trans_Side_Side_Decimal','Trans_Side_Bear_Decimal','Trans_Bear_Bull_Decimal','Trans_Bear_Side_Decimal','Trans_Bear_Bear_Decimal','Suggested_Direction','Suggested_Direction_Code','Auto_Lookback','Block_Levels','Volatility_Window','Forecast_Levels','Regime_Threshold','McGinley_21','McGinley_60','McGinley_21_Slope','McGinley_60_Slope','McGinley_Agreement'];
function row(r){if(!r)return HEADERS.map(()=>null);const f=r.features||{},m=r.matrix,round=v=>typeof v==='number'&&Number.isFinite(v)?Number(v.toFixed(4)):v;return [r.method,r.regime,r.stateCode,r.score,r.confidence,r.forecast,r.forecastCode,...r.probabilities,f.retScore,f.trendScore,f.bodyScore,f.locScore,f.ofScore,f.volatility,...r.stationary,...m[0],...m[1],...m[2],r.suggestedDirection,r.suggestedDirectionCode,r.lookback,r.blockLevels,r.volatilityWindow,r.forecastLevels,r.threshold,r.mcginley21,r.mcginley60,r.mcginley21Slope,r.mcginley60Slope,r.mcginleyAgreement].map(round);}
return {VERSION:'2.0.0-20-candle',HEADERS,computeSeries,row};
});
