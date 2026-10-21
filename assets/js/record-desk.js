(function () {
    'use strict';
    if (window.SparkRecordDesk) return;
    let modal, body, title, active, dirty=false, busy=false, generation=0;
    const label = key => ({CREATED_BY:'Created by (user ID)',CREATED_AT:'Created at',IP_ADDRESS:'IP address',gstin:'GSTIN',hsnSac:'HSN / SAC',gstRate:'GST rate',email:'Email address'}[key] || key.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase()));
    const display = value => value === null || value === undefined || value === '' ? '—' : typeof value === 'boolean' ? (value?'Yes':'No') : typeof value === 'object' ? JSON.stringify(value) : String(value);
    function node(tag,text,cls) { const el=document.createElement(tag); if(text!==undefined) el.textContent=text; if(cls)el.className=cls; return el; }
    async function request(url,options={}) {
        const response=await fetch(url,{credentials:'same-origin',...options,headers:{Accept:'application/json',...options.headers}});
        const result=await response.json().catch(()=>({error:'Could not read the server response. Please sign in again.'}));
        if(!response.ok || result.success===false) throw new Error(result.error || result.message || 'Request failed.');
        return result.data;
    }
    function setup() {
        if(modal)return;
        const shell=node('div',undefined,'modal fade'); shell.id='record-desk'; shell.tabIndex=-1; shell.setAttribute('aria-labelledby','record-desk-title');
        shell.innerHTML='<div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable"><div class="modal-content"><div class="modal-header"><div><div class="text-muted small mb-1">Record workspace</div><h2 class="modal-title fs-5 mb-0" id="record-desk-title"></h2></div><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body"></div></div></div>';
        document.body.append(shell); body=shell.querySelector('.modal-body'); title=shell.querySelector('.modal-title');
        shell.addEventListener('hide.bs.modal',event=>{if(busy || (dirty&&!window.confirm('Discard your unsaved changes?')))event.preventDefault();});
        shell.addEventListener('hidden.bs.modal',()=>{generation++;body.replaceChildren();active=null;dirty=false;});
        modal=bootstrap.Modal.getOrCreateInstance(shell);
    }
    function button(text,fn,cls='btn btn-outline-primary') {const b=node('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;}
    function skeleton(){const el=node('div',undefined,'record-skeleton');el.setAttribute('role','status');el.setAttribute('aria-label','Loading record');for(let i=0;i<6;i++)el.append(node('div',undefined,'skeleton-line'));return el;}
    function error(message) { window.SparkFeedback?.error(message); const old=body.querySelector('[role="alert"]'); if(old)old.remove();const el=node('div',message,'alert alert-danger');el.setAttribute('role','alert');body.prepend(el); }
    function render(record) {
        active=record; dirty=false; title.textContent=record.title; body.replaceChildren();
        const tools=node('div',undefined,'d-flex flex-wrap gap-2 mb-4 pb-3 border-bottom');
        tools.append(button('Details',()=>render(record),'btn btn-primary'),button('Edit history',()=>showHistory(1)));
        if(record.canEdit)tools.append(button('Edit',()=>edit(record),'btn btn-primary'));
        body.append(tools);
        if(record.lockReason)body.append(node('p',record.lockReason,'text-muted'));
        const dl=node('dl',undefined,'record-details row g-3 mb-0');
        for(const key of record.fields){const col=node('div',undefined,'col-12 col-md-6');const field=node('div',undefined,'h-100');const value=node('dd',key==='active'?(record.data[key]?'Active':'Inactive'):display(record.data[key]));if(key==='active'){const badge=node('span',value.textContent,record.data[key]?'badge bg-success-subtle text-success':'badge bg-secondary-subtle text-secondary');value.replaceChildren(badge);}field.append(node('dt',label(key)),value);col.append(field);dl.append(col);}body.append(dl);
        if(record.items?.length){body.append(node('h3','Line items','h6'));for(const item of record.items)body.append(node('p',Object.entries(item).map(([k,v])=>`${label(k)}: ${display(v)}`).join(' · '),'border rounded p-2 text-break'));}
    }
    function edit(record) {
        if(record.editorUrl){
            dirty=true;
            body.replaceChildren();body.append(button('Back to details',()=>render(record)));
            const frame=node('iframe');frame.title='Document editor';frame.src=record.editorUrl;frame.className='record-editor-frame';body.append(frame);return;
        }
        body.replaceChildren();const form=node('form',undefined,'row g-3');
        for(const key of record.editableFields){const box=node('div',undefined,['description','address','billingAddress','shippingAddress','active'].includes(key)?'col-12':'col-12 col-md-6');const id=`record-field-${key}`;const l=node('label',label(key),'form-label');l.htmlFor=id;let input;
            if(['description','address','billingAddress','shippingAddress'].includes(key))input=node('textarea');else input=node('input');
            input.id=id;input.name=key;input.className='form-control';
            if(key==='active'){input.type='checkbox';input.className='form-check-input';input.setAttribute('role','switch');input.checked=Boolean(record.data[key]);l.className='form-check-label';}
            else{input.value=record.data[key]??'';if(['rate','gstRate'].includes(key)){input.type='number';input.min='0';input.step='any';}if(key==='email')input.type='email';if(key==='name')input.required=true;}
            input.addEventListener('input',()=>{dirty=true;});if(key==='active'){const check=node('div',undefined,'form-check form-switch');check.append(input,l);box.append(check);}else box.append(l,input);form.append(box);
        }
        const save=node('button','Save changes','btn btn-primary');save.type='submit';const actions=node('div',undefined,'col-12 d-flex justify-content-end gap-2 border-top pt-3 mt-4');actions.append(button('Cancel',()=>{if(!dirty||confirm('Discard your unsaved changes?'))render(record);},'btn btn-light'),save);form.append(actions);
        form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;save.disabled=true;const changes={};for(const key of record.editableFields){const input=form.elements.namedItem(key);changes[key]=input.type==='checkbox'?input.checked:input.value;}
            try{const token=document.querySelector('input[name="_csrf"]')?.value || document.querySelector('meta[name="csrf-token"]')?.content;
                const updated=await request(`/api/records/${record.type}/${record.id}`,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':token||''},body:JSON.stringify({version:record.version,changes})});
                dirty=false;render(updated);body.prepend(node('div','Saved. The change history has been preserved. Close this window to refresh the table.','alert alert-success'));
                document.getElementById('record-desk').addEventListener('hidden.bs.modal',()=>location.reload(),{once:true});
            }catch(e){error(e.message);}finally{busy=false;save.disabled=false;}
        });body.append(form);
    }
    async function showHistory(page){const record=active,ticket=++generation;body.replaceChildren(skeleton());try{
        const result=await request(`/api/records/${record.type}/${record.id}/history?page=${page}`);if(ticket!==generation)return;
        body.replaceChildren(button('Back to details',()=>{generation++;render(record);}));
        body.append(node('p','Earlier activity may have no field snapshots. History is retained from the workflows that captured it.','text-muted mt-3'));
        const search=node('input');search.type='search';search.className='form-control mb-3';search.placeholder='Search this page of history';search.setAttribute('aria-label','Search this page of history');body.append(search);
        search.addEventListener('input',()=>{for(const section of body.querySelectorAll('section'))section.hidden=!section.textContent.toLowerCase().includes(search.value.toLowerCase());});
        if(!result.entries.length)body.append(node('p','No recorded changes yet.'));
        for(const entry of result.entries){const section=node('section',undefined,'border rounded p-3 my-3');section.append(node('h3',`${entry.actor} · ${new Date(entry.at).toLocaleString()} · ${entry.action}`,'h6'));
            for(const change of entry.changes)section.append(node('p',`${label(change.field)}: ${display(change.before)} → ${display(change.after)}`,'text-break'));if(entry.description)section.append(node('p',entry.description));body.append(section);}
        const nav=node('div',undefined,'d-flex gap-2 align-items-center');if(page>1)nav.append(button('Previous',()=>showHistory(page-1)));nav.append(node('span',`Page ${page} of ${result.totalPages}`));if(page<result.totalPages)nav.append(button('Next',()=>showHistory(page+1)));body.append(nav);
    }catch(e){if(ticket===generation){body.replaceChildren(button('Back to details',()=>render(record)));error(e.message);}}}
    async function open(type,id,editMode=false){setup();if(busy)return;if(dirty&&!confirm('Discard your unsaved changes?'))return;dirty=false;const ticket=++generation;title.textContent='Record details';body.replaceChildren(skeleton());modal.show();try{const record=await request(`/api/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);if(ticket===generation){render(record);if(editMode&&record.canEdit)edit(record);}}catch(e){if(ticket===generation)error(e.message);}}
    function identify(row){if(row.dataset.recordType)return {type:row.dataset.recordType,id:row.dataset.recordId};for(const a of row.querySelectorAll('a[href]')){const match=a.getAttribute('href').match(/^\/(clients|items|units|suppliers|projects|documents|purchases\/orders|purchases\/bills|purchases\/receipts|credit-debit-notes)\/(\d+)(?:\/|\?|$)/);if(match)return {type:({'clients':'client','items':'item','units':'unit','suppliers':'supplier','projects':'project','documents':'invoice','purchases/orders':'purchaseOrder','purchases/bills':'supplierBill','purchases/receipts':'goodsReceipt','credit-debit-notes':'creditDebitNote'})[match[1]],id:match[2]};}return null;}
    document.addEventListener('click',event=>{if(event.target.closest('a,button,input,select,textarea,label,[contenteditable="true"]'))return;const row=event.target.closest('tbody tr');if(!row||row.matches('.report-row-clickable')||row.closest('#record-desk')||window.getSelection()?.toString())return;const record=identify(row);if(record)open(record.type,record.id);});
    document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('tr[data-record-type]')){event.preventDefault();open(event.target.dataset.recordType,event.target.dataset.recordId);}});
    document.addEventListener('click',event=>{const a=event.target.closest('a[href]');if(!a || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)return;const match=a.getAttribute('href').match(/^\/(clients|items|suppliers|projects)\/(\d+)\/edit$/);if(!match || !a.closest('tbody'))return;event.preventDefault();open(({clients:'client',items:'item',suppliers:'supplier',projects:'project'})[match[1]],match[2],true);});
    window.SparkRecordDesk={open};
    window.addEventListener('message',async event=>{
        const frame=body?.querySelector('iframe');
        if(event.origin!==location.origin || !frame || event.source!==frame.contentWindow || event.data?.type!=='spark-record-saved' || Number(event.data.id)!==Number(active?.id))return;
        const record=active;
        try{render(await request(`/api/records/${record.type}/${record.id}`));body.prepend(node('div','Document updated with its revision history preserved.','alert alert-success'));document.getElementById('record-desk').addEventListener('hidden.bs.modal',()=>location.reload(),{once:true});}catch(e){error(e.message);}
    });
})();
