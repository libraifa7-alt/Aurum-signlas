'use strict';

// Server-side AURUM strategy port. Keep rules aligned with public/index.html.
function getStructureSignal(data, timeframe = 'UNKNOWN') {
  if (!Array.isArray(data) || data.length < 30) {
    return 'UNKNOWN';
  }

  // Abaikan candle terakhir yang mungkin belum selesai
  const candles = data.slice(0, -1).slice(-80);

  if (candles.length < 30) {
    return 'UNKNOWN';
  }

  const leftBars = 2;
  const rightBars = 2;

  const swingHighs = [];
  const swingLows = [];

  // DETEKSI SWING HIGH DAN SWING LOW
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const current = candles[i];

    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= leftBars; j++) {
      if (current.high <= candles[i - j].high) {
        isSwingHigh = false;
      }

      if (current.low >= candles[i - j].low) {
        isSwingLow = false;
      }
    }

    for (let j = 1; j <= rightBars; j++) {
      if (current.high <= candles[i + j].high) {
        isSwingHigh = false;
      }

      if (current.low >= candles[i + j].low) {
        isSwingLow = false;
      }
    }

    if (isSwingHigh) {
      swingHighs.push({
        index: i,
        confirmIndex: i + rightBars,
        price: current.high
      });
    }

    if (isSwingLow) {
      swingLows.push({
        index: i,
        confirmIndex: i + rightBars,
        price: current.low
      });
    }
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return 'UNKNOWN';
  }

  // MENENTUKAN ARAH STRUKTUR PADA WAKTU TERTENTU
  function getTrendAt(index) {
    const highs = swingHighs.filter(s => s.confirmIndex < index);
    const lows = swingLows.filter(s => s.confirmIndex < index);

    if (highs.length < 2 || lows.length < 2) {
      return 'RANGE';
    }

    const lastHigh = highs[highs.length - 1].price;
    const previousHigh = highs[highs.length - 2].price;

    const lastLow = lows[lows.length - 1].price;
    const previousLow = lows[lows.length - 2].price;

    if (lastHigh > previousHigh && lastLow > previousLow) {
      return 'BULLISH';
    }

    if (lastHigh < previousHigh && lastLow < previousLow) {
      return 'BEARISH';
    }

    return 'RANGE';
  }

  // CARI SEMUA PENEMBUSAN SWING
  const breakEvents = [];

  for (const swing of swingHighs) {
    for (
      let i = Math.max(swing.confirmIndex + 1, 1);
      i < candles.length;
      i++
    ) {
      if (
        candles[i - 1].close <= swing.price &&
        candles[i].close > swing.price
      ) {
        const previousTrend = getTrendAt(i);

        breakEvents.push({
          index: i,
          direction: 'BULLISH',
          type: previousTrend === 'BEARISH'
            ? 'CHOCH'
            : 'BOS'
        });

        break;
      }
    }
  }

  for (const swing of swingLows) {
    for (
      let i = Math.max(swing.confirmIndex + 1, 1);
      i < candles.length;
      i++
    ) {
      if (
        candles[i - 1].close >= swing.price &&
        candles[i].close < swing.price
      ) {
        const previousTrend = getTrendAt(i);

        breakEvents.push({
          index: i,
          direction: 'BEARISH',
          type: previousTrend === 'BULLISH'
            ? 'CHOCH'
            : 'BOS'
        });

        break;
      }
    }
  }

  // AMBIL PENEMBUSAN TERBARU
  breakEvents.sort((a, b) => b.index - a.index);

  
  const latestBreak = breakEvents[0];
  const lastIndex = candles.length - 1;

  // DIAGNOSTIK STRUKTUR BOS / CHOCH
  const structureDiagnostic = {
    timeframe,
    candleCount: candles.length,
    lastCandleTime: candles[lastIndex].time,
    lastClose: candles[lastIndex].close,
    swingHighCount: swingHighs.length,
    swingLowCount: swingLows.length,
    breakEventCount: breakEvents.length,
    latestBreak: latestBreak
      ? latestBreak.type + '_' + latestBreak.direction
      : 'NONE',
    latestBreakIndex: latestBreak
      ? latestBreak.index
      : null,
    candlesSinceBreak: latestBreak
      ? lastIndex - latestBreak.index
      : null
  };

  if (latestBreak && lastIndex - latestBreak.index <= 10) {
    return latestBreak.type + '_' + latestBreak.direction;
  }

  // JIKA TIDAK ADA PENEMBUSAN TERBARU, BACA ARAH TREN
  const lastHigh = swingHighs[swingHighs.length - 1].price;
  const previousHigh = swingHighs[swingHighs.length - 2].price;

  const lastLow = swingLows[swingLows.length - 1].price;
  const previousLow = swingLows[swingLows.length - 2].price;

  if (lastHigh > previousHigh && lastLow > previousLow) {
    return 'TREND_BULLISH';
  }

  if (lastHigh < previousHigh && lastLow < previousLow) {
    return 'TREND_BEARISH';
  }

  return 'RANGE';
          }

