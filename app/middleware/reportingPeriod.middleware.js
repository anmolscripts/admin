'use strict';
const fyService = require('../services/financialYear.service');
const iso = date => { const d=new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const listPaths = new Set(['/', '/documents','/purchases/orders','/purchases/bills','/financials/expenses','/financials/other-income','/reports/workbench']);
module.exports = async function reportingPeriod(req,res,next) {
  if(req.method!=='GET'||!req.session?.user||!req.businessId||req.path.startsWith('/api/'))return next();
  try {
    const fy=await fyService.ensureCurrentFinancialYear(req.businessId);
    res.locals.currentFinancialYear=fy;
    const query={...req.query};
    let selectedYear=fy;
    if(query.financialYearId){
      selectedYear=(await fyService.listFinancialYears(req.businessId)).find(year=>year.id===Number(query.financialYearId));
      if(!selectedYear)throw Object.assign(new Error('Choose a financial year in the current business.'),{statusCode:400});
    }
    let fromName='dateFrom',toName='dateTo';
    const isDashboard=req.path==='/dashboard';
    const isReport=/^\/reports\/(journals|general-ledger|trial-balance|profit-and-loss|customer-statement)(\/|$)/.test(req.path);
    if(isDashboard){fromName='from';toName='to';}
    else if(isReport){fromName='fromDate';toName='toDate';}
    const applies=listPaths.has(req.path)||isReport||isDashboard;
    if(applies&&!Object.hasOwn(query,fromName)&&!Object.hasOwn(query,toName)&&!query.financialYearId&&(!isDashboard||!query.range)){
      query[fromName]=iso(fy.startDate);query[toName]=iso(fy.endDate);
      if(isDashboard)query.range='current_fy';
    }
    if(req.path.startsWith('/reports'))query.businessId=String(req.businessId);
    if(applies){
      for(const key of [fromName,toName])if(query[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(query[key])||Number.isNaN(Date.parse(query[key]))||new Date(query[key]).toISOString().slice(0,10)!==query[key]))throw Object.assign(new Error('Choose valid reporting dates.'),{statusCode:400});
      if(query[fromName]&&query[toName]&&query[fromName]>query[toName])throw Object.assign(new Error('The start date must be on or before the end date.'),{statusCode:400});
      Object.defineProperty(req,'query',{value:query,configurable:true});
    }
    res.locals.reportingPeriod={from:query[fromName]??iso(selectedYear.startDate),to:query[toName]??iso(selectedYear.endDate),fromName,toName,applies,action:applies?req.path:'/reports/workbench',query};
    next();
  }catch(error){next(error);}
};
