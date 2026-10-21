'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM,VirtualConsole}=require('jsdom');
const content=require('../app/services/letterContent.service');
const tools=require('../assets/js/letter-code-tools.source');
const presentation=require('../app/services/letterPresentation.service');
after(()=>require('../app/config/prisma').$disconnect());
test('content CSS cannot escape to document, application, footer or resource-loading rules',()=>{
 const css=content.scopedCss('html body, :root, p { color: red !important; } .doc-footer-bar { display:none } @media print { h2 { color: blue } }');
 assert.ok(css.includes('letter-content-boundary > .letter-richtext'));
 assert.ok(content.scopedCss('section > p { color:red }').includes('section > p'));
 const dom=new JSDOM('<style>body{color:rgb(10,20,30)}.doc-footer-bar{display:flex;color:green}'+css+'</style><p id="outside">Outside</p><div class="doc-footer-bar">Footer</div><div class="letter-content-boundary"><div class="letter-richtext"><p id="inside">Inside</p></div></div>');
 try{const w=dom.window;assert.equal(w.getComputedStyle(w.document.getElementById('outside')).color,'rgb(10, 20, 30)');assert.equal(w.getComputedStyle(w.document.getElementById('inside')).color,'rgb(255, 0, 0)');assert.equal(w.getComputedStyle(w.document.querySelector('.doc-footer-bar')).display,'flex');assert.ok(!content.scopedCss('body + footer { display:none }').startsWith('body'));}finally{dom.window.close();}
 for(const css of ['@import "x";','@font-face{font-family:x;src:local(x)}','@page{margin:0}','@keyframes spin{to{opacity:0}}','@property --x{syntax:"*"}','p{background:url(https://example.test)}','p{background:image-set("https://example.test" 1x)}','p{position:fixed}','p{position:sticky}','p{--x:fixed;position:var(--x)}','p{behavior:bad}','p{color:\\72 ed}','p{content:"</style><script>bad</script>"}','p{ &:hover{color:red}}'])assert.throws(()=>content.cleanCss(css),{statusCode:400},css);
 assert.throws(()=>content.cleanCss('p { color: red'),{statusCode:400});assert.throws(()=>content.cleanCss('x'.repeat(50001)),{statusCode:400});
});
test('code HTML preserves classes, tables, semantic formatting and safe inline styling',()=>{
 const html=content.cleanHtml('<section class="letter-card"><h4 style="font-size:24px;background-color:yellow">Hello</h4><table><tbody><tr><td data-row="r1" colspan="2">H<sub>2</sub>O &amp; x<sup>2</sup></td></tr></tbody></table><pre><code>const x = 1;</code></pre><hr><p style="position:fixed;transform:translateX(100vw);font-size:18px" onclick="bad()">Safe</p><style>body{display:none}</style><script>bad()</script></section>');
 assert.ok(html.includes('class="letter-card"'));assert.ok(html.includes('<table>'));assert.ok(html.includes('font-size:24px'));assert.ok(html.includes('<sup>2</sup>'));assert.ok(!/position:|transform:|onclick|<style>|<script>/.test(html));
 const preview=content.preview(html,'body { color: green; }');assert.ok(preview.includes('Content-Security-Policy'));assert.ok(preview.includes("default-src 'none'"));
});
test('tag intelligence handles nested tags, quoted >, raw text, comments, void and implicit tags',()=>{
 const text='<section><div title="x>y"><span>Hello</span></div></section>';
 const pairs=tools.tagPairs(text);assert.deepEqual(pairs.map(p=>p.name),['section','div','span']);
 const span=pairs[2];assert.equal(tools.linkedPair(pairs,span.openNameFrom+1),span);assert.equal(tools.linkedPair(pairs,span.closeNameTo),span);assert.equal(tools.enclosingPair(pairs,text.indexOf('Hello')),span);
 assert.deepEqual(tools.tagPairs('<!-- <b>x</b> --><br><input><script>"<em>"</script>').map(p=>p.name),['script']);
 assert.deepEqual(tools.tagPairs('<p><b>x</p>').map(p=>p.name),['p']);
 assert.equal(tools.unclosedTagAt('<article class="x">',19),'article');assert.equal(tools.unclosedTagAt('<br>',4),null);assert.equal(tools.unclosedTagAt('<div></div>',5),null);assert.equal(tools.unclosedTagAt('<!-- <div>',10),null);assert.equal(tools.unclosedTagAt('<script>"<div>',14),null);
});
test('deleting an opening or closing tag removes only its partner and keeps nested content',()=>{
 const source='<div><b>Hello</b></div>';
 assert.deepEqual(tools.pairedDeletions(source,[{rangeOffset:0,rangeLength:5,text:''}]),[{from:source.indexOf('</div>')-5,to:source.length-5}]);
 assert.deepEqual(tools.pairedDeletions(source,[{rangeOffset:source.indexOf('</div>'),rangeLength:6,text:''}]),[{from:0,to:5}]);
 assert.deepEqual(tools.pairedDeletions(source,[{rangeOffset:0,rangeLength:source.length,text:''}]),[]);
 assert.deepEqual(tools.pairedDeletions(source,[{rangeOffset:1,rangeLength:3,text:'article'}]),[]);
});
test('tag rename mirrors a single edit without duplicating native multicursor edits',()=>{
 const html='<section class="x">Text</section>',end=html.lastIndexOf('section');
 assert.deepEqual(tools.pairedRename(html,[{rangeOffset:1,rangeLength:7,text:'article'}]),[{from:end,to:end+7,text:'article'}]);
 assert.deepEqual(tools.pairedRename(html,[{rangeOffset:end,rangeLength:7,text:'div'}]),[{from:1,to:8,text:'div'}]);
 assert.deepEqual(tools.pairedRename(html,[{rangeOffset:1,rangeLength:7,text:'div'},{rangeOffset:end,rangeLength:7,text:'div'}]),[]);
 assert.deepEqual(tools.pairedRename(html,[{rangeOffset:1,rangeLength:7,text:'div onclick="x"'}]),[]);
});
test('print and PDF markup keep custom CSS inside content wrappers and retain the letterhead',async()=>{
 const html=await presentation.render({businessId:1,letterNumber:'LTR/2026/10/CSS',letterDate:new Date('2026-10-21'),recipientName:'Example',subject:'Code letter',bodyHtml:'<section class="callout"><h2>Hello</h2><p>Content</p></section>',bodyCss:'body { color:red } .doc-brand-header,.doc-footer-bar { display:none }',templateId:'modern-minimal',status:'ACTIVE'},{legalName:'Unaffected Company',email:'office@example.test'});
 const dom=new JSDOM(html,{virtualConsole:new VirtualConsole()});try{const w=dom.window;assert.equal(w.getComputedStyle(w.document.querySelector('.doc-brand-header')).display,'block');assert.equal(w.getComputedStyle(w.document.querySelector('.doc-footer-bar')).display,'flex');assert.equal(w.getComputedStyle(w.document.querySelector('.letter-richtext h2')).color,'rgb(255, 0, 0)');assert.ok(w.document.querySelector('.letter-content-boundary .callout'));}finally{dom.window.close();}
});