function detectOrderBlock(data) {
  if (!data || data.length < 15) {
    return {
      status: 'DATA_KURANG',
      reason: 'Data candle belum cukup'
    };
  }

  // Abaikan candle terakhir yang belum selesai
  const candles = data.slice(0, -1).slice(-40);

  if (candles.length < 12) {
    return {
      status: 'DATA_KURANG',
      reason: 'Data candle belum cukup'
    };
  }

  const recent = candles.map(c => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));

  if (recent.some(c =>
    !Number.isFinite(c.open) ||
    !Number.isFinite(c.high) ||
    !Number.isFinite(c.low) ||
    !Number.isFinite(c.close) ||
    c.high < c.low
  )) {
    return {
      status: 'DATA_INVALID',
      reason: 'Data candle tidak valid'
    };
  }

let displacementCount = 0;
let swingHighCount = 0;
let swingLowCount = 0;
let bullishBosCount = 0;
let bearishBosCount = 0;
let opposingCandleCount = 0;
let maxBodyRatio = 0;
let maxBodyVsAverage = 0;
let bodyRatioPassCount = 0;
let bodyAveragePassCount = 0;

let bullishBosAttemptCount = 0;
let bearishBosAttemptCount = 0;
let bullishSwingAvailableCount = 0;
let bearishSwingAvailableCount = 0;
let lastBullishClose = null;
let lastBullishSwingHigh = null;
let bullishBosClose = null;
let bullishBosSwingHigh = null;
let bullishBosIndex = null;
let bullishCandleColors = [];  

