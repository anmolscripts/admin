'use strict';
// Public field allowlists are shared by inspection, editing and history redaction.
const entry = (model, table, module, title, fields, edit = [], page = null, editAction = 'EDIT', viewAction = 'VIEW') => ({ model, table, module, title, fields, edit, page, editAction, viewAction });
module.exports = {
    client: entry('client','clients','CLIENTS','Client',['clientCode','name','email','phone','gstin','stateCode','billingAddress','shippingAddress','active'],['name','email','phone','gstin','stateCode','billingAddress','shippingAddress','active']),
    item: entry('item','items','ITEMS','Item',['itemCode','name','description','unit','rate','hsnSac','gstRate','active'],['name','description','unit','rate','hsnSac','gstRate','active']),
    unit: entry('unit','units','UNITS','Unit',['unitCode','name','symbol','description','active'],['name','symbol','description','active']),
    supplier: entry('supplier','suppliers','CLIENTS','Supplier',['supplierCode','name','email','phone','gstin','stateCode','address','active'],['name','email','phone','gstin','stateCode','address','active']),
    project: entry('project','projects','PROJECTS','Project',['code','name','description','clientId','managerId','siteLocation','status','startDate','endDate','contractValue','budgetAmount','budgetMaterials','budgetLabour','budgetSubcontractor','budgetExpenses','hourlyRate','costRate','closedAt','closedById','closureOverrideReason'],['name','description','siteLocation'], '/projects'),
    invoice: entry('invoice','invoices','DOCUMENTS','Document',['invoiceNumber','documentType','clientName','clientEmail','clientPhone','sellerName','billingAddress','shippingAddress','invoiceDate','dueDate','validUntil','status','subtotal','gstAmount','grandTotal','paidAmount','outstandingAmount','remarks','termsAndConditions'],[], '/documents'),
    purchaseOrder: entry('purchaseOrder','purchase_orders','DOCUMENTS','Purchase order',['orderNumber','supplierName','orderDate','dueDate','status','taxableSubtotal','cgstAmount','sgstAmount','igstAmount','totalTaxAmount','totalAmount','remarks','termsAndConditions'],[], '/purchases/orders'),
    supplierBill: entry('supplierBill','supplier_bills','DOCUMENTS','Supplier bill',['billNumber','internalNumber','externalInvoiceNumber','supplierName','billDate','dueDate','status','taxableAmount','cgstAmount','sgstAmount','igstAmount','totalAmount','verificationStatus'],[], '/purchases/bills'),
    goodsReceipt: entry('goodsReceipt','goods_receipts','DOCUMENTS','Goods receipt',['receiptNumber','supplierName','receiptDate','deliveryChallanNumber','storeLocation','status','notes'],[], '/purchases/receipts'),
    expense: entry('expense','expenses','ACCOUNTS','Expense',['expenseNumber','expenseDate','category','description','amount','version']),
    otherIncome: entry('otherIncome','other_incomes','ACCOUNTS','Other income',['incomeNumber','incomeDate','source','description','amount','version']),
    payment: entry('payment','payments','PAYMENTS','Customer payment',['receiptNumber','paymentDate','amount','method','reference','status','clearedAt','notes']),
    supplierPayment: entry('supplierPayment','supplier_payments','DOCUMENTS','Supplier payment',['paymentNumber','paymentDate','amount','method','reference','status','notes']),
    creditDebitNote: entry('creditDebitNote','credit_debit_notes','CREDIT_NOTES','Credit / debit note',['noteNumber','noteType','noteDate','status','reason','subtotal','gstAmount','grandTotal'],[], '/credit-debit-notes'),
    journalEntry: entry('journalEntry','journal_entries','JOURNALS','Journal entry',['entryNumber','entryDate','sourceType','narration','status','postedAt'],[], '/reports/journals'),
    stockMovement: entry('stockMovement','stock_movements','ITEMS','Stock movement',['movementNumber','movementDate','movementType','quantity','unitCost','totalCost','storeLocation','notes']),
    employee: entry('employee','employees','TEAM','Employee',['employeeCode','firstName','lastName','designation','department','dateOfJoining','status']),
    payrollPeriod: entry('payrollPeriod','payroll_periods','ACCOUNTS','Payroll period',['periodCode','startDate','endDate','status','approvedAt']),
    projectTask: entry('projectTask','project_tasks','PROJECTS','Project task',['title','description','status','dueDate','estimatedHours','actualHours']),
    timesheetEntry: entry('timesheetEntry','timesheet_entries','PROJECTS','Timesheet entry',['entryDate','hours','status','notes']),
    dailyWorker: entry('dailyWorker','daily_workers','PROJECTS','Daily worker',['workerCode','name','trade','phone','status']),
    projectAttachment: entry('projectAttachment','project_attachments','PROJECTS','Attachment',['title','category','description','originalFilename','mimeType','fileSize','issueDate','expiryDate'],[],null,'EDIT','ATTACHMENT_VIEW')
};
