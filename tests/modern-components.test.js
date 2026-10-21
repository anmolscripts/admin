'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const {JSDOM}=require('jsdom');
const prisma=require('../app/config/prisma');
const fy=require('../app/services/financialYear.service');
const app=require('../app/app');
after(()=>prisma.$disconnect());
test('financial years create once, roll forward by date and preserve closed historical years per business',async()=>{
 assert.match(process.env.DATABASE_NAME,/^ui_audit_/);
 const business=await prisma.business.create({data:{name:'FY rollover audit '+Date.now(),legalName:'Synthetic audit',code:'FYA'+Date.now()}});
 const march=new Date(2031,2,31,23,59,59),april=new Date(2031,3,1);
 assert.equal(fy.computeFinancialYear(march).code,'2030-31');assert.equal(fy.computeFinancialYear(april).code,'2031-32');
 const old=await fy.ensureCurrentFinancialYear(business.id,march);
 await prisma.financialYear.update({where:{id:old.id},data:{status:'CLOSED'}});
 const years=await Promise.all([fy.ensureCurrentFinancialYear(business.id,april),fy.ensureCurrentFinancialYear(business.id,april)]);
 assert.equal(years[0].id,years[1].id);
 const listed=await fy.listFinancialYears(business.id);assert.equal(listed.length,2);assert.equal(listed.filter(y=>y.isCurrent).length,1);
 assert.equal(listed.find(y=>y.id===old.id).status,'CLOSED');assert.equal(listed.find(y=>y.id===old.id).isCurrent,false);
 assert.equal((await fy.ensureFinancialYear(march,business.id)).status,'CLOSED');
});
test('dashboard defaults to the current FY and accepts ranges spanning multiple years',()=>{
 const service=require('../app/services/dashboard.service');
 const current=service.getDateRangeFilter(undefined,null,null,new Date(2026,9,20));assert.equal(current.key,'current_fy');assert.equal(current.startDate.getFullYear(),2026);assert.equal(current.startDate.getMonth(),3);assert.equal(current.endDate.getFullYear(),2027);
 const multi=service.getDateRangeFilter('custom','2024-04-01','2027-03-31');assert.equal(multi.startDate.getFullYear(),2024);assert.equal(multi.endDate.getFullYear(),2027);
 assert.throws(()=>service.getDateRangeFilter('custom','2027-03-31','2024-04-01'),/valid date range/);
});
test('profile image picker previews an image and undo restores the persisted photo',async()=>{
 const dom=new JSDOM('<input id="avatar" type="file"><img id="avatar-preview" src="/old.png"><span id="avatar-placeholder" hidden>A</span><button id="avatar-reset" hidden>Undo</button><span id="avatar-file-name"></span>',{url:'http://audit.invalid',runScripts:'outside-only'});
 dom.window.eval(fs.readFileSync('assets/js/profile.js','utf8'));const input=dom.window.document.getElementById('avatar');
 Object.defineProperty(input,'files',{value:[new dom.window.File(['synthetic'],'preview.png',{type:'image/png'})],configurable:true});
 input.dispatchEvent(new dom.window.Event('change'));await new Promise(r=>setTimeout(r,30));
 assert.match(dom.window.document.getElementById('avatar-preview').src,/data:image\/png/);assert.equal(dom.window.document.getElementById('avatar-reset').hidden,false);
 dom.window.document.getElementById('avatar-reset').click();assert.match(dom.window.document.getElementById('avatar-preview').src,/old.png$/);assert.equal(dom.window.document.getElementById('avatar-reset').hidden,true);dom.window.close();
});
test('theme follows device defaults and retains explicit choices across reloads',async()=>{
 const header=fs.readFileSync('app/views/layouts/header.ejs','utf8');const init=header.match(/<script>([\s\S]*?)<\/script>/)[1];
 const dom=new JSDOM('<button id="theme-toggle"><i id="theme-toggle-icon"></i></button>',{url:'http://audit.invalid',runScripts:'outside-only'});let changed;
 dom.window.matchMedia=()=>({matches:true,addEventListener:(name,fn)=>{changed=fn;}});
 dom.window.eval(init);assert.equal(dom.window.document.documentElement.dataset.theme,'dark');
 dom.window.eval(fs.readFileSync('assets/js/dashboard.js','utf8'));dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
 dom.window.document.getElementById('theme-toggle').click();assert.equal(dom.window.localStorage.getItem('spark-theme'),'light');
 changed({matches:true});assert.equal(dom.window.document.documentElement.dataset.theme,'light');dom.window.eval(init);assert.equal(dom.window.document.documentElement.dataset.theme,'light');dom.window.close();
});
test('template editor opens and saves the selected layout and colors through the real authenticated API',async()=>{
 assert.match(process.env.DATABASE_NAME,/^ui_audit_/);
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let dom;
 try{
  const first=await fetch(base+'/login');let cookie=first.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const token=(await first.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token,email:'admin@email.com',password:process.env.SEED_ADMIN_PASSWORD})});assert.equal(login.status,302);cookie=login.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
  const page=await fetch(base+'/settings',{headers:{Cookie:cookie}});assert.equal(page.status,200);dom=new JSDOM(await page.text(),{url:base+'/settings',runScripts:'outside-only'});
  let opened,saved;dom.window.openSparkModal=selector=>{opened=selector;};dom.window.alert=message=>{throw new Error(message);};dom.window.setTimeout=()=>0;
  dom.window.fetch=async(url,options)=>{const response=await fetch(base+url,{...options,headers:{Cookie:cookie,...options.headers}});saved=await response.clone().json();assert.equal(response.status,200);return response;};
  const script=[...dom.window.document.scripts].find(s=>s.textContent.includes('async function templateRequest'));dom.window.eval(script.textContent);
  dom.window.document.getElementById('btn-open-create-template').click();assert.equal(opened,'#templateEditorModal');
  dom.window.document.getElementById('editor-name').value='UI test '+Date.now();dom.window.document.getElementById('editor-base-template').value='industrial-bold';dom.window.document.getElementById('editor-accent-color').value='#123456';dom.window.document.getElementById('editor-subtle-color').value='#eeeeee';
  dom.window.document.getElementById('btn-save-custom-template').click();for(let i=0;i<30&&!saved;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(saved.success,true);assert.equal(saved.template.baseLayout,'industrial-bold');assert.equal(saved.template.accentColor,'#123456');assert.equal(saved.template.accentSubtle,'#eeeeee');
  const emptyBusiness=await prisma.business.findFirst({where:{code:{startsWith:'FYA'}},orderBy:{id:'desc'}});
  const dashboard=await fetch(base+'/dashboard?range=custom&from=2090-04-01&to=2091-03-31',{headers:{Cookie:cookie,'X-Business-Id':String(emptyBusiness.id)}});assert.equal(dashboard.status,200);
  const chartDom=new JSDOM(await dashboard.text(),{url:base+'/dashboard',runScripts:'outside-only'});
  let charts=0;chartDom.window.ApexCharts=class{constructor(){charts++;}};
  const chartScript=[...chartDom.window.document.scripts].find(s=>s.textContent.includes('function chartContent'));chartDom.window.eval(chartScript.textContent);
  assert.equal(charts,0);assert.equal(chartDom.window.document.querySelectorAll('.spark-empty-state').length,5);assert.equal(chartDom.window.document.querySelectorAll('.spark-empty-state a').length,5);chartDom.window.close();
  const bad=await fetch(base+'/dashboard?range=invalid',{headers:{Cookie:cookie,Accept:'application/json'}});assert.equal(bad.status,400);const failure=await bad.json();assert.ok(failure.requestId);
  const log=fs.readFileSync('data/logs/errors-'+new Date().toISOString().slice(0,10)+'.jsonl','utf8');assert.ok(log.includes(failure.requestId));assert.ok(!log.includes(process.env.SEED_ADMIN_PASSWORD));
 }finally{dom?.window.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('period middleware preserves custom spans and rejects reversed dates',async()=>{
 const middleware=require('../app/middleware/reportingPeriod.middleware');const original=fy.ensureCurrentFinancialYear;
 try{fy.ensureCurrentFinancialYear=async()=>({code:'2026-27',startDate:new Date(2026,3,1),endDate:new Date(2027,2,31)});
  const run=async query=>{const req={method:'GET',path:'/purchases/orders',businessId:9,session:{user:{id:1}},query};const res={locals:{}};let error;await middleware(req,res,e=>error=e);return{req,res,error};};
  const current=await run({});assert.equal(current.req.query.dateFrom,'2026-04-01');assert.equal(current.req.query.dateTo,'2027-03-31');
  const multi=await run({dateFrom:'2024-04-01',dateTo:'2027-03-31'});assert.equal(multi.req.query.dateFrom,'2024-04-01');assert.equal(multi.error,undefined);
  assert.equal((await run({dateFrom:'2027-03-31',dateTo:'2024-04-01'})).error.statusCode,400);
 }finally{fy.ensureCurrentFinancialYear=original;}
});
test('SweetAlert errors use text, remain inside the active modal and suppress duplicate dialogs',()=>{
 const dom=new JSDOM('<div class="modal show" id="editor"></div>',{url:'http://audit.invalid',runScripts:'outside-only'});const calls=[];
 dom.window.Swal={fire:options=>calls.push(options)};dom.window.eval(fs.readFileSync('assets/js/spark-feedback.js','utf8'));
 dom.window.SparkFeedback.error('<img src=x onerror=alert(1)>');dom.window.SparkFeedback.error('<img src=x onerror=alert(1)>');
 assert.equal(calls.length,1);assert.equal(calls[0].text,'<img src=x onerror=alert(1)>');assert.equal(calls[0].html,undefined);assert.equal(calls[0].target.id,'editor');assert.equal(calls[0].keydownListenerCapture,true);dom.window.close();
});
test('shared chart rendering replaces empty report charts with an actionable state',async()=>{
 const dom=new JSDOM('<div id="chart"></div>',{url:'http://audit.invalid',runScripts:'outside-only'});let renders=0;
 dom.window.matchMedia=()=>({matches:false,addEventListener(){}});dom.window.ApexCharts=class{constructor(series){this.el=dom.window.document.getElementById('chart');this.w={config:{series}};}render(){renders++;return Promise.resolve(this);}};
 await new Promise(r=>dom.window.addEventListener('load',r,{once:true}));dom.window.eval(fs.readFileSync('assets/js/dashboard.js','utf8'));dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
 await new dom.window.ApexCharts([{data:[0,0]}]).render();assert.equal(renders,0);assert.match(dom.window.document.getElementById('chart').textContent,/No data to show/);assert.ok(dom.window.document.querySelector('.spark-empty-state a'));
 await new dom.window.ApexCharts([{data:[{x:'Apr',y:20}]}]).render();assert.equal(renders,1);dom.window.close();
});
