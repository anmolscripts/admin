(function () {
    'use strict';
    const upload=document.getElementById('avatar');
    if(upload){
      const preview=document.getElementById('avatar-preview'),placeholder=document.getElementById('avatar-placeholder'),reset=document.getElementById('avatar-reset'),caption=document.getElementById('avatar-file-name');
      const original=preview.getAttribute('src');let selection=0;
      function restore(){selection++;upload.value='';preview.src=original;preview.hidden=!original;placeholder.hidden=!!original;reset.hidden=true;caption.textContent='Changes save with your profile.';}
      reset.addEventListener('click',restore);
      upload.addEventListener('change',()=>{
        const file=upload.files[0];if(!file){restore();return;}
        if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>2*1024*1024){restore();const message='Choose a PNG, JPEG or WebP image under 2 MB.';caption.textContent=message;window.SparkFeedback?.error(message);return;}
        const version=++selection;const reader=new FileReader();
        reader.onload=()=>{if(version!==selection)return;preview.src=reader.result;preview.hidden=false;placeholder.hidden=true;reset.hidden=false;caption.textContent=file.name+' · Ready to save';};
        reader.onerror=()=>{restore();caption.textContent='The image could not be read. Choose another file.';};
        reader.readAsDataURL(file);
      });
    }
    for (const id of ['profile-form','password-form']) {
        const form=document.getElementById(id);
        if(!form)continue;
        form.addEventListener('submit',async event=>{
            event.preventDefault();
            const submit=form.querySelector('[type="submit"]');
            if(submit.disabled)return;
            let alert=form.querySelector('[role="alert"]');
            if(!alert){alert=document.createElement('div');alert.className='alert alert-danger';alert.setAttribute('role','alert');form.prepend(alert);}
            alert.hidden=true;
            const original=submit.innerHTML;submit.disabled=true;submit.textContent='Saving…';
            try {
                const fields=new FormData(form);
                const response=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:{Accept:'application/json','X-CSRF-Token':fields.get('_csrf')||''},body:id==='profile-form'?fields:new URLSearchParams(fields)});
                const result=await response.json().catch(()=>({error:'Your session may have expired. Sign in again and retry.'}));
                if(!response.ok||result.success!==true)throw new Error(result.error||result.message||'Could not save your changes.');
                window.location.assign(id==='profile-form'?'/profile?success=true':'/profile?passwordSuccess=true');
            } catch(error) {alert.textContent=error.message;alert.hidden=false;window.SparkFeedback?.error(error.message);}
            finally {submit.disabled=false;submit.innerHTML=original;}
        });
    }
})();
