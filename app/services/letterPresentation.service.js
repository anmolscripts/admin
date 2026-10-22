'use strict';
const path=require('node:path');
const fs=require('node:fs');
const ejs=require('ejs');
const documents=require('./documentView.service');
const letters=require('./letter.service');
const templates=require('./template.service');
const {parseDocument,DomUtils}=require('htmlparser2');
async function render(letter,profile) {
    const templateConfig=templates.getTemplate(letter.templateId,letter.businessId);
    const model=documents.buildDocumentViewModel({invoiceNumber:letter.letterNumber,invoiceDate:letter.letterDate,clientName:letter.recipientName,status:letter.status,items:[]},profile);
    model.isLetter=true;model.documentType='LETTER';model.documentTitle='LETTER';model.typeLabel='Letter';
    model.letter={...letter,bodyHtml:letters.cleanBody(letter.bodyHtml),scopedCss:require('./letterContent.service').scopedCss(letter.bodyCss)};
    model.letter.blocks=parseDocument(model.letter.bodyHtml).children.filter(node=>node.type==='tag'||(node.type==='text'&&node.data.trim())).map(node=>({html:node.type==='text'?'<p>'+DomUtils.getOuterHTML(node)+'</p>':DomUtils.getOuterHTML(node),pageBreak:(node.attribs?.class||'').split(/\s+/).includes('letter-page-break')}));
    while(model.letter.blocks.at(-1)?.pageBreak)model.letter.blocks.pop();
    if(profile.logoUrl?.startsWith('/uploads/logos/')){
        const file=path.join(__dirname,'../../assets',profile.logoUrl);
        if(fs.existsSync(file)){const ext=path.extname(file).slice(1);model.seller.logo=`data:image/${ext==='jpg'?'jpeg':ext};base64,${fs.readFileSync(file).toString('base64')}`;}
    }
    const body=await ejs.renderFile(path.join(__dirname,'../views/documents/templates/document.ejs'),{model,templateConfig});
    return '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:; img-src data:; base-uri \'none\'; form-action \'none\'"><title>Letter</title><style>@page{size:A4;margin:10mm 12mm}body{margin:0;background:#fff;print-color-adjust:exact;-webkit-print-color-adjust:exact}</style></head><body>'+body+'</body></html>';
}
module.exports={render};
