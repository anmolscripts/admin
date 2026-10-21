(function(){
 'use strict';
 const input=document.getElementById('organization-logo');if(!input)return;
 const preview=document.getElementById('organization-logo-preview'),placeholder=document.getElementById('organization-logo-placeholder'),reset=document.getElementById('organization-logo-reset'),caption=document.getElementById('organization-logo-caption');
 const original=preview.getAttribute('src');let version=0;
 function restore(){version++;input.value='';preview.src=original;preview.hidden=!original;placeholder.hidden=!!original;reset.hidden=true;caption.textContent='Preview first. Save changes to apply your logo.';}
 function error(message){restore();caption.textContent=message;window.SparkFeedback?.error(message);}
 reset.addEventListener('click',restore);
 preview.addEventListener('error',()=>{if(input.files.length&&preview.getAttribute('src').startsWith('data:'))error('This image could not be displayed. Choose another PNG, JPEG or WebP.');});
 input.addEventListener('change',()=>{
  const file=input.files[0];if(!file){restore();return;}
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>2*1024*1024){error('Choose a PNG, JPEG or WebP image under 2 MB.');return;}
  const current=++version,reader=new FileReader();reader.onload=()=>{if(current!==version)return;preview.src=reader.result;preview.hidden=false;placeholder.hidden=true;reset.hidden=false;caption.textContent=file.name+' · Ready to save';};reader.onerror=()=>{if(current===version)error('This image could not be read. Choose another file.');};reader.readAsDataURL(file);
 });
})();
