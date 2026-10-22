'use strict';

// A same-origin, fixed-upstream proxy. Never accept an upstream host or client jscode.
const PATHS = new Set([
  '/v3/assistant/inputtips', '/v3/place/around', '/v3/place/text', '/v3/place/detail',
  '/v3/geocode/geo', '/v3/geocode/regeo', '/v3/config/district', '/v3/ip',
  '/v4/map/styles', '/v3/vectormap'
]);
const buckets = new Map();
function allowedOrigin(req) {
  const configured = String(process.env.PINTU_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!configured.length) return false;
  try {
    const origin = new URL(req.headers.origin || req.headers.referer || '').origin;
    return configured.includes(origin);
  } catch (_) { return false; }
}
function limited(req) {
  const now = Date.now(), windowId = Math.floor(now / 60000);
  // This burst guard is supplemental. Configure a daily quota on the provider Key.
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const old = buckets.get(ip), item = old && old.windowId === windowId ? old : { windowId, count: 0 };
  if (buckets.size > 5000) for (const [key,value] of buckets) if (value.windowId !== windowId) buckets.delete(key);
  item.count++; buckets.set(ip,item);return item.count > 120;
}
async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  function error(status,message) { return res.status(status).json({status:'0',info:message}); }
  if(req.method!=='GET')return error(405,'METHOD_NOT_ALLOWED');
  if(!allowedOrigin(req))return error(403,'ORIGIN_NOT_ALLOWED');
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', new URL(req.headers.origin).origin);
    res.setHeader('Vary', 'Origin');
  }
  if(limited(req))return error(429,'RATE_LIMITED');
  const secret=process.env.AMAP_SECURITY_JS_CODE, key=process.env.AMAP_JS_API_KEY;
  if(!/^[a-f0-9]{16,64}$/i.test(secret||'')||!/^[a-f0-9]{16,64}$/i.test(key||''))return error(503,'MAP_NOT_CONFIGURED');
  const local=new URL(req.url,'https://proxy.invalid');
  const rewritten = req.query && req.query.path;
  const route = rewritten || local.searchParams.get('path') || (local.pathname.startsWith('/_AMapService/') ? local.pathname.slice('/_AMapService/'.length) : '');
  const path='/'+String(route).replace(/^\/+/, '');
  if(!PATHS.has(path))return error(404,'PATH_NOT_ALLOWED');
  if(req.url.length>8000)return error(414,'REQUEST_TOO_LONG');
  const callback=local.searchParams.get('callback');
  if(callback!==null && !/^[A-Za-z_$][\w$]{0,127}$/.test(callback))return error(400,'INVALID_CALLBACK');
  local.searchParams.delete('path');local.searchParams.delete('jscode');local.searchParams.set('key',key);local.searchParams.set('jscode',secret);
  const host=path==='/v4/map/styles'?'webapi.amap.com':path==='/v3/vectormap'?'fmap01.amap.com':'restapi.amap.com';
  const target='https://'+host+path+'?'+local.searchParams.toString();
  try {
    // AMap's domain whitelist checks the requesting site's Referer, as with
    // its documented reverse proxy. Forward only the already-allowed origin.
    const referer=new URL(req.headers.origin || req.headers.referer).origin+'/';
    const upstream=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(7000),headers:{Referer:referer}});
    if(!upstream.ok)return error(502,'MAP_UNAVAILABLE');
    const type=upstream.headers.get('content-type')||'application/json';
    if(!/^(application\/(json|javascript|x-javascript|octet-stream)|text\/(javascript|plain)|image\/)/i.test(type))return error(502,'INVALID_RESPONSE');
    const reader=upstream.body.getReader(), chunks=[];let size=0;
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8*1024*1024){await reader.cancel();return error(502,'RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(part.value));}
    let body=Buffer.concat(chunks);
    // Do not expose an upstream diagnostic that echoes the security code.
    if(body.includes(Buffer.from(secret)))return error(502,'MAP_UNAVAILABLE');
    // AMap sends JSONP as application/json. With nosniff browsers correctly
    // refuse to execute it. Validate the wrapper and JSON before serving JS.
    let responseType=type;
    if(callback || /^application\/json/i.test(type)) {
      let json=body.toString('utf8').trim();
      if(callback) {
        const prefix=callback+'(';
        if(!json.startsWith(prefix) || !/\);?$/.test(json))return error(502,'INVALID_RESPONSE');
        json=json.slice(prefix.length).replace(/\);?$/,'');
      }
      let data;try{data=JSON.parse(json);}catch(_){return error(502,'INVALID_RESPONSE');}
      if(data && typeof data==='object')for(const name of ['key','jscode','securityJsCode','sec_code','sec_code_debug'])delete data[name];
      const clean=JSON.stringify(data);
      body=Buffer.from(callback ? callback+'('+clean+');' : clean);
      responseType=callback?'application/javascript; charset=utf-8':'application/json; charset=utf-8';
    }
    res.setHeader('Content-Type',responseType);return res.status(200).send(body);
  }catch(_){return error(502,'MAP_UNAVAILABLE');}
}
module.exports=handler;
module.exports._private={PATHS,allowedOrigin,limited,buckets};
