'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const logDirectory=path.join(__dirname,'../../data/logs');
function logFailure(req,res,reason,error){
 if(req.failureLogged)return;
 req.failureLogged=true;
 const entry={time:new Date().toISOString(),requestId:req.requestId,method:req.method,path:req.path,status:res.statusCode,userId:req.session?.user?.id,businessId:req.businessId,reason:String(reason||'Request failed').slice(0,400).replace(/[\r\n]/g,' ')};
 if(error){entry.code=error.code||error.name;entry.diagnostic=String(error.message||'').split('\n').find(line=>line.trim())?.slice(0,300).replace(/\b(?:mysql|mariadb|https?):\/\/\S+/gi,'[redacted URL]').replace(/(?:password|secret|token)\s*[:=]\s*\S+/gi,'[redacted credential]');entry.frames=String(error.stack||'').split('\n').filter(line=>/^\s+at /.test(line)).slice(0,8);}
 // Never record submitted fields, cookies, query strings, passwords or file contents.
 try{fs.mkdirSync(logDirectory,{recursive:true});fs.appendFileSync(path.join(logDirectory,`errors-${new Date().toISOString().slice(0,10)}.jsonl`),JSON.stringify(entry)+'\n');}catch(e){console.error('[ERROR LOG WRITE FAILED]',e.code);}
}
module.exports=function requestLog(req,res,next){
 req.requestId=crypto.randomUUID();res.setHeader('X-Request-ID',req.requestId);
 const json=res.json;
 res.json=function(body){if(body&&typeof body==='object'&&(res.statusCode>=400||body.success===false)){body={...body,requestId:req.requestId};logFailure(req,res,body.error||body.message);}return json.call(this,body);};
 res.on('finish',()=>{if(res.statusCode>=400)logFailure(req,res,'HTTP '+res.statusCode);});
 next();
};
module.exports.logFailure=logFailure;
