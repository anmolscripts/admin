'use strict';
const router=require('express').Router();
const requireAuth=require('../middleware/auth.middleware');
const {requirePermission}=require('../middleware/permission.middleware');
const service=require('../services/recordDesk.service');
router.use(requireAuth);
router.use('/:type/:id', (req,res,next)=>{
    try { const def=service.definition(req.params.type); return requirePermission(def.module,def.viewAction)(req,res,next); }
    catch(error){next(error);}
});
const context=req=>({businessId:req.businessId,userId:req.session.user.id,permissions:req.userPermissions});
router.get('/:type/:id',async(req,res,next)=>{try{res.json({success:true,data:await service.inspect(req.params.type,req.params.id,context(req))});}catch(error){next(error);}});
router.get('/:type/:id/history',async(req,res,next)=>{try{res.json({success:true,data:await service.listHistory(req.params.type,req.params.id,context(req),req.query.page)});}catch(error){next(error);}});
router.put('/:type/:id',async(req,res,next)=>{try{res.json({success:true,data:await service.update(req.params.type,req.params.id,req.body,context(req))});}catch(error){next(error);}});
module.exports=router;
