'use strict';
const crypto=require('crypto');

async function redis(command){
  const url=process.env.KV_REST_API_URL,token=process.env.KV_REST_API_TOKEN;
  if(!url||!token) throw new Error('Redis KV belum dikonfigurasi');
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(8000)});
  const body=await response.json();
  if(!response.ok||body.error) throw new Error(body.error||'Redis request gagal');
  return body.result;
}

module.exports=async function handler(req,res){
  if (typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  if(req.method==='GET'){
    if(!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({status:'not_configured',message:'VAPID_PUBLIC_KEY belum dikonfigurasi'});
    return res.status(200).json({status:'success',publicKey:process.env.VAPID_PUBLIC_KEY});
  }
  if(req.method!=='POST'&&req.method!=='DELETE') return res.status(405).json({status:'error',message:'Method not allowed'});
  if(!process.env.KV_REST_API_URL||!process.env.KV_REST_API_TOKEN) return res.status(503).json({status:'not_configured',message:'Redis KV belum dikonfigurasi'});
  try{
    const subscription=req.body;
    if(!subscription||typeof subscription.endpoint!=='string'||!subscription.endpoint.startsWith('https://')||
       !subscription.keys||typeof subscription.keys.p256dh!=='string'||typeof subscription.keys.auth!=='string'){
      return res.status(400).json({status:'error',message:'Format subscription tidak valid'});
    }
    const id=crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
    const key='aurum:push:subscription:'+id;
    if(req.method==='DELETE'){
      await redis(['DEL',key]);await redis(['SREM','aurum:push:subscriptions',id]);
      return res.status(200).json({status:'success',subscribed:false});
    }
    await redis(['SET',key,JSON.stringify(subscription),'EX','7776000']);
    await redis(['SADD','aurum:push:subscriptions',id]);
    return res.status(200).json({status:'success',subscribed:true});
  }catch(error){return res.status(500).json({status:'error',message:String(error.message||error).slice(0,180)});}
};