for (let i = recent.length - 1; i >= 7; i--) {
  const current = recent[i];


const body = Math.abs(current.close - current.open);
const range = current.high - current.low;

if (range <= 0) continue;

if (body / range > maxBodyRatio) {
  maxBodyRatio = body / range;
}

if (body / range >= 0.35) {
  bodyRatioPassCount++;
}

const history = recent.slice(i - 6, i);

const averageBody = history.reduce(
  (sum, c) => sum + Math.abs(c.close - c.open),
  0
) / history.length;

if (averageBody <= 0) continue;

if (body / averageBody >= 1.2) {
  bodyAveragePassCount++;
}

if (body / averageBody > maxBodyVsAverage) {
  maxBodyVsAverage = body / averageBody;
}
  
    let swingHigh = null;
    let swingLow = null;

    for (let p = i - 3; p >= 2; p--) {
      const pivot = recent[p];

      const left = recent.slice(p - 2, p);
      const right = recent.slice(p + 1, p + 3);

if (
  swingHigh === null &&
  left.every(c => pivot.high > c.high) &&
  right.every(c => pivot.high > c.high)
) {
  swingHigh = pivot.high;
  swingHighCount++;
}


if (
  swingLow === null &&
  left.every(c => pivot.low < c.low) &&
  right.every(c => pivot.low < c.low)
) {
  swingLow = pivot.low;
  swingLowCount++;
}
      
      

if (swingHigh !== null && swingLow !== null) {
  break;
}

} // Menutup FOR pencarian Swing High dan Swing Low

const strongDisplacement =
  body / range >= 0.35 &&
  body >= averageBody * 1.2;

if (strongDisplacement) {
  displacementCount++;
}


if (current.close > current.open && swingHigh !== null) {
  bullishSwingAvailableCount++;

  if (current.close > swingHigh) {
    bullishBosAttemptCount++;
  }
}

if (current.close < current.open && swingLow !== null) {
  bearishSwingAvailableCount++;

  if (current.close < swingLow) {
    bearishBosAttemptCount++;
  }
}
  
  

if (
  current.close > current.open &&
  swingHigh !== null &&
  current.close > swingHigh &&
  strongDisplacement
) {
bullishBosCount++;
bullishBosClose = current.close;
bullishBosSwingHigh = swingHigh;
bullishBosIndex = i;

lastBullishClose = current.close;
lastBullishSwingHigh = swingHigh;

    
  
  bullishCandleColors = recent.slice(i - 6, i).map(c =>
    c.close < c.open ? 'BEARISH' :
    c.close > c.open ? 'BULLISH' : 'DOJI'
  );

  
  for (let j = i - 1; j >= Math.max(i - 6, 0); j--) {
    const ob = recent[j];

if (ob.close < ob.open) {
  opposingCandleCount++;

  return {
    status: 'VALID',
    type: 'BULLISH',
    high: ob.high,
    low: ob.low,
    bosLevel: swingHigh,
    obIndex: j,
    bosIndex: i,
    obTime: candles[j].time,
    bosTime: candles[i].time,
    reason:
      'Swing High BOS + Displacement valid' +
      ' | Displacement: ' + displacementCount +
      ' | Swing High: ' + swingHighCount +
      ' | Swing Low: ' + swingLowCount +
      ' | Bullish BOS: ' + bullishBosCount +
      ' | Bearish BOS: ' + bearishBosCount +
      ' | Opposing Candle: ' + opposingCandleCount +
      ' | 6 CANDLE SEBELUM BOS: ' + bullishCandleColors.join(', ') +
      ' | DETAIL 6 CANDLE BOS: ' +
        JSON.stringify(recent.slice(i - 6, i)) +
      ' | Max Body Ratio: ' + maxBodyRatio.toFixed(3) +
      ' | Max Body/Average: ' + maxBodyVsAverage.toFixed(3) +
      ' | Ratio Pass: ' + bodyRatioPassCount +
      ' | Average Pass: ' + bodyAveragePassCount +
      ' | Bullish Swing Available: ' + bullishSwingAvailableCount +
      ' | Bullish BOS Attempt: ' + bullishBosAttemptCount +
      ' | Last Bullish Close: ' + lastBullishClose.toFixed(2) +
      ' | Last Bullish Swing High: ' + lastBullishSwingHigh.toFixed(2) +
      ' | BOS Close: ' + bullishBosClose.toFixed(2) +
      ' | BOS Swing High: ' + bullishBosSwingHigh.toFixed(2) +
      ' | BOS Index: ' + bullishBosIndex
  };
} // Menutup IF opposing candle
} // Menutup FOR pencarian OB
} // Menutup IF Bullish BOS


if (
  current.close < current.open &&
  swingLow !== null &&
  current.close < swingLow &&
  strongDisplacement
) {
  bearishBosCount++;

  for (let j = i - 1; j >= Math.max(i - 6, 0); j--) {
    const ob = recent[j];

    if (ob.close > ob.open) {
      opposingCandleCount++;

      return {
        status: 'VALID',
        type: 'BEARISH',
        high: ob.high,
        low: ob.low,
        bosLevel: swingLow,
        obIndex: j,
        bosIndex: i,
        obTime: candles[j].time,
        bosTime: candles[i].time,
        reason:
          'Swing Low BOS + Displacement valid' +
          ' | Displacement: ' + displacementCount +
          ' | Swing High: ' + swingHighCount +
          ' | Swing Low: ' + swingLowCount +
          ' | Bullish BOS: ' + bullishBosCount +
          ' | Bearish BOS: ' + bearishBosCount +
          ' | Opposing Candle: ' + opposingCandleCount +
          ' | Max Body Ratio: ' + maxBodyRatio.toFixed(3) +
          ' | Max Body/Average: ' + maxBodyVsAverage.toFixed(3) +
          ' | Ratio Pass: ' + bodyRatioPassCount +
          ' | Average Pass: ' + bodyAveragePassCount +
          ' | Bearish Swing Available: ' + bearishSwingAvailableCount +
          ' | Bearish BOS Attempt: ' + bearishBosAttemptCount
      };
    }
  }
} // Menutup IF Bearish BOS

} // Menutup FOR utama (i)
  
