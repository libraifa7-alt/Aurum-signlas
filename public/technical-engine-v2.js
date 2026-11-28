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
 const good=results.filter(x=>x.analysis),bull=good.filter(x=>x.analysis.trend==='BULLISH').length,bear=good.filter(x=>x.analysis.trend==='BEARISH').length,range=good.length-bull-bear;
 const direction=good.length<4?'DATA TERBATAS':bull>bear&&bull>=3?'BULLISH':bear>bull&&bear>=3?'BEARISH':bull+bear===0?'RANGE':'MIXED';
 const all=good.map(x=>x.analysis),primary=all.find(x=>x.tf==='M15')||all.find(x=>x.tf==='H1')||all[0],priceSource=all.find(x=>x.tf==='M5')||primary;
 const price=priceSource?.last.close,fmtP=n=>Number.isFinite(n)?fmt(n):'—';
 const strength=x=>{if(!x||x.trend==='RANGE')return 50;const prev=x.last.close;const delta=x.last.close-(x._prevClose??x.last.close);return Math.max(51,Math.min(95,Math.round(65+Math.abs(delta)/(x.atr||1)*10)))};
 const cards=FRAMES.map(tf=>{const x=results.find(v=>v.tf===tf),a=x?.analysis,up=a?.trend==='BULLISH',down=a?.trend==='BEARISH',color=up?'#399fe8':down?'#ef5b67':'#aeb5bf',label=up?'BUY':down?'SELL':'NEUTRAL';return '<article class="tx-tf '+(up?'bull':down?'bear':'neutral')+'"><div class="tx-tf-head"><b>'+tf+'</b><span>'+(up?'▲':down?'▼':'•')+'</span></div><small>'+(a?a.trend:'NO DATA')+'</small><div class="tx-ring" style="--ring:'+color+'"><b>'+(a?strength(a)+'%':'—')+'</b><small>'+(a?label:'WAIT')+'</small></div><em>'+(a?label:'WAIT')+'</em></article>'}).join('');
 const bearishBlocks=good.length?Math.round(bear/good.length*28):0,neutralBlocks=good.length?Math.round(range/good.length*28):28;
 const segments=Array.from({length:28},(_,i)=>'<i class="'+(i<bearishBlocks?'bear':i<bearishBlocks+neutralBlocks?'neutral':'bull')+'"></i>').join('');
 const rows=results.map(x=>{const a=x.analysis;return '<div class="tx-row"><b>'+x.tf+'</b><span class="'+(a?.trend==='BULLISH'?'bull-text':a?.trend==='BEARISH'?'bear-text':'')+'">'+(a?a.trend:'WAIT')+'</span><span>'+(a?fmtP(a.last.volume):'—')+'</span><span>'+fmtP(a?.support?.price)+'</span><span>'+fmtP(a?.resistance?.price)+'</span></div>'}).join('');
 const level=primary||all[0],support=level?.support?.price,resistance=level?.resistance?.price,current=level?.last.close;
 let pos=50;if(Number.isFinite(support)&&Number.isFinite(resistance)&&resistance>support)pos=Math.max(0,Math.min(100,(current-support)/(resistance-support)*100));
 const keyType=level?(level.trend==='BEARISH'?'RESISTANCE · SELL ZONE':level.trend==='BULLISH'?'SUPPORT · BUY ZONE':'PIVOT RANGE'):'LEVEL DATA UNAVAILABLE';
 const daily=results.find(x=>x.tf==='D1')?.candles||[],d0=daily.at(-1),d1=daily.at(-2);
 const rangeHtml=d0?'<div class="tx-range-row"><span>Latest closed D1 candle</span><b><i>H '+fmtP(d0.high)+'</i><em>L '+fmtP(d0.low)+'</em></b></div>':'<div class="tx-range-row">Daily range unavailable</div>';
 const prevHtml=d1?'<div class="tx-range-row"><span>Previous closed D1 candle</span><b><i>H '+fmtP(d1.high)+'</i><em>L '+fmtP(d1.low)+'</em></b></div>':'';
 const smc=all.map(a=>'<div class="tx-smc-row"><b>'+a.tf+'</b><span>SWEEP: '+a.sweep+'</span><span>FVG: '+a.fvg.length+'</span><span>RETEST: '+a.role+'</span><span>'+a.zone+'</span></div>').join('');
 root.innerHTML='<div class="tx-dashboard">'+
 '<section class="tx-hero"><div class="tx-kicker"><span>'+escapeHtml(symbol)+' · CLOSED CANDLE ANALYSIS</span><b>● '+good.length+'/7 ACTIVE</b></div>'+
 '<div class="tx-hero-main"><div><strong>'+direction+'</strong><small>'+bull+' BULLISH · '+bear+' BEARISH · '+range+' RANGE</small></div><b>'+fmtP(price)+'</b></div>'+
 '<div class="tx-meter-title"><span>TREND METER</span><b>'+(bull-bear>0?'+':'')+(bull-bear)+' / 7</b></div><div class="tx-meter">'+segments+'</div>'+
 '<div class="tx-meter-legend"><span>BEARISH '+(good.length?Math.round(bear/good.length*100):0)+'%</span><span>MIXED '+(good.length?Math.round(range/good.length*100):0)+'%</span><span>BULLISH '+(good.length?Math.round(bull/good.length*100):0)+'%</span></div>'+
 '<div class="tx-share"><span>Bearish TF <b>'+bear+'</b></span><i><em style="width:'+(good.length?bear/good.length*100:0)+'%"></em><em style="width:'+(good.length?bull/good.length*100:0)+'%"></em></i><span>Bullish TF <b>'+bull+'</b></span></div></section>'+
 '<div class="tx-cards">'+cards+'</div><div class="tx-table"><div class="tx-row tx-head"><b>TF</b><b>TREND</b><b>VOLUME</b><b>SUPPORT</b><b>RESIST.</b></div>'+rows+'</div>'+
 '<section class="tx-key"><div class="tx-section-title"><b>● AT A KEY LEVEL</b><small>'+(level?.tf||'NO TF')+' · '+(level?'PIVOT':'WAITING')+'</small></div><div class="tx-key-card"><div class="tx-key-head"><strong>'+(level?.tf||'—')+'</strong><span>'+keyType+'</span><b>'+fmtP(support)+' — '+fmtP(resistance)+'</b></div><div class="tx-key-track"><i style="left:'+pos+'%"></i></div><div class="tx-key-foot"><span>'+fmtP(support)+'</span><span>PRICE · '+fmtP(current)+'</span><span>'+fmtP(resistance)+'</span></div><small>Level hanya ditampilkan jika pivot berulang terkonfirmasi.</small></div></section>'+
 '<section class="tx-range"><div class="tx-section-title"><b>DAILY CANDLE RANGE</b><small>D1 · CLOSED CANDLES</small></div>'+rangeHtml+prevHtml+'</section>'+
 '<section class="tx-smc"><div class="tx-section-title"><b>SMART MONEY · ICT</b><small>SWEEP / FVG / RBS / SBR</small></div>'+(smc||'Belum ada data SMC.')+'</section>'+
 '<p class="tx-note">'+(errors.length?'Data belum lengkap: '+escapeHtml(errors.join(' · ')):'Seluruh timeframe berhasil dianalisis.')+' · Persentase kartu adalah estimasi kekuatan momentum, bukan probabilitas kemenangan. Volume ditampilkan sebagai volume candle, bukan dominasi buyer/seller.</p></div>';
 $('newTechnicalStatus').textContent=good.length+'/7 TIMEFRAME AKTIF · '+symbol;
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