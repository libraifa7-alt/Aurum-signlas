'use strict';

const { TIMEFRAMES, normalizeCandles, evaluateMarket } = require('./engine');
const webpush = require('web-push');

async function redis(command) {
  const url=process.env.KV_REST_API_URL;
  const token=process.env.KV_REST_API_TOKEN;
  if(!url||!token) throw new Error('KV_REST_API_URL dan KV_REST_API_TOKEN belum dikonfigurasi');
  const response=await fetch(url,{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(command),
    signal:AbortSignal.timeout(8000)
  });
  const body=await response.json();
  if(!response.ok||body.error) throw new Error(body.error||'Redis request gagal');
  return body.result;
}

module.exports=async function handler(req,res){
  if(req.method!=='GET'&&req.method!=='POST') return res.status(405).json({status:'error',message:'Method not allowed'});
  const secret=process.env.CRON_SECRET;
  if(!secret) return res.status(503).json({status:'not_configured',message:'CRON_SECRET belum dikonfigurasi'});
  const authorization=String(req.headers.authorization||'');
  if(authorization!=='Bearer '+secret) return res.status(401).json({status:'error',message:'Unauthorized'});
  if(!process.env.KV_REST_API_URL||!process.env.KV_REST_API_TOKEN) {
    return res.status(503).json({status:'not_configured',message:'Redis KV belum dikonfigurasi; mesin sinyal tidak dijalankan'});
  }

  try {
    // Use the canonical public deployment URL. VERCEL_URL may point to a protected
    // preview/deployment hostname and return 401 when called from a serverless function.
    const baseUrl=process.env.AURUM_PUBLIC_URL||'https://aurum-signals-ai.vercel.app';
    const symbols=['XAU/USD','BTC/USD','WTI'];
    const results=[];

    for(const symbol of symbols){
      const candleSets={};
      const feedDiagnostics={};
      const fetchResults=await Promise.all(TIMEFRAMES.map(async tf=>{
        const url=new URL('/api',baseUrl);
        url.searchParams.set('symbol',symbol);
        url.searchParams.set('interval',tf);
        const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
        if(!response.ok) throw new Error(symbol+' '+tf+' API HTTP '+response.status);
        const payload=await response.json();
        if(payload.status!=='success') throw new Error(symbol+' '+tf+' data tidak tersedia');
        const candles=normalizeCandles(payload.candles);
        const last=candles.at(-1)?.time||0;
        return [tf,candles,{
          source:payload.candleSource||payload.source||null,
          candleStatus:payload.candleStatus||null,
          providerFetchedAt:payload.providerFetchedAt||null,
          lastCandleAt:last?new Date(last*1000).toISOString():null,
          candleAgeSeconds:last?Math.floor(Date.now()/1000-last):null,
          candleError:payload.candleError||null,
          candleCount:candles.length
        }];
      }));
      for(const [tf,candles,diagnostic] of fetchResults){candleSets[tf]=candles;feedDiagnostics[tf]=diagnostic;}

      const latestTimes=TIMEFRAMES.map(tf=>candleSets[tf].at(-1)?.time||0);
      const stale=TIMEFRAMES.filter(tf=>{
        const last=latestTimes[TIMEFRAMES.indexOf(tf)];
        const age=(Date.now()/1000)-last;
        const limits={M5:900,M15:2700,M30:5400,M45:8100,H1:10800,H4:43200,D1:259200};
        return !last||age< -60||age>limits[tf];
      });
      // Only H4/H1/M15 are execution gates in the dashboard's ICT strategy.
      // Other timeframes contribute context/strength only; stale context must
      // be excluded from scoring, but must not block a valid execution setup.
      const executionTimeframes=new Set(['M15','H1','H4']);
      const blockingStale=stale.filter(tf=>executionTimeframes.has(tf));
      const contextualStale=stale.filter(tf=>!executionTimeframes.has(tf));
      if(blockingStale.length){
        // Never leave an old BUY/SELL visible when an execution feed is stale.
        const stateKey='aurum:server-signal:'+encodeURIComponent(symbol);
        const fingerprint='WAIT:STALE_EXECUTION_CANDLES:'+blockingStale.join(',');
        const record={
          status:'WAIT',
          symbol,
          reason:'STALE_OR_MISSING_CANDLES',
          timeframes:blockingStale,
          contextualTimeframesStale:contextualStale,
          feedDiagnostics,
          checkedAt:new Date().toISOString(),
          fingerprint
        };
        const priorRaw=await redis(['GET',stateKey]);
        const prior=priorRaw?JSON.parse(priorRaw):null;
        record.changed=!prior||prior.fingerprint!==fingerprint;
        await redis(['SET',stateKey,JSON.stringify(record),'EX','604800']);
        results.push({symbol,status:'WAIT',reason:record.reason,timeframes:blockingStale,
          contextualTimeframesStale:contextualStale,feedDiagnostics,changed:record.changed});
        continue;
      }

      // Do not calculate multi-timeframe strength from stale context candles.
      for(const tf of contextualStale) candleSets[tf]=[];

      const evaluation=evaluateMarket(symbol,candleSets);
      const stateKey='aurum:server-signal:'+encodeURIComponent(symbol);
      const priorRaw=await redis(['GET',stateKey]);
      const prior=priorRaw?JSON.parse(priorRaw):null;
      const fingerprint=evaluation.status==='SIGNAL'
        ? [evaluation.direction,evaluation.tradePlan.entryLow,evaluation.tradePlan.entryHigh,evaluation.tradePlan.sl].join(':')
        : 'WAIT:'+evaluation.reason;
      const changed=!prior||prior.fingerprint!==fingerprint;
      const record={
        ...evaluation,
        feedDiagnostics,
        checkedAt:new Date().toISOString(),
        fingerprint,
        changed
      };
      await redis(['SET',stateKey,JSON.stringify(record),'EX','604800']);
      if(changed&&evaluation.status==='SIGNAL'){
        await redis(['LPUSH','aurum:server-signal-history:'+encodeURIComponent(symbol),JSON.stringify(record)]);
        await redis(['LTRIM','aurum:server-signal-history:'+encodeURIComponent(symbol),'0','99']);
      }
      let pushResult='not_sent';
      if(changed&&evaluation.status==='SIGNAL'&&process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&process.env.VAPID_SUBJECT){
        webpush.setVapidDetails(process.env.VAPID_SUBJECT,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
        const ids=await redis(['SMEMBERS','aurum:push:subscriptions'])||[];
        let sent=0,failed=0;
        for(const id of ids){
          const raw=await redis(['GET','aurum:push:subscription:'+id]);
          if(!raw) { await redis(['SREM','aurum:push:subscriptions',id]); continue; }
          try{
            await webpush.sendNotification(JSON.parse(raw),JSON.stringify({
              title:'AURUM SIGNAL — '+symbol,
              body:evaluation.direction+' | Entry '+evaluation.tradePlan.entryLow+'–'+evaluation.tradePlan.entryHigh+' | SL '+evaluation.tradePlan.sl,
              tag:'aurum-'+encodeURIComponent(symbol),
              url:'/'
            }));
            sent++;
          }catch(pushError){
            failed++;
            if(pushError.statusCode===404||pushError.statusCode===410){
              await redis(['DEL','aurum:push:subscription:'+id]);
              await redis(['SREM','aurum:push:subscriptions',id]);
            }
          }
        }
        pushResult={sent,failed};
      }else if(!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY||!process.env.VAPID_SUBJECT){
        pushResult='vapid_not_configured';
      }
      results.push({symbol,status:evaluation.status,reason:evaluation.reason||null,changed,push:pushResult,
        direction:evaluation.direction||null,contextualTimeframesStale:contextualStale,feedDiagnostics,
        latestCandleAt:Object.fromEntries(TIMEFRAMES.map(tf=>[tf,feedDiagnostics[tf].lastCandleAt]))});
    }

    return res.status(200).json({status:'success',engine:'server-side-ict',checkedAt:new Date().toISOString(),results});
  } catch(error){
    console.error('AURUM SERVER ENGINE:',error);
    return res.status(500).json({status:'error',message:String(error.message||error).slice(0,240)});
  }
};