const bullishBosCandles = bullishBosIndex === null
  ? 'N/A'
  : JSON.stringify(recent.slice(bullishBosIndex - 6, bullishBosIndex));

return {
  status: 'NO_PATTERN',
  reason:
    'OB DIAGNOSTIC' +
    ' | Displacement: ' + displacementCount +
    ' | Swing High: ' + swingHighCount +
    ' | Swing Low: ' + swingLowCount +
    ' | Bullish BOS: ' + bullishBosCount +
    ' | Bearish BOS: ' + bearishBosCount +
    ' | Opposing Candle: ' + opposingCandleCount +
    ' | 6 CANDLE SEBELUM BOS: ' + bullishCandleColors.join(', ') +
    ' | DETAIL 6 CANDLE BOS: ' + bullishBosCandles +
    ' | Max Body Ratio: ' + maxBodyRatio.toFixed(3) +
    ' | Max Body/Average: ' + maxBodyVsAverage.toFixed(3) +
    ' | Ratio Pass: ' + bodyRatioPassCount +
    ' | Average Pass: ' + bodyAveragePassCount +
    ' | Bullish Swing Available: ' + bullishSwingAvailableCount +
    ' | Bearish Swing Available: ' + bearishSwingAvailableCount +
    ' | Bullish BOS Attempt: ' + bullishBosAttemptCount +
    ' | Bearish BOS Attempt: ' + bearishBosAttemptCount +
    ' | Last Bullish Close: ' +
    (lastBullishClose === null ? 'N/A' : lastBullishClose.toFixed(2)) +
    ' | Last Bullish Swing High: ' +
    (lastBullishSwingHigh === null ? 'N/A' : lastBullishSwingHigh.toFixed(2)) +
    ' | BOS Close: ' +
    (bullishBosClose === null ? 'N/A' : bullishBosClose.toFixed(2)) +
    ' | BOS Swing High: ' +
    (bullishBosSwingHigh === null ? 'N/A' : bullishBosSwingHigh.toFixed(2)) +
    ' | BOS Index: ' +
    (bullishBosIndex === null ? 'N/A' : bullishBosIndex)
};
} // Menutup fungsi detectOrderBlock

function calculateTradePlan(obZone) {
  if (!obZone || obZone.status !== 'VALID') return null;

  const high = Number(obZone.high);
  const low = Number(obZone.low);

  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;

  const bullish = obZone.type === 'BULLISH';
  if (!bullish && obZone.type !== 'BEARISH') return null;

  const entry = (high + low) / 2;
  const buffer = (high - low) * 0.10;
  const sl = bullish ? low - buffer : high + buffer;
  const risk = Math.abs(entry - sl);

  if (risk <= 0) return null;

  return {
    type: obZone.type,
    entryLow: low,
    entryHigh: high,
    entry,
    sl,
    tp1: bullish ? entry + risk : entry - risk,
    tp2: bullish ? entry + risk * 2 : entry - risk * 2,
    tp3: bullish ? entry + risk * 3 : entry - risk * 3,
    riskReward: '1:1 / 1:2 / 1:3'
  };
}

