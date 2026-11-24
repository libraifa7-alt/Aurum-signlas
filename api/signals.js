'use strict';

async function redis(command) {
  const url=process.env.KV_REST_API_URL;
  const token=process.env.KV_REST_API_TOKEN;
  if(!url||!token) throw new Error('Redis KV belum dikonfigurasi');
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
  if (typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  if(req.method!=='GET') return res.status(405).json({status:'error',message:'Method not allowed'});
  if(!process.env.KV_REST_API_URL||!process.env.KV_REST_API_TOKEN)
    return res.status(503).json({status:'not_configured',message:'Redis KV belum dikonfigurasi'});
  try{
    const symbols=['XAU/USD','BTC/USD','WTI'];
    const results=await Promise.all(symbols.map(async symbol=>{
      const key='aurum:server-signal:'+encodeURIComponent(symbol);
      const raw=await redis(['GET',key]);
      const history=await redis(['LRANGE','aurum:server-signal-history:'+encodeURIComponent(symbol),'0','19']);
      return {
        symbol,
        current:raw?JSON.parse(raw):null,
        history:Array.isArray(history)?history.map(item=>{try{return JSON.parse(item)}catch{return null}}).filter(Boolean):[]
      };
    }));
    return res.status(200).json({status:'success',source:'server',updatedAt:new Date().toISOString(),results});
  }catch(error){
    return res.status(500).json({status:'error',message:String(error.message||error).slice(0,180)});
  }
};
