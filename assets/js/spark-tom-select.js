/* ==========================================================================
   SPARK ADMIN ERP — TOM SELECT INTEGRATION MODULE
   - Converts all project select elements to Tom Select with smooth search & options
   - Full two-way data binding support for AJAX form submission & GET population
   - Supports Light & Dark modes seamlessly
   ========================================================================== */

(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Reactive Property Interceptor: HTMLSelectElement.prototype.value
    //    Whenever existing scripts or modals do `select.value = 'foo'`,
    //    automatically reflect and synchronize the active TomSelect instance!
    // -------------------------------------------------------------------------
    try {
        const originalValueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        if (originalValueDescriptor && originalValueDescriptor.set) {
            Object.defineProperty(HTMLSelectElement.prototype, 'value', {
                get: function () {
                    return originalValueDescriptor.get.call(this);
                },
                set: function (val) {
                    originalValueDescriptor.set.call(this, val);
                    if (this.tomselect && !this._tsSettingValue) {
                        this._tsSettingValue = true;
                        try {
                            const stringVal = val === null || val === undefined ? '' : String(val);
                            // If option doesn't exist yet, dynamically append it to TomSelect options
                            if (stringVal !== '' && !this.tomselect.options[stringVal]) {
                                const matchingOpt = this.querySelector(`option[value="${CSS.escape(stringVal)}"]`);
                                const text = matchingOpt ? matchingOpt.textContent.trim() : stringVal;
                                this.tomselect.addOption({ value: stringVal, text: text });
                            }
                            this.tomselect.setValue(stringVal, true);
                        } catch (err) {
                            // Non-fatal fallback
                        } finally {
                            this._tsSettingValue = false;
                        }
                    }
                }
            });
        }
    } catch (e) {
        console.warn('[TomSelect] Prototype descriptor hook skipped:', e);
    }

    // -------------------------------------------------------------------------
    // 2. Global Sync Helper: window.syncTomSelect(el, [val])
    // -------------------------------------------------------------------------
    window.syncTomSelect = function (selectEl, value) {
        if (!selectEl) return;
        if (typeof selectEl === 'string') {
            selectEl = document.querySelector(selectEl);
        }
        if (!selectEl) return;

        if (value !== undefined) {
            selectEl.value = value;
        }
        if (selectEl.tomselect) {
            selectEl.tomselect.setValue(selectEl.value, true);
        }
    };

    // -------------------------------------------------------------------------
    // 3. TomSelect Factory: initTomSelect(el)
    // -------------------------------------------------------------------------
    function initTomSelect(el) {
        if (!el || typeof TomSelect === 'undefined') return null;
        if (el.tomselect || el.classList.contains('tomselected') || el.dataset.noTomselect === 'true') {
            return el.tomselect || null;
        }

        // Avoid attaching to hidden or detached templates
        if (el.closest('template') || el.closest('[data-template]')) {
            return null;
        }

        const optionCount = el.options ? el.options.length : 0;
        const isSearchable = (optionCount > 7 && el.dataset.searchable !== 'false') || el.dataset.searchable === 'true';
        const isSmall = (el.classList.contains('form-select-sm') && el.closest('table')) || 
                        el.classList.contains('pagination-size-select') ||
                        el.classList.contains('spark-dt-size-select');

        // Resolve placeholder
        let placeholder = el.getAttribute('placeholder');
        if (!placeholder) {
            const emptyOpt = el.querySelector('option[value=""]');
            if (emptyOpt && emptyOpt.textContent.trim()) {
                placeholder = emptyOpt.textContent.trim();
            } else {
                placeholder = el.getAttribute('aria-label') || 'Select...';
            }
        }

        // Detect modal container so dropdown is never clipped and focus isn't trapped
        const modalContainer = el.closest('.modal-content') || el.closest('.modal-body') || el.closest('.modal');
        const dropdownParent = modalContainer ? modalContainer : 'body';

        const plugins = [];
        if (isSearchable) {
            plugins.push('dropdown_input');
        }

        // Add clear button if not multiple and allows empty option
        if (!el.multiple && el.querySelector('option[value=""]')) {
            plugins.push('clear_button');
        }

        let tsInstance = null;
        try {
            tsInstance = new TomSelect(el, {
                plugins: plugins,
                create: el.dataset.allowCreate === 'true',
                allowEmptyOption: true,
                maxOptions: 250,
                controlInput: isSearchable ? undefined : null,
                dropdownParent: dropdownParent,
                placeholder: placeholder,
                copyClassesToDropdown: false,
                render: {
                    no_results: function (data, escape) {
                        return '<div class="no-results p-2 text-muted small text-center">No matching results found</div>';
                    }
                },
                onInitialize: function () {
                    if (isSmall && this.wrapper) {
                        this.wrapper.classList.add('ts-sm');
                    }
                    if (el.classList.contains('toolbar-select') && this.wrapper) {
                        this.wrapper.classList.add('ts-toolbar');
                    }
                    if (this.wrapper) {
                        const curVal = this.getValue();
                        this.wrapper.classList.toggle('has-real-value', !!(curVal && curVal !== ''));
                    }
                },
                onChange: function (val) {
                    if (this.wrapper) {
                        this.wrapper.classList.toggle('has-real-value', !!(val && val !== ''));
                    }
                    if (el._tsSettingValue) return;

                    el._tsSettingValue = true;
                    try {
                        el.value = val;
                    } finally {
                        el._tsSettingValue = false;
                    }

                    // Dispatch bubbling change event so AJAX / Vanilla / React handlers trigger
                    const event = new Event('change', { bubbles: true });
                    el.dispatchEvent(event);

                    // If inline onchange attribute is present, invoke it
                    if (typeof el.onchange === 'function') {
                        el.onchange.call(el, event);
                    }
                }
            });

            el.tomselect = tsInstance;
        } catch (err) {
            console.warn('[TomSelect] Failed to initialize on element:', el, err);
            return null;
        }

        return tsInstance;
    }

    // -------------------------------------------------------------------------
    // 4. Batch Initializer: initAllTomSelects(root)
    // -------------------------------------------------------------------------
    function initAllTomSelects(root) {
        if (typeof TomSelect === 'undefined') return;
        const container = root || document;

        // Query all select elements in project
        const selects = container.querySelectorAll(
            'select:not([data-no-tomselect="true"]):not(.tomselected)'
        );

        selects.forEach(sel => {
            initTomSelect(sel);
        });
    }

    // Expose global API
    window.initTomSelect = initTomSelect;
    window.initAllTomSelects = initAllTomSelects;

    // -------------------------------------------------------------------------
    // 5. Automatic DOM Readiness & Dynamic DOM Observer
    // -------------------------------------------------------------------------
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initAllTomSelects());
    } else {
        initAllTomSelects();
    }

    // Handle dynamically appended elements (modals, ajax tables, line item additions)
    const observer = new MutationObserver((mutations) => {
        let shouldInit = false;
        for (let i = 0; i < mutations.length; i++) {
            const added = mutations[i].addedNodes;
            for (let j = 0; j < added.length; j++) {
                const node = added[j];
                if (node.nodeType === 1) { // ELEMENT_NODE
                    if (node.tagName === 'SELECT' && !node.tomselect && node.dataset.noTomselect !== 'true') {
                        shouldInit = true;
                        break;
                    }
                    if (node.querySelector && node.querySelector('select:not([data-no-tomselect="true"]):not(.tomselected)')) {
                        shouldInit = true;
                        break;
                    }
                }
            }
            if (shouldInit) break;
        }
        if (shouldInit) {
            initAllTomSelects();
        }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

})();

