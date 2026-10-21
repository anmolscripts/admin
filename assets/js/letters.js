(function(){
 'use strict';
 const csrf=document.querySelector('meta[name="csrf-token"]')?.content||'';
 async function request(url,method,data,html=false,signal){
  const response=await fetch(url,{method,signal,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,Accept:html?'text/html':'application/json'},body:JSON.stringify(data)});
  if(!response.ok){let problem;try{problem=await response.json();}catch(_){throw Error('The request failed. Reload the page and try again.');}throw Error(problem.error?.message||problem.error||problem.message||'Unable to save letter.');}
  return html?response.text():response.json();
 }
 const form=document.getElementById('letter-form');
 if(form){
  const Delta=Quill.import('delta');
  const BlockEmbed=Quill.import('blots/block/embed');
  class PageBreak extends BlockEmbed{static blotName='page-break';static tagName='DIV';static className='letter-page-break';html(){return '<div class="letter-page-break"></div>';}}
  class Rule extends BlockEmbed{static blotName='horizontal-rule';static tagName='HR';}
  Quill.register(PageBreak);Quill.register(Rule);
  const sizes=Quill.import('attributors/style/size');sizes.whitelist=['10px','12px','14px','16px','18px','20px','24px','28px','32px','40px','48px'];Quill.register(sizes,true);
  const quill=new Quill('#letter-editor',{theme:'snow',placeholder:'Write your letter…',formats:['header','font','size','bold','italic','underline','strike','color','background','align','list','indent','script','blockquote','code','code-block','link','table','page-break','horizontal-rule'],modules:{table:true,toolbar:'#letter-toolbar',history:{delay:800,maxStack:100,userOnly:true}}});
  for(const [size,value] of Object.entries({small:'12px',large:'24px',huge:'32px'}))quill.clipboard.addMatcher('span.ql-size-'+size,(_node,delta)=>delta.compose(new Delta().retain(delta.length(),{size:value})));
  quill.clipboard.dangerouslyPasteHTML(document.getElementById('letter-initial').value,'silent');
  quill.root.setAttribute('role','textbox');quill.root.setAttribute('aria-label','Letter content');quill.root.setAttribute('aria-multiline','true');
  let dirty=false,mode=form.dataset.editorMode||'RICH',source,sourceLoading,previewTimer,previewController;
  const htmlSource=document.getElementById('letter-html-source'),cssSource=document.getElementById('letter-css-source');
  const dialog={buttonsStyling:false,customClass:{popup:'spark-feedback-dialog',confirmButton:'btn btn-primary',cancelButton:'btn btn-outline-secondary'}};
  const getHtml=()=>mode==='CODE'?(source?source.getHtml():htmlSource.value):quill.getSemanticHTML();
  const getCss=()=>source?source.getCss():cssSource.value;
  const count=()=>{const text=(mode==='CODE'?getHtml().replace(/<[^>]*>/g,' '):quill.getText()).trim();document.getElementById('letter-word-count').textContent=(text?text.split(/\s+/).length:0)+' words · A4 pages flow automatically · HTML limit 200 KB · CSS limit 50 KB';};
  function showMode(){
   for(const kind of ['rich','code']){const selected=mode===kind.toUpperCase();document.getElementById('letter-'+kind+'-panel').hidden=!selected;const tab=document.getElementById('letter-'+kind+'-tab');tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));}
  }
  const data=()=>({...Object.fromEntries(new FormData(form)),version:Number(form.dataset.version),bodyHtml:getHtml(),bodyCss:getCss(),editorMode:mode});
  async function livePreview(){
   if(mode!=='CODE')return;
   const status=document.getElementById('letter-live-status'),cssError=source?.cssError();
   if(cssError){status.textContent='Fix CSS syntax to refresh: '+cssError;return;}
   previewController?.abort();previewController=new AbortController();status.textContent='Updating preview…';
   const payload=data();payload.subject=payload.subject||'Letter preview';payload.recipientName=payload.recipientName||'Recipient';payload.bodyHtml=payload.bodyHtml.trim()||'<p>Start writing your HTML.</p>';
   try{const html=await request('/api/letters/content-preview','POST',payload,true,previewController.signal);if(mode==='CODE'){document.getElementById('letter-code-preview').srcdoc=html;status.textContent='Preview updated · changes are not saved.';}}
   catch(error){if(error.name!=='AbortError')status.textContent=error.message;}
  }
  function codeChanged(){dirty=true;count();clearTimeout(previewTimer);previewTimer=setTimeout(livePreview,600);}
  async function ensureSource(){
   if(source)return source;
   if(!sourceLoading)sourceLoading=window.LetterSourceEditor.create({html:htmlSource.value,css:cssSource.value,onChange:codeChanged,status:document.getElementById('letter-code-status')}).then(result=>{source=result;htmlSource.hidden=cssSource.hidden=true;return result;}).catch(error=>{document.getElementById('letter-code-status').textContent='Code tools could not load. You can still edit the source below; reload to restore completion tools.';console.error('Letter code editor:',error);return null;});
   return sourceLoading;
  }
  async function openCode(user=true){
   if(mode==='RICH'){htmlSource.value=quill.getSemanticHTML();if(source)source.setHtml(htmlSource.value);}
   mode='CODE';showMode();if(user)dirty=true;
   await ensureSource();source?.layout();count();livePreview();
  }
  document.getElementById('letter-code-tab').onclick=()=>openCode();
  document.getElementById('letter-rich-tab').onclick=async()=>{
   if(mode==='RICH')return;
   const result=await Swal.fire({...dialog,title:'Convert to Rich Text?',text:'Rich Text may simplify custom HTML and CSS-based layouts. Stay in HTML & CSS to preserve the exact source. Your saved versions remain in history.',showCancelButton:true,confirmButtonText:'Convert to Rich Text',cancelButtonText:'Keep HTML & CSS'});
   if(!result.isConfirmed)return;
   quill.clipboard.dangerouslyPasteHTML(getHtml(),'silent');cssSource.value=getCss();mode='RICH';showMode();dirty=true;count();
  };
  htmlSource.addEventListener('input',codeChanged);cssSource.addEventListener('input',codeChanged);
  for(const [id,method] of [['letter-format-code','format'],['letter-rename-tag','rename'],['letter-select-tags','selectTags'],['letter-remove-tag','removeTags'],['letter-command-palette','commands']])document.getElementById(id).onclick=async()=>{try{const editor=await ensureSource();if(editor)await editor[method]();}catch(error){SparkFeedback.error(error.message);}};
  document.getElementById('letter-wrap-code').onclick=async event=>{const enabled=event.currentTarget.getAttribute('aria-pressed')!=='true';event.currentTarget.setAttribute('aria-pressed',String(enabled));(await ensureSource())?.wrap(enabled);};
  document.getElementById('letter-refresh-code-preview').onclick=livePreview;
  count();quill.on('text-change',(_a,_b,source)=>{if(source==='user')dirty=true;count();});form.addEventListener('input',()=>{dirty=true;});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  form.querySelector('a').addEventListener('click',async event=>{if(!dirty)return;event.preventDefault();const href=event.currentTarget.href;const result=await Swal.fire({...dialog,title:'Discard unsaved changes?',text:'This draft has not been saved.',showCancelButton:true,confirmButtonText:'Discard changes',cancelButtonText:'Keep editing'});if(result.isConfirmed){dirty=false;window.location.assign(href);}});
  document.getElementById('letter-undo').onclick=async()=>mode==='CODE'?(await ensureSource())?.undo():quill.history.undo();document.getElementById('letter-redo').onclick=async()=>mode==='CODE'?(await ensureSource())?.redo():quill.history.redo();
  document.getElementById('letter-page-break').onclick=async()=>{if(mode==='CODE'){(await ensureSource())?.insertHtml('<div class="letter-page-break"></div>\n');return;}const selection=quill.getSelection(true);quill.insertEmbed(selection.index,'page-break',true,'user');quill.setSelection(selection.index+1,0,'silent');};
  document.getElementById('letter-horizontal-rule').onclick=()=>{const selection=quill.getSelection(true);quill.insertEmbed(selection.index,'horizontal-rule',true,'user');quill.setSelection(selection.index+1,0,'silent');};
  document.getElementById('letter-insert-table').onclick=async()=>{
   const selection=quill.getSelection(true);
   const result=await Swal.fire({...dialog,title:'Insert table',html:'<label class="form-label" for="letter-table-rows">Rows (1–20)</label><input class="form-control mb-3" type="number" id="letter-table-rows" value="3" min="1" max="20"><label class="form-label" for="letter-table-columns">Columns (1–10)</label><input class="form-control" type="number" id="letter-table-columns" value="3" min="1" max="10">',showCancelButton:true,confirmButtonText:'Insert table',preConfirm:()=>{const rows=Number(document.getElementById('letter-table-rows').value),columns=Number(document.getElementById('letter-table-columns').value);if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||rows>20||columns<1||columns>10){Swal.showValidationMessage('Choose 1–20 rows and 1–10 columns.');return false;}return {rows,columns};}});
   if(result.isConfirmed){quill.setSelection(selection,'silent');quill.getModule('table').insertTable(result.value.rows,result.value.columns);}
  };
  document.querySelectorAll('[data-table-action]').forEach(button=>button.onclick=()=>{quill.focus();const table=quill.getModule('table');if(!table.getTable()[0])return SparkFeedback.error('Place the caret inside a table cell first.');table[button.dataset.tableAction]();});
  const findPanel=document.createElement('div');findPanel.className='letter-find-panel p-3 border-bottom';findPanel.hidden=true;findPanel.innerHTML='<div class="row g-2 align-items-end"><div class="col-sm-4"><label class="form-label" for="letter-find-text">Find text</label><input class="form-control" id="letter-find-text"></div><div class="col-sm-4"><label class="form-label" for="letter-replace-text">Replace with</label><input class="form-control" id="letter-replace-text"></div><div class="col-sm-4 d-flex flex-wrap gap-2"><button type="button" class="btn btn-sm btn-outline-secondary" id="letter-find-next">Find Next</button><button type="button" class="btn btn-sm btn-outline-secondary" id="letter-replace-one">Replace</button><button type="button" class="btn btn-sm btn-outline-secondary" id="letter-replace-all">Replace All</button></div></div><div class="d-flex gap-3 mt-2"><label class="form-check-label"><input class="form-check-input me-2" type="checkbox" id="letter-find-case">Match case</label><span class="small text-muted" id="letter-find-status" role="status"></span></div>';
  document.getElementById('letter-rich-panel').prepend(findPanel);
  const matches=()=>{const needle=document.getElementById('letter-find-text').value;if(!needle)return [];const pattern=new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),document.getElementById('letter-find-case').checked?'gu':'giu');return [...quill.getText().matchAll(pattern)];};
  const findNext=()=>{const found=matches(),selection=quill.getSelection(),from=selection?selection.index+selection.length:0,match=found.find(m=>m.index>=from)||found[0];document.getElementById('letter-find-status').textContent=found.length+' match(es)';if(match)quill.setSelection(match.index,match[0].length,'user');return match;};
  document.getElementById('letter-find-next').onclick=findNext;
  document.getElementById('letter-replace-one').onclick=()=>{const selected=quill.getSelection(),found=matches(),match=found.find(m=>selected&&m.index===selected.index&&m[0].length===selected.length)||findNext();if(match){const value=document.getElementById('letter-replace-text').value;quill.updateContents(new Delta().retain(match.index).delete(match[0].length).insert(value),'user');quill.setSelection(match.index+value.length,0,'silent');}};
  document.getElementById('letter-replace-all').onclick=()=>{const found=matches(),value=document.getElementById('letter-replace-text').value;let delta=new Delta(),last=0;for(const match of found){delta=delta.retain(match.index-last).delete(match[0].length).insert(value);last=match.index+match[0].length;}quill.updateContents(delta,'user');document.getElementById('letter-find-status').textContent='Replaced '+found.length+' match(es).';};
  document.getElementById('letter-find').onclick=async()=>{if(mode==='CODE'){(await ensureSource())?.find();return;}findPanel.hidden=!findPanel.hidden;if(!findPanel.hidden)document.getElementById('letter-find-text').focus();};
  const workspace=document.getElementById('letter-workspace');
  document.getElementById('letter-fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(workspace.requestFullscreen)await workspace.requestFullscreen();else workspace.classList.toggle('letter-workspace-expanded');source?.layout();}catch(error){SparkFeedback.error(error.message);}};
  showMode();if(mode==='CODE')openCode(false);
  window.addEventListener('pagehide',()=>{previewController?.abort();clearTimeout(previewTimer);source?.dispose();});
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
