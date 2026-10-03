/**
 * Spark Admin - Quotations & Invoices Listing Module
 * Full-featured client controller handling search, filters, pagination,
 * responsive rendering, Indian currency formatting, and URL synchronization.
 */

(function () {
    'use strict';

    // State
    const state = {
        type: '',
        status: '',
        paymentStatus: '',
        search: '',
        dateFrom: '',
        dateTo: '',
        page: 1,
        limit: 10,
        totalPages: 1,
        total: 0,
        isLoading: false,
        activeAbortController: null
    };

    // DOM Elements
    let searchInput;
    let typeSelect;
    let statusSelect;
    let paymentStatusSelect;
    let dateFromInput;
    let dateToInput;
    let clearFiltersBtn;
    let tableTbody;
    let tableCard;
    let emptyStateContainer;
    let errorStateContainer;
    let errorMessageEl;
    let retryBtn;
    let paginationBar;
    let paginationInfo;
    let pageSizeSelect;
    let prevPageBtn;
    let nextPageBtn;
    let pageIndicator;
    let searchDebounceTimer = null;

    /**
     * Parse query parameters from window.location.search into state
     */
    function parseUrlState() {
        const params = new URLSearchParams(window.location.search);
        
        state.type = params.get('type') || params.get('documentType') || '';
        state.status = params.get('status') || '';
        state.paymentStatus = params.get('paymentStatus') || '';
        state.search = params.get('search') || '';
        state.dateFrom = params.get('dateFrom') || '';
        state.dateTo = params.get('dateTo') || '';
        state.page = Math.max(1, parseInt(params.get('page'), 10) || 1);
        state.limit = Math.min(100, Math.max(1, parseInt(params.get('limit'), 10) || 10));
    }

    /**
     * Synchronize current state to window URL without page reload
     */
    function syncStateToUrl() {
        const params = new URLSearchParams();
        
        if (state.type) params.set('type', state.type);
        if (state.status) params.set('status', state.status);
        if (state.paymentStatus) params.set('paymentStatus', state.paymentStatus);
        if (state.search) params.set('search', state.search);
        if (state.dateFrom) params.set('dateFrom', state.dateFrom);
        if (state.dateTo) params.set('dateTo', state.dateTo);
        if (state.page > 1) params.set('page', String(state.page));
        if (state.limit !== 10) params.set('limit', String(state.limit));

        const newQuery = params.toString();
        const newUrl = newQuery ? `${window.location.pathname}?${newQuery}` : window.location.pathname;
        
        if (window.location.search !== (newQuery ? `?${newQuery}` : '')) {
            const serializableState = {
                type: state.type,
                status: state.status,
                paymentStatus: state.paymentStatus,
                search: state.search,
                dateFrom: state.dateFrom,
                dateTo: state.dateTo,
                page: state.page,
                limit: state.limit
            };
            window.history.pushState(serializableState, '', newUrl);
        }
    }

    /**
     * Apply state values to toolbar form controls
     */
    function applyStateToControls() {
        if (searchInput) searchInput.value = state.search;
        if (typeSelect) typeSelect.value = state.type;
        if (statusSelect) statusSelect.value = state.status;
        if (paymentStatusSelect) paymentStatusSelect.value = state.paymentStatus;
        if (dateFromInput) dateFromInput.value = state.dateFrom;
        if (dateToInput) dateToInput.value = state.dateTo;
        if (pageSizeSelect) pageSizeSelect.value = String(state.limit);
    }

    /**
     * Format numbers into Indian currency format (e.g., ₹1,25,000.00)
     */
    function formatIndianCurrency(amount) {
        const num = Number(amount);
        if (isNaN(num)) return '₹0.00';
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(num);
    }

    /**
     * Format ISO or YYYY-MM-DD date into DD/MM/YYYY
     */
    function formatDate(dateInput) {
        if (!dateInput) return '—';
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return '—';
        
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    }

    /**
     * Calculate display due date or validity notice
     */
    function formatDueDate(doc) {
        if (doc.documentType === 'QUOTATION') {
            if (doc.validUntil) return formatDate(doc.validUntil);
            if (doc.invoiceDate) {
                const d = new Date(doc.invoiceDate);
                if (!isNaN(d.getTime())) {
                    d.setDate(d.getDate() + 15);
                    return formatDate(d);
                }
            }
        } else {
            if (doc.dueDate) return formatDate(doc.dueDate);
            if (doc.invoiceDate) {
                const d = new Date(doc.invoiceDate);
                if (!isNaN(d.getTime())) {
                    d.setDate(d.getDate() + 30);
                    return formatDate(d);
                }
            }
        }
        return '—';
    }

    /**
     * Render accessible status badge
     */
    function renderStatusBadge(status) {
        const badge = document.createElement('span');
        badge.className = 'badge-doc-status';

        const icon = document.createElement('i');
        const text = document.createElement('span');
        text.textContent = status || 'UNKNOWN';

        switch (status) {
            case 'ACTIVE':
                badge.classList.add('badge-status-active');
                icon.className = 'bi bi-check-circle-fill';
                break;
            case 'INACTIVE':
                badge.classList.add('badge-status-inactive');
                icon.className = 'bi bi-pause-circle-fill';
                break;
            case 'VOID':
                badge.classList.add('badge-status-void');
                icon.className = 'bi bi-slash-circle-fill';
                break;
            case 'DELETED':
                badge.classList.add('badge-status-deleted');
                icon.className = 'bi bi-trash3-fill';
                break;
            default:
                badge.classList.add('badge-status-inactive');
                icon.className = 'bi bi-question-circle-fill';
                break;
        }

        badge.appendChild(icon);
        badge.appendChild(text);
        return badge;
    }

    /**
     * Render document type badge
     */
    function renderTypeBadge(type) {
        const badge = document.createElement('span');
        badge.className = 'badge-doc-type';

        const icon = document.createElement('i');
        const text = document.createElement('span');
        text.textContent = type || 'DOCUMENT';

        if (type === 'QUOTATION') {
            badge.classList.add('badge-type-quotation');
            icon.className = 'bi bi-file-earmark-text';
        } else {
            badge.classList.add('badge-type-invoice');
            icon.className = 'bi bi-receipt';
        }

        badge.appendChild(icon);
        badge.appendChild(text);
        return badge;
    }

    /**
     * Create action menu item
     */
    function createActionItem(label, iconClass, actionKey, docId, isDanger = false) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = `dropdown-item ${isDanger ? 'text-danger' : ''}`;
        a.href = '#';
        a.setAttribute('data-action', actionKey);
        a.setAttribute('data-id', docId);

        const icon = document.createElement('i');
        icon.className = `bi ${iconClass}`;
        a.appendChild(icon);

        const textSpan = document.createElement('span');
        textSpan.textContent = label;
        a.appendChild(textSpan);

        a.addEventListener('click', function (e) {
            e.preventDefault();
            handleRowAction(actionKey, docId);
        });

        li.appendChild(a);
        return li;
    }

    /**
     * Render action dropdown for a document row
     */
    function renderActionsDropdown(doc) {
        const wrapper = document.createElement('div');
        wrapper.className = 'dropdown text-end';

        const button = document.createElement('button');
        button.className = 'btn-doc-actions dropdown-toggle';
        button.type = 'button';
        button.setAttribute('data-bs-toggle', 'dropdown');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', `Actions for ${doc.invoiceNumber}`);

        const btnText = document.createElement('span');
        btnText.textContent = 'Actions';
        const btnIcon = document.createElement('i');
        btnIcon.className = 'bi bi-chevron-down';

        button.appendChild(btnText);
        button.appendChild(btnIcon);
        wrapper.appendChild(button);

        const menu = document.createElement('ul');
        menu.className = 'dropdown-menu dropdown-menu-end dropdown-menu-actions shadow-sm';

        // 1. View
        menu.appendChild(createActionItem('View Document', 'bi-eye', 'view', doc.id));

        // 2. Edit (only if not VOID and not DELETED)
        if (doc.status !== 'VOID' && doc.status !== 'DELETED') {
            menu.appendChild(createActionItem('Edit Document', 'bi-pencil', 'edit', doc.id));
        }

        // 3. Convert (only for Quotation that is not VOID/DELETED and not already converted)
        if (doc.documentType === 'QUOTATION' && doc.status !== 'VOID' && doc.status !== 'DELETED' && !doc.convertedInvoice) {
            menu.appendChild(createActionItem('Convert to Invoice', 'bi-arrow-repeat', 'convert', doc.id));
        }

        // Divider
        const divider1 = document.createElement('li');
        divider1.innerHTML = '<hr class="dropdown-divider">';
        menu.appendChild(divider1);

        // 4. Copy / Duplicate
        menu.appendChild(createActionItem('Duplicate as New', 'bi-files', 'copy', doc.id));

        // 5. Print / Export
        menu.appendChild(createActionItem('Print / Export', 'bi-printer', 'print', doc.id));

        // 6. Lifecycle Transitions
        if (doc.status === 'DELETED') {
            const divider2 = document.createElement('li');
            divider2.innerHTML = '<hr class="dropdown-divider">';
            menu.appendChild(divider2);
            menu.appendChild(createActionItem('Restore Document', 'bi-arrow-counterclockwise text-success', 'restore', doc.id));
        } else if (doc.status !== 'VOID') {
            const divider2 = document.createElement('li');
            divider2.innerHTML = '<hr class="dropdown-divider">';
            menu.appendChild(divider2);
            menu.appendChild(createActionItem('Void Document', 'bi-slash-circle', 'void', doc.id));
            menu.appendChild(createActionItem('Delete Document', 'bi-trash3 text-danger', 'delete', doc.id, true));
        }

        wrapper.appendChild(menu);
        return wrapper;
    }

    /**
     * Display a non-intrusive toast notice to inform user of future phase workflows
     */
    function showNoticeToast(message, iconClass = 'bi-info-circle') {
        const existing = document.querySelector('.notice-toast-container');
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.className = 'notice-toast-container';

        const toast = document.createElement('div');
        toast.className = 'notice-toast';

        const icon = document.createElement('i');
        icon.className = `bi ${iconClass} fs-5 text-lime`;
        toast.appendChild(icon);

        const text = document.createElement('span');
        text.textContent = message;
        toast.appendChild(text);

        container.appendChild(toast);
        document.body.appendChild(container);

        setTimeout(() => {
            container.style.transition = 'opacity 0.3s ease';
            container.style.opacity = '0';
            setTimeout(() => container.remove(), 350);
        }, 3200);
    }

    /**
     * Handle row action hooks for subsequent phases
     */
    function handleRowAction(actionKey, docId) {
        switch (actionKey) {
            case 'view':
                window.location.href = `/documents/${docId}`;
                break;
            case 'edit':
                window.location.href = `/documents/${docId}/edit`;
                break;
            case 'convert':
                window.location.href = `/documents/${docId}`;
                break;
            case 'copy':
                window.location.href = `/documents/new?copyFrom=${docId}`;
                break;
            case 'print':
                window.open(`/documents/${docId}/print`, '_blank');
                break;
            case 'pdf':
                window.open(`/api/invoices/${docId}/pdf`, '_blank');
                break;
            case 'void':
            case 'delete':
            case 'restore':
                window.location.href = `/documents/${docId}`;
                break;
            default:
                break;
        }
    }

    /**
     * Render skeleton loading rows while fetching
     */
    function renderLoadingSkeleton() {
        if (!tableTbody) return;
        tableTbody.innerHTML = '';

        for (let i = 0; i < 5; i++) {
            const tr = document.createElement('tr');
            tr.className = 'skeleton-row';
            tr.innerHTML = `
                <td><div class="skeleton-box" style="width: 110px;"></div></td>
                <td><div class="skeleton-box" style="width: 85px;"></div></td>
                <td><div class="skeleton-box" style="width: 160px;"></div></td>
                <td><div class="skeleton-box" style="width: 90px;"></div></td>
                <td><div class="skeleton-box" style="width: 90px;"></div></td>
                <td class="text-end"><div class="skeleton-box ms-auto" style="width: 100px;"></div></td>
                <td class="text-center"><div class="skeleton-box mx-auto" style="width: 75px;"></div></td>
                <td class="text-end"><div class="skeleton-box ms-auto" style="width: 70px;"></div></td>
            `;
            tableTbody.appendChild(tr);
        }
    }

    /**
     * Render documents into the table
     */
    function renderTableRows(documents) {
        if (!tableTbody) return;
        tableTbody.innerHTML = '';

        documents.forEach((doc) => {
            const tr = document.createElement('tr');

            // 1. Document No
            const tdDocNo = document.createElement('td');
            tdDocNo.className = 'doc-number-cell';
            const docLink = document.createElement('a');
            docLink.href = `/documents/${doc.id}`;
            docLink.className = 'doc-number-link text-decoration-none fw-semibold font-monospace';
            docLink.textContent = doc.invoiceNumber || '—';
            tdDocNo.appendChild(docLink);
            tr.appendChild(tdDocNo);

            // 2. Type
            const tdType = document.createElement('td');
            tdType.appendChild(renderTypeBadge(doc.documentType));
            tr.appendChild(tdType);

            // 3. Client Name
            const tdClient = document.createElement('td');
            tdClient.className = 'doc-client-cell';
            tdClient.title = doc.clientName || '';
            tdClient.textContent = doc.clientName || '—';
            tr.appendChild(tdClient);

            // 4. Document Date
            const tdDate = document.createElement('td');
            tdDate.className = 'doc-date-cell';
            tdDate.textContent = formatDate(doc.invoiceDate);
            tr.appendChild(tdDate);

            // 5. Due / Expiry Date
            const tdDue = document.createElement('td');
            tdDue.className = 'doc-date-cell';
            tdDue.textContent = formatDueDate(doc);
            tr.appendChild(tdDue);

            // 6. Amount & Payment Status
            const tdAmount = document.createElement('td');
            tdAmount.className = 'doc-amount-cell text-end';
            const amountDiv = document.createElement('div');
            amountDiv.className = 'fw-bold';
            amountDiv.textContent = formatIndianCurrency(doc.grandTotal);
            tdAmount.appendChild(amountDiv);

            if (doc.documentType === 'INVOICE') {
                const paid = Number(doc.paidAmount) || 0;
                const grand = Number(doc.grandTotal) || 0;
                const payPill = document.createElement('span');
                payPill.className = 'badge font-monospace mt-1';
                payPill.style.fontSize = '10px';
                payPill.style.padding = '2px 6px';

                if (paid >= grand && grand > 0) {
                    payPill.className += ' bg-success-subtle text-success border border-success-subtle';
                    payPill.textContent = 'PAID';
                } else if (paid > 0) {
                    payPill.className += ' bg-warning-subtle text-warning border border-warning-subtle';
                    payPill.textContent = 'PARTIAL';
                } else {
                    const dueDate = doc.dueDate ? new Date(doc.dueDate) : (doc.invoiceDate ? new Date(new Date(doc.invoiceDate).getTime() + 30 * 24 * 60 * 60 * 1000) : null);
                    if (dueDate && !isNaN(dueDate.getTime()) && dueDate < new Date()) {
                        payPill.className += ' bg-danger-subtle text-danger border border-danger-subtle';
                        payPill.textContent = 'OVERDUE';
                    } else {
                        payPill.className += ' bg-secondary-subtle text-secondary border border-secondary-subtle';
                        payPill.textContent = 'UNPAID';
                    }
                }
                tdAmount.appendChild(payPill);
            }
            tr.appendChild(tdAmount);

            // 7. Status
            const tdStatus = document.createElement('td');
            tdStatus.className = 'text-center';
            tdStatus.appendChild(renderStatusBadge(doc.status));
            tr.appendChild(tdStatus);

            // 8. Actions
            const tdActions = document.createElement('td');
            tdActions.className = 'text-end';
            tdActions.appendChild(renderActionsDropdown(doc));
            tr.appendChild(tdActions);

            tableTbody.appendChild(tr);
        });
    }

    /**
     * Render empty state differentiating no records vs no matches
     */
    function renderEmptyState(isFiltered) {
        if (tableCard) tableCard.classList.add('d-none');
        if (paginationBar) paginationBar.classList.add('d-none');
        if (errorStateContainer) errorStateContainer.classList.add('d-none');
        if (!emptyStateContainer) return;

        emptyStateContainer.classList.remove('d-none');
        const titleEl = emptyStateContainer.querySelector('.state-title');
        const descEl = emptyStateContainer.querySelector('.state-desc');
        const clearBtn = emptyStateContainer.querySelector('#btn-empty-clear');

        if (isFiltered) {
            if (titleEl) titleEl.textContent = 'No documents match your filters';
            if (descEl) descEl.textContent = 'Try adjusting or clearing your search keywords, status, or date range filters.';
            if (clearBtn) clearBtn.classList.remove('d-none');
        } else {
            if (titleEl) titleEl.textContent = 'No documents found';
            if (descEl) descEl.textContent = 'There are no quotations or invoices recorded in the system yet.';
            if (clearBtn) clearBtn.classList.add('d-none');
        }
    }

    /**
     * Render error state with message
     */
    function renderErrorState(message) {
        if (tableCard) tableCard.classList.add('d-none');
        if (paginationBar) paginationBar.classList.add('d-none');
        if (emptyStateContainer) emptyStateContainer.classList.add('d-none');
        if (!errorStateContainer) return;

        errorStateContainer.classList.remove('d-none');
        if (errorMessageEl) {
            errorMessageEl.textContent = message || 'An unexpected error occurred while loading documents. Please try again.';
        }
    }

    /**
     * Update pagination bar UI
     */
    function updatePaginationControls(pagination) {
        if (!paginationBar) return;
        paginationBar.classList.remove('d-none');

        state.total = pagination.total || 0;
        state.page = pagination.page || 1;
        state.limit = pagination.limit || 10;
        state.totalPages = Math.max(1, pagination.totalPages || 1);

        const startIdx = state.total === 0 ? 0 : (state.page - 1) * state.limit + 1;
        const endIdx = Math.min(state.total, state.page * state.limit);

        if (paginationInfo) {
            paginationInfo.textContent = `Showing ${startIdx} to ${endIdx} of ${state.total} document${state.total === 1 ? '' : 's'}`;
        }

        if (pageIndicator) {
            pageIndicator.textContent = `Page ${state.page} of ${state.totalPages}`;
        }

        if (prevPageBtn) {
            prevPageBtn.disabled = state.page <= 1;
        }

        if (nextPageBtn) {
            nextPageBtn.disabled = state.page >= state.totalPages;
        }

        if (pageSizeSelect) {
            pageSizeSelect.value = String(state.limit);
        }
    }

    /**
     * Main fetch function calling GET /api/invoices
     */
    async function loadDocuments() {
        if (state.activeAbortController) {
            state.activeAbortController.abort();
        }
        state.activeAbortController = new AbortController();
        const { signal } = state.activeAbortController;

        state.isLoading = true;
        if (emptyStateContainer) emptyStateContainer.classList.add('d-none');
        if (errorStateContainer) errorStateContainer.classList.add('d-none');
        if (tableCard) tableCard.classList.remove('d-none');
        renderLoadingSkeleton();

        const queryParams = new URLSearchParams();
        if (state.type) queryParams.set('type', state.type);
        if (state.status) queryParams.set('status', state.status);
        if (state.paymentStatus) queryParams.set('paymentStatus', state.paymentStatus);
        if (state.search) queryParams.set('search', state.search);
        if (state.dateFrom) queryParams.set('dateFrom', state.dateFrom);
        if (state.dateTo) queryParams.set('dateTo', state.dateTo);
        queryParams.set('page', String(state.page));
        queryParams.set('limit', String(state.limit));

        try {
            const res = await fetch(`/api/invoices?${queryParams.toString()}`, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                },
                signal
            });

            if (res.status === 401) {
                // Session expired or unauthenticated; redirect to login
                window.location.href = '/login?expired=1';
                return;
            }

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `Server responded with HTTP ${res.status}`);
            }

            const response = await res.json();
            const documents = response.data || [];
            const pagination = response.pagination || { total: 0, page: 1, limit: state.limit, totalPages: 1 };

            syncStateToUrl();

            if (documents.length === 0) {
                const isFiltered = Boolean(state.type || state.status || state.paymentStatus || state.search || state.dateFrom || state.dateTo);
                renderEmptyState(isFiltered);
            } else {
                renderTableRows(documents);
                updatePaginationControls(pagination);
            }
            loadKPIs();
        } catch (err) {
            if (err.name === 'AbortError') {
                return; // Request was cleanly cancelled by subsequent user action
            }
            console.error('[DOCUMENTS LIST ERROR]:', err);
            renderErrorState(err.message || 'Unable to connect to the server. Please check your network connection.');
        } finally {
            state.isLoading = false;
        }
    }

    /**
     * Clear all filters and reload
     */
    function resetFilters() {
        state.type = '';
        state.status = '';
        state.paymentStatus = '';
        state.search = '';
        state.dateFrom = '';
        state.dateTo = '';
        state.page = 1;

        applyStateToControls();
        loadDocuments();
    }

    /**
     * Initialize DOM event handlers
     */
    function initEventHandlers() {
        // Search Input (Debounced)
        if (searchInput) {
            searchInput.addEventListener('input', function (e) {
                clearTimeout(searchDebounceTimer);
                searchDebounceTimer = setTimeout(() => {
                    state.search = e.target.value.trim();
                    state.page = 1;
                    loadDocuments();
                }, 350);
            });
        }

        // Type Filter Select
        if (typeSelect) {
            typeSelect.addEventListener('change', function (e) {
                state.type = e.target.value;
                state.page = 1;
                loadDocuments();
            });
        }

        // Status Filter Select
        if (statusSelect) {
            statusSelect.addEventListener('change', function (e) {
                state.status = e.target.value;
                state.page = 1;
                loadDocuments();
            });
        }

        // Payment Status Filter Select
        if (paymentStatusSelect) {
            paymentStatusSelect.addEventListener('change', function (e) {
                state.paymentStatus = e.target.value;
                state.page = 1;
                loadDocuments();
            });
        }

        // Date From
        if (dateFromInput) {
            dateFromInput.addEventListener('change', function (e) {
                state.dateFrom = e.target.value;
                state.page = 1;
                loadDocuments();
            });
        }

        // Date To
        if (dateToInput) {
            dateToInput.addEventListener('change', function (e) {
                state.dateTo = e.target.value;
                state.page = 1;
                loadDocuments();
            });
        }

        // Clear Filters Buttons
        if (clearFiltersBtn) {
            clearFiltersBtn.addEventListener('click', resetFilters);
        }

        const emptyClearBtn = document.getElementById('btn-empty-clear');
        if (emptyClearBtn) {
            emptyClearBtn.addEventListener('click', resetFilters);
        }

        // Export Excel Button
        const exportExcelBtn = document.getElementById('btn-export-excel');
        if (exportExcelBtn) {
            exportExcelBtn.addEventListener('click', function () {
                const params = new URLSearchParams();
                if (state.type) params.set('documentType', state.type);
                if (state.status) params.set('status', state.status);
                if (state.search) params.set('search', state.search);
                if (state.dateFrom) params.set('dateFrom', state.dateFrom);
                if (state.dateTo) params.set('dateTo', state.dateTo);
                window.location.href = `/api/invoices/export/excel?${params.toString()}`;
            });
        }

        // Retry Button in Error State
        if (retryBtn) {
            retryBtn.addEventListener('click', loadDocuments);
        }

        // Page Size Select
        if (pageSizeSelect) {
            pageSizeSelect.addEventListener('change', function (e) {
                state.limit = parseInt(e.target.value, 10) || 10;
                state.page = 1;
                loadDocuments();
            });
        }

        // Pagination Buttons
        if (prevPageBtn) {
            prevPageBtn.addEventListener('click', function () {
                if (state.page > 1) {
                    state.page--;
                    loadDocuments();
                }
            });
        }

        if (nextPageBtn) {
            nextPageBtn.addEventListener('click', function () {
                if (state.page < state.totalPages) {
                    state.page++;
                    loadDocuments();
                }
            });
        }

        // Browser History Popstate (Back/Forward)
        window.addEventListener('popstate', function () {
            parseUrlState();
            applyStateToControls();
            loadDocuments();
        });
    }

    /**
     * Fetch and update KPI summary metrics from /api/invoices/kpis
     */
    async function loadKPIs() {
        try {
            const res = await fetch('/api/invoices/kpis', {
                headers: { 'Accept': 'application/json' }
            });
            if (!res.ok) return;
            const data = await res.json();
            const activeQuotationsEl = document.getElementById('kpi-active-quotations');
            const activeInvoicesEl = document.getElementById('kpi-active-invoices');
            const totalOutstandingEl = document.getElementById('kpi-total-outstanding');
            const overdueInvoicesEl = document.getElementById('kpi-overdue-invoices');

            if (activeQuotationsEl) activeQuotationsEl.textContent = data.activeQuotations ?? '0';
            if (activeInvoicesEl) activeInvoicesEl.textContent = data.activeInvoices ?? '0';
            if (totalOutstandingEl) totalOutstandingEl.textContent = formatIndianCurrency(data.totalOutstanding || 0);
            if (overdueInvoicesEl) overdueInvoicesEl.textContent = data.overdueInvoices ?? '0';
        } catch (err) {
            console.error('[KPI LOAD ERROR]:', err);
        }
    }

    /**
     * Module Entry Point
     */
    document.addEventListener('DOMContentLoaded', function () {
        searchInput = document.getElementById('search-input');
        typeSelect = document.getElementById('filter-type');
        statusSelect = document.getElementById('filter-status');
        paymentStatusSelect = document.getElementById('filter-payment-status');
        dateFromInput = document.getElementById('filter-date-from');
        dateToInput = document.getElementById('filter-date-to');
        clearFiltersBtn = document.getElementById('btn-clear-filters');
        tableTbody = document.getElementById('documents-tbody');
        tableCard = document.getElementById('documents-table-card');
        emptyStateContainer = document.getElementById('empty-state');
        errorStateContainer = document.getElementById('error-state');
        errorMessageEl = document.getElementById('error-message');
        retryBtn = document.getElementById('btn-retry');
        paginationBar = document.getElementById('documents-pagination-bar');
        paginationInfo = document.getElementById('pagination-info');
        pageSizeSelect = document.getElementById('page-size-select');
        prevPageBtn = document.getElementById('btn-prev-page');
        nextPageBtn = document.getElementById('btn-next-page');
        pageIndicator = document.getElementById('page-indicator');

        parseUrlState();
        applyStateToControls();
        initEventHandlers();
        loadKPIs();
        loadDocuments();
    });
})();
