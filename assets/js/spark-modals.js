/* ==========================================================================
   SPARK ADMIN ERP — GLOBAL MODAL & STACKING MANAGEMENT
   - Automatically promotes all .modal dialogs to document.body
     to prevent CSS backdrop-filter / transform stacking context trapping.
   - Ensures backdrops are always underneath modals, never covering inputs.
   - Cleans up orphaned backdrops and restores body scroll state.
   ========================================================================== */

(function () {
    'use strict';

    function promoteModalToBody(modalEl) {
        if (!modalEl || modalEl.parentElement === document.body) return;
        try {
            document.body.appendChild(modalEl);
        } catch (err) {
            console.warn('[SparkModals] Failed to promote modal to body:', err);
        }
    }

    function promoteAllModals() {
        const modals = document.querySelectorAll('.modal');
        modals.forEach(promoteModalToBody);
    }

    // Run immediately if DOM ready, otherwise on DOMContentLoaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', promoteAllModals);
    } else {
        promoteAllModals();
    }

    // Intercept when Bootstrap starts opening any modal
    document.addEventListener('show.bs.modal', function (event) {
        const modal = event.target;
        if (modal && modal.parentElement !== document.body) {
            promoteModalToBody(modal);
        }
    });

    // Ensure dropdowns inside tables, cards, toolbars or scrollable containers pop out of the container
    document.addEventListener('show.bs.dropdown', function (event) {
        const toggle = event.target;
        if (!toggle) return;
        const shouldFix = toggle.closest('.table-responsive, .spark-dt-table-wrap, .view-table-wrapper, table, .card, .card-glass, .kpi-card, .toolbar-filter-card, .main-content');
        if (shouldFix) {
            toggle.setAttribute('data-bs-popper-config', '{"strategy":"fixed"}');
            try {
                if (typeof bootstrap !== 'undefined' && bootstrap.Dropdown) {
                    const inst = bootstrap.Dropdown.getInstance(toggle) || bootstrap.Dropdown.getOrCreateInstance(toggle);
                    if (inst && inst._popper) {
                        inst._popper.setOptions({ strategy: 'fixed' });
                    }
                }
            } catch (e) {}
        }
    });

    // Cleanup stray backdrops and restore page interactivity when all modals hide
    document.addEventListener('hidden.bs.modal', function () {
        setTimeout(function () {
            const activeModals = document.querySelectorAll('.modal.show');
            if (activeModals.length === 0) {
                const strayBackdrops = document.querySelectorAll('.modal-backdrop');
                strayBackdrops.forEach(function (b) {
                    b.remove();
                });
                document.body.classList.remove('modal-open');
                document.body.style.removeProperty('overflow');
                document.body.style.removeProperty('padding-right');
            }
        }, 50);
    });

    // Global helper for programmatic invocation
    window.openSparkModal = function (selectorOrEl) {
        const el = typeof selectorOrEl === 'string' ? document.querySelector(selectorOrEl) : selectorOrEl;
        if (!el || typeof bootstrap === 'undefined' || !bootstrap.Modal) return null;
        promoteModalToBody(el);
        const modalInstance = bootstrap.Modal.getOrCreateInstance(el);
        modalInstance.show();
        return modalInstance;
    };

    window.closeSparkModal = function (selectorOrEl) {
        const el = typeof selectorOrEl === 'string' ? document.querySelector(selectorOrEl) : selectorOrEl;
        if (!el || typeof bootstrap === 'undefined' || !bootstrap.Modal) return;
        const modalInstance = bootstrap.Modal.getInstance(el);
        if (modalInstance) {
            modalInstance.hide();
        }
    };
})();

