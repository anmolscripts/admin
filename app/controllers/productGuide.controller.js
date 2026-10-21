'use strict';
const path=require('node:path');
const fs=require('node:fs');
const prisma=require('../config/prisma');
const guide=require('../services/productGuide.service');
const {NotFoundError,ForbiddenError}=require('../services/errorTypes');
const imageDirectory=path.join(__dirname,'../content/product-guide-screens');
async function context(req){
 const user=await prisma.user.findUnique({where:{id:req.session.user.id},select:{id:true,role:true,active:true}});
 if(!user?.active)throw new ForbiddenError('Your account is inactive.');
 return {...user,hasPermission:(module,action)=>Boolean(req.hasPermission?.(module,action))};
}
async function render(req,res,next){
 try{
  const current=await context(req);const chapters=guide.catalogue(current).map(chapter=>({...chapter,search:guide.searchText(chapter),screen:chapter.screen?{...chapter.screen,available:fs.existsSync(path.join(imageDirectory,chapter.screen.id+'.png'))}:null}));
  const selected=typeof req.query.lesson==='string'?req.query.lesson:(req.query.q?'':'welcome');
  if(selected&&!chapters.some(chapter=>chapter.id===selected))throw new NotFoundError('This guide chapter is not available for your current access.');
  res.set('Cache-Control','private, no-store');
  res.render('product-guide/index',{pageTitle:'Product Documentation',pageSubtitle:'Guides and reference for your workspace.',chapters,selected,guideRole:req.userPermissions?.roleName||current.role,guideUserId:current.id,guideBusinessId:req.businessId||0,guideQuery:typeof req.query.q==='string'?req.query.q.slice(0,150):''});
 }catch(error){next(error);}
}
async function screenshot(req,res,next){
 try{
  const screen=guide.getScreen(req.params.id,await context(req));
  if(!screen)throw new NotFoundError('Training image not available.');
  const file=path.join(imageDirectory,req.params.id+'.png');if(!fs.existsSync(file))throw new NotFoundError('Training image is being prepared. Open the training screen from the chapter instead.');
  res.set('Cache-Control','private, no-store');res.sendFile(file);
 }catch(error){next(error);}
}
async function demo(req,res,next){
 try{
  const screen=guide.getScreen(req.params.id,await context(req));if(!screen)throw new NotFoundError('Training screen not available.');
  res.set('Cache-Control','private, no-store');
  res.set('Content-Security-Policy',"default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'none'; frame-ancestors 'self'");
  res.render('product-guide/screen',{screen});
 }catch(error){next(error);}
}
module.exports={render,screenshot,demo};
