'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {JSDOM}=require('jsdom');
const prisma=require('../app/config/prisma');
const profile=require('../app/services/businessProfile.service');
after(()=>prisma.$disconnect());
test('logo picker previews, undoes and rejects oversized selections without writing',async()=>{
 const dom=new JSDOM('<input type="file" id="organization-logo"><img id="organization-logo-preview" src="/old-logo.png"><span id="organization-logo-placeholder" hidden></span><button id="organization-logo-reset" hidden>Undo</button><span id="organization-logo-caption"></span>',{url:'https://test.invalid',runScripts:'outside-only'});const w=dom.window,d=w.document;
 w.eval(fs.readFileSync('assets/js/organization-logo.js','utf8'));const input=d.getElementById('organization-logo');
 const choose=async file=>{Object.defineProperty(input,'files',{value:[file],configurable:true});input.dispatchEvent(new w.Event('change'));await new Promise(r=>setTimeout(r,25));};
 await choose(new w.File(['sample'],'logo.png',{type:'image/png'}));assert.match(d.getElementById('organization-logo-preview').src,/^data:image\/png/);assert.equal(d.getElementById('organization-logo-reset').hidden,false);
 d.getElementById('organization-logo-reset').click();assert.match(d.getElementById('organization-logo-preview').src,/old-logo.png$/);
 await choose(new w.File([new Uint8Array(2*1024*1024+1)],'big.png',{type:'image/png'}));assert.match(d.getElementById('organization-logo-caption').textContent,/under 2 MB/);assert.match(d.getElementById('organization-logo-preview').src,/old-logo.png$/);
 await choose(new w.File(['svg'],'logo.svg',{type:'image/svg+xml'}));assert.equal(d.getElementById('organization-logo-reset').hidden,true);dom.window.close();
});
test('multipart settings saves a logo, preserves old files, rejects invalid uploads and requires CSRF',async()=>{
 assert.match(process.env.DATABASE_NAME,/^ui_audit_/);
 const business=await prisma.business.create({data:{name:'Logo synthetic workspace',code:'LOGO'+Date.now()}});
 await profile.updateProfile({legalName:'Logo Test Company',logoUrl:'/images/default-avatar.png',email:'keep@example.test',stateCode:'27'},business.id);
 const server=http.createServer(require('../app/app'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const first=await fetch(base+'/login');let cookie=first.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const token=(await first.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token,email:'admin@email.com',password:process.env.SEED_ADMIN_PASSWORD})});assert.equal(login.status,302);cookie=login.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
  const headers={Cookie:cookie,'X-Business-Id':String(business.id)};const page=await fetch(base+'/settings',{headers});const html=await page.text();assert.equal(page.status,200);assert.match(html,/enctype="multipart\/form-data"/);const csrf=html.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const png=fs.readFileSync('assets/images/default-avatar.png');
  async function send(buffer=png,{tokenValue=csrf,name='logo.png',type='image/png',logoUrl='/images/default-avatar.png',requestHeaders=headers}={}){const form=new FormData();if(tokenValue)form.append('_csrf',tokenValue);form.append('legalName','Logo Test Company');form.append('email','keep@example.test');form.append('stateCode','27');form.append('logoUrl',logoUrl);if(buffer)form.append('logo',new Blob([buffer],{type}),name);return fetch(base+'/settings',{method:'POST',headers:{...requestHeaders,...(tokenValue?{'X-CSRF-Token':tokenValue}:{})},body:form});}
  assert.equal((await send()).status,200);const saved=await profile.getProfile(business.id);assert.match(saved.logoUrl,/^\/uploads\/logos\/[a-f0-9-]+\.png$/);assert.equal(saved.email,'keep@example.test');const savedFile=path.join('assets',saved.logoUrl);assert.deepEqual(fs.readFileSync(savedFile),png);
  assert.equal((await send(Buffer.from('fake PNG'))).status,400);assert.equal((await profile.getProfile(business.id)).logoUrl,saved.logoUrl);
  assert.equal((await send(png,{tokenValue:null})).status,403);assert.equal((await send(Buffer.alloc(2*1024*1024+1))).status,413);
  assert.equal((await send(png,{name:'logo.svg',type:'image/svg+xml'})).status,400);assert.equal((await profile.getProfile(business.id)).logoUrl,saved.logoUrl);
  assert.equal((await send(png,{logoUrl:saved.logoUrl})).status,200);assert.ok(fs.existsSync(savedFile),'Previous logo retained');const next=await profile.getProfile(business.id);assert.notEqual(next.logoUrl,saved.logoUrl);
  assert.equal((await send(null,{logoUrl:next.logoUrl})).status,200);assert.equal((await profile.getProfile(business.id)).logoUrl,next.logoUrl);
  const role=await prisma.role.create({data:{name:'Logo viewer '+Date.now()}});const bcrypt=require('bcrypt');const viewer=await prisma.user.create({data:{name:'Logo viewer',email:'logo-viewer-'+Date.now()+'@example.test',role:'STAFF',roleId:role.id,password:await bcrypt.hash('Logo-Test-Only-2026!',10)}});await prisma.businessMembership.create({data:{businessId:business.id,userId:viewer.id,role:'VIEWER',status:'ACTIVE',isDefault:true}});
  const viewerFirst=await fetch(base+'/login');const viewerCookie0=viewerFirst.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const viewerToken0=(await viewerFirst.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];const viewerLogin=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Cookie:viewerCookie0,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:viewerToken0,email:viewer.email,password:'Logo-Test-Only-2026!'})});assert.equal(viewerLogin.status,302);const viewerCookie=viewerLogin.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const viewerProfile=await fetch(base+'/profile',{headers:{Cookie:viewerCookie}});const viewerToken=(await viewerProfile.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
  assert.equal((await send(png,{tokenValue:viewerToken,requestHeaders:{Cookie:viewerCookie,'X-Business-Id':String(business.id)}})).status,403);assert.equal((await profile.getProfile(business.id)).logoUrl,next.logoUrl);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
