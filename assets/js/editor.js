/**
 * ========================================================================
 * SPARK ADMIN - REUSABLE DOCUMENT EDITOR CONTROLLER
 * Supports Quotation Creation, Invoice Creation, Quotation Editing, Invoice Editing
 * ========================================================================
 */

(function () {
    'use strict';

    // Application State
    let isDirty = false;
    let isSaving = false;
    let initialDoc = null;
    let editorMode = 'create'; // 'create' | 'edit'
    let docType = 'INVOICE';   // 'QUOTATION' | 'INVOICE'

    // DOM Elements Cache
    let formEl;
    let csrfTokenInput;
    let docIdInput;
    let docVersionInput;
    let docDateInput;
    let docDueDateInput;
    let clientNameInput;
    let clientEmailInput;
    let clientPhoneInput;
    let billingAddressInput;
    let shippingAddressInput;
    let sameAsBillingToggle;
    let docTermsInput;
    let docNotesInput;
    let itemsTbody;
    let btnAddItem;
    let btnAddItemHeader;
    let itemsCountIndicator;
    let gstEnabledToggle;
    let gstRateContainer;
    let gstRateSelect;
    let summarySubtotalEl;
    let summaryGstBreakdownEl;
    let summaryCgstLabelEl;
    let summaryCgstAmountEl;
    let summarySgstLabelEl;
    let summarySgstAmountEl;
    let summaryGstTotalEl;
    let summaryRoundoffEl;
    let summaryGrandtotalEl;
    let btnSave;
    let btnSaveText;
    let saveSpinner;
    let saveIcon;
    let btnCancel;
    let btnBackHeader;
    let conflictAlert;
    let conflictMessageEl;
    let btnReloadConflict;
    let formErrorAlert;
    let formErrorMessageEl;
    let formSuccessAlert;
    let unsavedWarningBanner;

    /**
     * Currency formatting using Indian numbering system (₹ 1,25,000.00)
     */
    function formatIndianCurrency(amount) {
        const num = Number(amount);
        if (isNaN(num)) return '₹0.00';

        const isNegative = num < 0;
        const absNum = Math.abs(num);
        const parts = absNum.toFixed(2).split('.');
        let integerPart = parts[0];
        const decimalPart = parts[1];

        // Format integer part for Indian numbering (last 3, then groups of 2)
        if (integerPart.length > 3) {
            const lastThree = integerPart.substring(integerPart.length - 3);
            const remaining = integerPart.substring(0, integerPart.length - 3);
            integerPart = remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree;
        }

        return (isNegative ? '-₹' : '₹') + integerPart + '.' + decimalPart;
    }

    /**
     * Format a Date object to YYYY-MM-DD string for input[type="date"]
     */
    function formatDateToInputString(date) {
        if (!date) return '';
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    /**
     * Mark form dirty state and update warning
     */
    function markDirty() {
        if (!isDirty) {
            isDirty = true;
        }
    }

    /**
     * Create an accessible item row element
     */
    function createItemRow(data = {}) {
        const tr = document.createElement('tr');
        tr.className = 'line-item-row';

        const name = data.name || '';
        const quantity = data.quantity !== undefined ? Number(data.quantity) : 1;
        const unit = data.unit || 'PCS';
        const rate = data.rate !== undefined ? Number(data.rate) : 0;
        const amount = Math.round(quantity * rate * 100) / 100;

        tr.innerHTML = `
            <td class="text-center">
                <span class="item-index-badge">1</span>
            </td>
            <td>
                <input 
                    type="text" 
                    class="form-control-custom item-name" 
                    placeholder="Item description or service..." 
                    value="${escapeHtml(name)}" 
                    required 
                    aria-label="Item description"
                />
            </td>
            <td>
                <input 
                    type="number" 
                    class="form-control-custom item-qty text-end font-monospace" 
                    value="${quantity}" 
                    min="0.01" 
                    step="0.01" 
                    required 
                    aria-label="Item quantity"
                />
            </td>
            <td>
                <select class="form-select-custom item-unit" aria-label="Item unit">
                    <option value="PCS" ${unit === 'PCS' ? 'selected' : ''}>PCS</option>
                    <option value="Project" ${unit === 'Project' ? 'selected' : ''}>Project</option>
                    <option value="Hours" ${unit === 'Hours' ? 'selected' : ''}>Hours</option>
                    <option value="Months" ${unit === 'Months' ? 'selected' : ''}>Months</option>
                    <option value="Units" ${unit === 'Units' ? 'selected' : ''}>Units</option>
                    <option value="License" ${unit === 'License' ? 'selected' : ''}>License</option>
                    <option value="Year" ${unit === 'Year' ? 'selected' : ''}>Year</option>
                    <option value="Package" ${unit === 'Package' ? 'selected' : ''}>Package</option>
                    <option value="Set" ${unit === 'Set' ? 'selected' : ''}>Set</option>
                    <option value="KG" ${unit === 'KG' ? 'selected' : ''}>KG</option>
                    <option value="Service" ${unit === 'Service' ? 'selected' : ''}>Service</option>
                </select>
            </td>
            <td>
                <input 
                    type="number" 
                    class="form-control-custom item-rate text-end font-monospace" 
                    value="${rate.toFixed(2)}" 
                    min="0" 
                    step="0.01" 
                    required 
                    aria-label="Item rate in rupees"
                />
            </td>
            <td class="text-end">
                <span class="item-amount-display font-monospace fw-semibold">${formatIndianCurrency(amount)}</span>
            </td>
            <td class="text-center">
                <button type="button" class="btn-remove-item" title="Remove item" aria-label="Remove item">
                    <i class="bi bi-trash3"></i>
                </button>
            </td>
        `;

        // Attach Row Listeners
        const nameInput = tr.querySelector('.item-name');
        const qtyInput = tr.querySelector('.item-qty');
        const unitSelect = tr.querySelector('.item-unit');
        const rateInput = tr.querySelector('.item-rate');
        const removeBtn = tr.querySelector('.btn-remove-item');

        nameInput.addEventListener('input', () => {
            nameInput.classList.remove('is-invalid-custom');
            markDirty();
        });

        qtyInput.addEventListener('input', () => {
            qtyInput.classList.remove('is-invalid-custom');
            updateRowAmount(tr);
            markDirty();
            recalculateTotals();
        });

        unitSelect.addEventListener('change', () => {
            markDirty();
        });

        rateInput.addEventListener('input', () => {
            rateInput.classList.remove('is-invalid-custom');
            updateRowAmount(tr);
            markDirty();
            recalculateTotals();
        });

        removeBtn.addEventListener('click', () => {
            removeItemRow(tr);
        });

        return tr;
    }

    /**
     * Escape HTML helper for safe interpolation
     */
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Update row's calculated amount
     */
    function updateRowAmount(tr) {
        const qtyInput = tr.querySelector('.item-qty');
        const rateInput = tr.querySelector('.item-rate');
        const amountDisplay = tr.querySelector('.item-amount-display');

        const qty = parseFloat(qtyInput.value) || 0;
        const rate = parseFloat(rateInput.value) || 0;
        const amount = Math.round(qty * rate * 100) / 100;

        amountDisplay.textContent = formatIndianCurrency(amount);
    }

    /**
     * Re-index all item line badges
     */
    function updateItemRowNumbers() {
        const rows = itemsTbody.querySelectorAll('.line-item-row');
        rows.forEach((row, idx) => {
            const badge = row.querySelector('.item-index-badge');
            if (badge) badge.textContent = idx + 1;
            const nameInput = row.querySelector('.item-name');
            if (nameInput) nameInput.setAttribute('aria-label', `Item ${idx + 1} description`);
        });

        if (itemsCountIndicator) {
            itemsCountIndicator.textContent = `${rows.length} line item${rows.length === 1 ? '' : 's'}`;
        }
    }

    /**
     * Remove an item row
     */
    function removeItemRow(tr) {
        const rows = itemsTbody.querySelectorAll('.line-item-row');
        if (rows.length <= 1) {
            // Do not delete last remaining row; clear inputs instead
            const nameInput = tr.querySelector('.item-name');
            const qtyInput = tr.querySelector('.item-qty');
            const rateInput = tr.querySelector('.item-rate');
            nameInput.value = '';
            qtyInput.value = '1';
            rateInput.value = '0.00';
            updateRowAmount(tr);
            markDirty();
            recalculateTotals();
            return;
        }

        tr.remove();
        updateItemRowNumbers();
        markDirty();
        recalculateTotals();
    }

    /**
     * Add a new blank item row
     */
    function addItemRow(data = {}) {
        const row = createItemRow(data);
        itemsTbody.appendChild(row);
        updateItemRowNumbers();
        markDirty();
        recalculateTotals();

        // Focus description of newly added row if empty
        if (!data.name) {
            const nameInput = row.querySelector('.item-name');
            if (nameInput) nameInput.focus();
        }
    }

    /**
     * Recalculate and update live financial summary in the browser
     * (Authoritative verification remains with backend upon save)
     */
    function recalculateTotals() {
        const rows = itemsTbody.querySelectorAll('.line-item-row');
        let subtotalCents = 0;

        rows.forEach((row) => {
            const qty = parseFloat(row.querySelector('.item-qty').value) || 0;
            const rate = parseFloat(row.querySelector('.item-rate').value) || 0;
            const amount = Math.round(qty * rate * 100) / 100;
            subtotalCents += Math.round(amount * 100);
        });

        const subtotal = subtotalCents / 100;
        const isGst = gstEnabledToggle.checked;
        const gstRate = isGst ? parseFloat(gstRateSelect.value) || 0 : 0;

        let gstAmount = 0;
        if (isGst) {
            gstAmount = Math.round((subtotal * gstRate / 100) * 100) / 100;
        }

        const totalBeforeRound = Math.round((subtotal + gstAmount) * 100) / 100;
        const grandTotal = Math.round(totalBeforeRound);
        const roundOff = Math.round((grandTotal - totalBeforeRound) * 100) / 100;

        // Update DOM displays
        summarySubtotalEl.textContent = formatIndianCurrency(subtotal);

        if (isGst) {
            summaryGstBreakdownEl.classList.remove('d-none');
            const halfRate = (gstRate / 2).toFixed(2);
            const halfGstAmount = Math.round((gstAmount / 2) * 100) / 100;
            const remainingGst = Math.round((gstAmount - halfGstAmount) * 100) / 100;

            summaryCgstLabelEl.textContent = `CGST (${halfRate}%):`;
            summaryCgstAmountEl.textContent = formatIndianCurrency(halfGstAmount);

            summarySgstLabelEl.textContent = `SGST (${halfRate}%):`;
            summarySgstAmountEl.textContent = formatIndianCurrency(remainingGst);

            summaryGstTotalEl.textContent = formatIndianCurrency(gstAmount);
        } else {
            summaryGstBreakdownEl.classList.add('d-none');
        }

        summaryRoundoffEl.textContent = (roundOff >= 0 ? '+' : '') + formatIndianCurrency(roundOff);
        summaryGrandtotalEl.textContent = formatIndianCurrency(grandTotal);
    }

    /**
     * Show validation error alert
     */
    function showErrorAlert(message, title = 'Validation Error') {
        formErrorAlert.classList.remove('d-none');
        formErrorMessageEl.innerHTML = message;
        const heading = formErrorAlert.querySelector('#form-error-title');
        if (heading) heading.textContent = title;
        formErrorAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /**
     * Hide validation error alert
     */
    function hideErrorAlert() {
        formErrorAlert.classList.add('d-none');
    }

    /**
     * Validate client-side inputs prior to submission
     */
    function validateForm() {
        hideErrorAlert();
        let isValid = true;
        let firstInvalidEl = null;

        // 1. Client Name validation
        const clientNameVal = clientNameInput.value.trim();
        const clientNameFeedback = document.getElementById('client-name-feedback');
        if (!clientNameVal) {
            clientNameInput.classList.add('is-invalid-custom');
            if (clientNameFeedback) clientNameFeedback.classList.remove('d-none');
            isValid = false;
            if (!firstInvalidEl) firstInvalidEl = clientNameInput;
        } else {
            clientNameInput.classList.remove('is-invalid-custom');
            if (clientNameFeedback) clientNameFeedback.classList.add('d-none');
        }

        // 1b. Client Email validation (if provided)
        const emailVal = clientEmailInput ? clientEmailInput.value.trim() : '';
        const emailFeedback = document.getElementById('client-email-feedback');
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (emailVal && !emailRegex.test(emailVal)) {
            clientEmailInput.classList.add('is-invalid-custom');
            if (emailFeedback) emailFeedback.classList.remove('d-none');
            isValid = false;
            if (!firstInvalidEl) firstInvalidEl = clientEmailInput;
        } else if (clientEmailInput) {
            clientEmailInput.classList.remove('is-invalid-custom');
            if (emailFeedback) emailFeedback.classList.add('d-none');
        }

        // 2. Document Date validation
        const docDateVal = docDateInput.value;
        const docDateFeedback = document.getElementById('doc-date-feedback');
        if (!docDateVal) {
            docDateInput.classList.add('is-invalid-custom');
            if (docDateFeedback) docDateFeedback.classList.remove('d-none');
            isValid = false;
            if (!firstInvalidEl) firstInvalidEl = docDateInput;
        } else {
            docDateInput.classList.remove('is-invalid-custom');
            if (docDateFeedback) docDateFeedback.classList.add('d-none');
        }

        // 3. Expiry / Due Date validation
        const docDueDateVal = docDueDateInput.value;
        const docDueDateFeedback = document.getElementById('doc-due-date-feedback');
        if (docDateVal && docDueDateVal) {
            const dateObj = new Date(docDateVal);
            const dueObj = new Date(docDueDateVal);
            if (dueObj < dateObj) {
                docDueDateInput.classList.add('is-invalid-custom');
                if (docDueDateFeedback) docDueDateFeedback.classList.remove('d-none');
                isValid = false;
                if (!firstInvalidEl) firstInvalidEl = docDueDateInput;
            } else {
                docDueDateInput.classList.remove('is-invalid-custom');
                if (docDueDateFeedback) docDueDateFeedback.classList.add('d-none');
            }
        }

        // 4. Line Items validation
        const rows = itemsTbody.querySelectorAll('.line-item-row');
        const itemsFeedback = document.getElementById('items-validation-feedback');
        let validItemsCount = 0;

        if (rows.length === 0) {
            if (itemsFeedback) itemsFeedback.classList.remove('d-none');
            isValid = false;
        } else {
            rows.forEach((row, idx) => {
                const nameInput = row.querySelector('.item-name');
                const qtyInput = row.querySelector('.item-qty');
                const rateInput = row.querySelector('.item-rate');

                const name = nameInput.value.trim();
                const qty = parseFloat(qtyInput.value);
                const rate = parseFloat(rateInput.value);

                let rowValid = true;

                if (!name) {
                    nameInput.classList.add('is-invalid-custom');
                    rowValid = false;
                    if (!firstInvalidEl) firstInvalidEl = nameInput;
                } else {
                    nameInput.classList.remove('is-invalid-custom');
                }

                if (isNaN(qty) || qty <= 0) {
                    qtyInput.classList.add('is-invalid-custom');
                    rowValid = false;
                    if (!firstInvalidEl) firstInvalidEl = qtyInput;
                } else {
                    qtyInput.classList.remove('is-invalid-custom');
                }

                if (isNaN(rate) || rate < 0) {
                    rateInput.classList.add('is-invalid-custom');
                    rowValid = false;
                    if (!firstInvalidEl) firstInvalidEl = rateInput;
                } else {
                    rateInput.classList.remove('is-invalid-custom');
                }

                if (rowValid) {
                    validItemsCount++;
                }
            });

            if (validItemsCount === 0 || validItemsCount < rows.length) {
                if (itemsFeedback) itemsFeedback.classList.remove('d-none');
                isValid = false;
            } else {
                if (itemsFeedback) itemsFeedback.classList.add('d-none');
            }
        }

        // 5. Focus first invalid element
        if (!isValid) {
            showErrorAlert('Please fix the highlighted errors before saving.', 'Incomplete Form');
            if (firstInvalidEl) {
                firstInvalidEl.focus();
            }
        }

        return isValid;
    }

    /**
     * Gather payload for submission
     */
    function gatherPayload() {
        const rows = itemsTbody.querySelectorAll('.line-item-row');
        const items = [];

        rows.forEach((row) => {
            items.push({
                name: row.querySelector('.item-name').value.trim(),
                quantity: parseFloat(row.querySelector('.item-qty').value) || 0,
                unit: row.querySelector('.item-unit').value || 'PCS',
                rate: parseFloat(row.querySelector('.item-rate').value) || 0
            });
        });

        const isGst = gstEnabledToggle.checked;
        const gstRate = isGst ? parseFloat(gstRateSelect.value) || 0 : 0;

        const payload = {
            clientName: clientNameInput.value.trim(),
            clientEmail: clientEmailInput ? (clientEmailInput.value.trim() || null) : null,
            clientPhone: clientPhoneInput ? (clientPhoneInput.value.trim() || null) : null,
            billingAddress: billingAddressInput ? (billingAddressInput.value.trim() || null) : null,
            shippingAddress: shippingAddressInput ? (shippingAddressInput.value.trim() || null) : null,
            termsAndConditions: docTermsInput ? (docTermsInput.value.trim() || null) : null,
            remarks: docNotesInput ? (docNotesInput.value.trim() || null) : null,
            invoiceDate: docDateInput.value,
            gstEnabled: isGst,
            gstRate: gstRate,
            items: items
        };

        if (docDueDateInput.value) {
            if (docType === 'QUOTATION') {
                payload.validUntil = docDueDateInput.value;
            } else {
                payload.dueDate = docDueDateInput.value;
            }
        }

        if (editorMode === 'create') {
            payload.documentType = docType;
        } else {
            payload.version = parseInt(docVersionInput.value, 10);
        }

        return payload;
    }

    /**
     * Handle Form Submission (Create or Edit)
     */
    async function handleFormSubmit(e) {
        e.preventDefault();

        if (isSaving) return;
        if (!validateForm()) return;

        isSaving = true;
        btnSave.disabled = true;
        saveSpinner.classList.remove('d-none');
        saveIcon.classList.add('d-none');
        btnSaveText.textContent = editorMode === 'create' ? 'Creating...' : 'Saving...';
        conflictAlert.classList.add('d-none');
        hideErrorAlert();

        const payload = gatherPayload();
        const csrfToken = csrfTokenInput.value;
        const isEdit = editorMode === 'edit';
        const docId = docIdInput.value;

        const url = isEdit ? `/api/invoices/${docId}` : '/api/invoices';
        const method = isEdit ? 'PUT' : 'POST';

        try {
            const response = await fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken
                },
                body: JSON.stringify(payload)
            });

            // 1. Session Expiry (401)
            if (response.status === 401) {
                isDirty = false;
                window.location.href = '/login?expired=1';
                return;
            }

            // 2. Concurrency Conflict (409)
            if (response.status === 409) {
                const data = await response.json().catch(() => ({}));
                conflictMessageEl.textContent = data.error || 'This document was changed by another user. Current version is newer.';
                conflictAlert.classList.remove('d-none');
                conflictAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
                resetSaveButton();
                return;
            }

            // 3. Validation or Business Rule Rejection (400)
            if (response.status === 400) {
                const data = await response.json().catch(() => ({}));
                showErrorAlert(data.error || 'The submission was rejected by the server.', 'Server Validation Error');
                resetSaveButton();
                return;
            }

            // 4. Forbidden (403)
            if (response.status === 403) {
                showErrorAlert('You do not have permission to perform this action, or your CSRF session expired. Please refresh the page.', 'Access Forbidden');
                resetSaveButton();
                return;
            }

            // 5. Not Found (404)
            if (response.status === 404) {
                showErrorAlert('The requested document was not found.', 'Not Found');
                resetSaveButton();
                return;
            }

            // 6. Server Error (500)
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                showErrorAlert(data.error || 'A server error occurred while processing your request. Your entered inputs were preserved.', 'Server Error');
                resetSaveButton();
                return;
            }

            // Success (200 or 201)
            const result = await response.json();
            const savedDoc = result.data;

            isDirty = false;
            formSuccessAlert.classList.remove('d-none');
            formSuccessAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });

            const successMessage = document.getElementById('form-success-message');
            if (successMessage && savedDoc) {
                successMessage.textContent = `${savedDoc.documentType} ${savedDoc.invoiceNumber} saved successfully! Redirecting...`;
            }

            // Redirect back to listing after brief success display
            setTimeout(() => {
                window.location.href = `/documents?highlight=${savedDoc ? savedDoc.invoiceNumber : ''}`;
            }, 850);

        } catch (err) {
            console.error('[DOCUMENT SAVE ERROR]:', err);
            showErrorAlert('A network error occurred while contacting the server. Your inputs remain safe.', 'Network Error');
            resetSaveButton();
        }
    }

    /**
     * Reset save button after async response
     */
    function resetSaveButton() {
        isSaving = false;
        btnSave.disabled = false;
        saveSpinner.classList.add('d-none');
        saveIcon.classList.remove('d-none');
        btnSaveText.textContent = editorMode === 'create'
            ? (docType === 'QUOTATION' ? 'Save Quotation' : 'Save Invoice')
            : 'Save Changes';
    }

    /**
     * Reload latest document data upon 409 conflict
     */
    async function reloadLatestVersion() {
        const docId = docIdInput.value;
        if (!docId) return;

        btnReloadConflict.disabled = true;
        btnReloadConflict.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Reloading...';

        try {
            const res = await fetch(`/api/invoices/${docId}`);
            if (!res.ok) {
                throw new Error('Failed to reload document');
            }
            const body = await res.json();
            const doc = body.data;

            // Populate form with latest data
            initialDoc = doc;
            docVersionInput.value = doc.version;
            clientNameInput.value = doc.clientName || '';
            if (clientEmailInput) clientEmailInput.value = doc.clientEmail || '';
            if (clientPhoneInput) clientPhoneInput.value = doc.clientPhone || '';
            if (billingAddressInput) billingAddressInput.value = doc.billingAddress || '';
            if (shippingAddressInput) shippingAddressInput.value = doc.shippingAddress || '';
            if (docTermsInput) docTermsInput.value = doc.termsAndConditions || '';
            if (docNotesInput) docNotesInput.value = doc.remarks || '';

            if (sameAsBillingToggle && billingAddressInput && shippingAddressInput) {
                const bVal = (billingAddressInput.value || '').trim();
                const sVal = (shippingAddressInput.value || '').trim();
                if ((!bVal && !sVal) || (bVal && sVal && bVal === sVal)) {
                    sameAsBillingToggle.checked = true;
                    shippingAddressInput.readOnly = true;
                    shippingAddressInput.classList.add('bg-light');
                } else {
                    sameAsBillingToggle.checked = false;
                    shippingAddressInput.readOnly = false;
                    shippingAddressInput.classList.remove('bg-light');
                }
            }

            docDateInput.value = formatDateToInputString(doc.invoiceDate);

            // Re-render items
            itemsTbody.innerHTML = '';
            if (doc.items && doc.items.length > 0) {
                doc.items.forEach(item => addItemRow(item));
            } else {
                addItemRow();
            }

            // GST
            gstEnabledToggle.checked = Boolean(doc.gstEnabled);
            if (doc.gstEnabled) {
                gstRateContainer.classList.remove('d-none');
                gstRateSelect.value = String(Number(doc.gstRate));
            } else {
                gstRateContainer.classList.add('d-none');
            }

            recalculateTotals();

            // Hide conflict banner
            conflictAlert.classList.add('d-none');
            isDirty = false;

            showErrorAlert(`Document updated to latest version (${doc.version}). Review and make your changes.`, 'Document Reloaded');
        } catch (err) {
            console.error('Failed to reload latest version:', err);
            alert('Failed to fetch the latest document version. Please refresh the browser window.');
        } finally {
            btnReloadConflict.disabled = false;
            btnReloadConflict.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i> Reload Latest Version';
        }
    }

    /**
     * Handle Cancel / Back Navigation with Unsaved Protection
     */
    function handleCancel() {
        if (isDirty) {
            const confirmed = window.confirm(
                'You have unsaved changes. Are you sure you want to discard them and return to the documents list?'
            );
            if (!confirmed) return;
        }
        isDirty = false;
        window.location.href = '/documents';
    }

    /**
     * Hydrate Form on initial page load
     */
    function hydrateForm() {
        // Read initial context from global window
        initialDoc = window.__INITIAL_DOCUMENT__ || null;
        editorMode = window.__EDITOR_MODE__ || 'create';
        docType = window.__DOCUMENT_TYPE__ || 'INVOICE';

        if (editorMode === 'edit' && initialDoc) {
            // Edit Mode Hydration
            docDateInput.value = formatDateToInputString(initialDoc.invoiceDate);

            // Calculate display due date
            if (initialDoc.documentType === 'QUOTATION' && initialDoc.invoiceDate) {
                const expDate = new Date(initialDoc.invoiceDate);
                expDate.setDate(expDate.getDate() + 15);
                docDueDateInput.value = formatDateToInputString(expDate);
            } else if (initialDoc.documentType === 'INVOICE' && initialDoc.invoiceDate) {
                const dueDate = new Date(initialDoc.invoiceDate);
                dueDate.setDate(dueDate.getDate() + 30);
                docDueDateInput.value = formatDateToInputString(dueDate);
            }

            // Snapshot fields hydration
            if (clientEmailInput) clientEmailInput.value = initialDoc.clientEmail || '';
            if (clientPhoneInput) clientPhoneInput.value = initialDoc.clientPhone || '';
            if (billingAddressInput) billingAddressInput.value = initialDoc.billingAddress || '';
            if (shippingAddressInput) shippingAddressInput.value = initialDoc.shippingAddress || '';
            if (docTermsInput) docTermsInput.value = initialDoc.termsAndConditions || '';
            if (docNotesInput) docNotesInput.value = initialDoc.remarks || '';

            // Hydrate items
            itemsTbody.innerHTML = '';
            if (initialDoc.items && initialDoc.items.length > 0) {
                initialDoc.items.forEach(item => {
                    const row = createItemRow({
                        name: item.name,
                        quantity: Number(item.quantity),
                        unit: item.unit,
                        rate: Number(item.rate)
                    });
                    itemsTbody.appendChild(row);
                });
            } else {
                addItemRow();
            }

            updateItemRowNumbers();
            recalculateTotals();

        } else {
            // Create Mode Defaults
            const today = new Date();
            docDateInput.value = formatDateToInputString(today);

            const futureDate = new Date(today);
            if (docType === 'QUOTATION') {
                futureDate.setDate(futureDate.getDate() + 15);
            } else {
                futureDate.setDate(futureDate.getDate() + 30);
            }
            docDueDateInput.value = formatDateToInputString(futureDate);

            // Start with 1 empty item
            itemsTbody.innerHTML = '';
            addItemRow();
        }

        // Address synchronization: "Same as billing"
        if (sameAsBillingToggle && billingAddressInput && shippingAddressInput) {
            const bVal = (billingAddressInput.value || '').trim();
            const sVal = (shippingAddressInput.value || '').trim();
            if ((!bVal && !sVal) || (bVal && sVal && bVal === sVal)) {
                sameAsBillingToggle.checked = true;
                shippingAddressInput.readOnly = true;
                shippingAddressInput.classList.add('bg-light');
            } else {
                sameAsBillingToggle.checked = false;
                shippingAddressInput.readOnly = false;
                shippingAddressInput.classList.remove('bg-light');
            }

            sameAsBillingToggle.addEventListener('change', () => {
                markDirty();
                if (sameAsBillingToggle.checked) {
                    shippingAddressInput.value = billingAddressInput.value;
                    shippingAddressInput.readOnly = true;
                    shippingAddressInput.classList.add('bg-light');
                } else {
                    shippingAddressInput.readOnly = false;
                    shippingAddressInput.classList.remove('bg-light');
                }
            });

            billingAddressInput.addEventListener('input', () => {
                markDirty();
                if (sameAsBillingToggle.checked) {
                    shippingAddressInput.value = billingAddressInput.value;
                }
            });

            shippingAddressInput.addEventListener('input', () => {
                markDirty();
            });
        }
    }

    /**
     * Attach all form event listeners
     */
    function attachEventListeners() {
        // Track dirty changes on standard inputs
        formEl.addEventListener('input', () => markDirty());
        formEl.addEventListener('change', () => markDirty());

        // Document Date change also updates default due date if untouched
        docDateInput.addEventListener('change', () => {
            docDateInput.classList.remove('is-invalid-custom');
            if (docDateInput.value && !docDueDateInput.dataset.manual) {
                const newBase = new Date(docDateInput.value);
                if (!isNaN(newBase.getTime())) {
                    newBase.setDate(newBase.getDate() + (docType === 'QUOTATION' ? 15 : 30));
                    docDueDateInput.value = formatDateToInputString(newBase);
                }
            }
        });

        docDueDateInput.addEventListener('change', () => {
            docDueDateInput.dataset.manual = 'true';
            docDueDateInput.classList.remove('is-invalid-custom');
        });

        // Add Item Buttons
        btnAddItem.addEventListener('click', () => addItemRow());
        if (btnAddItemHeader) {
            btnAddItemHeader.addEventListener('click', () => addItemRow());
        }

        // GST Switch
        gstEnabledToggle.addEventListener('change', () => {
            markDirty();
            if (gstEnabledToggle.checked) {
                gstRateContainer.classList.remove('d-none');
            } else {
                gstRateContainer.classList.add('d-none');
            }
            recalculateTotals();
        });

        // GST Rate Select
        gstRateSelect.addEventListener('change', () => {
            markDirty();
            recalculateTotals();
        });

        // Form Submit
        formEl.addEventListener('submit', handleFormSubmit);

        // Cancel / Back
        btnCancel.addEventListener('click', handleCancel);
        if (btnBackHeader) {
            btnBackHeader.addEventListener('click', (e) => {
                e.preventDefault();
                handleCancel();
            });
        }

        // Close Error Button
        const btnCloseError = document.getElementById('btn-close-error');
        if (btnCloseError) {
            btnCloseError.addEventListener('click', hideErrorAlert);
        }

        // Reload Conflict Button
        btnReloadConflict.addEventListener('click', reloadLatestVersion);

        // Unsaved Changes Browser Guard
        window.addEventListener('beforeunload', (e) => {
            if (isDirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    /**
     * DOM Ready Entry Point
     */
    document.addEventListener('DOMContentLoaded', () => {
        formEl = document.getElementById('document-form');
        if (!formEl) return;

        csrfTokenInput = document.getElementById('csrf-token');
        docIdInput = document.getElementById('doc-id');
        docVersionInput = document.getElementById('doc-version');
        docDateInput = document.getElementById('doc-date');
        docDueDateInput = document.getElementById('doc-due-date');
        clientNameInput = document.getElementById('client-name');
        clientEmailInput = document.getElementById('client-email');
        clientPhoneInput = document.getElementById('client-phone');
        billingAddressInput = document.getElementById('billing-address');
        shippingAddressInput = document.getElementById('shipping-address');
        sameAsBillingToggle = document.getElementById('same-as-billing');
        docTermsInput = document.getElementById('doc-terms');
        docNotesInput = document.getElementById('doc-notes');
        itemsTbody = document.getElementById('items-tbody');
        btnAddItem = document.getElementById('btn-add-item');
        btnAddItemHeader = document.getElementById('btn-add-item-header');
        itemsCountIndicator = document.getElementById('items-count-indicator');
        gstEnabledToggle = document.getElementById('gst-enabled-toggle');
        gstRateContainer = document.getElementById('gst-rate-container');
        gstRateSelect = document.getElementById('gst-rate-select');
        summarySubtotalEl = document.getElementById('summary-subtotal');
        summaryGstBreakdownEl = document.getElementById('summary-gst-breakdown');
        summaryCgstLabelEl = document.getElementById('summary-cgst-label');
        summaryCgstAmountEl = document.getElementById('summary-cgst-amount');
        summarySgstLabelEl = document.getElementById('summary-sgst-label');
        summarySgstAmountEl = document.getElementById('summary-sgst-amount');
        summaryGstTotalEl = document.getElementById('summary-gst-total');
        summaryRoundoffEl = document.getElementById('summary-roundoff');
        summaryGrandtotalEl = document.getElementById('summary-grandtotal');
        btnSave = document.getElementById('btn-save');
        btnSaveText = document.getElementById('save-btn-text');
        saveSpinner = document.getElementById('save-spinner');
        saveIcon = document.getElementById('save-icon');
        btnCancel = document.getElementById('btn-cancel');
        btnBackHeader = document.getElementById('btn-back-header');
        conflictAlert = document.getElementById('conflict-alert');
        conflictMessageEl = document.getElementById('conflict-message');
        btnReloadConflict = document.getElementById('btn-reload-conflict');
        formErrorAlert = document.getElementById('form-error-alert');
        formErrorMessageEl = document.getElementById('form-error-message');
        formSuccessAlert = document.getElementById('form-success-alert');
        unsavedWarningBanner = document.getElementById('unsaved-warning-banner');

        hydrateForm();
        attachEventListeners();
    });

})();
