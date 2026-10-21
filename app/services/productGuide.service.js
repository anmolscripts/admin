'use strict';
const {lessons,screens}=require('../content/product-guide');
function allowed(rule,context){
 if(!rule)return true;
 if(rule.roles&&!rule.roles.includes(context.role))return false;
 const has=([module,action])=>context.hasPermission(module,action);
 return (!rule.all||rule.all.every(has))&&(!rule.any||rule.any.some(has));
}
function catalogue(context){
 return lessons.filter(item=>allowed(item.access,context)).map(item=>{
  const screen=item.screen&&allowed(item.screenAccess,context)&&allowed(screens[item.screen]?.access,context)?{id:item.screen,...screens[item.screen]}:null;
  const links=(item.links||[]).map(link=>Array.isArray(link)?{label:link[0],href:link[1]}:link).filter(link=>allowed(link.access,context));
  return {...item,screen,links,steps:item.steps.filter(s=>allowed(s.access,context)).map(s=>({...s,anchor:item.id+'-'+s.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}))};
 });
}
function getScreen(id,context){return Object.hasOwn(screens,id)&&allowed(screens[id].access,context)?screens[id]:null;}
function searchText(item){return [item.title,item.summary,item.simple,item.category,...item.steps.flatMap(s=>[s.title,s.body,s.check]),...(item.notes||[]).flat(),...(item.glossary||[]).flat(),...(item.pitfalls||[])].join(' ');}
module.exports={allowed,catalogue,getScreen,searchText};
