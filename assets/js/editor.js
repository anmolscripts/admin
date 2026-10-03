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
    let clientSelect;
    let btnClearClient;
    let clientIdInput;
    let clientNameInput;
    let clientEmailInput;
    let clientPhoneInput;
    let clientGstinInput;
    let placeOfSupplyInput;
    let billingAddressInput;
    let shippingAddressInput;
    let sameAsBillingToggle;
    let docTermsInput;
    let docNotesInput;
    let itemsTbody;
    let btnAddItem;
    let btnAddItemHeader;
    let itemsCountIndicator;

    let availableUnits = (window.__AVAILABLE_UNITS__ && Array.isArray(window.__AVAILABLE_UNITS__))
        ? window.__AVAILABLE_UNITS__
        : [];

    let autocompletePortalEl = null;
    let activeRowContext = null;
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
     * Load active units from server if not already embedded
     */
    async function loadActiveUnitsIfMissing() {
        if (!availableUnits || availableUnits.length === 0) {
            try {
                const res = await fetch('/api/units/active');
                if (res.ok) {
                    const json = await res.json();
                    if (json.success && Array.isArray(json.data) && json.data.length > 0) {
                        availableUnits = json.data;
                        const selects = itemsTbody ? itemsTbody.querySelectorAll('.item-unit') : [];
                        selects.forEach(sel => {
                            const curVal = sel.value;
                            sel.innerHTML = renderUnitOptions(curVal);
                        });
                    }
                }
            } catch (_) {}
        }
    }

    /**
     * Render options for unit select from Unit Master
     */
    function renderUnitOptions(selectedUnit) {
        const list = (availableUnits && availableUnits.length > 0)
            ? availableUnits
            : [
                { symbol: 'PCS' }, { symbol: 'm' }, { symbol: 'unit' },
                { symbol: 'Project' }, { symbol: 'Hours' }, { symbol: 'Months' },
                { symbol: 'Units' }, { symbol: 'License' }, { symbol: 'Year' },
                { symbol: 'Package' }, { symbol: 'Set' }, { symbol: 'KG' },
                { symbol: 'Service' }
            ];

        let html = '';
        let matched = false;
        list.forEach(u => {
            const sym = u.symbol || u;
            const isSel = selectedUnit && selectedUnit.toLowerCase() === String(sym).toLowerCase();
            if (isSel) matched = true;
            html += `<option value="${escapeHtml(sym)}" ${isSel ? 'selected' : ''}>${escapeHtml(sym)}</option>`;
        });

        if (!matched && selectedUnit) {
            html = `<option value="${escapeHtml(selectedUnit)}" selected>${escapeHtml(selectedUnit)}</option>` + html;
        }
        return html;
    }

    /**
     * Top-level Autocomplete Portal Management
     */
    function getOrCreateAutocompletePortal() {
        if (!autocompletePortalEl) {
            autocompletePortalEl = document.getElementById('item-autocomplete-portal');
            if (!autocompletePortalEl) {
                autocompletePortalEl = document.createElement('div');
                autocompletePortalEl.id = 'item-autocomplete-portal';
                autocompletePortalEl.className = 'item-autocomplete-portal d-none';
                autocompletePortalEl.setAttribute('role', 'listbox');
                autocompletePortalEl.setAttribute('aria-label', 'Item suggestions');
                document.body.appendChild(autocompletePortalEl);
            }
        }
        return autocompletePortalEl;
    }

    function positionPortal(inputEl) {
        if (!inputEl || !autocompletePortalEl || autocompletePortalEl.classList.contains('d-none')) return;
        const rect = inputEl.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            hideAutocompletePortal();
            return;
        }
        const vpHeight = window.innerHeight;
        const vpWidth = window.innerWidth;
        const portalWidth = Math.max(rect.width, 380);
        let left = rect.left;
        if (left + portalWidth > vpWidth - 12) {
            left = Math.max(12, vpWidth - portalWidth - 12);
        }

        const spaceBelow = vpHeight - rect.bottom;
        const spaceAbove = rect.top;
        const estimatedHeight = Math.min(autocompletePortalEl.scrollHeight || 240, 280);

        let top;
        if (spaceBelow >= estimatedHeight + 8 || spaceBelow >= spaceAbove) {
            top = rect.bottom + 4;
            autocompletePortalEl.style.maxHeight = `${Math.min(280, Math.max(100, spaceBelow - 16))}px`;
        } else {
            top = Math.max(8, rect.top - estimatedHeight - 4);
            autocompletePortalEl.style.maxHeight = `${Math.min(280, Math.max(100, spaceAbove - 16))}px`;
        }

        autocompletePortalEl.style.position = 'fixed';
        autocompletePortalEl.style.top = `${top}px`;
        autocompletePortalEl.style.left = `${left}px`;
        autocompletePortalEl.style.width = `${portalWidth}px`;
    }

    function hideAutocompletePortal() {
        if (autocompletePortalEl) {
            autocompletePortalEl.classList.add('d-none');
            autocompletePortalEl.innerHTML = '';
        }
        if (activeRowContext && activeRowContext.nameInput) {
            activeRowContext.nameInput.setAttribute('aria-expanded', 'false');
            activeRowContext.nameInput.removeAttribute('aria-activedescendant');
        }
        if (activeRowContext) {
            activeRowContext.suggestions = [];
            activeRowContext.highlightedIdx = -1;
        }
    }

    function renderSuggestions(items, ctx) {
        const portal = getOrCreateAutocompletePortal();
        portal.innerHTML = '';
        ctx.suggestions = items || [];
        ctx.highlightedIdx = -1;

        if (!items || items.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'item-autocomplete-empty';
            emptyDiv.innerHTML = '<i class="bi bi-info-circle me-1"></i> No matching items found in Item Master';
            portal.appendChild(emptyDiv);
            portal.classList.remove('d-none');
            ctx.nameInput.setAttribute('aria-expanded', 'true');
            positionPortal(ctx.nameInput);
            return;
        }

        items.forEach((item, idx) => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'item-autocomplete-item';
            itemDiv.setAttribute('role', 'option');
            itemDiv.setAttribute('id', `item-opt-${idx}`);
            itemDiv.setAttribute('aria-selected', 'false');

            const nameSpan = document.createElement('span');
            nameSpan.className = 'item-autocomplete-item-name';
            nameSpan.textContent = item.name;

            const metaSpan = document.createElement('span');
            metaSpan.className = 'item-autocomplete-item-meta';

            const badgeSpan = document.createElement('span');
            badgeSpan.className = 'item-autocomplete-price-badge font-monospace';
            const rateFormatted = Number(item.rate).toFixed(2);
            badgeSpan.textContent = `₹ ${rateFormatted} / ${item.unit || 'PCS'}`;
            metaSpan.appendChild(badgeSpan);

            itemDiv.appendChild(nameSpan);
            itemDiv.appendChild(metaSpan);

            itemDiv.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                ctx.selectItem(item);
            });

            itemDiv.addEventListener('mouseenter', () => {
                setHighlightedIndex(idx, ctx);
            });

            portal.appendChild(itemDiv);
        });

        portal.classList.remove('d-none');
        ctx.nameInput.setAttribute('aria-expanded', 'true');
        positionPortal(ctx.nameInput);
    }

    function setHighlightedIndex(newIdx, ctx) {
        if (!autocompletePortalEl) return;
        const items = autocompletePortalEl.querySelectorAll('.item-autocomplete-item');
        items.forEach((el) => {
            el.classList.remove('active');
            el.setAttribute('aria-selected', 'false');
        });

        if (newIdx >= 0 && newIdx < items.length) {
            ctx.highlightedIdx = newIdx;
            items[newIdx].classList.add('active');
            items[newIdx].setAttribute('aria-selected', 'true');
            items[newIdx].scrollIntoView({ block: 'nearest' });
            ctx.nameInput.setAttribute('aria-activedescendant', `item-opt-${newIdx}`);
        } else {
            ctx.highlightedIdx = -1;
            ctx.nameInput.removeAttribute('aria-activedescendant');
        }
    }

    // Window-level portal scroll & resize listeners
    window.addEventListener('scroll', () => {
        if (activeRowContext && activeRowContext.nameInput) {
            positionPortal(activeRowContext.nameInput);
        }
    }, true);

    window.addEventListener('resize', () => {
        if (activeRowContext && activeRowContext.nameInput) {
            positionPortal(activeRowContext.nameInput);
        }
    });

    document.addEventListener('click', (e) => {
        if (autocompletePortalEl && !autocompletePortalEl.contains(e.target)) {
            if (!activeRowContext || e.target !== activeRowContext.nameInput) {
                hideAutocompletePortal();
            }
        }
    });

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
        const hsnSac = data.hsnSac || '';
        const amount = Math.round(quantity * rate * 100) / 100;

        tr.innerHTML = `
            <td class="text-center">
                <span class="item-index-badge">1</span>
            </td>
            <td>
                <div class="item-autocomplete-container position-relative">
                    <input
                        type="text"
                        class="form-control-custom item-name"
                        placeholder="Item description or service..."
                        value="${escapeHtml(name)}"
                        required
                        autocomplete="off"
                        aria-autocomplete="list"
                        aria-expanded="false"
                        aria-label="Item description"
                    />
                </div>
            </td>
            <td>
                <select class="form-select-custom item-unit" aria-label="Item unit">
                    ${renderUnitOptions(unit)}
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
                <input
                    type="text"
                    class="form-control-custom item-hsn font-monospace"
                    value="${escapeHtml(hsnSac)}"
                    maxlength="20"
                    placeholder="HSN/SAC"
                    aria-label="HSN or SAC code"
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

        // Row Element References
        const nameInput = tr.querySelector('.item-name');
        const unitSelect = tr.querySelector('.item-unit');
        const rateInput = tr.querySelector('.item-rate');
        const qtyInput = tr.querySelector('.item-qty');
        const hsnInput = tr.querySelector('.item-hsn');
        const removeBtn = tr.querySelector('.btn-remove-item');

        // Visual focus highlighting
        [nameInput, unitSelect, rateInput, qtyInput, hsnInput].forEach(el => {
            el.addEventListener('focus', () => tr.classList.add('row-active-focus'));
            el.addEventListener('blur', () => tr.classList.remove('row-active-focus'));
        });

        // Row Context for Autocomplete & Navigation
        const rowContext = {
            tr,
            nameInput,
            unitSelect,
            rateInput,
            qtyInput,
            hsnInput,
            suggestions: [],
            highlightedIdx: -1,
            searchTimer: null,
            searchSeq: 0,
            selectItem: function(item) {
                nameInput.value = item.name;
                if (item.unit) {
                    let found = false;
                    for (let i = 0; i < unitSelect.options.length; i++) {
                        if (unitSelect.options[i].value.toLowerCase() === item.unit.toLowerCase()) {
                            unitSelect.selectedIndex = i;
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        const opt = document.createElement('option');
                        opt.value = item.unit;
                        opt.textContent = item.unit;
                        opt.selected = true;
                        unitSelect.appendChild(opt);
                    }
                }
                if (item.rate !== undefined && !isNaN(Number(item.rate))) {
                    rateInput.value = Number(item.rate).toFixed(2);
                }
                if (item.hsnSac && hsnInput) {
                    hsnInput.value = item.hsnSac;
                }

                hideAutocompletePortal();
                updateRowAmount(tr);
                markDirty();
                recalculateTotals();

                // Fast data entry sequence: Enter on item autocomplete moves focus to Unit!
                unitSelect.focus();
            }
        };

        // Search Autocomplete on Input
        nameInput.addEventListener('input', () => {
            nameInput.classList.remove('is-invalid-custom');
            markDirty();

            clearTimeout(rowContext.searchTimer);
            const query = nameInput.value.trim();
            if (query.length === 0) {
                hideAutocompletePortal();
                return;
            }

            activeRowContext = rowContext;
            rowContext.searchTimer = setTimeout(async () => {
                const curId = ++rowContext.searchSeq;
                try {
                    const res = await fetch(`/api/items/search?q=${encodeURIComponent(query)}`);
                    if (curId !== rowContext.searchSeq) return; // Stale response protection
                    if (res.ok) {
                        const json = await res.json();
                        if (curId === rowContext.searchSeq && json.success) {
                            renderSuggestions(json.data, rowContext);
                        }
                    }
                } catch (_) {
                    // Ignore network abort
                }
            }, 180);
        });

        nameInput.addEventListener('focus', () => {
            activeRowContext = rowContext;
            const query = nameInput.value.trim();
            if (query.length > 0 && (!autocompletePortalEl || autocompletePortalEl.classList.contains('d-none'))) {
                nameInput.dispatchEvent(new Event('input'));
            }
        });

        nameInput.addEventListener('blur', () => {
            setTimeout(() => {
                if (activeRowContext === rowContext) {
                    hideAutocompletePortal();
                }
            }, 220);
        });

        // Keyboard sequence and autocomplete navigation on item-name
        nameInput.addEventListener('keydown', (e) => {
            const isPortalOpen = autocompletePortalEl && !autocompletePortalEl.classList.contains('d-none');

            if (e.key === 'ArrowDown') {
                if (isPortalOpen && rowContext.suggestions.length > 0) {
                    e.preventDefault();
                    const next = (rowContext.highlightedIdx + 1) % rowContext.suggestions.length;
                    setHighlightedIndex(next, rowContext);
                }
            } else if (e.key === 'ArrowUp') {
                if (isPortalOpen && rowContext.suggestions.length > 0) {
                    e.preventDefault();
                    const prev = (rowContext.highlightedIdx - 1 + rowContext.suggestions.length) % rowContext.suggestions.length;
                    setHighlightedIndex(prev, rowContext);
                }
            } else if (e.key === 'Escape') {
                if (isPortalOpen) {
                    e.preventDefault();
                    e.stopPropagation();
                    hideAutocompletePortal();
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (isPortalOpen && rowContext.highlightedIdx >= 0 && rowContext.suggestions[rowContext.highlightedIdx]) {
                    rowContext.selectItem(rowContext.suggestions[rowContext.highlightedIdx]);
                } else {
                    hideAutocompletePortal();
                    unitSelect.focus();
                }
            }
        });

        // Sequence: Unit → Rate
        unitSelect.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                rateInput.focus();
                rateInput.select();
            }
        });

        // Sequence: Rate → Quantity
        rateInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                qtyInput.focus();
                qtyInput.select();
            }
        });

        // Helper to focus next row or add row if at end
        function advanceToNextRow() {
            const nextRow = tr.nextElementSibling;
            if (nextRow && nextRow.classList.contains('line-item-row')) {
                const nextName = nextRow.querySelector('.item-name');
                if (nextName) {
                    nextName.focus();
                    nextName.select();
                }
            } else {
                const newRow = addItemRow();
                if (newRow) {
                    const newName = newRow.querySelector('.item-name');
                    if (newName) newName.focus();
                }
            }
        }

        // Sequence: Quantity → next row Item Name (creates row if last)
        qtyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                advanceToNextRow();
            }
        });

        // Optional HSN field navigation
        hsnInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                advanceToNextRow();
            }
        });

        // Value change handlers
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

        hsnInput.addEventListener('input', () => {
            markDirty();
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

        return row;
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
        formErrorMessageEl.textContent = message;
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
            const hsnEl = row.querySelector('.item-hsn');
            items.push({
                name: row.querySelector('.item-name').value.trim(),
                quantity: parseFloat(row.querySelector('.item-qty').value) || 0,
                unit: row.querySelector('.item-unit').value || 'PCS',
                rate: parseFloat(row.querySelector('.item-rate').value) || 0,
                hsnSac: hsnEl ? (hsnEl.value.trim() || null) : null
            });
        });

        const isGst = gstEnabledToggle.checked;
        const gstRate = isGst ? parseFloat(gstRateSelect.value) || 0 : 0;

        const payload = {
            clientId: clientIdInput && clientIdInput.value ? parseInt(clientIdInput.value, 10) : null,
            clientName: clientNameInput.value.trim(),
            clientEmail: clientEmailInput ? (clientEmailInput.value.trim() || null) : null,
            clientPhone: clientPhoneInput ? (clientPhoneInput.value.trim() || null) : null,
            clientGSTIN: clientGstinInput ? (clientGstinInput.value.trim() || null) : null,
            placeOfSupplyStateCode: placeOfSupplyInput ? (placeOfSupplyInput.value.trim() || null) : null,
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
            if (initialDoc && initialDoc.id) {
                payload.copyFromId = initialDoc.id;
            }
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

            // Hydrate Due / Expiry Date
            if (initialDoc.documentType === 'QUOTATION') {
                if (initialDoc.validUntil) {
                    docDueDateInput.value = formatDateToInputString(initialDoc.validUntil);
                } else if (initialDoc.invoiceDate) {
                    const expDate = new Date(initialDoc.invoiceDate);
                    expDate.setDate(expDate.getDate() + 15);
                    docDueDateInput.value = formatDateToInputString(expDate);
                }
            } else if (initialDoc.documentType === 'INVOICE') {
                if (initialDoc.dueDate) {
                    docDueDateInput.value = formatDateToInputString(initialDoc.dueDate);
                } else if (initialDoc.invoiceDate) {
                    const dueDate = new Date(initialDoc.invoiceDate);
                    dueDate.setDate(dueDate.getDate() + 30);
                    docDueDateInput.value = formatDateToInputString(dueDate);
                }
            }

            // Snapshot fields hydration
            if (clientSelect && initialDoc.clientId) {
                clientSelect.value = String(initialDoc.clientId);
                if (btnClearClient) btnClearClient.classList.remove('d-none');
            }
            if (clientIdInput && initialDoc.clientId) clientIdInput.value = initialDoc.clientId;
            if (clientNameInput && initialDoc.clientName) clientNameInput.value = initialDoc.clientName;
            if (clientEmailInput) clientEmailInput.value = initialDoc.clientEmail || '';
            if (clientPhoneInput) clientPhoneInput.value = initialDoc.clientPhone || '';
            if (clientGstinInput) clientGstinInput.value = initialDoc.clientGSTIN || '';
            if (placeOfSupplyInput) placeOfSupplyInput.value = initialDoc.placeOfSupplyStateCode || '';
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

        } else if (editorMode === 'create' && initialDoc) {
            // Create Mode with Prefilled / Copied Data
            const today = new Date();
            docDateInput.value = formatDateToInputString(today);

            if (docType === 'QUOTATION') {
                if (initialDoc.validUntil && new Date(initialDoc.validUntil) >= today) {
                    docDueDateInput.value = formatDateToInputString(initialDoc.validUntil);
                } else {
                    const futureDate = new Date(today);
                    futureDate.setDate(futureDate.getDate() + 15);
                    docDueDateInput.value = formatDateToInputString(futureDate);
                }
            } else {
                if (initialDoc.dueDate && new Date(initialDoc.dueDate) >= today) {
                    docDueDateInput.value = formatDateToInputString(initialDoc.dueDate);
                } else {
                    const futureDate = new Date(today);
                    futureDate.setDate(futureDate.getDate() + 30);
                    docDueDateInput.value = formatDateToInputString(futureDate);
                }
            }

            if (clientSelect && initialDoc.clientId) {
                clientSelect.value = String(initialDoc.clientId);
                if (btnClearClient) btnClearClient.classList.remove('d-none');
            }
            if (clientIdInput && initialDoc.clientId) clientIdInput.value = initialDoc.clientId;
            if (clientNameInput && initialDoc.clientName) clientNameInput.value = initialDoc.clientName;
            if (clientEmailInput && initialDoc.clientEmail) clientEmailInput.value = initialDoc.clientEmail;
            if (clientPhoneInput && initialDoc.clientPhone) clientPhoneInput.value = initialDoc.clientPhone;
            if (clientGstinInput && initialDoc.clientGSTIN) clientGstinInput.value = initialDoc.clientGSTIN;
            if (placeOfSupplyInput && initialDoc.placeOfSupplyStateCode) placeOfSupplyInput.value = initialDoc.placeOfSupplyStateCode;
            if (billingAddressInput && initialDoc.billingAddress) billingAddressInput.value = initialDoc.billingAddress;
            if (shippingAddressInput && initialDoc.shippingAddress) shippingAddressInput.value = initialDoc.shippingAddress;
            if (docTermsInput && initialDoc.termsAndConditions) docTermsInput.value = initialDoc.termsAndConditions;
            if (docNotesInput && initialDoc.remarks) docNotesInput.value = initialDoc.remarks;

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

            // GST
            gstEnabledToggle.checked = Boolean(initialDoc.gstEnabled);
            if (initialDoc.gstEnabled) {
                gstRateContainer.classList.remove('d-none');
                gstRateSelect.value = String(Number(initialDoc.gstRate));
            } else {
                gstRateContainer.classList.add('d-none');
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

        // Saved Client Selection Auto-fill
        if (clientSelect) {
            clientSelect.addEventListener('change', () => {
                const opt = clientSelect.options[clientSelect.selectedIndex];
                if (opt && opt.value) {
                    if (clientIdInput) clientIdInput.value = opt.value;
                    if (clientNameInput) clientNameInput.value = opt.dataset.name || '';
                    if (clientEmailInput) clientEmailInput.value = opt.dataset.email || '';
                    if (clientPhoneInput) clientPhoneInput.value = opt.dataset.phone || '';
                    if (clientGstinInput) clientGstinInput.value = opt.dataset.gstin || '';
                    if (placeOfSupplyInput) placeOfSupplyInput.value = opt.dataset.state || '';
                    if (billingAddressInput) billingAddressInput.value = opt.dataset.billing || '';
                    if (shippingAddressInput) shippingAddressInput.value = opt.dataset.shipping || '';

                    if (sameAsBillingToggle && billingAddressInput && shippingAddressInput) {
                        const b = opt.dataset.billing || '';
                        const s = opt.dataset.shipping || '';
                        if ((!s && b) || (b && s && b === s)) {
                            sameAsBillingToggle.checked = true;
                            shippingAddressInput.readOnly = true;
                            shippingAddressInput.classList.add('bg-light');
                        } else {
                            sameAsBillingToggle.checked = false;
                            shippingAddressInput.readOnly = false;
                            shippingAddressInput.classList.remove('bg-light');
                        }
                    }

                    if (btnClearClient) btnClearClient.classList.remove('d-none');
                    markDirty();
                } else {
                    if (clientIdInput) clientIdInput.value = '';
                    if (btnClearClient) btnClearClient.classList.add('d-none');
                }
            });
        }

        if (btnClearClient) {
            btnClearClient.addEventListener('click', () => {
                if (clientSelect) clientSelect.value = '';
                if (clientIdInput) clientIdInput.value = '';
                btnClearClient.classList.add('d-none');
                markDirty();
            });
        }

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

        // Prevent accidental form submission on Enter in text inputs
        formEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const target = e.target;
                if (target && target.tagName === 'INPUT' && target.type !== 'submit') {
                    if (!target.closest('#items-tbody')) {
                        e.preventDefault();
                    }
                }
            }
        });

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
        clientSelect = document.getElementById('client-select');
        btnClearClient = document.getElementById('btn-clear-client');
        clientIdInput = document.getElementById('client-id');
        clientNameInput = document.getElementById('client-name');
        clientEmailInput = document.getElementById('client-email');
        clientPhoneInput = document.getElementById('client-phone');
        clientGstinInput = document.getElementById('client-gstin');
        placeOfSupplyInput = document.getElementById('place-of-supply');
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
        loadActiveUnitsIfMissing();
    });

})();
