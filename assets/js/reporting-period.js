(function(){
 'use strict';
 const form=document.getElementById('reporting-period-form');if(!form)return;
 const from=form.querySelector('#period-from'),to=form.querySelector('#period-to');
 for(const [id,input,ending] of [['period-from-fy',from,false],['period-through-fy',to,true]]){
  const select=document.getElementById(id);
  select.addEventListener('change',()=>{if(select.value)input.value=ending?`${Number(select.value)+1}-03-31`:`${select.value}-04-01`;});
  input.addEventListener('input',()=>{select.value='';});
 }
 form.addEventListener('submit',event=>{to.setCustomValidity(from.value>to.value?'End date must be on or after the start date.':'');if(!form.reportValidity())event.preventDefault();});
 to.addEventListener('input',()=>to.setCustomValidity(''));from.addEventListener('input',()=>to.setCustomValidity(''));
 // Keep the chosen period when another filter on the same list is submitted.
 if(form.getAttribute('action')===location.pathname){
  document.querySelectorAll('form[method="GET" i]').forEach(other=>{
   if(other===form||new URL(other.action).pathname!==location.pathname)return;
   for(const source of [from,to])if(!other.querySelector(`[name="${source.name}"]`)){const hidden=document.createElement('input');hidden.type='hidden';hidden.name=source.name;hidden.value=source.value;other.append(hidden);}
  });
  document.querySelectorAll('a[href]').forEach(link=>{const url=new URL(link.href);if(url.origin===location.origin&&url.pathname===location.pathname&&url.searchParams.has('page')){url.searchParams.set(from.name,from.value);url.searchParams.set(to.name,to.value);link.href=url.href;}});
 }
})();
