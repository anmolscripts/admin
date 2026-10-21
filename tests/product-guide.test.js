'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ejs=require('ejs');
const {JSDOM}=require('jsdom');
const {lessons,screens}=require('../app/content/product-guide');
const guide=require('../app/services/productGuide.service');
const context=(permissions=[],role='STAFF')=>({role,hasPermission:(m,a)=>permissions.includes(m+':'+a)});
const all={role:'ADMIN',hasPermission:()=>true};
function page(ctx=all,selected='',query=''){
 const chapters=guide.catalogue(ctx).map(c=>({...c,search:guide.searchText(c),screen:c.screen?{...c.screen,available:true}:null}));
 return ejs.render(fs.readFileSync('app/views/product-guide/index.ejs','utf8'),{chapters,selected,guideQuery:query,guideRole:ctx.role,guideUserId:99,guideBusinessId:12,include:()=>''});
}
function browser(html=page()){
 const dom=new JSDOM(html,{url:'https://guide.example.test/product-guide',runScripts:'outside-only'});
 dom.window.HTMLElement.prototype.scrollIntoView=function(){};
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 dom.window.fetch=()=>{throw new Error('Learning tools must not write to a server');};
 dom.window.eval(fs.readFileSync('assets/js/product-guide.js','utf8'));return dom;
}
test('documentation authoring has complete sections, internal links and whitelisted screenshots',()=>{
 assert.equal(new Set(lessons.map(c=>c.id)).size,lessons.length);assert.ok(lessons.length>=30);
 for(const c of lessons){assert.ok(c.summary&&c.simple&&c.outcome&&c.steps.length);for(const s of c.steps)assert.ok(s.title&&s.body&&s.check);if(c.screen)assert.ok(screens[c.screen]);if(c.quiz)assert.ok(c.quiz.choices[c.quiz.answer]&&c.quiz.why);for(const l of c.links||[])assert.match(Array.isArray(l)?l[1]:l.href,/^\/(?!\/)/);}
});
test('guide filters chapters, action steps and screenshots by effective permissions, not role labels',()=>{
 const none=guide.catalogue(context([], 'ADMIN'));assert.ok(none.some(c=>c.id==='profile'));assert.ok(!none.some(c=>c.id==='templates'));
 const viewer=guide.catalogue(context(['DOCUMENTS:VIEW','SETTINGS:VIEW']));
 assert.ok(viewer.some(c=>c.id==='document-basics'));assert.ok(!viewer.some(c=>c.id==='create-document'));assert.equal(viewer.find(c=>c.id==='templates').screen,null);
 assert.ok(!viewer.find(c=>c.id==='records').steps.some(s=>s.title==='Make a permitted edit'));
 const fullRecord=guide.catalogue(all).find(c=>c.id==='records');for(const step of viewer.find(c=>c.id==='records').steps)assert.equal(step.anchor,fullRecord.steps.find(s=>s.title===step.title).anchor);
 assert.equal(guide.getScreen('editor',context(['DOCUMENTS:VIEW'])),null);assert.ok(guide.getScreen('editor',context(['DOCUMENTS:EDIT'])));
 for(const id of ['../profile','constructor','__proto__','unknown'])assert.equal(guide.getScreen(id,all),null);
 const html=page(context());assert.ok(!html.includes('id="lesson-payroll-api"'));assert.ok(!JSON.parse(new JSDOM(html).window.document.getElementById('guide-data').textContent).chapters.some(c=>c.id==='payroll-api'));
});
test('guide search escapes script delimiters and preserves exact searchable text',()=>{
 const html=page(all,'','</script><img src=x onerror=alert(1)>');const dom=new JSDOM(html);
 const data=JSON.parse(dom.window.document.getElementById('guide-data').textContent);assert.equal(data.query,'</script><img src=x onerror=alert(1)>');assert.equal(dom.window.document.querySelector('[onerror]'),null);dom.window.close();
});
test('documentation has topic navigation, reference articles and a table of contents instead of quizzes',()=>{
 const dom=browser(page(all,'welcome')),d=dom.window.document;
 assert.ok(d.getElementById('guide-toc-links').children.length>=4);assert.equal(d.querySelector('.guide-quiz,.guide-hero,[data-guide-complete]'),null);
 assert.ok(d.querySelector('#lesson-welcome h3[id]'));assert.equal(new Set([...d.querySelectorAll('[id]')].map(el=>el.id)).size,d.querySelectorAll('[id]').length);
 dom.window.close();
});
test('section search links directly to detailed content and bookmarks stay scoped to account and business',()=>{
 const dom=browser(page(all,'welcome')),w=dom.window,d=w.document;
 d.querySelector('[data-guide-save="welcome"]').click();let saved=JSON.parse(w.localStorage.getItem('spark-guide-v1:99:12'));assert.deepEqual(saved.saved,['welcome']);assert.equal(w.localStorage.getItem('spark-guide-v1:99:13'),null);
 d.getElementById('guide-bookmarks').click();assert.equal(d.querySelector('[data-chapter-result="profile"]').hidden,true);assert.equal(d.querySelector('[data-chapter-result="welcome"]').hidden,false);
 d.getElementById('guide-home').click();const search=d.getElementById('guide-search');search.value='profile photo';search.dispatchEvent(new w.Event('input'));assert.equal(d.getElementById('guide-search-results').hidden,false);
 const result=d.querySelector('.docs-section-result');assert.ok(result);assert.ok(result.nextElementSibling.textContent.length>20);result.click();assert.ok(w.location.hash);assert.equal(d.getElementById('guide-search-results').hidden,true);assert.equal(d.activeElement.id,w.location.hash.slice(1));
 search.value='nonexistentXYZ';search.dispatchEvent(new w.Event('input'));assert.equal(d.getElementById('guide-no-results').hidden,false);
 d.getElementById('guide-clear-search').click();assert.equal(d.getElementById('guide-overview').hidden,false);assert.equal(d.querySelector('.docs-nav-group').hidden,false);dom.window.close();
});
test('documentation keyboard search, section links, previous/next and screenshot zoom work',()=>{
 const dom=browser(page(all,'welcome')),w=dom.window,d=w.document;
 d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'/',bubbles:true,cancelable:true}));assert.equal(d.activeElement.id,'guide-search');
 d.querySelector('#guide-toc-links a').click();assert.ok(w.location.hash);assert.equal(d.activeElement.tagName,'H3');
 d.querySelector('#lesson-welcome [data-guide-next]').click();assert.equal(d.getElementById('lesson-profile').hidden,false);assert.match(d.querySelector('#lesson-profile [data-guide-prev] span').textContent,/Introduction/);
 const zoom=d.querySelector('#lesson-profile [data-guide-zoom]');zoom.click();assert.equal(d.getElementById('guide-image-dialog').open,true);for(let i=0;i<12;i++)d.getElementById('guide-zoom-in').click();assert.equal(d.getElementById('guide-zoom-level').textContent,'300%');d.getElementById('guide-zoom-close').click();assert.equal(d.activeElement,zoom);dom.window.close();
});
test('every training illustration uses sample data and contains no executable script or writable form',()=>{
 for(const screen of Object.values(screens)){const html=ejs.render(fs.readFileSync('app/views/product-guide/screen.ejs','utf8'),{screen});const dom=new JSDOM(html);assert.equal(dom.window.document.querySelectorAll('script,form').length,0);assert.match(dom.window.document.body.textContent,/SAMPLE DATA/);assert.ok(dom.window.document.getElementById('training-frame'));dom.window.close();}
});
test('account menu places Product Guide immediately after My Profile',()=>{
 const header=fs.readFileSync('app/views/layouts/header.ejs','utf8');assert.match(header,/href="\/profile"[\s\S]*?<\/li>\s*<li>\s*<a[^>]+href="\/product-guide"/);
});

