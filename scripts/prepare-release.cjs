const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function prepare(env = process.env, projectRoot = root) {
  const root = projectRoot;
  const config = JSON.parse(fs.readFileSync(path.join(root,'cloudbaserc.json'),'utf8'));
  const envId = env.CLOUDBASE_ENV_ID || config.envId;
  if (!/^[a-zA-Z0-9_-]{5,100}$/.test(envId)) throw new Error('Invalid CloudBase environment ID');
  const proxy = env.PINTU_MAP_PROXY_ORIGIN || 'https://pintu-app-nu.vercel.app';
  const origin = new URL(proxy);
  if(origin.protocol!=='https:' || origin.origin!==proxy || origin.username || origin.password)throw new Error('Map proxy must be an HTTPS origin');
  const collaborationOrigin = env.PINTU_COLLAB_ORIGIN === undefined ? 'https://pintu-prod-d1grnmzg0f6778ea6-1303073868.tcloudbaseapp.com' : env.PINTU_COLLAB_ORIGIN;
  if (collaborationOrigin) {
    const site = new URL(collaborationOrigin);
    if (site.protocol !== 'https:' || site.origin !== collaborationOrigin || site.username || site.password) throw new Error('Collaboration site must be an HTTPS origin');
  }
  const mapKey=env.AMAP_JS_API_KEY || '';
  if(mapKey && !/^[a-f0-9]{16,64}$/i.test(mapKey))throw new Error('Invalid public AMap JS API key');
  config.envId=envId;
  fs.writeFileSync(path.join(root,'cloudbaserc.json'),JSON.stringify(config,null,2)+'\n');
  fs.writeFileSync(path.join(root,'app-config.js'),'// Generated public configuration. Never put secrets here.\nwindow.PINTU_CONFIG = Object.freeze('+JSON.stringify({cloudbaseEnvId:envId,amapServiceHost:proxy+'/_AMapService',collaborationOrigin,supportEmail:'pgu9555@gmail.com'},null,2)+');\n');
  fs.writeFileSync(path.join(root,'miniprogram-shell/environment.js'),"// Public environment identifier shared with the web deployment.\nmodule.exports = "+JSON.stringify({cloudbaseEnvId:envId})+'\n');
  const destination=path.join(root,'cloudbase-site');fs.mkdirSync(destination,{recursive:true});
  for(const name of ['index.html','app-config.js','launch-support.js','privacy.html','terms.html','legal.css'])fs.copyFileSync(path.join(root,name),path.join(destination,name));
  if(mapKey){
    const html=fs.readFileSync(path.join(destination,'index.html'),'utf8');
    fs.writeFileSync(path.join(destination,'index.html'),html.replace(/(https:\/\/webapi\.amap\.com\/maps\?v=2\.0&key=)[a-f0-9]+/i,'$1'+mapKey));
  }
}
if(require.main===module)prepare();
module.exports={prepare};
