'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const bcrypt=require('bcrypt');
const http=require('node:http');
const prisma=require('../app/config/prisma');
const service=require('../app/services/business.service');
after(()=>prisma.$disconnect());
test('organization rename synchronizes branding, preserves profile details and records atomic history',async()=>{
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const org=await prisma.business.create({data:{code:`RENAME_${Date.now()}`,name:'Original organization',legalName:'Original legal entity'}});
    await prisma.businessProfile.create({data:{businessId:org.id,legalName:'Original legal entity',displayName:org.name,workspaceName:org.name,email:'keep@example.test',address:'Retain this address',bankName:'Preserved bank',accountNumber:'TEST-ACCOUNT',gstin:'27AABCS1429B1ZB'}});
    const updated=await service.updateBusiness(org.id,{name:'Renamed organization',legalName:'Renamed legal entity',_version:org.updatedAt.toISOString()});
    const profile=await prisma.businessProfile.findFirst({where:{businessId:org.id}});
    assert.equal(profile.workspaceName,updated.name);assert.equal(profile.displayName,updated.name);assert.equal(profile.legalName,updated.legalName);
    assert.equal(profile.bankName,'Preserved bank');assert.equal(profile.accountNumber,'TEST-ACCOUNT');assert.equal(profile.email,'keep@example.test');assert.equal(profile.address,'Retain this address');assert.equal(profile.gstin,'27AABCS1429B1ZB');
    const log=await prisma.userActivityLog.findFirst({where:{targetType:'BUSINESS',targetId:String(org.id),action:'BUSINESS_UPDATED'},orderBy:{id:'desc'}});
    assert.deepEqual(log.metadata.changes.find(c=>c.field==='name'),{field:'name',before:'Original organization',after:'Renamed organization'});
    await assert.rejects(service.updateBusiness(org.id,{name:'Stale rename',_version:org.updatedAt.toISOString()}),{statusCode:409});
    await assert.rejects(service.updateBusiness(org.id,{name:'Should roll back'},2147483647));
    assert.equal((await prisma.business.findUnique({where:{id:org.id}})).name,updated.name);
    assert.equal((await prisma.businessProfile.findFirst({where:{businessId:org.id}})).workspaceName,updated.name);
    await assert.rejects(service.updateBusiness(org.id,{name:'x'.repeat(256)}),{statusCode:400});
});
test('organization edit endpoint requires owner/admin membership and renders an edit action',async()=>{
    const org=await prisma.business.create({data:{code:`ROLE_EDIT_${Date.now()}`,name:'Role edit organization'}});
    const password='Audit-Organization-2026!';
    const user=await prisma.user.create({data:{name:'Organization viewer',email:`org_viewer_${Date.now()}@example.test`,password:await bcrypt.hash(password,10),role:'STAFF',active:true}});
    await prisma.businessMembership.create({data:{businessId:org.id,userId:user.id,role:'VIEWER',status:'ACTIVE',isDefault:true}});
    const server=http.createServer(require('../app/app'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    try {
        const initial=await fetch(base+'/login');const cookie0=initial.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const token0=(await initial.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
        const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Cookie:cookie0,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token0,email:user.email,password})});assert.equal(login.status,302);
        const cookie=login.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];const headers={Cookie:cookie,Accept:'application/json','X-Business-Id':String(org.id)};
        const getPage=async()=>{const response=await fetch(base+'/admin/businesses',{headers});assert.equal(response.status,200);return response.text();};
        let html=await getPage();assert.ok(!html.includes(`aria-label="Edit ${org.name}"`));
        let token=html.match(/name="csrf-token" content="([^"]+)"/)[1];
        const submit=(id,name)=>fetch(base+`/api/businesses/${id}`,{method:'POST',headers:{...headers,'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({name,_version:org.updatedAt.toISOString()})});
        assert.equal((await submit(org.id,'Forbidden rename')).status,403);
        await prisma.businessMembership.update({where:{userId_businessId:{userId:user.id,businessId:org.id}},data:{role:'OWNER'}});
        html=await getPage();assert.ok(html.includes(`aria-label="Edit ${org.name}"`));token=html.match(/name="csrf-token" content="([^"]+)"/)[1];
        const foreign=await prisma.business.findFirst({where:{id:{not:org.id}}});assert.equal((await submit(foreign.id,'Foreign rename')).status,403);
        const saved=await submit(org.id,'Owner renamed organization');assert.equal(saved.status,200,await saved.text());
        html=await getPage();assert.ok(html.includes('Owner renamed organization'));
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