const prisma=require('../app/config/prisma');after(()=>prisma.$disconnect());
test('authenticated HTTP guide omits restricted content and denies guessed chapters and images',async()=>{
 require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
 const http=require('node:http'),bcrypt=require('bcrypt');
 const stamp=Date.now();const role=await prisma.role.create({data:{name:'Guide viewer '+stamp}});
 const permission=await prisma.permission.findUniqueOrThrow({where:{module_action:{module:'DOCUMENTS',action:'VIEW'}}});
 await prisma.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});
 const user=await prisma.user.create({data:{name:'Guide sample viewer',email:`guide-${stamp}@example.test`,password:await bcrypt.hash('Guide-Test-Only-2026!',10),role:'STAFF',roleId:role.id}});
 const business=await prisma.business.create({data:{code:'GUIDE'+stamp,name:'Guide synthetic workspace'}});
 await prisma.businessMembership.create({data:{businessId:business.id,userId:user.id,role:'VIEWER',status:'ACTIVE',isDefault:true}});
 const server=http.createServer(require('../app/app'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const anonymous=await fetch(base+'/product-guide',{redirect:'manual'});assert.equal(anonymous.status,302);
  const loginPage=await fetch(base+'/login');let cookie=loginPage.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const token=(await loginPage.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token,email:user.email,password:'Guide-Test-Only-2026!'})});assert.equal(login.status,302);cookie=login.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
  const headers={Cookie:cookie,'X-Business-Id':String(business.id),'X-Role':'ADMIN'};
  const response=await fetch(base+'/product-guide',{headers});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/private, no-store/);
  const dom=new JSDOM(await response.text());assert.ok(dom.window.document.getElementById('lesson-document-basics'));assert.equal(dom.window.document.getElementById('lesson-create-document'),null);assert.equal(dom.window.document.getElementById('lesson-team'),null);assert.equal(dom.window.document.querySelector('.navbar-profile-img').getAttribute('src'),'/images/default-avatar.png');dom.window.close();
  const ownProfile=await fetch(base+'/profile',{headers});assert.equal(ownProfile.status,200);const profileDom=new JSDOM(await ownProfile.text());assert.equal(profileDom.window.document.getElementById('avatar-preview').getAttribute('src'),'/images/default-avatar.png');profileDom.window.close();
  const defaultImage=await fetch(base+'/images/default-avatar.png');assert.equal(defaultImage.status,200);assert.deepEqual(Buffer.from(await defaultImage.arrayBuffer()),fs.readFileSync('assets/images/default-avatar.png'));
  for(const route of ['/product-guide?lesson=team','/product-guide?lesson=create-document','/product-guide/screens/templates','/product-guide/demo/templates','/product-guide/screens/constructor'])assert.equal((await fetch(base+route,{headers})).status,404,route);
  const demo=await fetch(base+'/product-guide/demo/documents',{headers});assert.equal(demo.status,200);assert.match(demo.headers.get('content-security-policy'),/script-src 'none'/);
  if(fs.existsSync('app/content/product-guide-screens/documents.png')){const screenshot=await fetch(base+'/product-guide/screens/documents',{headers});assert.equal(screenshot.status,200);assert.match(screenshot.headers.get('content-type'),/image\/png/);assert.match(screenshot.headers.get('cache-control'),/private/);}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