function calculateRiskProfiles(obZone) {
  if (!obZone || obZone.status !== 'VALID') return [];
  const high = Number(obZone.high), low = Number(obZone.low);
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return [];
  const bullish = obZone.type === 'BULLISH';
  if (!bullish && obZone.type !== 'BEARISH') return [];
  const width = high - low;
  return [
    { key:'HIGH', label:'HIGH RISK', width:1, buffer:0.10, note:'Zona entry lebih lebar' },
    { key:'MEDIUM', label:'MEDIUM RISK', width:0.60, buffer:0.12, note:'Zona entry menengah' },
    { key:'LOW', label:'LOW RISK', width:0.30, buffer:0.15, note:'Zona entry lebih selektif' }
  ].map(profile => {
    const entryWidth = width * profile.width;
    const entryLow = (high + low - entryWidth) / 2;
    const entryHigh = entryLow + entryWidth;
    const entry = (entryLow + entryHigh) / 2;
    const stopBuffer = width * profile.buffer;
    const sl = bullish ? low - stopBuffer : high + stopBuffer;
    const risk = Math.abs(entry - sl);
    return {
      ...profile, entryLow, entryHigh, entry, sl,
      tp1: bullish ? entry + risk : entry - risk,
      tp2: bullish ? entry + risk * 2 : entry - risk * 2,
      tp3: bullish ? entry + risk * 3 : entry - risk * 3,
      riskReward:'1:1 / 1:2 / 1:3'
    };
  });
}

const TIMEFRAMES = ['M5','M15','M30','M45','H1','H4','D1'];

function classify(signal) {
  if (String(signal).includes('BULLISH')) return 'BULLISH';
  if (String(signal).includes('BEARISH')) return 'BEARISH';
  if (signal === 'RANGE') return 'RANGE';
  return 'UNKNOWN';
}

function normalizeCandles(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.some(c => !c || typeof c !== 'object' || Array.isArray(c))) return [];
  const candles = rows.map(c => ({
    time: Number(c.time ?? c.timestamp ?? (Date.parse(c.datetime) / 1000)),
    open: Number(c.open ?? c.o),
    high: Number(c.high ?? c.h),
    low: Number(c.low ?? c.l),
    close: Number(c.close ?? c.c)
  }));

  // Do not silently discard malformed bars: a partial series can distort
  // swings, BOS/CHOCH and order-block detection while appearing complete.
  if (candles.some(c =>
    !Number.isFinite(c.time) || c.time <= 0 ||
    !Number.isFinite(c.open) || c.open <= 0 ||
    !Number.isFinite(c.high) || c.high <= 0 ||
    !Number.isFinite(c.low) || c.low <= 0 ||
    !Number.isFinite(c.close) || c.close <= 0 ||
    c.high < Math.max(c.open, c.close) ||
    c.low > Math.min(c.open, c.close) ||
    c.high < c.low
  )) return [];

  candles.sort((a, b) => a.time - b.time);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time <= candles[i - 1].time) return [];
  }
  return candles;
}

