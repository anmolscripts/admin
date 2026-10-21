'use strict';
const letters=require('../services/letter.service');
const presentation=require('../services/letterPresentation.service');
const templates=require('../services/template.service');
const profiles=require('../services/businessProfile.service');
const pdf=require('../services/pdf.service');
const ExcelJS=require('exceljs');
const {ValidationError}=require('../services/errorTypes');
const wrap=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){next(error);}};
const id=req=>{const value=Number(req.params.id);if(!Number.isSafeInteger(value)||value<1)throw new ValidationError('Invalid letter ID.');return value;};
const actor=req=>req.session.user.id;
const fileName=letter=>letter.letterNumber.replace(/[^a-z0-9_-]/gi,'_');
exports.index=wrap(async(req,res)=>res.render('letters/index',{pageTitle:'Letters',pageSubtitle:'Write and manage branded correspondence.',letters:await letters.list(req.businessId,req.query),filters:req.query}));
exports.editor=wrap(async(req,res)=>{
    let letter=null;
    if(req.params.id){letter=await letters.get(id(req),req.businessId);if(letter.status!=='ACTIVE')throw new ValidationError('Copy this letter to create an editable version.');}
    else if(req.query.copyFrom){letter={...await letters.get(Number(req.query.copyFrom),req.businessId),id:null,version:null,letterNumber:null,status:'ACTIVE'};}
    res.render('letters/editor',{pageTitle:letter?.id?'Edit Letter':'New Letter',pageSubtitle:'Compose a letter with your invoice and quotation branding.',letter,templates:templates.listTemplates(req.businessId),defaultTemplate:templates.getActiveTemplates(req.businessId).invoiceTemplate});
});
exports.view=wrap(async(req,res)=>{
    const letter=await letters.get(id(req),req.businessId);
    const revisions=await letters.history(letter.id,req.businessId);
    const actorIds=[...new Set(revisions.map(r=>r.changedById))];
    const users=await require('../config/prisma').user.findMany({where:{id:{in:actorIds}},select:{id:true,name:true}});
    const actorNames=Object.fromEntries(users.map(u=>[u.id,u.name]));
    res.render('letters/view',{pageTitle:letter.letterNumber,pageSubtitle:letter.subject,letter,revisions:revisions.map(r=>({...r,contentText:letters.plainText(r.snapshot.bodyHtml)})),actorNames});
});
exports.create=wrap(async(req,res)=>res.status(201).json({success:true,letter:await letters.create(req.body,req.businessId,actor(req))}));
exports.update=wrap(async(req,res)=>res.json({success:true,letter:await letters.change(id(req),req.body,req.businessId,actor(req))}));
exports.action=action=>wrap(async(req,res)=>res.json({success:true,letter:await letters.change(id(req),req.body,req.businessId,actor(req),action)}));
exports.preview=wrap(async(req,res)=>{
    const letter={...letters.validate(req.body,req.businessId),businessId:req.businessId,letterNumber:'UNSAVED PREVIEW',status:'ACTIVE'};
    res.type('html').send(await presentation.render(letter,await profiles.getProfile(req.businessId)));
});
exports.html=wrap(async(req,res)=>{
    const letter=await letters.get(id(req),req.businessId);
    let html=await presentation.render(letter,await profiles.getProfile(req.businessId));
    if(req.path.endsWith('/print')) html=html.replace('</body>','<button class="print-action" onclick="window.print()">Print / Save as PDF</button><style>.print-action{position:fixed;right:20px;bottom:20px;padding:12px 20px;background:#123d2b;color:#fff;border:0;border-radius:8px;cursor:pointer}@media print{.print-action{display:none}}</style></body>');
    res.type('html').send(html);
});
exports.pdf=wrap(async(req,res)=>{
    const letter=await letters.get(id(req),req.businessId);
    const html=await presentation.render(letter,await profiles.getProfile(req.businessId));
    res.type('pdf').attachment(fileName(letter)+'.pdf').send(await pdf.generateHtmlPdf(html));
});
exports.excel=wrap(async(req,res)=>{
    const rows=req.params.id?[await letters.get(id(req),req.businessId)]:await letters.list(req.businessId,req.query,true);
    const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Letters');
    sheet.columns=[{header:'Reference',key:'letterNumber',width:26},{header:'Date',key:'letterDate',width:16},{header:'Subject',key:'subject',width:45},{header:'Recipient',key:'recipientName',width:30},{header:'Address',key:'recipientAddress',width:35},{header:'Status',key:'status',width:14},{header:'Version',key:'version',width:10},{header:'Letter content',key:'content',width:90}];
    for(const letter of rows){
        const text=letters.plainText(letter.bodyHtml);
        // Excel cells have a 32,767-character limit; continuation rows retain the complete letter.
        for(let offset=0;offset<text.length;){
            let end=Math.min(offset+32000,text.length);
            if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
            sheet.addRow({...letter,letterDate:letter.letterDate.toISOString().slice(0,10),content:text.slice(offset,end)});
            offset=end;
        }
    }
    sheet.getRow(1).font={bold:true};sheet.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};});
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('letters.xlsx').send(Buffer.from(await book.xlsx.writeBuffer()));
});
