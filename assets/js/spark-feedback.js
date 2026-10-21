(function(){
 'use strict';
 let last='',lastAt=0;
 function show(message,type='error'){
  const text=String(message||'The request could not be completed.');
  if(text===last&&Date.now()-lastAt<1500)return;
  last=text;lastAt=Date.now();
  if(window.Swal)return Swal.fire({target:document.querySelector('.modal.show')||document.body,heightAuto:false,keydownListenerCapture:true,icon:type,title:type==='error'?'Unable to complete the request':'Done',text,confirmButtonText:'Got it',customClass:{popup:'spark-feedback-dialog',confirmButton:'btn btn-primary'},buttonsStyling:false,returnFocus:true});
  window.SparkLoader?.toast(text,type);
 }
 window.SparkFeedback={error:message=>show(message),success:message=>show(message,'success')};
 window.alert=message=>show(message,/success|updated|saved/i.test(String(message))&&!/fail|error/i.test(String(message))?'success':'error');
})();