function evaluateMarket(symbol, candleSets) {
  const { analyzeSmartMoney } = require('./smc');
  const smartMoney = Object.fromEntries(TIMEFRAMES.map(tf => [
    tf,
    Array.isArray(candleSets[tf]) ? analyzeSmartMoney(candleSets[tf], tf) : { timeframe: tf, status: 'INSUFFICIENT_DATA', candleCount: 0 }
  ]));
  // Mirror the live dashboard's actual MTF confirmation:
  // H4 is contextual; H1 and M15 must agree, and both OB zones must
  // confirm that same direction. Do not require D1/M45 or 5-of-7
  // alignment here; that was stricter than the dashboard strategy.
  const required = ['H4','H1','M15'];
  const missing = required.filter(tf => !Array.isArray(candleSets[tf]) || candleSets[tf].length < 30);
  if (missing.length) return {status:'WAIT',reason:'DATA_TIMEFRAME_KURANG',missing,symbol,smartMoney};

  const trends = {};
  const diagnostics = {};
  for (const tf of TIMEFRAMES) {
    trends[tf] = Array.isArray(candleSets[tf]) && candleSets[tf].length >= 30
      ? getStructureSignal(candleSets[tf],tf)
      : 'UNKNOWN';
    diagnostics[tf] = classify(trends[tf]);
  }

  const h4 = diagnostics.H4;
  const h1 = diagnostics.H1;
  const m15 = diagnostics.M15;
  const h1Ob = detectOrderBlock(candleSets.H1);
  const m15Ob = detectOrderBlock(candleSets.M15);

  if ([h4,h1,m15].includes('UNKNOWN')) {
    return {
      status:'WAIT',reason:'OB_STRUCTURE_DATA_INSUFFICIENT',symbol,
      trends:diagnostics,smartMoney,
      orderBlocks:{H1:{status:h1Ob.status,type:h1Ob.type||null},M15:{status:m15Ob.status,type:m15Ob.type||null}}
    };
  }

  // H4 remains visible as higher-timeframe context, matching the dashboard.
  // H1 + M15 structure and H1 + M15 order blocks are the execution gate.
  let bias = 'WAIT';
  if (h1==='BULLISH' && m15==='BULLISH') bias='BUY';
  else if (h1==='BEARISH' && m15==='BEARISH') bias='SELL';

  const alignedOb = bias==='BUY'
    ? h1Ob.status==='VALID' && m15Ob.status==='VALID' && h1Ob.type==='BULLISH' && m15Ob.type==='BULLISH'
    : bias==='SELL'
      ? h1Ob.status==='VALID' && m15Ob.status==='VALID' && h1Ob.type==='BEARISH' && m15Ob.type==='BEARISH'
      : false;

  if (bias==='WAIT' || !alignedOb) {
    return {
      status:'WAIT',
      reason:bias==='WAIT'?'MTF_NOT_ALIGNED':'ORDER_BLOCK_NOT_ALIGNED',
      symbol,trends:diagnostics,smartMoney,
      orderBlocks:{H1:{status:h1Ob.status,type:h1Ob.type||null},M15:{status:m15Ob.status,type:m15Ob.type||null}}
    };
  }

  const selectedOb=m15Ob;
  const tradePlan=calculateTradePlan(selectedOb);
  const riskProfiles=calculateRiskProfiles(selectedOb);
  if (!tradePlan || riskProfiles.length!==3) {
    return {status:'WAIT',reason:'TRADE_PLAN_INVALID',symbol,trends:diagnostics,smartMoney};
  }

  const wanted=bias==='BUY'?'BULLISH':'BEARISH';
  const alignedCount=Object.values(diagnostics).filter(value=>value===wanted).length;
  const availableCount=Object.values(diagnostics).filter(value=>value!=='UNKNOWN').length;
  const h4Aligned=h4===wanted;
  const strengthParts=[
    {label:'Struktur H1 dan M15 searah',points:25,earned:25},
    {label:'Konfirmasi Order Block H1 dan M15',points:25,earned:25},
    {label:'Konteks H4 searah',points:25,earned:h4Aligned?25:0},
    {label:'Keselarasan timeframe tersedia ('+alignedCount+'/'+availableCount+')',points:25,earned:Math.round(25*(alignedCount/Math.max(1,availableCount)))}
  ];
  const signalStrength={
    score:strengthParts.reduce((sum,item)=>sum+item.earned,0),
    reasons:strengthParts.map(item=>item.label+': '+item.earned+'/'+item.points)
  };

  return {
    status:'SIGNAL',direction:bias,symbol,generatedAt:new Date().toISOString(),
    trends:diagnostics,smartMoney,bullish:Object.values(diagnostics).filter(x=>x==='BULLISH').length,
    bearish:Object.values(diagnostics).filter(x=>x==='BEARISH').length,
    unknown:Object.values(diagnostics).filter(x=>x==='UNKNOWN').length,
    signalStrength,
    orderBlocks:{H1:{status:h1Ob.status,type:h1Ob.type},M15:{status:m15Ob.status,type:m15Ob.type}},
    tradePlan,riskProfiles
  };
}

module.exports = {TIMEFRAMES,normalizeCandles,getStructureSignal,detectOrderBlock,calculateTradePlan,calculateRiskProfiles,evaluateMarket};
