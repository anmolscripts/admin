/**
 * ========================================================================
 * SPARK ADMIN - DOCUMENT VIEW & LIFECYCLE CONTROLLER (PHASE 4)
 * Handles Activate, Deactivate, Void, Delete, Restore, Convert, & Concurrency
 * ========================================================================
 */

(function () {
    'use strict';

    // Global document state injected by server
    const docData = window.__DOCUMENT_DATA__ || null;
    if (!docData) return;

    const docId = docData.id;
    let currentVersion = docData.version;

    // DOM Elements
    const csrfTokenInput = document.getElementById('csrf-token');
    const conflictAlert = document.getElementById('conflict-alert');
    const conflictMessage = document.getElementById('conflict-message');
    const btnReloadConflict = document.getElementById('btn-reload-conflict');
    const feedbackAlert = document.getElementById('action-feedback-alert');
    const feedbackMessage = document.getElementById('feedback-message');

    // Modals
    const modalActivateEl = document.getElementById('modal-activate');
    const modalDeactivateEl = document.getElementById('modal-deactivate');
    const modalVoidEl = document.getElementById('modal-void');
    const modalDeleteEl = document.getElementById('modal-delete');
    const modalRestoreEl = document.getElementById('modal-restore');
    const modalConvertEl = document.getElementById('modal-convert');

    const modalActivate = modalActivateEl ? new bootstrap.Modal(modalActivateEl) : null;
    const modalDeactivate = modalDeactivateEl ? new bootstrap.Modal(modalDeactivateEl) : null;
    const modalVoid = modalVoidEl ? new bootstrap.Modal(modalVoidEl) : null;
    const modalDelete = modalDeleteEl ? new bootstrap.Modal(modalDeleteEl) : null;
    const modalRestore = modalRestoreEl ? new bootstrap.Modal(modalRestoreEl) : null;
    const modalConvert = modalConvertEl ? new bootstrap.Modal(modalConvertEl) : null;

    // Confirmation Buttons
    const btnConfirmActivate = document.getElementById('btn-confirm-activate');
    const btnConfirmDeactivate = document.getElementById('btn-confirm-deactivate');
    const btnConfirmVoid = document.getElementById('btn-confirm-void');
    const btnConfirmDelete = document.getElementById('btn-confirm-delete');
    const btnConfirmRestore = document.getElementById('btn-confirm-restore');
    const btnConfirmConvert = document.getElementById('btn-confirm-convert');

    // Input fields inside modals
    const voidReasonInput = document.getElementById('void-reason');
    const deleteReasonInput = document.getElementById('delete-reason');

    /**
     * Show conflict banner
     */
    function showConflictAlert(message) {
        if (!conflictAlert) return;
        if (conflictMessage) {
            conflictMessage.textContent = message || 'This document was changed by another user. Please reload the latest version before retrying.';
        }
        conflictAlert.classList.remove('d-none');
        conflictAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /**
     * Show general error feedback banner
     */
    function showErrorFeedback(message) {
        if (!feedbackAlert) return;
        feedbackAlert.className = 'alert alert-danger alert-dismissible fade show mb-4 shadow-sm';
        if (feedbackMessage) {
            feedbackMessage.textContent = message || 'An error occurred while performing the requested action.';
        }
        feedbackAlert.classList.remove('d-none');
        feedbackAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /**
     * Generic API caller with lifecycle button states and error handling
     */
    async function executeLifecycleAction({
        url,
        method,
        payload,
        buttonEl,
        spinnerEl,
        modalInstance
    }) {
        const csrfToken = csrfTokenInput ? csrfTokenInput.value : '';

        // Disable button & show spinner
        if (buttonEl) buttonEl.disabled = true;
        if (spinnerEl) spinnerEl.classList.remove('d-none');
        if (conflictAlert) conflictAlert.classList.add('d-none');
        if (feedbackAlert) feedbackAlert.classList.add('d-none');

        try {
            const response = await fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken
                },
                body: JSON.stringify(payload)
            });

            // Handle Session Expiry
            if (response.status === 401) {
                if (modalInstance) modalInstance.hide();
                window.location.href = '/login?expired=1';
                return;
            }

            // Handle Concurrency Conflict (409)
            if (response.status === 409) {
                if (modalInstance) modalInstance.hide();
                const errData = await response.json().catch(() => ({}));
                showConflictAlert(errData.error);
                return;
            }

            // Handle Validation or Business Rule Rejection (400)
            if (response.status === 400) {
                if (modalInstance) modalInstance.hide();
                const errData = await response.json().catch(() => ({}));
                showErrorFeedback(errData.error || 'The server rejected this action.');
                return;
            }

            // Handle Forbidden (403)
            if (response.status === 403) {
                if (modalInstance) modalInstance.hide();
                showErrorFeedback('You do not have permission to perform this action.');
                return;
            }

            // Handle Not Found (404)
            if (response.status === 404) {
                if (modalInstance) modalInstance.hide();
                showErrorFeedback('Document not found. It may have been permanently removed.');
                return;
            }

            // Handle Server Error (500)
            if (!response.ok) {
                if (modalInstance) modalInstance.hide();
                const errData = await response.json().catch(() => ({}));
                showErrorFeedback(errData.error || 'A server error occurred. Please try again.');
                return;
            }

            // Success (200 / 201)
            const result = await response.json();
            if (modalInstance) modalInstance.hide();

            // If conversion succeeded, give option to view new invoice
            if (url.endsWith('/convert') && result.data && result.data.id) {
                window.location.href = `/documents/${result.data.id}?converted=1`;
                return;
            }

            // Otherwise, reload page to load authoritative server-rendered data
            window.location.reload();

        } catch (err) {
            console.error('[DOCUMENT ACTION ERROR]:', err);
            if (modalInstance) modalInstance.hide();
            showErrorFeedback('A network communication error occurred. Please verify your connection.');
        } finally {
            if (buttonEl) buttonEl.disabled = false;
            if (spinnerEl) spinnerEl.classList.add('d-none');
        }
    }

    /**
     * Attach Event Listeners
     */
    function attachListeners() {
        // 1. Activate
        if (btnConfirmActivate) {
            btnConfirmActivate.addEventListener('click', () => {
                executeLifecycleAction({
                    url: `/api/invoices/${docId}/status`,
                    method: 'PATCH',
                    payload: {
                        status: 'ACTIVE',
                        version: currentVersion
                    },
                    buttonEl: btnConfirmActivate,
                    spinnerEl: document.getElementById('spinner-activate'),
                    modalInstance: modalActivate
                });
            });
        }

        // 2. Deactivate
        if (btnConfirmDeactivate) {
            btnConfirmDeactivate.addEventListener('click', () => {
                executeLifecycleAction({
                    url: `/api/invoices/${docId}/status`,
                    method: 'PATCH',
                    payload: {
                        status: 'INACTIVE',
                        version: currentVersion
                    },
                    buttonEl: btnConfirmDeactivate,
                    spinnerEl: document.getElementById('spinner-deactivate'),
                    modalInstance: modalDeactivate
                });
            });
        }

        // 3. Void
        if (btnConfirmVoid) {
            btnConfirmVoid.addEventListener('click', () => {
                const reason = voidReasonInput ? voidReasonInput.value.trim() : '';
                executeLifecycleAction({
                    url: `/api/invoices/${docId}/status`,
                    method: 'PATCH',
                    payload: {
                        status: 'VOID',
                        deleteReason: reason || 'Voided by user',
                        version: currentVersion
                    },
                    buttonEl: btnConfirmVoid,
                    spinnerEl: document.getElementById('spinner-void'),
                    modalInstance: modalVoid
                });
            });
        }

        // 4. Delete (Soft-Delete)
        if (btnConfirmDelete) {
            btnConfirmDelete.addEventListener('click', () => {
                const reason = deleteReasonInput ? deleteReasonInput.value.trim() : '';
                executeLifecycleAction({
                    url: `/api/invoices/${docId}`,
                    method: 'DELETE',
                    payload: {
                        deleteReason: reason || 'Soft-deleted by user',
                        version: currentVersion
                    },
                    buttonEl: btnConfirmDelete,
                    spinnerEl: document.getElementById('spinner-delete'),
                    modalInstance: modalDelete
                });
            });
        }

        // 5. Restore
        if (btnConfirmRestore) {
            btnConfirmRestore.addEventListener('click', () => {
                executeLifecycleAction({
                    url: `/api/invoices/${docId}/restore`,
                    method: 'POST',
                    payload: {
                        version: currentVersion
                    },
                    buttonEl: btnConfirmRestore,
                    spinnerEl: document.getElementById('spinner-restore'),
                    modalInstance: modalRestore
                });
            });
        }

        // 6. Convert Quotation to Invoice
        if (btnConfirmConvert) {
            btnConfirmConvert.addEventListener('click', () => {
                executeLifecycleAction({
                    url: `/api/invoices/${docId}/convert`,
                    method: 'POST',
                    payload: {
                        version: currentVersion
                    },
                    buttonEl: btnConfirmConvert,
                    spinnerEl: document.getElementById('spinner-convert'),
                    modalInstance: modalConvert
                });
            });
        }

        // 7. Reload latest version after conflict
        if (btnReloadConflict) {
            btnReloadConflict.addEventListener('click', () => {
                window.location.reload();
            });
        }
    }

    document.addEventListener('DOMContentLoaded', attachListeners);

})();

