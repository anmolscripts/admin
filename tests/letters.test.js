'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const prisma=require('../app/config/prisma');
const letters=require('../app/services/letter.service');
const presentation=require('../app/services/letterPresentation.service');
const templates=require('../app/services/template.service');
const http=require('node:http');
const ExcelJS=require('exceljs');
const {JSDOM,VirtualConsole}=require('jsdom');
const base={subject:'Business introduction',recipientName:'Example recipient',recipientAddress:'Example office',letterDate:'2026-10-21',bodyHtml:'<p>Dear team,</p><p><strong>Welcome</strong> to our company.</p>',templateId:'modern-minimal'};
after(()=>prisma.$disconnect());
test('letter rich text permits formatting and page breaks but blocks scripts, remote assets and dangerous CSS',()=>{
 const html=letters.cleanBody('<script>alert(1)</script><img src="http://private.test"><iframe src="https://example.test"></iframe><p onclick="alert(1)" style="color:rgb(10, 20, 30);position:fixed;background-image:url(https://private.test)"><strong>Safe</strong></p><a href="javascript:alert(1)">Bad</a><a href="https://example.test">Good</a><div class="letter-page-break evil"></div>');
 assert.ok(!/script|iframe|<img|onclick|position:|background-image|href="javascript/.test(html));
 assert.ok(html.includes('<strong>Safe</strong>'));assert.ok(html.includes('class="letter-page-break"'));assert.ok(html.includes('rel="noopener noreferrer"'));
 for(const data of [{...base,bodyHtml:'<p><br></p>'},{...base,bodyHtml:'x'.repeat(200001)},{...base,letterDate:'2026-02-30'},{...base,templateId:'foreign-template'},{...base,subject:[]},{...base,recipientName:''}])assert.throws(()=>letters.validate(data,1),{statusCode:400});
 assert.equal(letters.validate(base,1).subject,base.subject);
});
test('actual rich text editor retains formatting and round-trips page breaks through server sanitization',async()=>{
 const html=await ejs.renderFile(path.join(__dirname,'../app/views/letters/editor.ejs'),{pageTitle:'New Letter',pageSubtitle:'Compose',currentPath:'/documents/letters/new',user:{name:'Tester',role:'ADMIN'},hasPermission:()=>true,csrfToken:'audit',letter:{...base,letterDate:new Date(base.letterDate)},templates:templates.listTemplates(1),defaultTemplate:'modern-minimal'});
 const dom=new JSDOM(html,{url:'http://audit.invalid/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});
 try{
  const w=dom.window;w.document.createRange=(()=>{const original=w.document.createRange.bind(w.document);return()=>{const range=original();range.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0});range.getClientRects=()=>[];return range;};})();
  w.HTMLElement.prototype.scrollIntoView=()=>{};w.SparkFeedback={error:message=>{throw Error(message);}};
  w.eval(fs.readFileSync(path.join(__dirname,'../assets/libs/quill/quill.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'../assets/js/letters.js'),'utf8'));
  const editor=w.Quill.find(w.document.getElementById('letter-editor'));
  assert.ok(editor);assert.ok(editor.getSemanticHTML().includes('<strong>Welcome</strong>'));
  editor.setSelection(editor.getLength()-1,0,'silent');w.document.getElementById('letter-page-break').click();
  const result=letters.cleanBody(editor.getSemanticHTML());assert.ok(result.includes('class="letter-page-break"'));
  editor.clipboard.dangerouslyPasteHTML(result,'silent');assert.ok(editor.getSemanticHTML().includes('letter-page-break'));
  assert.equal(editor.root.getAttribute('aria-label'),'Letter content');
 }finally{dom.window.close();}
});
test('letters are tenant scoped, versioned, soft deleted and never post accounting entries',async()=>{
 assert.match(process.env.DATABASE_NAME,/^ui_audit_/);
 const actor=await prisma.user.findFirst({where:{role:'ADMIN'}});assert.ok(actor);
 const business=await prisma.business.create({data:{code:'LETTERS_'+Date.now(),name:'Letter test organization'}});
 const foreign=await prisma.business.create({data:{code:'LETTERS_FOREIGN_'+Date.now(),name:'Foreign organization'}});
 const invoiceCount=await prisma.invoice.count({where:{businessId:business.id}}),journalCount=await prisma.journalEntry.count({where:{businessId:business.id}});
 const letter=await letters.create(base,business.id,actor.id);
 assert.match(letter.letterNumber,/^LTR\/2026\/10\/\d+$/);assert.equal(letter.version,1);
 await assert.rejects(letters.get(letter.id,foreign.id),{statusCode:404});
 await assert.rejects(letters.change(letter.id,{...base,version:1},foreign.id,actor.id),{statusCode:404});
 const updated=await letters.change(letter.id,{...base,subject:'Revised letter',version:1},business.id,actor.id);
 assert.equal(updated.version,2);
 await assert.rejects(letters.change(letter.id,{...base,version:1},business.id,actor.id),{statusCode:409});
 const race=await Promise.allSettled(['A','B'].map(subject=>letters.change(letter.id,{...base,subject,version:2},business.id,actor.id)));
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.find(x=>x.status==='rejected').reason.statusCode,409);
 await assert.rejects(letters.change(letter.id,{version:3,reason:''},business.id,actor.id,'VOIDED'),{statusCode:400});
 const voided=await letters.change(letter.id,{version:3,reason:'Superseded'},business.id,actor.id,'VOIDED');assert.equal(voided.status,'VOID');
 await assert.rejects(letters.change(letter.id,{...base,version:4},business.id,actor.id),{statusCode:400});
 const deleted=await letters.change(letter.id,{version:4,reason:'Retire correspondence'},business.id,actor.id,'DELETED');assert.equal(deleted.status,'DELETED');
 const restored=await letters.change(letter.id,{version:5,reason:'Review voided letter'},business.id,actor.id,'RESTORED');assert.equal(restored.status,'VOID');
 const history=await letters.history(letter.id,business.id);assert.equal(history.length,6);assert.equal(history.at(-1).snapshot.bodyHtml,base.bodyHtml);assert.equal(history[0].reason,'Review voided letter');
 assert.equal(await prisma.invoice.count({where:{businessId:business.id}}),invoiceCount);assert.equal(await prisma.journalEntry.count({where:{businessId:business.id}}),journalCount);
 assert.equal((await letters.list(foreign.id,{status:'ALL'})).length,0);
 const copy=await letters.create({...base,bodyHtml:restored.bodyHtml},business.id,actor.id);assert.notEqual(copy.letterNumber,letter.letterNumber);assert.equal(copy.status,'ACTIVE');
});
test('letters reuse every invoice template, repeat letterhead for print, and omit financial sections',async()=>{
 const letter={...base,id:1,businessId:1,letterNumber:'LTR/2026/10/1',letterDate:new Date(base.letterDate),status:'VOID'};
 for(const template of templates.listTemplates(1)){
  const html=await presentation.render({...letter,templateId:template.id},{legalName:'Example company',address:'Company address',email:'office@example.test',phone:'1234567890'});
  assert.ok(html.includes(template.themeClass));assert.ok(html.includes('Business introduction'));assert.ok(html.includes('<strong>Welcome</strong>'));
  assert.ok(html.includes('table-header-group'));assert.ok(html.includes('table-footer-group'));assert.ok(html.includes('VOID'));
  assert.ok(!html.includes('Pending settlement account configuration'));assert.ok(!html.includes('Thanks for your Business!'));
 }
 const locals={pageTitle:'Letter',pageSubtitle:'Test',currentPath:'/documents/letters',user:{name:'Tester',role:'ADMIN'},hasPermission:()=>true,csrfToken:'audit',letter,templates:templates.listTemplates(1),defaultTemplate:'modern-minimal',filters:{},letters:[],revisions:[{version:1,action:'CREATED',changedAt:new Date(),changedById:1,snapshot:letter,contentText:'Welcome'}],actorNames:{1:'Tester'}};
 for(const name of ['index','editor','view'])await ejs.renderFile(path.join(__dirname,'../app/views/letters',name+'.ejs'),locals);
 assert.ok(fs.readFileSync(path.join(__dirname,'../app/views/documents/index.ejs'),'utf8').includes('/documents/letters'));
});
test('letter HTTP workflow enforces CSRF and permissions and exports multi-page correspondence',async()=>{
 assert.match(process.env.DATABASE_NAME,/^ui_audit_/);
 const server=http.createServer(require('../app/app'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 try{
  const loginPage=await fetch(origin+'/login');const initialCookie=loginPage.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const token0=(await loginPage.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const login=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{Cookie:initialCookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token0,email:process.env.SEED_ADMIN_EMAIL||'admin@email.com',password:process.env.SEED_ADMIN_PASSWORD})});assert.equal(login.status,302);
  const cookie=login.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
  const page=await fetch(origin+'/documents/letters',{headers:{Cookie:cookie}});assert.equal(page.status,200);const csrf=(await page.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
  const headers={Cookie:cookie,Accept:'application/json','Content-Type':'application/json','X-CSRF-Token':csrf};
  const payload={...base,bodyHtml:base.bodyHtml+'<div class="letter-page-break"></div>'+Array.from({length:260},(_,i)=>`<p>Paragraph ${i+1}: This correspondence explains the delivery and coordination process in detail, retaining its company letterhead and footer on every page.</p>`).join('')};
  const noCsrf=await fetch(origin+'/api/letters',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(noCsrf.status,403);
  const saved=await fetch(origin+'/api/letters',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(saved.status,201,await saved.clone().text());const letter=(await saved.json()).letter;
  for(const endpoint of [`/documents/letters/${letter.id}`,`/documents/letters/${letter.id}/edit`,`/documents/letters/new?copyFrom=${letter.id}`,`/documents/letters/${letter.id}/print`]){const response=await fetch(origin+endpoint,{headers:{Cookie:cookie}});assert.equal(response.status,200,endpoint+' '+await response.text());}
  const preview=await fetch(origin+'/api/letters/preview',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(preview.status,200);assert.ok((await preview.text()).includes('letter-page-break'));
  const excel=await fetch(origin+`/documents/letters/${letter.id}/excel`,{headers:{Cookie:cookie}});assert.equal(excel.status,200);const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(await excel.arrayBuffer()));const sheet=workbook.worksheets[0];assert.equal(sheet.getCell('A2').value,letter.letterNumber);const chunks=sheet.getColumn('H').values.slice(2);assert.ok(chunks.length>1);assert.ok(chunks.every(text=>text.length<=32000));assert.equal(chunks.join(''),letters.plainText(payload.bodyHtml));assert.ok(chunks.join('').includes('Paragraph 260'));
  const pdf=await fetch(origin+`/documents/letters/${letter.id}/pdf`,{headers:{Cookie:cookie}});assert.equal(pdf.status,200,await pdf.clone().text());const buffer=Buffer.from(await pdf.arrayBuffer());assert.equal(buffer.subarray(0,5).toString(),'%PDF-');const pages=buffer.toString('latin1').match(/\/Type\s*\/Page\b/g)||[];assert.ok(pages.length>2,'Long letter must have multiple PDF pages');
  fs.mkdirSync('data/letter-test-evidence',{recursive:true});fs.writeFileSync('data/letter-test-evidence/multi-page-letter.pdf',buffer);
  for(const [action,version] of [['void',1],['delete',2],['restore',3]]){const response=await fetch(origin+`/api/letters/${letter.id}/${action}`,{method:'POST',headers,body:JSON.stringify({version,reason:'Integration lifecycle check'})});assert.equal(response.status,200,await response.text());}
  const viewer=await prisma.user.create({data:{name:'Letter viewer',email:`letter_viewer_${Date.now()}@example.test`,password:await require('bcrypt').hash('Audit-Letters-2026!',10),role:'STAFF',active:true}});
  await prisma.businessMembership.create({data:{businessId:1,userId:viewer.id,role:'VIEWER',status:'ACTIVE',isDefault:true}});
  const viewPermission=await prisma.permission.findUnique({where:{module_action:{module:'DOCUMENTS',action:'VIEW'}}});assert.ok(viewPermission);
  await prisma.userPermission.create({data:{userId:viewer.id,permissionId:viewPermission.id}});
  const p=await fetch(origin+'/login');const cookie0=p.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const token=(await p.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const signin=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{Cookie:cookie0,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token,email:viewer.email,password:'Audit-Letters-2026!'})});assert.equal(signin.status,302);
  const viewerCookie=signin.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
  const readonly=await fetch(origin+'/documents/letters',{headers:{Cookie:viewerCookie}});assert.equal(readonly.status,200);const readonlyHtml=await readonly.text();assert.ok(!readonlyHtml.includes('href="/documents/letters/new"'));
  const viewerCsrf=readonlyHtml.match(/name="csrf-token" content="([^"]+)"/)[1];
  const denied=await fetch(origin+'/api/letters',{method:'POST',headers:{...headers,Cookie:viewerCookie,'X-CSRF-Token':viewerCsrf},body:JSON.stringify(base)});assert.equal(denied.status,403);assert.match(await denied.text(),/permission|access/i);
  await prisma.userPermission.deleteMany({where:{userId:viewer.id}});
  const createPermission=await prisma.permission.findUnique({where:{module_action:{module:'DOCUMENTS',action:'CREATE'}}});
  await prisma.userPermission.create({data:{userId:viewer.id,permissionId:createPermission.id}});
  const forbiddenCopy=await fetch(origin+`/documents/letters/new?copyFrom=${letter.id}`,{headers:{Cookie:viewerCookie}});assert.equal(forbiddenCopy.status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
