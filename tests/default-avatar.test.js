'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ejs=require('ejs');
const {JSDOM}=require('jsdom');
test('all user avatar surfaces use the supplied default and keep uploaded photos',()=>{
 const image=fs.readFileSync('assets/images/default-avatar.png');assert.equal(image.subarray(1,4).toString(),'PNG');
 for(const file of ['layouts/header','profile/index','team/index','team/show']){
  const source=fs.readFileSync('app/views/'+file+'.ejs','utf8');const tags=source.match(/<img[^>]*default-avatar\.png[\s\S]*?\/>/g)||[];assert.ok(tags.length,file);
  for(const tag of tags){for(const avatarUrl of [null,'/uploads/custom-user.png']){const person={name:'Example',avatarUrl};const dom=new JSDOM(ejs.render(tag,{user:person,profile:person,member:person,m:person}));assert.equal(dom.window.document.querySelector('img').getAttribute('src'),avatarUrl||'/images/default-avatar.png');dom.window.close();}}
 }
});
test('undoing an upload restores the default avatar when no personal photo is saved',{timeout:5000},async()=>{
 const dom=new JSDOM('<input type="file" id="avatar"><img id="avatar-preview" src="/images/default-avatar.png"><span id="avatar-placeholder" hidden></span><button id="avatar-reset" hidden>Undo</button><span id="avatar-file-name"></span>',{url:'https://test.invalid',runScripts:'outside-only'});
 const w=dom.window;w.eval(fs.readFileSync('assets/js/profile.js','utf8'));const input=w.document.getElementById('avatar');Object.defineProperty(input,'files',{value:[new w.File(['sample'],'photo.png',{type:'image/png'})],configurable:true});const previewReady=new Promise(resolve=>{const observer=new w.MutationObserver(()=>{if(w.document.getElementById('avatar-preview').src.startsWith('data:')){observer.disconnect();resolve();}});observer.observe(w.document.getElementById('avatar-preview'),{attributes:true,attributeFilter:['src']});});input.dispatchEvent(new w.Event('change'));await previewReady;assert.match(w.document.getElementById('avatar-preview').src,/^data:image\/png/);w.document.getElementById('avatar-reset').click();assert.match(w.document.getElementById('avatar-preview').src,/\/images\/default-avatar\.png$/);assert.equal(w.document.getElementById('avatar-preview').hidden,false);assert.equal(w.document.getElementById('avatar-placeholder').hidden,true);dom.window.close();
});
