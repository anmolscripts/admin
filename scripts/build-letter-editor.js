'use strict';
const path=require('node:path');
const fs=require('node:fs');
const root=path.resolve(__dirname,'..');
require('esbuild').buildSync({entryPoints:[path.join(root,'assets/js/letter-code-tools.source.js')],bundle:true,minify:true,platform:'browser',format:'iife',globalName:'LetterCodeTools',outfile:path.join(root,'assets/js/letter-code-tools.js'),legalComments:'eof'});
const monaco=path.resolve(path.dirname(require.resolve('monaco-editor')),'../..');
const output=path.join(root,'assets/libs/monaco');
fs.mkdirSync(output,{recursive:true});
fs.cpSync(path.join(monaco,'min/vs'),path.join(output,'vs'),{recursive:true});
for(const file of ['LICENSE','ThirdPartyNotices.txt'])fs.copyFileSync(path.join(monaco,file),path.join(output,file));
console.log('Letter code tools and local Monaco assets built.');
const notices=['htmlparser2','domhandler','domutils','dom-serializer','domelementtype','entities'].map(name=>{
 const folder=path.join(root,'node_modules',name),license=fs.readdirSync(folder).find(file=>/^licen[sc]e(?:\..*)?$/i.test(file));
 return name+'\n'+fs.readFileSync(path.join(folder,license),'utf8');
});
fs.writeFileSync(path.join(root,'assets/js/letter-code-tools.LICENSE.txt'),notices.join('\n\n--------------------\n\n'));
