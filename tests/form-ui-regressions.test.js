'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const bcrypt=require('bcrypt');
const {JSDOM}=require('jsdom');
const prisma=require('../app/config/prisma');
const app=require('../app/app');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=','base64');
after(()=>prisma.$disconnect());
async function login(base,email,password){
 const first=await fetch(base+'/login');const cookie=first.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const token=(await first.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
 const result=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token,email,password})});assert.equal(result.status,302);return result.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
}
test('native multipart profile saves validate CSRF, enforce upload limits and retain data on failure',async()=>{
 assert.match(process.env.DATABASE_NAME,/^ui_audit_/);
 const password='Audit-Upload-Only-2026!';const user=await prisma.user.create({data:{name:'Upload audit user',email:`upload_${Date.now()}@example.test`,password:await bcrypt.hash(password,10),role:'STAFF',active:true}});
 const business=await prisma.business.findFirst();await prisma.businessMembership.create({data:{businessId:business.id,userId:user.id,role:'MEMBER',isDefault:true}});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const cookie=await login(base,user.email,password);const page=await fetch(base+'/profile',{headers:{Cookie:cookie}});assert.equal(page.status,200);const token=(await page.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
  const body=(csrf=true,file=png,name='avatar.png',mime='image/png')=>{const data=new FormData();if(csrf)data.set('_csrf',token);data.set('name',user.name);data.set('email',user.email);data.set('phone','9876543210');data.set('avatar',new Blob([file],{type:mime}),name);return data;};
  const response=await fetch(base+'/profile',{method:'POST',headers:{Cookie:cookie},body:body(),redirect:'manual'});assert.equal(response.status,302,await response.text());assert.equal(response.headers.get('location'),'/profile?success=true');
  const saved=await prisma.user.findUnique({where:{id:user.id}});assert.ok(saved.avatarUrl);assert.equal(saved.phone,'9876543210');const file=path.join(__dirname,'../assets',saved.avatarUrl);assert.deepEqual(fs.readFileSync(file),png);
  const dir=path.dirname(file),count=fs.readdirSync(dir).length;
  const denied=await fetch(base+'/profile',{method:'POST',headers:{Cookie:cookie},body:body(false)});assert.equal(denied.status,403);const html=await denied.text();assert.match(html,/>403<\/h1>/);assert.ok(!html.includes('>500</h1>'));
  for(const [bytes,name,mime,status]of [[Buffer.from('fake PNG'),'fake.png','image/png',400],[Buffer.from('<svg/>'),'bad.svg','image/svg+xml',400],[Buffer.alloc(2*1024*1024+1),'large.png','image/png',413]]){
   const failed=await fetch(base+'/profile',{method:'POST',headers:{Cookie:cookie,Accept:'application/json','X-CSRF-Token':token},body:body(true,bytes,name,mime)});assert.equal(failed.status,status,await failed.text());
  }
  assert.equal((await prisma.user.findUnique({where:{id:user.id}})).avatarUrl,saved.avatarUrl);assert.deepEqual(fs.readFileSync(file),png);assert.equal(fs.readdirSync(dir).length,count);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('authenticated list and editor pages render a single primary heading',async()=>{
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{const cookie=await login(base,'admin@email.com',process.env.SEED_ADMIN_PASSWORD);const business=await prisma.business.findFirst();
 for(const route of ['/suppliers','/suppliers/new','/purchases/orders','/purchases/bills','/purchases/receipts','/financials/expenses','/financials/other-income','/projects','/projects/new','/admin/businesses','/admin/numbering','/financial-years','/profile','/clients','/items','/units','/documents','/settings','/reports']){
  const response=await fetch(base+route,{headers:{Cookie:cookie,'X-Business-Id':String(business.id)}});assert.equal(response.status,200,route);const dom=new JSDOM(await response.text());assert.equal(dom.window.document.querySelectorAll('h1').length,1,route);dom.window.close();
 }
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('server-paged DataTables keep every loaded row and do not add a second pager',async()=>{
 const dom=new JSDOM(`<table data-spark-datatable="true" data-server-paginated="true"><thead><tr><th>Name</th></tr></thead><tbody>${Array.from({length:25},(_,i)=>`<tr><td>Record ${i}</td></tr>`).join('')}</tbody></table>`,{url:'http://audit.invalid/',runScripts:'outside-only'});
 await new Promise(r=>dom.window.addEventListener('load',r,{once:true}));dom.window.eval(fs.readFileSync('assets/js/spark-datatable.js','utf8'));
 assert.equal(dom.window.document.querySelectorAll('tbody tr').length,25);assert.equal(dom.window.document.querySelectorAll('.spark-dt-page-btn').length,0);assert.match(dom.window.document.querySelector('.spark-dt-info').textContent,/25/);dom.window.close();
});
test('profile AJAX failures retain inputs, send CSRF and re-enable save',async()=>{
 const dom=new JSDOM('<form id="profile-form" action="/profile"><input name="_csrf" value="test-token"><input name="name" value="Keep this name"><button type="submit">Save</button></form>',{url:'http://audit.invalid/',runScripts:'outside-only'});let request;
 dom.window.fetch=async(url,options)=>{request=options;return{ok:false,json:async()=>({success:false,error:'Invalid image content.'})};};dom.window.eval(fs.readFileSync('assets/js/profile.js','utf8'));
 const form=dom.window.document.querySelector('form');form.dispatchEvent(new dom.window.Event('submit',{cancelable:true,bubbles:true}));await new Promise(r=>setTimeout(r,10));
 assert.equal(form.elements.name.value,'Keep this name');assert.equal(form.querySelector('button').disabled,false);assert.equal(request.headers['X-CSRF-Token'],'test-token');assert.match(form.querySelector('[role="alert"]').textContent,/Invalid image/);dom.window.close();
});
test('failed avatar persistence keeps the old image and removes only the newly staged image',async()=>{
 assert.match(process.env.DATABASE_NAME,/^ui_audit_/);
 const directory=path.join(__dirname,'../assets/uploads/avatars');fs.mkdirSync(directory,{recursive:true});const name=`retained-${Date.now()}.png`;const original=path.join(directory,name);fs.writeFileSync(original,png);
 const user=await prisma.user.create({data:{name:'Retained avatar',email:`retained_${Date.now()}@example.test`,password:'synthetic-test-only',role:'STAFF',avatarUrl:'/uploads/avatars/'+name}});
 const count=fs.readdirSync(directory).length;const update=prisma.user.update;
 try{prisma.user.update=async()=>{throw Object.assign(new Error('Simulated unique constraint race'),{code:'P2002'});};await assert.rejects(require('../app/services/profile.service').updateUserProfile(user.id,{name:user.name,email:user.email},{buffer:png,originalname:'replacement.png'}),{statusCode:409});}
 finally{prisma.user.update=update;}
 assert.deepEqual(fs.readFileSync(original),png);assert.equal(fs.readdirSync(directory).length,count);assert.equal((await prisma.user.findUnique({where:{id:user.id}})).avatarUrl,user.avatarUrl);
});
test('actual supplier-bill form and void scripts submit valid CSRF to authenticated endpoints',async()=>{
 const admin=await prisma.user.findUnique({where:{email:'admin@email.com'}}),business=await prisma.business.findFirst();
 const supplier=await prisma.supplier.create({data:{businessId:business.id,name:`AAA UI Supplier ${Date.now()}`,createdById:admin.id}});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;const doms=[];
 try{
  const cookie=await login(base,admin.email,process.env.SEED_ADMIN_PASSWORD);const headers={Cookie:cookie,'X-Business-Id':String(business.id)};
  const page=await fetch(base+'/purchases/bills/new',{headers});assert.equal(page.status,200);const dom=new JSDOM(await page.text(),{url:base+'/purchases/bills/new',runScripts:'outside-only'});doms.push(dom);
  const outcomes=[];dom.window.alert=()=>{};dom.window.fetch=async(url,options)=>{assert.ok(options.headers['X-CSRF-Token']);const response=await fetch(base+url,{...options,headers:{...headers,...options.headers}});outcomes.push({status:response.status,data:await response.clone().json()});return response;};
  const script=[...dom.window.document.scripts].find(s=>s.textContent.includes("document.getElementById('billForm').addEventListener"));dom.window.eval(script.textContent);
  const form=dom.window.document.getElementById('billForm');form.elements.billNumber.value=`UI-BILL-${Date.now()}`;form.elements.supplierId.value=String(supplier.id);assert.equal(form.elements.supplierId.value,String(supplier.id));
  form.querySelector('.item-name').value=`UI untracked delivery ${Date.now()}`;form.querySelector('.item-rate').value='25';form.querySelector('.item-qty').value='0';
  const submit=async()=>{const count=outcomes.length;form.dispatchEvent(new dom.window.Event('submit',{cancelable:true,bubbles:true}));for(let i=0;i<150&&outcomes.length===count;i++)await new Promise(r=>setTimeout(r,20));await new Promise(r=>setTimeout(r,20));return outcomes.at(-1);};
  assert.equal((await submit()).status,400);assert.equal(form.querySelector('[type="submit"]').disabled,false);
  form.querySelector('.item-qty').value='2';const posted=await submit();assert.equal(posted.status,201,JSON.stringify(posted.data));
  const bill=await prisma.supplierBill.findFirst({where:{businessId:business.id,billNumber:form.elements.billNumber.value}});assert.ok(bill);
  const list=await fetch(base+'/purchases/bills',{headers});const view=new JSDOM(await list.text(),{url:base+'/purchases/bills',runScripts:'outside-only'});doms.push(view);view.window.alert=()=>{};view.window.prompt=()=>'Synthetic UI regression reversal';let reversed;
  view.window.fetch=async(url,options)=>{assert.ok(options.headers['X-CSRF-Token']);const response=await fetch(base+url,{...options,headers:{...headers,...options.headers}});reversed={status:response.status,data:await response.clone().json()};return response;};
  view.window.eval([...view.window.document.scripts].find(s=>s.textContent.includes('async function voidBill(')).textContent);await view.window.voidBill(bill.id);assert.equal(reversed.status,200,JSON.stringify(reversed.data));assert.equal((await prisma.supplierBill.findUnique({where:{id:bill.id}})).status,'VOID');
 }finally{for(const d of doms)d.window.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
