'use strict';
const sanitizeHtml=require('sanitize-html');
const postcss=require('postcss');
const selectorParser=require('postcss-selector-parser');
const {ValidationError}=require('./errorTypes');
const CONTENT_SCOPE='.letter-content-boundary > .letter-richtext';
const safeValue=/^(?!.*(?:url\s*\(|expression\s*\(|javascript|[<>\\])).{1,500}$/i;
const inlineProperties=['color','background-color','font-family','font-size','font-weight','font-style','text-decoration','text-align','text-indent','line-height','letter-spacing','word-spacing','vertical-align','border','border-color','border-width','border-style','border-radius','padding','padding-top','padding-right','padding-bottom','padding-left','margin','margin-top','margin-right','margin-bottom','margin-left','width','max-width','min-width','height','max-height','min-height','display','list-style-type','border-collapse','table-layout'];
function cleanHtml(html){
 if(typeof html!=='string'||Buffer.byteLength(html,'utf8')>200000)throw new ValidationError('Letter content must be under 200 KB.');
 return sanitizeHtml(html,{
  allowedTags:['p','br','strong','b','em','i','u','s','h1','h2','h3','h4','h5','h6','blockquote','ol','ul','li','span','a','div','section','article','header','footer','main','aside','small','sup','sub','mark','code','pre','hr','table','thead','tbody','tfoot','tr','td','th','caption','colgroup','col','dl','dt','dd'],
  allowedAttributes:{'*':['class','id','style','title'],a:['href','title','rel','target'],td:['colspan','rowspan','data-row'],th:['colspan','rowspan','scope'],li:[{name:'data-list',values:['checked','unchecked','bullet','ordered']}],ol:['start']},
  allowedStyles:{'*':Object.fromEntries(inlineProperties.map(property=>[property,[safeValue]]))},
  allowedSchemes:['https','http','mailto'],allowProtocolRelative:false,
  transformTags:{a:(tagName,attribs)=>({tagName,attribs:{...attribs,rel:'noopener noreferrer',target:'_blank'}})}
 });
}
function cleanCss(value=''){
 if(value==null)value='';
 if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>50000)throw new ValidationError('Letter CSS must be under 50 KB.');
 if(!value.trim())return '';
 if(/[<\\]|(?:url|image-set|image|cross-fade|paint|element|src|expression)\s*\(|(?:https?:)?\/\//i.test(value))throw new ValidationError('CSS cannot load external resources, use escaped identifiers, or contain HTML.');
 let root;
 try{root=postcss.parse(value);}catch(error){throw new ValidationError(`CSS syntax error at line ${error.line||1}: ${error.reason||'invalid CSS'}.`);}
 root.walkAtRules(rule=>{if(!['media','supports'].includes(rule.name.toLowerCase()))throw new ValidationError('Only @media and @supports are supported. Global rules such as @import, @page and @keyframes are not allowed.');});
 root.walkRules(rule=>{
  if(rule.parent.type!=='root'&&rule.parent.type!=='atrule')throw new ValidationError('Use flat CSS rules rather than nested selectors.');
  try{selectorParser().astSync(rule.selector);}catch(_){throw new ValidationError('CSS contains an invalid selector.');}
  if(rule.selector.includes('&'))throw new ValidationError('Use flat CSS selectors without & nesting.');
 });
 root.walkDecls(decl=>{
  if(/^(?:behavior|-moz-binding)$/i.test(decl.prop)||(/^position$/i.test(decl.prop)&&!/^(?:static|relative|absolute)$/i.test(decl.value.trim())))throw new ValidationError('Only static, relative or absolute positioning is allowed in letter content.');
 });
 return root.toString();
}
function scopedCss(value){
 const css=cleanCss(value);if(!css)return '';
 const root=postcss.parse(css);
 root.walkRules(rule=>{
  rule.selector=selectorParser(selectors=>{
   selectors.each(selector=>{
    const isRoot=node=>node&&((node.type==='tag'&&['html','body'].includes(node.value.toLowerCase()))||(node.type==='pseudo'&&node.value===':root'));
    if(isRoot(selector.first)){
     selector.first.remove();
     while(selector.first?.type==='combinator'&&selector.first.value.trim()===''&&isRoot(selector.nodes[1])){selector.first.remove();selector.first.remove();}
    }else selector.prepend(selectorParser.combinator({value:' '}));
    const prefix=selectorParser().astSync(CONTENT_SCOPE).first.nodes;
    for(const node of [...prefix].reverse())selector.prepend(node.clone());
   });
  }).processSync(rule.selector);
 });
 return root.toString();
}
function preview(html,css){
 const body=cleanHtml(html),styles=scopedCss(css);
 return '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>Content preview</title><style>body{margin:0;padding:24px;background:#fff;color:#17283d;font:16px/1.7 Arial,sans-serif}.letter-content-boundary{position:relative;contain:paint;isolation:isolate;overflow:hidden;max-width:100%}.letter-richtext{overflow-wrap:anywhere}.letter-richtext p{margin:0 0 1em}.letter-richtext table{width:100%;border-collapse:collapse;table-layout:fixed}.letter-richtext td,.letter-richtext th{border:1px solid #bcc6d1;padding:8px}.letter-richtext pre{white-space:pre-wrap}.letter-page-break{border-top:1px dashed #bac7d1;margin:20px 0}.ql-align-center{text-align:center}.ql-align-right{text-align:right}.ql-align-justify{text-align:justify}'+".letter-richtext .ql-indent-1{padding-left:2em}.letter-richtext .ql-indent-2{padding-left:4em}.letter-richtext .ql-indent-3{padding-left:6em}.letter-richtext .ql-indent-4{padding-left:8em}.letter-richtext .ql-indent-5{padding-left:10em}.letter-richtext .ql-indent-6{padding-left:12em}.letter-richtext .ql-indent-7{padding-left:14em}.letter-richtext .ql-indent-8{padding-left:16em}.letter-richtext li[data-list=\"bullet\"]{list-style-type:disc}.letter-richtext li[data-list=\"checked\"],.letter-richtext li[data-list=\"unchecked\"]{list-style-type:none}.letter-richtext li[data-list=\"checked\"]::before{content:\"☑ \";}.letter-richtext li[data-list=\"unchecked\"]::before{content:\"☐ \";}.letter-richtext .ql-font-serif{font-family:Georgia,serif}.letter-richtext .ql-font-monospace{font-family:monospace}"+styles+'</style></head><body><div class="letter-content-boundary"><div class="letter-richtext">'+body+'</div></div></body></html>';
}
module.exports={cleanHtml,cleanCss,scopedCss,CONTENT_SCOPE,preview};
