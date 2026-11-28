'use strict';

// Causal Smart Money Concepts diagnostics. Only closed candles should be passed.
function analyzeSmartMoney(rows, timeframe='UNKNOWN') {
  if (!Array.isArray(rows) || rows.length < 12) {
    return {timeframe,status:'INSUFFICIENT_DATA',candleCount:Array.isArray(rows)?rows.length:0};
  }
  const candles=rows.slice(0,-1).slice(-120).map(c=>({
    time:Number(c.time),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)
  }));
  if(candles.length<10 || candles.some(c=>!Object.values(c).every(Number.isFinite) || c.high<c.low))
    return {timeframe,status:'INVALID_DATA',candleCount:candles.length};

  const tr=candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));
  const atr=tr.slice(-14).reduce((a,b)=>a+b,0)/Math.max(1,tr.slice(-14).length);
  const tolerance=Math.max(atr*0.12,Math.abs(candles.at(-1).close)*0.00015);
  const swings=[];
  // A pivot is only available after two right-hand candles have closed.
  for(let i=2;i<candles.length-2;i++){
    const c=candles[i],left=candles.slice(i-2,i),right=candles.slice(i+1,i+3);
    if(left.every(x=>c.high>x.high)&&right.every(x=>c.high>x.high)) swings.push({kind:'HIGH',price:c.high,index:i,confirmedAt:i+2});
    if(left.every(x=>c.low<x.low)&&right.every(x=>c.low<x.low)) swings.push({kind:'LOW',price:c.low,index:i,confirmedAt:i+2});
  }
  const latest=candles.at(-1), prior=candles.at(-2);
  const lastHigh=[...swings].reverse().find(s=>s.kind==='HIGH'&&s.confirmedAt<candles.length-1);
  const lastLow=[...swings].reverse().find(s=>s.kind==='LOW'&&s.confirmedAt<candles.length-1);

  const liquidity=[];
  for(const kind of ['HIGH','LOW']){
    const pool=swings.filter(s=>s.kind===kind&&s.confirmedAt<candles.length-1);
    for(let i=0;i<pool.length;i++){
      const cluster=pool.filter(s=>Math.abs(s.price-pool[i].price)<=tolerance);
      if(cluster.length>=2&&!liquidity.some(x=>x.kind===kind&&Math.abs(x.level-pool[i].price)<=tolerance)){
        liquidity.push({kind,level:Number((cluster.reduce((a,s)=>a+s.price,0)/cluster.length).toFixed(8)),touches:cluster.length});
      }
    }
  }
  const sweptHigh=liquidity.find(x=>x.kind==='HIGH'&&prior.high<=x.level+tolerance&&latest.high>x.level+tolerance&&latest.close<x.level);
  const sweptLow=liquidity.find(x=>x.kind==='LOW'&&prior.low>=x.level-tolerance&&latest.low<x.level-tolerance&&latest.close>x.level);
  const fvg=[];
  for(let i=Math.max(2,candles.length-25);i<candles.length;i++){
    const a=candles[i-2],b=candles[i-1],c=candles[i];
    if(a.high<c.low) fvg.push({type:'BULLISH',low:a.high,high:c.low,formedAt:c.time,mitigated:latest.low<=c.low});
    if(a.low>c.high) fvg.push({type:'BEARISH',low:c.high,high:a.low,formedAt:c.time,mitigated:latest.high>=c.high});
  }
  const zones=[];
  for(const kind of ['HIGH','LOW']){
    const pool=swings.filter(s=>s.kind===kind&&s.confirmedAt<candles.length-1);
    const grouped=[];
    for(const s of pool){
      let g=grouped.find(x=>Math.abs(x.level-s.price)<=tolerance);
      if(!g){g={kind,level:s.price,touches:0,lastIndex:-99};grouped.push(g);}
      if(s.index-g.lastIndex>=3){g.touches++;g.lastIndex=s.index;}
    }
    for(const g of grouped.filter(x=>x.touches>=2)){
      const latestClose=latest.close;
      const broken=g.kind==='HIGH'?candles.some((c,i)=>i>0&&c.close>g.level+tolerance):candles.some((c,i)=>i>0&&c.close<g.level-tolerance);
      const retested=g.kind==='HIGH'
        ? candles.slice(-8).some(c=>c.low<=g.level+tolerance&&c.close>g.level)
        : candles.slice(-8).some(c=>c.high>=g.level-tolerance&&c.close<g.level);
      const role=broken&&retested?(g.kind==='HIGH'?'RBS':'SBR'):'S/R';
      zones.push({kind:g.kind,level:Number(g.level.toFixed(8)),touches:g.touches,role,twiceTested:g.touches>=2});
    }
  }
  const rangeHigh=lastHigh?.price??Math.max(...candles.slice(-20).map(c=>c.high));
  const rangeLow=lastLow?.price??Math.min(...candles.slice(-20).map(c=>c.low));
  const equilibrium=(rangeHigh+rangeLow)/2;
  const structure=lastHigh&&lastLow
    ? latest.close>lastHigh.price?'BULLISH_BREAK':latest.close<lastLow.price?'BEARISH_BREAK':'RANGE'
    : 'UNCONFIRMED';
  return {
    timeframe,status:'OK',candleCount:candles.length,atr:Number(atr.toFixed(8)),
    structure,latestClose:latest.close,
    swings:{lastHigh:lastHigh?.price??null,lastLow:lastLow?.price??null},
    liquidityPools:liquidity.slice(-8),
    liquiditySweep:sweptHigh?{type:'BUY_SIDE_SWEEP',level:sweptHigh.level}:sweptLow?{type:'SELL_SIDE_SWEEP',level:sweptLow.level}:null,
    fvgs:fvg.slice(-6),supportResistance:zones.slice(-8),
    premiumDiscount:{rangeHigh,rangeLow,equilibrium,zone:latest.close>equilibrium?'PREMIUM':latest.close<equilibrium?'DISCOUNT':'EQUILIBRIUM'}
  };
}

module.exports={analyzeSmartMoney};
