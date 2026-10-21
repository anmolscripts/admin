(function(){
 'use strict';
 const root=document.getElementById('product-guide');if(!root)return;
 const data=JSON.parse(document.getElementById('guide-data').textContent),chapters=data.chapters,known=new Set(chapters.map(c=>c.id));
 const search=document.getElementById('guide-search'),status=document.getElementById('guide-status');
 let selected=data.selected||'',savedOnly=false,saved=[];
 try{const previous=JSON.parse(localStorage.getItem(root.dataset.progressKey)||'{}');if(Array.isArray(previous.saved))saved=previous.saved.filter(id=>known.has(id));}catch(_){}
 function store(){try{const previous=JSON.parse(localStorage.getItem(root.dataset.progressKey)||'{}');localStorage.setItem(root.dataset.progressKey,JSON.stringify({...previous,saved,last:selected}));}catch(_){status.textContent='Bookmarks cannot be saved in this browser.';}}
 function bookmarks(){document.querySelectorAll('[data-guide-save]').forEach(button=>{const active=saved.includes(button.dataset.guideSave);button.textContent=active?'Saved page':'Save page';button.setAttribute('aria-pressed',String(active));});}
 function toc(){
  const holder=document.getElementById('guide-toc-links');holder.replaceChildren();document.getElementById('guide-toc').hidden=!selected;
  if(!selected)return;
  for(const heading of document.querySelectorAll('#lesson-'+selected+' h3[id],#lesson-'+selected+' h4[id]')){const link=document.createElement('a');link.href='/product-guide?lesson='+selected+'#'+heading.id;link.textContent=heading.textContent.replace(/#$/,'');if(heading.tagName==='H4')link.className='docs-toc-sub';link.addEventListener('click',event=>{event.preventDefault();navigate(selected,heading.id);});holder.append(link);}
 }
 function filter(){
  const terms=search.value.toLowerCase().trim().split(/\s+/).filter(Boolean),matches=chapters.filter(c=>(!savedOnly||saved.includes(c.id))&&terms.every(term=>c.search.toLowerCase().includes(term)));
  for(const c of chapters)document.querySelectorAll(`[data-chapter-result="${c.id}"]`).forEach(el=>el.hidden=!matches.includes(c));
  document.querySelectorAll('.docs-nav-group,[data-topic-group]').forEach(group=>group.hidden=![...group.querySelectorAll('[data-chapter-result]')].some(el=>!el.hidden));
  document.getElementById('guide-results').textContent=matches.length+' matching article'+(matches.length===1?'':'s');
  document.getElementById('guide-no-results').hidden=!!selected||!!matches.length;
  document.getElementById('guide-overview').hidden=!!selected||!!terms.length||!matches.length;
  document.getElementById('guide-search-results').hidden=!!selected||!terms.length||!matches.length;
  const holder=document.getElementById('docs-search-matches');holder.replaceChildren();
  if(!terms.length||selected)return;
  document.getElementById('docs-search-summary').textContent=`${matches.length} articles for “${search.value.trim()}”. Open an article or jump directly to a matching section.`;
  for(const c of matches){
   const section=document.createElement('section');section.className='docs-search-result';
   const link=document.createElement('a');link.href='/product-guide?lesson='+c.id;link.textContent=c.title;link.addEventListener('click',e=>{e.preventDefault();navigate(c.id);});section.append(link);
   const related=(c.sections||[]).filter(s=>terms.some(term=>(s.title+' '+s.body).toLowerCase().includes(term))).slice(0,3);
   for(const s of related){const jump=document.createElement('a');jump.className='docs-section-result';jump.href=link.href+'#'+s.anchor;jump.textContent=s.title;const excerpt=document.createElement('p');const lower=s.body.toLowerCase(),positions=terms.map(t=>lower.indexOf(t)).filter(n=>n>=0),index=positions.length?Math.max(0,Math.min(...positions)-65):0;excerpt.textContent=(index?'…':'')+s.body.slice(index,index+210)+(s.body.length>index+210?'…':'');jump.addEventListener('click',e=>{e.preventDefault();navigate(c.id,s.anchor);});section.append(jump,excerpt);}
   holder.append(section);
  }
 }
 function show(id,anchor='',focus=false){
  selected=known.has(id)?id:'';
  document.getElementById('guide-print').disabled=!selected;
  document.querySelectorAll('[data-guide-lesson]').forEach(el=>el.hidden=el.dataset.guideLesson!==selected);
  document.querySelectorAll('[data-guide-open]').forEach(link=>{if(link.dataset.guideOpen===selected)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
  if(selected){const article=document.getElementById('lesson-'+selected),index=chapters.findIndex(c=>c.id===selected);for(const [selector,next] of [['[data-guide-prev]',chapters[index-1]],['[data-guide-next]',chapters[index+1]]]){const button=article.querySelector(selector);button.hidden=!next;button.querySelector('span').textContent=next?.title||'';}
   const target=anchor&&document.getElementById(anchor);const heading=target&&article.contains(target)?target:article.querySelector('h2');if(focus||target){heading.focus({preventScroll:true});heading.scrollIntoView({block:'start'});}
  }
  toc();filter();bookmarks();
 }
 function navigate(id,anchor=''){search.value='';savedOnly=false;document.getElementById('guide-bookmarks').setAttribute('aria-pressed','false');const url=new URL('/product-guide',location.origin);if(id)url.searchParams.set('lesson',id);else url.searchParams.set('lesson','');if(anchor)url.hash=anchor;history.pushState({},'',url);show(id,anchor,true);store();}
 document.querySelectorAll('[data-guide-open]').forEach(link=>link.addEventListener('click',event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(link.dataset.guideOpen);}));
 function query(){const url=new URL('/product-guide',location.origin);url.searchParams.set('lesson','');if(search.value.trim())url.searchParams.set('q',search.value.trim());history.replaceState({},'',url);show('');}
 search.addEventListener('input',query);document.getElementById('guide-search-form').addEventListener('submit',e=>{e.preventDefault();query();});
 document.getElementById('guide-home').addEventListener('click',()=>navigate(''));
 document.getElementById('guide-clear-search').addEventListener('click',()=>navigate(''));
 document.getElementById('guide-bookmarks').addEventListener('click',event=>{savedOnly=!savedOnly;event.currentTarget.setAttribute('aria-pressed',String(savedOnly));query();});
 document.querySelectorAll('[data-guide-save]').forEach(button=>button.addEventListener('click',()=>{const id=button.dataset.guideSave;saved=saved.includes(id)?saved.filter(x=>x!==id):[...saved,id];store();bookmarks();status.textContent=saved.includes(id)?'Page saved in this browser.':'Page removed from saved pages.';}));
 document.querySelectorAll('[data-guide-copy]').forEach(button=>button.addEventListener('click',async()=>{const url=new URL('/product-guide',location.origin);url.searchParams.set('lesson',button.dataset.guideCopy);url.hash=location.hash;try{await navigator.clipboard.writeText(url.href);status.textContent='Article link copied. Access is checked for each reader.';}catch(_){status.textContent='Article link: '+url.href;}}));
 document.querySelectorAll('[data-guide-prev],[data-guide-next]').forEach(button=>button.addEventListener('click',()=>{const index=chapters.findIndex(c=>c.id===selected);const next=chapters[index+(button.hasAttribute('data-guide-next')?1:-1)];if(next)navigate(next.id);}));
 document.querySelectorAll('.docs-anchor').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();navigate(selected,new URL(link.href).hash.slice(1));}));
 document.getElementById('guide-print').addEventListener('click',()=>window.print());
 document.addEventListener('keydown',event=>{if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)&&!event.target.isContentEditable&&!dialog.open){event.preventDefault();search.focus();}if(event.key==='Escape'&&document.activeElement===search){navigate('');search.focus();}});
 const dialog=document.getElementById('guide-image-dialog'),image=document.getElementById('guide-zoom-image');let zoom=100,opener;
 function setZoom(value){zoom=Math.min(300,Math.max(50,value));image.style.width=zoom+'%';document.getElementById('guide-zoom-level').textContent=zoom+'%';}
 document.querySelectorAll('[data-guide-zoom]').forEach(button=>button.addEventListener('click',()=>{opener=button;image.src=button.dataset.guideZoom;image.alt=button.querySelector('img').alt;document.getElementById('guide-zoom-caption').textContent=button.dataset.caption;setZoom(100);dialog.showModal();}));
 document.getElementById('guide-zoom-in').addEventListener('click',()=>setZoom(zoom+25));document.getElementById('guide-zoom-out').addEventListener('click',()=>setZoom(zoom-25));document.getElementById('guide-zoom-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>opener?.focus());dialog.addEventListener('keydown',event=>{if(event.key==='+'||event.key==='='){event.preventDefault();setZoom(zoom+25);}if(event.key==='-'){event.preventDefault();setZoom(zoom-25);}});
 function hash(){try{return decodeURIComponent(location.hash.slice(1));}catch(_){return '';}}
 window.addEventListener('popstate',()=>{const query=new URLSearchParams(location.search);search.value=query.get('q')||'';savedOnly=false;document.getElementById('guide-bookmarks').setAttribute('aria-pressed','false');show(query.has('lesson')?query.get('lesson'):(search.value?'':'welcome'),hash());});
 show(selected,hash());
})();
