'use strict';
const prisma = require('../config/prisma');
const sanitizeHtml = require('sanitize-html');
const numbering = require('./numbering.service');
const templates = require('./template.service');
const {ValidationError,NotFoundError,ConflictError} = require('./errorTypes');
const content=require('./letterContent.service');

function cleanBody(html) {
    return content.cleanHtml(html);
}
function plainText(html) {
    return sanitizeHtml(html.replace(/<\/(?:p|h[1-6]|li|blockquote|td|th|tr|pre|div|section)>/g,'\n'),{allowedTags:[],allowedAttributes:{}})
        .replace(/&(amp|lt|gt|quot|#39|nbsp);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'",nbsp:' '}[key])).trim();
}
function validate(input,businessId) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidationError('Invalid letter data.');
    const text = (key,max,required=false) => {
        if (input[key] !== undefined && typeof input[key] !== 'string') throw new ValidationError(`Invalid ${key}.`);
        const value=(input[key]||'').trim();
        if ((required&&!value)||value.length>max) throw new ValidationError(`${key} is required and must be at most ${max} characters.`);
        return value;
    };
    const date=text('letterDate',10,true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(new Date(date).getTime())||new Date(date).toISOString().slice(0,10)!==date) throw new ValidationError('Choose a valid letter date.');
    const bodyHtml=cleanBody(input.bodyHtml);
    if (!plainText(bodyHtml)) throw new ValidationError('Write some letter content before saving.');
    const templateId=text('templateId',100,true);
    if(!templates.listTemplates(businessId).some(t=>t.id===templateId)) throw new ValidationError('Choose an available document template.');
    const editorMode=input.editorMode||'RICH';
    if(!['RICH','CODE'].includes(editorMode))throw new ValidationError('Invalid editor mode.');
    return {subject:text('subject',255,true),recipientName:text('recipientName',255,true),recipientAddress:text('recipientAddress',5000),letterDate:new Date(date),bodyHtml,bodyCss:content.cleanCss(input.bodyCss),editorMode,templateId};
}
function scope(businessId) {
    const id=Number(businessId);
    if(!Number.isSafeInteger(id)||id<=0) throw new ValidationError('Choose an organization first.');
    return id;
}
async function get(id,businessId,client=prisma) {
    id=Number(id);
    if(!Number.isInteger(id)||id<1||id>2147483647)throw new ValidationError('Invalid letter ID.');
    const letter=await client.letter.findFirst({where:{id,businessId:scope(businessId)}});
    if(!letter)throw new NotFoundError('Letter not found in this organization.');
    return letter;
}
async function list(businessId,query={},includeContent=false) {
    const where={businessId:scope(businessId)};
    const status=String(query.status||'ACTIVE');
    if(status!=='ALL') {
        if(!['ACTIVE','VOID','DELETED'].includes(status))throw new ValidationError('Invalid letter status.');
        where.status=status;
    }
    if(query.q){const contains=String(query.q).slice(0,255);where.OR=[{subject:{contains}},{recipientName:{contains}},{letterNumber:{contains}}];}
    return prisma.letter.findMany({where,orderBy:{id:'desc'},take:500,select:{id:true,letterNumber:true,subject:true,recipientName:true,recipientAddress:true,letterDate:true,status:true,version:true,bodyHtml:includeContent}});
}
async function revision(tx,letter,action,reason,actorId) {
    await tx.letterRevision.create({data:{letterId:letter.id,version:letter.version,action,reason:reason||null,changedById:actorId,snapshot:JSON.parse(JSON.stringify(letter))}});
    await tx.userActivityLog.create({data:{actorUserId:actorId,businessId:letter.businessId,module:'DOCUMENTS',action:`LETTER_${action}`,targetType:'LETTER',targetId:String(letter.id),targetReference:letter.letterNumber,metadata:{version:letter.version,reason:reason||null}}});
}
async function create(input,businessId,actorId) {
    businessId=scope(businessId);
    const data=validate(input,businessId);
    return prisma.$transaction(async tx=>{
        const letterNumber=await numbering.allocateNumber({businessId,entityType:'LETTER',date:data.letterDate,tx});
        const letter=await tx.letter.create({data:{...data,businessId,letterNumber,createdById:actorId,updatedById:actorId}});
        await revision(tx,letter,'CREATED',null,actorId);
        return letter;
    });
}
async function change(id,input,businessId,actorId,action='UPDATED') {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidationError('Invalid letter data.');
    const version=Number(input.version);
    if(!Number.isSafeInteger(version)||version<1)throw new ValidationError('The letter version is required. Reload before saving.');
    const allowed=['UPDATED','VOIDED','DELETED','RESTORED'];
    if(!allowed.includes(action))throw new ValidationError('Invalid letter action.');
    let reason=null;
    if(action!=='UPDATED') {
        reason=typeof input.reason==='string'?input.reason.trim():'';
        if(!reason||reason.length>2000)throw new ValidationError('Enter an action reason (up to 2000 characters).');
    }
    const data=action==='UPDATED'?validate(input,businessId):{};
    return prisma.$transaction(async tx=>{
        const existing=await get(id,businessId,tx);
        if(existing.version!==version)throw new ConflictError('This letter was changed by someone else. Reload it before saving.');
        if(action==='RESTORED') {
            if(existing.status!=='DELETED')throw new ValidationError('Only deleted letters can be restored.');
            // Restoration keeps voided correspondence voided.
            const previous=await tx.letterRevision.findFirst({where:{letterId:existing.id,version:version-1}});
            data.status=previous?.snapshot?.status==='VOID'?'VOID':'ACTIVE';
        } else if(action==='DELETED') {
            if(existing.status==='DELETED')throw new ValidationError('This letter is already deleted.');
            data.status='DELETED';
        } else {
            if(existing.status!=='ACTIVE')throw new ValidationError('Only active letters can be edited or voided. Copy this letter to create a new one.');
            if(action==='VOIDED')data.status='VOID';
        }
        const result=await tx.letter.updateMany({where:{id:existing.id,businessId:existing.businessId,version},data:{...data,version:{increment:1},updatedById:actorId}});
        if(result.count!==1)throw new ConflictError('Letter changed while saving. Reload it.');
        const letter=await get(id,businessId,tx);
        await revision(tx,letter,action,reason,actorId);
        return letter;
    });
}
async function history(id,businessId) {
    await get(id,businessId);
    return prisma.letterRevision.findMany({where:{letterId:Number(id)},orderBy:{version:'desc'}});
}
module.exports={cleanBody,plainText,validate,get,list,create,change,history};
