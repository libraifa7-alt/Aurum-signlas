'use strict';
const crypto=require('crypto');

async function redis(command,env){
  const url=env.KV_REST_API_URL,token=env.KV_REST_API_TOKEN;
  if(!url||!token) throw new Error('Redis KV belum dikonfigurasi');
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(8000)});
  const body=await response.json();
  if(!response.ok||body.error) throw new Error(body.error||'Redis request gagal');
  return body.result;
}

function validateSubscription(subscription, requireKeys) {
  if (!subscription || typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 4096) {
    return false;
  }
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch { return false; }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port) return false;

  // Only accept known browser push-service domains. This prevents the cron
  // worker from being used as a generic HTTPS request proxy.
  const host = endpoint.hostname.toLowerCase();
  const allowedHost = host === 'fcm.googleapis.com' ||
    host === 'web.push.apple.com' ||
    host.endsWith('.push.services.mozilla.com') ||
    host === 'push.services.mozilla.com' ||
    host.endsWith('.notify.windows.com');
  if (!allowedHost) return false;

  if (!requireKeys) return true;
  const keys = subscription.keys;
  return Boolean(keys &&
    typeof keys.p256dh === 'string' && /^[A-Za-z0-9_-]{40,200}$/.test(keys.p256dh) &&
    typeof keys.auth === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(keys.auth));
}

module.exports=async function handler(req,res){
  const env=req.env||process.env;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  if(req.method==='GET'){
    if(!env.VAPID_PUBLIC_KEY) return res.status(503).json({status:'not_configured',message:'VAPID_PUBLIC_KEY belum dikonfigurasi'});
    return res.status(200).json({status:'success',publicKey:env.VAPID_PUBLIC_KEY});
  }
  if(req.method!=='POST'&&req.method!=='DELETE') return res.status(405).json({status:'error',message:'Method not allowed'});
  if(!env.KV_REST_API_URL||!env.KV_REST_API_TOKEN) return res.status(503).json({status:'not_configured',message:'Redis KV belum dikonfigurasi'});
  try{
    const subscription=req.body;
    if(!validateSubscription(subscription, req.method === 'POST')){
      return res.status(400).json({status:'error',message:'Format subscription tidak valid'});
    }
    const id=crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
    const key='aurum:push:subscription:'+id;
    if(req.method==='DELETE'){
      await redis(['DEL',key],env);await redis(['SREM','aurum:push:subscriptions',id],env);
      return res.status(200).json({status:'success',subscribed:false});
    }
    const serialized=JSON.stringify(subscription);
    if (Buffer.byteLength(serialized, 'utf8') > 8192) {
      return res.status(413).json({status:'error',message:'Ukuran subscription terlalu besar'});
    }
    await redis(['SET',key,serialized,'EX','7776000'],env);
    await redis(['SADD','aurum:push:subscriptions',id],env);
    return res.status(200).json({status:'success',subscribed:true});
  }catch(error){return res.status(500).json({status:'error',message:String(error.message||error).slice(0,180)});}
};
