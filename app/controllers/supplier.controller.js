const supplierService = require('../services/supplier.service');
const activityService = require('../services/activity.service');

// Render the Suppliers master list page
async function renderSuppliersList(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) return res.redirect('/select-business');
        const suppliers = await supplierService.searchSuppliers(req.query.q || '', 100, businessId);
        res.render('suppliers/index', {
            pageTitle: 'Suppliers',
            pageSubtitle: 'Manage vendor master data.',
            suppliers,
            search: req.query.q || '',
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

// Render the New Supplier creation form page
async function renderNewSupplier(req, res, next) {
    try {
        res.render('suppliers/form', {
            pageTitle: 'Add Supplier',
            pageSubtitle: 'Create a new vendor record.',
            supplier: {},
            returnTo: req.query.returnTo || '',
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

// Render the Edit Supplier form page
async function renderEditSupplier(req, res, next) {
  try {
    const supplier = await supplierService.getSupplierById(req.params.id, req.businessId || req.session?.activeBusinessId);
    res.render('suppliers/form', {
      pageTitle: 'Edit Supplier',
      pageSubtitle: 'Update supplier details.',
      supplier,
      csrfToken: req.session ? req.session.csrfToken : ''
    });
  } catch (err) {
    return next(err);
  }
}

// Create a new supplier record
async function createSupplier(req, res, next) {
  try {
    const businessId = req.businessId || req.session?.activeBusinessId;
    const userId = req.user?.id || req.session?.user?.id || req.session?.userId || null;
    await supplierService.createSupplier({ ...req.body, businessId }, userId);
    return res.redirect(req.body.returnTo && req.body.returnTo.startsWith('/') && !req.body.returnTo.startsWith('//') ? req.body.returnTo : '/suppliers');
  } catch (err) {
    if (err instanceof supplierService.ValidationError || err instanceof supplierService.ConflictError) {
      return res.status(400).render('suppliers/form', {
        pageTitle: 'Add Supplier', pageSubtitle: 'Create a new vendor record.', supplier: req.body,
        returnTo: req.body.returnTo || '', error: err.message, csrfToken: req.session ? req.session.csrfToken : ''
      });
    }
    return next(err);
  }
}

// Inactivate (soft delete) a supplier
async function updateSupplier(req, res, next) {
  try {
    const businessId = req.businessId || req.session?.activeBusinessId;
    const userId = req.user?.id || req.session?.user?.id || req.session?.userId || null;
    const payload = { ...req.body, active: req.body.active === 'true' || req.body.active === true };
    await supplierService.updateSupplier(req.params.id, payload, userId, businessId);
    return res.redirect('/suppliers');
  } catch (err) {
    if (err instanceof supplierService.ValidationError || err instanceof supplierService.ConflictError) {
      return res.status(400).render('suppliers/form', {
        pageTitle: 'Edit Supplier', pageSubtitle: 'Update supplier details.', supplier: { ...req.body, id: req.params.id },
        error: err.message, csrfToken: req.session ? req.session.csrfToken : ''
      });
    }
    return next(err);
  }
}

async function setSupplierActive(req, res, next) {
  try {
    const businessId = req.businessId || req.session?.activeBusinessId;
    const userId = req.user?.id || req.session?.user?.id || req.session?.userId || null;
    await supplierService.setSupplierActive(req.params.id, req.body.active === 'true' || req.body.active === true, userId, businessId);
    return res.redirect('/suppliers');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  renderSuppliersList,
  renderNewSupplier,
  renderEditSupplier,
  createSupplier,
  updateSupplier,
  setSupplierActive
};
