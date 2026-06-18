/* Command Center — Cloudflare Pages advanced-mode Worker (_worker.js). KV-backed session. */
const SCOPES=["openid","email","https://www.googleapis.com/auth/calendar.readonly","https://www.googleapis.com/auth/gmail.readonly"].join(" ");
const json=(o,s=200,ex={})=>new Response(JSON.stringify(o),{status:s,headers:{"content-type":"application/json; charset=utf-8",...ex}});
const redirect=(location,headers={})=>new Response(null,{status:302,headers:{location,...headers}});
function parseCookies(req){const h=req.headers.get("cookie")||"";return Object.fromEntries(h.split(/;\s*/).filter(Boolean).map(c=>{const i=c.indexOf("=");return [c.slice(0,i),decodeURIComponent(c.slice(i+1))];}));}
const allowed=env=>(env.ALLOWED_EMAILS||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
const rid=()=>crypto.randomUUID().replace(/-/g,"");
const base=req=>new URL(req.url).origin;
const cookie=(v,age)=>`sid=${v}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;
async function getSession(req,env){const sid=parseCookies(req).sid;if(!sid)return null;const raw=await env.KV.get("sess:"+sid);if(!raw)return null;const s=JSON.parse(raw);s.__sid=sid;return s;}
async function saveSession(env,sid,s){const c={...s};delete c.__sid;await env.KV.put("sess:"+sid,JSON.stringify(c),{expirationTtl:60*60*24*30});}
async function freshToken(env,session){if(session.access_token&&Date.now()<(session.expiry||0)-60000)return session.access_token;if(!session.refresh_token)return null;const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,grant_type:"refresh_token",refresh_token:session.refresh_token})});if(!r.ok)return null;const t=await r.json();session.access_token=t.access_token;session.expiry=Date.now()+(t.expires_in||3600)*1000;await saveSession(env,session.__sid,session);return session.access_token;}
const gfetch=(url,token)=>fetch(url,{headers:{authorization:"Bearer "+token}});
async function authLogin(req,env){const state=rid();await env.KV.put("state:"+state,"1",{expirationTtl:600});const u=new URL("https://accounts.google.com/o/oauth2/v2/auth");u.searchParams.set("client_id",env.GOOGLE_CLIENT_ID);u.searchParams.set("redirect_uri",base(req)+"/auth/callback");u.searchParams.set("response_type","code");u.searchParams.set("scope",SCOPES);u.searchParams.set("access_type","offline");u.searchParams.set("include_granted_scopes","true");u.searchParams.set("prompt","consent");u.searchParams.set("state",state);return redirect(u.toString());}
async function authCallback(req,env){const url=new URL(req.url);const code=url.searchParams.get("code"),state=url.searchParams.get("state");if(!code||!state||!(await env.KV.get("state:"+state)))return new Response("Invalid auth state",{status:400});await env.KV.delete("state:"+state);const tr=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:base(req)+"/auth/callback",grant_type:"authorization_code"})});if(!tr.ok)return new Response("Token exchange failed",{status:400});const t=await tr.json();const ui=await gfetch("https://www.googleapis.com/oauth2/v2/userinfo",t.access_token).then(r=>r.json());const email=(ui.email||"").toLowerCase();const list=allowed(env);if(list.length&&!list.includes(email))return new Response("Access denied for "+email,{status:403});const sid=rid();await saveSession(env,sid,{email,name:ui.name||email,picture:ui.picture||"",access_token:t.access_token,refresh_token:t.refresh_token||"",expiry:Date.now()+(t.expires_in||3600)*1000});return redirect(base(req)+"/",{"set-cookie":cookie(sid,60*60*24*30)});}
async function authLogout(req,env){const s=await getSession(req,env);if(s)await env.KV.delete("sess:"+s.__sid);return redirect(base(req)+"/",{"set-cookie":cookie("",0)});}
async function getConfig(env){try{const raw=await env.KV.get("config:dashboard");return raw?JSON.parse(raw):{};}catch(e){return {};}}
async function apiCalendar(env,token){const cfg=await getConfig(env);const now=new Date(),end=new Date(Date.now()+(cfg.calDays||14)*864e5);const u=new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");u.searchParams.set("timeMin",now.toISOString());u.searchParams.set("timeMax",end.toISOString());u.searchParams.set("singleEvents","true");u.searchParams.set("orderBy","startTime");u.searchParams.set("maxResults","25");const d=await gfetch(u.toString(),token).then(r=>r.json());return json({events:(d.items||[]).map(e=>({summary:e.summary||"(no title)",location:e.location||"",eventType:e.eventType||"default",start:e.start||{},end:e.end||{},status:e.status}))});}
async function apiGmail(env,token){const list=await gfetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in%3Ainbox&maxResults=12",token).then(r=>r.json());const ids=(list.messages||[]).map(m=>m.id);const msgs=await Promise.all(ids.map(id=>gfetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/"+id+"?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",token).then(r=>r.json())));return json({messages:msgs.map(m=>{const hs=((m.payload&&m.payload.headers)||[]).reduce((a,h)=>{a[h.name.toLowerCase()]=h.value;return a;},{});return {sender:hs.from||"",subject:hs.subject||"(no subject)",date:hs.date?new Date(hs.date).toISOString():null,snippet:m.snippet||"",labelIds:m.labelIds||[],threadId:m.threadId||""};})});}
async function apiMarkets(env,force){
  const CACHE="markets:cache";
  if(!force){try{const c=await env.KV.get(CACHE);if(c){const o=JSON.parse(c);if(Date.now()-o.t<55*60*1000)return json({markets:o.markets,asOf:o.t,cached:true});}}catch(e){}}
  // [yahooSymbol, displayName, stooqSymbol]
  const SYMS=[["^GSPC","S&P 500","^spx"],["^DJI","Dow Jones","^dji"],["^IXIC","Nasdaq","^ndq"],["^TNX","10Y Treasury","10usy.b"],["^VIX","VIX","^vix"],["CL=F","Crude Oil","cl.f"],["GC=F","Gold","xauusd"],["BTC-USD","Bitcoin","btcusd"],["ETH-USD","Ethereum","ethusd"]];
  const now=new Date();const yr=now.getUTCFullYear();const mo=String(now.getUTCMonth()+1).padStart(2,"0");const dd=String(now.getUTCDate()).padStart(2,"0");
  const monthStart=yr+"-"+mo+"-01";const yearStart=yr+"-01-01";
  const pc=(p,ref)=>(p!=null&&ref!=null&&ref!==0)?((p-ref)/ref*100):null;
  const findBefore=(rows,d0)=>{for(let i=rows.length-1;i>=0;i--){if(rows[i][0]<d0)return rows[i][1];}return null;};
  const TO=(ms)=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;};
  async function yahoo(sym){
    const url="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(sym)+"?range=1y&interval=1d";
    const r=await fetch(url,{headers:{"user-agent":"Mozilla/5.0","accept":"application/json"},signal:TO(8000)});
    if(!r.ok)throw new Error("y"+r.status);
    const d=await r.json();const res=d&&d.chart&&d.chart.result&&d.chart.result[0];if(!res)throw new Error("ynores");
    const m=res.meta||{};const price=(m.regularMarketPrice!=null)?m.regularMarketPrice:null;
    const ts=res.timestamp||[];const cl=(res.indicators&&res.indicators.quote&&res.indicators.quote[0]&&res.indicators.quote[0].close)||[];
    const rows=[];for(let i=0;i<ts.length;i++){if(cl[i]!=null)rows.push([new Date(ts[i]*1000).toISOString().slice(0,10),cl[i]]);}
    if(price==null||!rows.length)throw new Error("yempty");
    const lastDate=rows[rows.length-1][0];
    const mktDate=m.regularMarketTime?new Date(m.regularMarketTime*1000).toISOString().slice(0,10):lastDate;
    const prevClose=(lastDate===mktDate&&rows.length>=2)?rows[rows.length-2][1]:rows[rows.length-1][1];
    return {price,prevClose,rows,state:m.marketState||""};
  }
  async function stooq(scode){
    const hurl="https://stooq.com/q/d/l/?s="+encodeURIComponent(scode)+"&i=d&d1="+(yr-1)+"1201&d2="+yr+mo+dd;
    const hr=await fetch(hurl,{signal:TO(8000)});const ht=await hr.text();
    const lines=ht.trim().split(/\r?\n/);const rows=[];
    for(let i=1;i<lines.length;i++){const p=lines[i].split(",");if(p.length>=5){const c=parseFloat(p[4]);if(!isNaN(c))rows.push([p[0],c]);}}
    if(!rows.length)throw new Error("sempty");
    let price=rows[rows.length-1][1];let prevClose=rows.length>=2?rows[rows.length-2][1]:null;
    try{const lr=await fetch("https://stooq.com/q/l/?s="+encodeURIComponent(scode)+"&f=sd2t2c&e=csv",{signal:TO(6000)});const lt=(await lr.text()).trim().split(/\r?\n/);const lp=lt[lt.length-1].split(",");const lc=parseFloat(lp[lp.length-1]);if(!isNaN(lc)&&lc>0){price=lc;prevClose=rows[rows.length-1][1];}}catch(e){}
    return {price,prevClose,rows,state:""};
  }
  async function one(yh,name,sc){
    let data=null;
    try{data=await yahoo(yh);}catch(e){try{data=await stooq(sc);}catch(e2){data=null;}}
    if(!data||data.price==null)return {symbol:yh,name,price:null,changePercent:null,mtd:null,ytd:null,state:""};
    return {symbol:yh,name,price:data.price,changePercent:pc(data.price,data.prevClose),mtd:pc(data.price,findBefore(data.rows,monthStart)),ytd:pc(data.price,findBefore(data.rows,yearStart)),state:data.state};
  }
  const markets=await Promise.all(SYMS.map(s=>one(s[0],s[1],s[2])));
  try{await env.KV.put(CACHE,JSON.stringify({t:Date.now(),markets}),{expirationTtl:3600});}catch(e){}
  return json({markets,asOf:Date.now(),cached:false});
}
async function apiRental(env,token){
  let manual={};try{const mr=await env.KV.get("config:rental");if(mr)manual=JSON.parse(mr);}catch(e){}
  const search=(q,n)=>gfetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults="+n+"&q="+encodeURIComponent(q),token).then(r=>r.json());
  const getMsg=(id)=>gfetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/"+id+"?format=metadata&metadataHeaders=Subject&metadataHeaders=Date",token).then(r=>r.json());
  const hdr=(m,name)=>{const hs=((m.payload&&m.payload.headers)||[]);const h=hs.find(x=>x.name.toLowerCase()===name);return h?h.value:"";};
  const iso=(m)=>m.internalDate?new Date(parseInt(m.internalDate,10)).toISOString():null;
  let lastPayment=null,ytd=0,payCount=0;
  try{
    const l=await search('from:topkey.io "owner payment"',20);
    const ids=(l.messages||[]).map(m=>m.id);
    const msgs=await Promise.all(ids.map(getMsg));
    const yr=new Date().getUTCFullYear();
    const pays=msgs.map(m=>{const amt=parseFloat((((m.snippet||"").match(/\$([0-9,]+(?:\.[0-9]{1,2})?)/)||[])[1]||"").replace(/,/g,""));return {amount:isNaN(amt)?null:amt,date:iso(m)};}).filter(p=>p.amount!=null);
    pays.sort((a,b)=>(a.date<b.date?1:-1));
    lastPayment=pays[0]||null;
    const ytdPays=pays.filter(p=>p.date&&new Date(p.date).getUTCFullYear()===yr);
    ytd=ytdPays.reduce((s,p)=>s+p.amount,0);payCount=ytdPays.length;
  }catch(e){}
  let lastStatement=null;
  try{const l=await search('from:guesty.com "Owner statement"',3);const id=(l.messages||[])[0]&&l.messages[0].id;if(id){const m=await getMsg(id);lastStatement={period:hdr(m,"subject").replace(/^Owner statement\s*/i,""),date:iso(m),threadId:m.threadId};}}catch(e){}
  let lastUpdate=null;
  try{const l=await search('from:owners@bluegemsmgmt.com "Homeowner Update"',3);const id=(l.messages||[])[0]&&l.messages[0].id;if(id){const m=await getMsg(id);lastUpdate={subject:hdr(m,"subject"),date:iso(m),threadId:m.threadId};}}catch(e){}
  return json({property:"855 Golden Bear",lastPayment,ytdPayouts:ytd,paymentCount:payCount,lastStatement,lastUpdate,occupancy:(manual.occupancy!=null?manual.occupancy:null),revenue30d:(manual.revenue30d!=null?manual.revenue30d:null),asOf:manual.asOf||null});
}
async function apiData(req,env,email,kind){const key="data:"+email+":"+kind;if(req.method==="GET"){const raw=await env.KV.get(key);return json({items:raw?JSON.parse(raw):null});}if(req.method==="PUT"){const body=await req.json();await env.KV.put(key,JSON.stringify(body.items||[]));return json({ok:true});}return json({error:"method not allowed"},405);}
async function apiTracker(env,request){
  const KEY="tracker:spcx";
  if(request.method==="PUT"){const b=await request.json();await env.KV.put(KEY,JSON.stringify(b));return json({ok:true});}
  let cfg={};try{const raw=await env.KV.get(KEY);if(raw)cfg=JSON.parse(raw);}catch(e){}
  const ticker=cfg.ticker||"SPCX";
  let price=null,changePercent=null,state="";
  try{
    const ck="tracker:price:"+ticker;
    const c=await env.KV.get(ck);
    if(c){const o=JSON.parse(c);if(Date.now()-o.t<10*60*1000){price=o.price;changePercent=o.cp;state=o.s||"";}}
    if(price==null){
      const sig=(()=>{const a=new AbortController();setTimeout(()=>a.abort(),8000);return a.signal;})();
      const r=await fetch("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(ticker)+"?range=1mo&interval=1d",{headers:{"user-agent":"Mozilla/5.0","accept":"application/json"},signal:sig});
      if(r.ok){const d=await r.json();const res=d&&d.chart&&d.chart.result&&d.chart.result[0];if(res){const m=res.meta||{};const cl=(res.indicators&&res.indicators.quote&&res.indicators.quote[0]&&res.indicators.quote[0].close)||[];const rows=cl.filter(x=>x!=null);price=(m.regularMarketPrice!=null)?m.regularMarketPrice:(rows.length?rows[rows.length-1]:null);const prev=rows.length>=2?rows[rows.length-2]:(m.chartPreviousClose||null);changePercent=(price!=null&&prev)?((price-prev)/prev*100):null;state=m.marketState||"";}}
      if(price!=null){await env.KV.put(ck,JSON.stringify({t:Date.now(),price,cp:changePercent,s:state}),{expirationTtl:900});}
    }
  }catch(e){}
  return json({config:cfg,ticker,price,changePercent,state,asOf:Date.now()});
}
async function ntfyPush(env,payload){
  let topic="";try{topic=(await env.KV.get("ntfy:topic"))||"";}catch(e){}
  if(!topic)return {ok:false,error:"no_topic"};
  const headers={};
  if(env.NTFY_TOKEN)headers["Authorization"]="Bearer "+env.NTFY_TOKEN;
  if(payload&&payload.title)headers["Title"]=payload.title;
  if(payload&&payload.tags)headers["Tags"]=payload.tags;
  if(payload&&payload.priority)headers["Priority"]=String(payload.priority);
  if(payload&&payload.click)headers["Click"]=payload.click;
  try{const r=await fetch("https://ntfy.sh/"+encodeURIComponent(topic),{method:"POST",headers,body:(payload&&payload.message)||""});return {ok:r.ok,status:r.status};}catch(e){return {ok:false,error:String(e)};}
}
async function apiCheckReminders(env,email){
  const now=Date.now();let last=now-30*60*1000;
  try{const l=await env.KV.get("ntfy:lastcheck");if(l)last=parseInt(l,10);}catch(e){}
  const due=[];
  const consider=(items,label)=>{(items||[]).forEach(t=>{if(t&&t.when&&!t.done){const w=new Date(t.when).getTime();if(!isNaN(w)&&w>last&&w<=now)due.push({text:t.text,assignee:t.assignee||"",label:label});}});};
  try{const td=await env.KV.get("data:"+email+":todos");if(td)consider(JSON.parse(td),"To-Do");}catch(e){}
  try{const pr=await env.KV.get("data:"+email+":projects");if(pr){JSON.parse(pr).forEach(p=>consider(p.tasks,p.name));}}catch(e){}
  for(const d of due){await ntfyPush(env,{title:"⏰ "+(d.label||"Reminder"),message:d.text+(d.assignee?(" — "+d.assignee):""),tags:"alarm_clock"});}
  await env.KV.put("ntfy:lastcheck",String(now));
  return {checked:true,pushed:due.length};
}
export default {async fetch(request,env){const p=new URL(request.url).pathname;try{
if(p==="/auth/login")return authLogin(request,env);
if(p==="/auth/callback")return authCallback(request,env);
if(p==="/auth/logout")return authLogout(request,env);
if(p.startsWith("/api/")){const session=await getSession(request,env);if(!session)return json({error:"unauthorized"},401);
if(p==="/api/markets")return apiMarkets(env,new URL(request.url).searchParams.has("nocache"));
if(p==="/api/me")return json({email:session.email,name:session.name,picture:session.picture});
if(p==="/api/todos")return apiData(request,env,session.email,"todos");
if(p==="/api/projects")return apiData(request,env,session.email,"projects");
if(p==="/api/research/archive"){const a=await env.KV.get("research:archive");return json(a?{entries:JSON.parse(a)}:{entries:[]});}
if(p==="/api/research"){if(request.method==="PUT"){const b2=await request.json();try{const prev=await env.KV.get("research:latest");if(prev){const pj=JSON.parse(prev);let arr=[];try{const a=await env.KV.get("research:archive");if(a)arr=JSON.parse(a);}catch(e){}if(!arr.length||arr[0].updated!==pj.updated){arr.unshift(pj);}arr=arr.slice(0,30);await env.KV.put("research:archive",JSON.stringify(arr));}}catch(e){}await env.KV.put("research:latest",JSON.stringify(b2));return json({ok:true});}const raw=await env.KV.get("research:latest");return json(raw?JSON.parse(raw):{updated:null,sections:[]});}
if(p==="/api/config"){if(request.method==="PUT"){const b3=await request.json();await env.KV.put("config:dashboard",JSON.stringify(b3));return json({ok:true});}const raw=await env.KV.get("config:dashboard");return json(raw?JSON.parse(raw):{calDays:14,accent:"#3b66f5",title:"Command Center",hidePanels:[]});}
if(p==="/api/drafts"){if(request.method==="PUT"){const b4=await request.json();await env.KV.put("drafts:latest",JSON.stringify(b4));return json({ok:true});}const raw=await env.KV.get("drafts:latest");return json(raw?JSON.parse(raw):{updated:null,items:[]});}
if(p==="/api/tracker")return apiTracker(env,request);
if(p==="/api/rental"&&request.method==="PUT"){const br=await request.json();await env.KV.put("config:rental",JSON.stringify(br));return json({ok:true});}
if(p==="/api/ntfy"){if(request.method==="PUT"){const bn=await request.json();await env.KV.put("ntfy:topic",String((bn&&bn.topic)||""));return json({ok:true});}const t=await env.KV.get("ntfy:topic");return json({topic:t||""});}
if(p==="/api/notify"){if(request.method!=="POST")return json({error:"post_only"},405);const bn=await request.json();return json(await ntfyPush(env,bn));}
if(p==="/api/check-reminders")return json(await apiCheckReminders(env,session.email));
const token=await freshToken(env,session);if(!token)return json({error:"token_expired"},401);
if(p==="/api/calendar")return apiCalendar(env,token);
if(p==="/api/gmail")return apiGmail(env,token);
if(p==="/api/rental")return apiRental(env,token);
return json({error:"not found"},404);}
return env.ASSETS.fetch(request);}catch(err){return json({error:String((err&&err.message)||err)},500);}}};
