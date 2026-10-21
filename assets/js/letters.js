(function(){
 'use strict';
 const csrf=document.querySelector('meta[name="csrf-token"]')?.content||'';
 async function request(url,method,data,html=false){
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,Accept:html?'text/html':'application/json'},body:JSON.stringify(data)});
  if(!response.ok){let problem;try{problem=await response.json();}catch(_){throw Error('The request failed. Reload the page and try again.');}throw Error(problem.error?.message||problem.error||problem.message||'Unable to save letter.');}
  return html?response.text():response.json();
 }
 const form=document.getElementById('letter-form');
 if(form){
  const BlockEmbed=Quill.import('blots/block/embed');
  class PageBreak extends BlockEmbed{static blotName='page-break';static tagName='DIV';static className='letter-page-break';html(){return '<div class="letter-page-break"></div>';}}
  Quill.register(PageBreak);
  const quill=new Quill('#letter-editor',{theme:'snow',placeholder:'Write your letter…',formats:['header','font','size','bold','italic','underline','strike','color','align','list','blockquote','link','page-break'],modules:{toolbar:'#letter-toolbar',history:{delay:800,maxStack:100,userOnly:true}}});
  quill.clipboard.dangerouslyPasteHTML(document.getElementById('letter-initial').value,'silent');
  quill.root.setAttribute('role','textbox');quill.root.setAttribute('aria-label','Letter content');quill.root.setAttribute('aria-multiline','true');
  let dirty=false;
  const count=()=>{const text=quill.getText().trim();document.getElementById('letter-word-count').textContent=(text?text.split(/\s+/).length:0)+' words · A4 pages flow automatically · Maximum 200 KB';};
  count();quill.on('text-change',(_a,_b,source)=>{if(source==='user')dirty=true;count();});form.addEventListener('input',()=>{dirty=true;});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  document.getElementById('letter-undo').onclick=()=>quill.history.undo();document.getElementById('letter-redo').onclick=()=>quill.history.redo();
  document.getElementById('letter-page-break').onclick=()=>{const selection=quill.getSelection(true);quill.insertEmbed(selection.index,'page-break',true,'user');quill.setSelection(selection.index+1,0,'silent');};
  const data=()=>({...Object.fromEntries(new FormData(form)),version:Number(form.dataset.version),bodyHtml:quill.getSemanticHTML()});
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(!form.reportValidity())return;
   const button=document.getElementById('letter-save');button.disabled=true;
   try{const result=await request('/api/letters'+(form.dataset.letterId?'/'+form.dataset.letterId:''),form.dataset.letterId?'PUT':'POST',data());dirty=false;window.location.assign('/documents/letters/'+result.letter.id);}
   catch(error){SparkFeedback.error(error.message);}finally{button.disabled=false;}
  });
  document.getElementById('letter-preview-btn').addEventListener('click',async event=>{
   if(!form.reportValidity())return;const button=event.currentTarget;button.disabled=true;
   try{const html=await request('/api/letters/preview','POST',data(),true);document.getElementById('letter-preview-frame').srcdoc=html;bootstrap.Modal.getOrCreateInstance(document.getElementById('letter-preview-modal')).show();}
   catch(error){SparkFeedback.error(error.message);}finally{button.disabled=false;}
  });
 }
 document.querySelectorAll('[data-letter-action]').forEach(button=>button.addEventListener('click',async()=>{
  const action=button.dataset.letterAction,container=document.getElementById('letter-actions');
  const result=await Swal.fire({title:action.charAt(0).toUpperCase()+action.slice(1)+' this letter?',text:action==='delete'?'The letter will move to deleted records. Its content and history are retained.':'This action is recorded in letter history.',input:'textarea',inputLabel:'Reason',inputPlaceholder:'Explain why this action is needed',showCancelButton:true,confirmButtonText:'Confirm '+action,buttonsStyling:false,customClass:{popup:'spark-feedback-dialog',confirmButton:'btn btn-danger',cancelButton:'btn btn-outline-secondary'},inputValidator:value=>!value.trim()?'Enter a reason.':value.trim().length>2000?'Use at most 2000 characters.':undefined});
  if(!result.isConfirmed)return;button.disabled=true;
  try{await request('/api/letters/'+container.dataset.letterId+'/'+action,'POST',{version:Number(container.dataset.version),reason:result.value});window.location.reload();}
  catch(error){SparkFeedback.error(error.message);}finally{button.disabled=false;}
 }));
})();
