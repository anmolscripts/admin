'use strict';
const {parseDocument,DomUtils}=require('htmlparser2');
function tagPairs(text){
 const document=parseDocument(text,{withStartIndices:true,withEndIndices:true,recognizeSelfClosing:true});
 return DomUtils.findAll(node=>typeof node.name==='string',document.children).flatMap(node=>{
  const from=node.startIndex,to=node.endIndex+1;
  if(from==null||!Number.isFinite(to))return [];
  const opening=text.slice(from).match(/^<([a-z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/i);
  if(!opening||/\/\s*>$/.test(opening[0]))return [];
  const closeFrom=text.lastIndexOf('</',to-1),closing=text.slice(closeFrom,to).match(/^<\/\s*([a-z][\w:-]*)\s*>$/i);
  if(!closing||closing[1].toLowerCase()!==node.name.toLowerCase()||closeFrom<from+opening[0].length)return [];
  const closeNameFrom=closeFrom+text.slice(closeFrom,to).indexOf(closing[1]);
  return [{name:opening[1],openFrom:from,openTo:from+opening[0].length,openNameFrom:from+1,openNameTo:from+1+opening[1].length,closeFrom,closeTo:to,closeNameFrom,closeNameTo:closeNameFrom+closing[1].length}];
 });
}
function linkedPair(pairs,offset){return pairs.find(pair=>(offset>=pair.openNameFrom&&offset<=pair.openNameTo)||(offset>=pair.closeNameFrom&&offset<=pair.closeNameTo));}
function enclosingPair(pairs,offset){return pairs.filter(pair=>offset>=pair.openFrom&&offset<=pair.closeTo).sort((a,b)=>(a.closeTo-a.openFrom)-(b.closeTo-b.openFrom))[0];}
function unclosedTagAt(text,offset){
 const before=text.slice(0,offset),match=before.match(/<([a-z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>$/i);
 if(!match||/\/\s*>$/.test(match[0])||/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(match[1]))return null;
 const start=offset-match[0].length;
 if(tagPairs(text).some(pair=>pair.openFrom===start))return null;
 const nodes=DomUtils.findAll(node=>typeof node.name==='string',parseDocument(before,{withStartIndices:true}).children);
 return nodes.some(node=>node.startIndex===start)?match[1]:null;
}
function pairedDeletions(before,changes){
 const pairs=tagPairs(before),edits=[];
 function moved(offset){let result=offset;for(const change of changes){if(change.rangeOffset+change.rangeLength<=offset)result+=change.text.length-change.rangeLength;else if(change.rangeOffset<offset)return null;}return result;}
 for(const pair of pairs){
  for(const [from,to,otherFrom,otherTo] of [[pair.openFrom,pair.openTo,pair.closeFrom,pair.closeTo],[pair.closeFrom,pair.closeTo,pair.openFrom,pair.openTo]]){
   if(!changes.some(change=>change.text===''&&change.rangeLength>0&&change.rangeOffset<=from&&change.rangeOffset+change.rangeLength>=to))continue;
   if(changes.some(change=>change.rangeOffset<otherTo&&change.rangeOffset+change.rangeLength>otherFrom))continue;
   const start=moved(otherFrom),end=moved(otherTo);if(start!=null&&end!=null)edits.push({from:start,to:end});
  }
 }
 return edits.filter((edit,index)=>edits.findIndex(other=>other.from===edit.from&&other.to===edit.to)===index);
}
function pairedRename(before,changes){
 if(changes.length!==1)return [];
 const change=changes[0],end=change.rangeOffset+change.rangeLength;
 for(const pair of tagPairs(before))for(const [from,to,otherFrom,otherTo] of [[pair.openNameFrom,pair.openNameTo,pair.closeNameFrom,pair.closeNameTo],[pair.closeNameFrom,pair.closeNameTo,pair.openNameFrom,pair.openNameTo]]){
  if(change.rangeOffset<from||end>to)continue;
  const name=before.slice(from,change.rangeOffset)+change.text+before.slice(end,to);
  if(!/^[a-z][\w:-]*$/i.test(name))return [];
  const shift=otherFrom>=end?change.text.length-change.rangeLength:0;
  return [{from:otherFrom+shift,to:otherTo+shift,text:name}];
 }
 return [];
}
module.exports={tagPairs,linkedPair,enclosingPair,pairedDeletions,pairedRename,unclosedTagAt};
