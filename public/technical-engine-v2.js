(function(){
'use strict';
const FRAMES=['M5','M15','M30','M45','H1','H4','D1'];
const DURATION={M5:300,M15:900,M30:1800,M45:2700,H1:3600,H4:14400,D1:86400};
const $=id=>document.getElementById(id);
const fmt=n=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:5}):'—';
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function symbolNow(){const p=$('pair')?.value;if(p)return p;return document.querySelector('#marketPage [data-asset].active')?.dataset.asset||'XAU/USD';}
function normalize(raw,tf){
 if(!Array.isArray(raw))return [];
 const now=Date.now()/1000,seconds=DURATION[tf];
 return raw.map(c=>({time:Math.floor(Date.parse(c.datetime)/1000),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume)||0}))
 .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.high>=Math.max(c.open,c.close,c.low)&&c.low<=Math.min(c.open,c.close,c.high))
 .sort((a,b)=>a.time-b.time)
 .filter((c,i,a)=>i===0||c.time>a[i-1].time)
 .filter(c=>c.time+seconds<=now+1).slice(-240);
}
async function load(tf,symbol){
 const url='/api?interval='+encodeURIComponent(tf)+'&symbol='+encodeURIComponent(symbol);
 const response=await fetch(url,{cache:'no-store'});
 let payload;try{payload=await response.json()}catch(_){throw new Error('Respons API bukan JSON ('+response.status+')')}
 if(!response.ok)throw new Error('HTTP '+response.status);
 if(payload.status!=='success'||!Array.isArray(payload.candles))throw new Error(payload.message||payload.error||'Provider tidak mengirim candle');
 const candles=normalize(payload.candles,tf);
 if(candles.length<12)throw new Error('Candle valid/tertutup hanya '+candles.length);
 return {tf,symbol,candles,payload};
}
function analyze(candles,tf){
 const n=candles.length,last=candles[n-1],prev=candles[n-2];
 const tr=candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));
 const tail=tr.slice(-14),atr=tail.reduce((a,b)=>a+b,0)/Math.max(1,tail.length),tol=Math.max(atr*.12,last.close*.00015);
 const highs=[],lows=[];
 for(let i=2;i<n-2;i++){
  const c=candles[i],l=candles.slice(i-2,i),r=candles.slice(i+1,i+3);
  if(l.every(x=>c.high>x.high)&&r.every(x=>c.high>x.high))highs.push({p:c.high,i,confirmed:i+2});
  if(l.every(x=>c.low<x.low)&&r.every(x=>c.low<x.low))lows.push({p:c.low,i,confirmed:i+2});
 }
 const confirmedH=highs.filter(x=>x.confirmed<n-1),confirmedL=lows.filter(x=>x.confirmed<n-1);
 const h=confirmedH.slice(-2),l=confirmedL.slice(-2);
 let trend='RANGE';
 if(h.length===2&&l.length===2){if(h[1].p>h[0].p&&l[1].p>l[0].p)trend='BULLISH';else if(h[1].p<h[0].p&&l[1].p<l[0].p)trend='BEARISH';}
 const levels=[];
 for(const [kind,list] of [['RESISTANCE',confirmedH],['SUPPORT',confirmedL]]){
  const groups=[];
  for(const p of list){let g=groups.find(x=>Math.abs(x.sum/x.count-p.p)<=tol);if(!g){g={sum:0,count:0,last:-99};groups.push(g)}if(p.i-g.last>=3){g.sum+=p.p;g.count++;g.last=p.i}}
  groups.filter(g=>g.count>=2).forEach(g=>levels.push({kind,price:g.sum/g.count,touches:g.count}));
 }
 const support=levels.filter(x=>x.kind==='SUPPORT'&&x.price<last.close).sort((a,b)=>b.price-a.price)[0]||null;
 const resistance=levels.filter(x=>x.kind==='RESISTANCE'&&x.price>last.close).sort((a,b)=>a.price-b.price)[0]||null;
 const recentHigh=confirmedH.at(-1),recentLow=confirmedL.at(-1);
 let sweep='NONE';
 if(recentHigh&&last.high>recentHigh.p+tol&&last.close<recentHigh.p)sweep='BUY-SIDE SWEEP';
 if(recentLow&&last.low<recentLow.p-tol&&last.close>recentLow.p)sweep='SELL-SIDE SWEEP';
 const fvg=[];
 for(let i=Math.max(2,n-30);i<n;i++){
  const a=candles[i-2],c=candles[i];
  if(a.high<c.low)fvg.push({type:'BULLISH',low:a.high,high:c.low,time:c.time,mitigated:candles.slice(i+1).some(x=>x.low<=c.low)});
  if(a.low>c.high)fvg.push({type:'BEARISH',low:c.high,high:a.low,time:c.time,mitigated:candles.slice(i+1).some(x=>x.high>=c.high)});
 }
 let role='NONE';
 for(const lev of levels.slice().reverse()){
  const breakAt=candles.findIndex((c,i)=>i>0&&i>=Math.max(0,n-30)&&(lev.kind==='RESISTANCE'?candles[i-1].close<=lev.price&&c.close>lev.price:candles[i-1].close>=lev.price&&c.close<lev.price));
  if(breakAt>=0&&candles.slice(breakAt+1).some(c=>lev.kind==='RESISTANCE'?c.low<=lev.price+tol&&c.close>lev.price:c.high>=lev.price-tol&&c.close<lev.price)){role=lev.kind==='RESISTANCE'?'RBS':'SBR';break}
 }
 const hi=recentHigh?.p??Math.max(...candles.slice(-20).map(c=>c.high)),lo=recentLow?.p??Math.min(...candles.slice(-20).map(c=>c.low)),eq=(hi+lo)/2;
 const structure=recentHigh&&last.close>recentHigh.p?'BOS BULLISH':recentLow&&last.close<recentLow.p?'BOS BEARISH':'STRUCTURE';
 return {tf,count:n,last,trend,structure,atr,support,resistance,levels,sweep,fvg:fvg.filter(x=>!x.mitigated).slice(-3),role,zone:last.close>eq?'PREMIUM':last.close<eq?'DISCOUNT':'EQUILIBRIUM',hi,lo};
}
function render(results,symbol,errors){
 const root=$('newTechnicalDashboard');if(!root)return;
 const good=results.filter(x=>x.analysis),bull=good.filter(x=>x.analysis.trend==='BULLISH').length,bear=good.filter(x=>x.analysis.trend==='BEARISH').length;
 const direction=good.length<4?'DATA TERBATAS':bull>=5?'BULLISH':bear>=5?'BEARISH':bull+bear===0?'RANGE':'MIXED';
 const top=good.map(x=>x.analysis).filter(Boolean);
 const sr=top.find(x=>x.tf==='M15')||top.find(x=>x.tf==='H1')||top[0];
 $('newTechnicalStatus').textContent=good.length+'/7 TIMEFRAME AKTIF · '+symbol;
 $('newTechnicalHero').innerHTML='<div class="nt-hero"><div><small>BIAS MULTI-TIMEFRAME</small><strong>'+direction+'</strong><span>'+good.length+' timeframe valid dari 7 · bukan sinyal entry otomatis</span></div><b>'+bull+' ▲ / '+bear+' ▼</b></div>';
 $('newTechnicalCards').innerHTML=FRAMES.map(tf=>{const x=results.find(v=>v.tf===tf),a=x?.analysis;return '<article class="nt-tf"><header><b>'+tf+'</b><span class="'+(a?'ok':'bad')+'">'+(a?'AKTIF':'GAGAL')+'</span></header>'+(a?'<strong class="'+a.trend.toLowerCase()+'">'+a.trend+'</strong><small>'+a.count+' candle tertutup</small><small>Close '+fmt(a.last.close)+'</small>':'<strong class="wait">WAIT</strong><small>'+escapeHtml(x?.error||'Data tidak tersedia')+'</small>')+'</article>'}).join('');
 $('newTechnicalLevels').innerHTML=sr?'<div class="nt-level"><small>SUPPORT TERDEKAT ('+sr.tf+')</small><b>'+(sr.support?fmt(sr.support.price):'Belum ada pivot berulang')+'</b><span>'+(sr.support?sr.support.touches+' sentuhan':'')+'</span></div><div class="nt-level"><small>RESISTANCE TERDEKAT ('+sr.tf+')</small><b>'+(sr.resistance?fmt(sr.resistance.price):'Belum ada pivot berulang')+'</b><span>'+(sr.resistance?sr.resistance.touches+' sentuhan':'')+'</span></div>':'<p>Menunggu candle valid untuk menghitung level.</p>';
 $('newTechnicalSMC').innerHTML=top.map(a=>'<div class="nt-row"><b>'+a.tf+'</b><span>Sweep: '+a.sweep+'</span><span>FVG aktif: '+a.fvg.length+'</span><span>Retest: '+a.role+'</span><span>Zona: '+a.zone+'</span></div>').join('')||'<p>Belum ada hasil SMC.</p>';
 $('newTechnicalTable').innerHTML=results.map(x=>{const a=x.analysis;return '<tr><td>'+x.tf+'</td><td>'+(a?a.trend:'WAIT')+'</td><td>'+(a?fmt(a.last.close):'—')+'</td><td>'+(a&&a.support?fmt(a.support.price):'—')+'</td><td>'+(a&&a.resistance?fmt(a.resistance.price):'—')+'</td><td>'+(a?a.structure:escapeHtml(x.error||'Data gagal'))+'</td></tr>'}).join('');
 $('newTechnicalErrors').textContent=errors.length?'Catatan data: '+errors.join(' · '):'Semua timeframe berhasil dimuat. Level hanya ditampilkan jika ada pivot terkonfirmasi berulang.';
}
let running=false,lastSymbol='';
async function run(reason){
 if(running)return;running=true;
 const symbol=symbolNow(),status=$('newTechnicalStatus');
 if(status)status.textContent='MENGAMBIL CANDLE PROVIDER…';
 try{
  const settled=await Promise.all(FRAMES.map(async tf=>{try{const data=await load(tf,symbol);return {...data,analysis:analyze(data.candles,tf)}}catch(e){return {tf,error:e.message}}}));
  if(symbolNow()!==symbol)return;
  const errors=settled.filter(x=>x.error).map(x=>x.tf+': '+x.error);
  render(settled,symbol,errors);lastSymbol=symbol;
  console.info('SIGNATURE NEW TECHNICAL ENGINE',reason,settled.map(x=>({tf:x.tf,count:x.candles?.length,error:x.error})));
 }catch(e){if(status)status.textContent='GAGAL: '+e.message;console.error(e)}
 finally{running=false}
}
function init(){
 const root=$('newTechnicalDashboard');if(!root)return;
 $('newTechnicalRefresh')?.addEventListener('click',()=>run('manual-refresh'));
 document.querySelectorAll('#marketPage [data-asset]').forEach(b=>b.addEventListener('click',()=>setTimeout(()=>run('asset-change'),150)));
 const observer=new MutationObserver(()=>{if($('marketPage')?.classList.contains('active')&&$('marketPage [data-signal-panel="analysis"]')?.classList.contains('active'))run('analysis-visible')});
 const page=$('marketPage');if(page)observer.observe(page,{attributes:true,subtree:true,attributeFilter:['class']});
 setTimeout(()=>run('engine-init'),250);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();