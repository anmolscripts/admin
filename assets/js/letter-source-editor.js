(function(){
 'use strict';
 let loading;
 function load(){
  if(!loading)loading=new Promise((resolve,reject)=>{
   if(window.monaco?.editor)return resolve(window.monaco);
   window.require.config({paths:{vs:'/libs/monaco/vs'}});
   window.require(['vs/editor/editor.main'],()=>resolve(window.monaco),reject);
  });
  return loading;
 }
 async function create({html,css,onChange,status}){
  const monaco=await load(),tools=window.LetterCodeTools;
  const range=(model,from,to)=>{const a=model.getPositionAt(from),b=model.getPositionAt(to);return new monaco.Range(a.lineNumber,a.column,b.lineNumber,b.column);};
  let cachedText,cachedPairs;
  const pairsFor=text=>{if(text!==cachedText){cachedText=text;cachedPairs=tools.tagPairs(text);}return cachedPairs;};
  const theme=()=>monaco.editor.setTheme(document.documentElement.dataset.theme==='dark'?'vs-dark':'vs');theme();
  const observer=new MutationObserver(theme);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  const options={editContext:false,automaticLayout:true,minimap:{enabled:false},fontSize:14,lineNumbers:'on',lineNumbersMinChars:3,tabSize:2,insertSpaces:true,wordWrap:'on',scrollBeyondLastLine:false,autoIndent:'full',autoClosingBrackets:'always',autoClosingQuotes:'always',autoClosingDelete:'always',linkedEditing:false,matchBrackets:'always',bracketPairColorization:{enabled:true},folding:true,formatOnPaste:true,formatOnType:true,quickSuggestions:true,suggestOnTriggerCharacters:true,padding:{top:12,bottom:12}};
  const htmlHost=document.getElementById('letter-html-code'),cssHost=document.getElementById('letter-css-code');
  htmlHost.style.display=cssHost.style.display='block';
  const uri='inmemory://letter/'+Date.now();
  const htmlModel=monaco.editor.createModel(html,'html',monaco.Uri.parse(uri+'.html')),cssModel=monaco.editor.createModel(css,'css',monaco.Uri.parse(uri+'.css'));
  const htmlEditor=monaco.editor.create(htmlHost,{...options,model:htmlModel,ariaLabel:'HTML code editor'}),cssEditor=monaco.editor.create(cssHost,{...options,model:cssModel,ariaLabel:'CSS code editor'});
  let active=htmlEditor,previous=htmlModel.getValue(),applying=false,decorating=false,decorations=[];
  function currentPair(){return tools.enclosingPair(pairsFor(htmlModel.getValue()),htmlModel.getOffsetAt(htmlEditor.getPosition()));}
  function focusTag(){
   if(decorating)return;decorating=true;
   const pair=currentPair();
   try{decorations=htmlEditor.deltaDecorations(decorations,pair?[{range:range(htmlModel,pair.openNameFrom,pair.openNameTo),options:{inlineClassName:'letter-matching-tag'}},{range:range(htmlModel,pair.closeNameFrom,pair.closeNameTo),options:{inlineClassName:'letter-matching-tag'}}]:[]);}finally{decorating=false;}
   const position=active.getPosition();status.textContent=(active===htmlEditor&&pair?'<'+pair.name+'> · ':'')+'Line '+position.lineNumber+', column '+position.column;
  }
  htmlEditor.onDidFocusEditorText(()=>{active=htmlEditor;focusTag();});cssEditor.onDidFocusEditorText(()=>{active=cssEditor;focusTag();});
  htmlEditor.onDidChangeCursorPosition(focusTag);cssEditor.onDidChangeCursorPosition(focusTag);
  htmlEditor.onDidChangeModelContent(event=>{
   if(applying)return;
   const edits=event.isUndoing||event.isRedoing?[]:[...tools.pairedDeletions(previous,event.changes),...tools.pairedRename(previous,event.changes)];
   if(edits.length){
    const version=htmlModel.getVersionId();
    queueMicrotask(()=>{if(htmlModel.isDisposed()||htmlModel.getVersionId()!==version)return;applying=true;try{htmlEditor.executeEdits('letter-paired-edit',edits.map(edit=>({range:range(htmlModel,edit.from,edit.to),text:edit.text||''})));previous=htmlModel.getValue();}finally{applying=false;}focusTag();onChange();});
   }
   previous=htmlModel.getValue();focusTag();onChange();
  });
  cssEditor.onDidChangeModelContent(()=>{focusTag();onChange();});
  htmlEditor.onDidType(text=>{
   if(text!=='>')return;
   const position=htmlEditor.getPosition(),name=tools.unclosedTagAt(htmlModel.getValue(),htmlModel.getOffsetAt(position));
   if(name)htmlEditor.executeEdits('letter-close-tag',[{range:monaco.Range.fromPositions(position),text:'</'+name+'>'}],[monaco.Selection.fromPositions(position)]);
  });
  htmlEditor.onKeyDown(event=>{
   if(event.keyCode!==monaco.KeyCode.Backspace||!htmlEditor.getSelection().isEmpty())return;
   const offset=htmlModel.getOffsetAt(htmlEditor.getPosition()),pair=pairsFor(htmlModel.getValue()).find(p=>p.openTo===offset&&p.closeFrom===offset);
   if(pair){event.preventDefault();htmlEditor.executeEdits('letter-empty-tag',[{range:range(htmlModel,pair.openFrom,pair.closeTo),text:''}]);}
  });
  focusTag();
  return {
   getHtml:()=>htmlModel.getValue(),getCss:()=>cssModel.getValue(),
   setHtml(value){if(htmlModel.getValue()!==value)htmlModel.setValue(value);},
   async format(){await Promise.all([htmlEditor.getAction('editor.action.formatDocument').run(),cssEditor.getAction('editor.action.formatDocument').run()]);},
   find(){active.getAction('editor.action.startFindReplaceAction').run();},
   commands(){active.focus();active.trigger('letter','editor.action.quickCommand',null);},
   rename(){htmlEditor.focus();htmlEditor.getAction('editor.action.rename').run();},
   selectTags(){const pair=currentPair();if(!pair)throw Error('Place the caret inside a matching HTML tag first.');htmlEditor.setSelections([range(htmlModel,pair.openNameFrom,pair.openNameTo),range(htmlModel,pair.closeNameFrom,pair.closeNameTo)].map(r=>new monaco.Selection(r.startLineNumber,r.startColumn,r.endLineNumber,r.endColumn)));htmlEditor.focus();},
   removeTags(){const pair=currentPair();if(!pair)throw Error('Place the caret inside a matching HTML element first.');htmlEditor.pushUndoStop();htmlEditor.executeEdits('letter-remove-tag',[{range:range(htmlModel,pair.openFrom,pair.openTo),text:''},{range:range(htmlModel,pair.closeFrom,pair.closeTo),text:''}]);htmlEditor.pushUndoStop();htmlEditor.focus();},
   wrap(enabled){htmlEditor.updateOptions({wordWrap:enabled?'on':'off'});cssEditor.updateOptions({wordWrap:enabled?'on':'off'});},
   cssError(){return monaco.editor.getModelMarkers({resource:cssModel.uri}).find(marker=>marker.severity===monaco.MarkerSeverity.Error)?.message||'';},
   undo(){active.trigger('letter','undo',null);},redo(){active.trigger('letter','redo',null);},
   insertHtml(text){htmlEditor.executeEdits('letter-insert',[{range:htmlEditor.getSelection(),text}]);htmlEditor.focus();},
   layout(){htmlEditor.layout();cssEditor.layout();},
   dispose(){observer.disconnect();htmlEditor.dispose();cssEditor.dispose();htmlModel.dispose();cssModel.dispose();}
  };
 }
 window.LetterSourceEditor={create};
})();
