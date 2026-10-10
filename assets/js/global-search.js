/**
 * Spark Admin — Global Command Palette & Search (Ctrl+K / Cmd+K)
 * Universal keyboard navigation, debounced async search, and accessible ARIA combobox.
 */
(() => {
    'use strict';

    const searchInput = document.getElementById('main-search');
    const searchDropdown = document.getElementById('global-search-dropdown');
    const searchBody = document.getElementById('global-search-body');
    const searchSpinner = document.getElementById('main-search-spinner');
    const searchIcon = document.getElementById('main-search-icon');
    const searchContainer = document.getElementById('global-search-container');
    const searchBtn = document.getElementById('main-search-btn');

    if (!searchInput || !searchDropdown || !searchBody) {
        return;
    }

    let debounceTimer = null;
    let abortController = null;
    let activeItemIndex = -1;
    let currentItems = [];

    // Helper: Escape HTML strings to prevent XSS in client rendering
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Helper: Highlight query matches in text
    function highlightMatch(text, query) {
        const safeText = escapeHtml(text);
        if (!query || query.trim().length === 0) return safeText;
        const q = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${q})`, 'gi');
        return safeText.replace(regex, '<span class="global-search-highlight">$1</span>');
    }

    // Show/hide loading indicator
    function setLoading(isLoading) {
        if (searchSpinner && searchIcon) {
            if (isLoading) {
                searchSpinner.classList.remove('d-none');
                searchIcon.classList.add('d-none');
            } else {
                searchSpinner.classList.add('d-none');
                searchIcon.classList.remove('d-none');
            }
        }
    }

    // Open dropdown
    function openDropdown() {
        searchDropdown.classList.remove('d-none');
        searchInput.setAttribute('aria-expanded', 'true');
    }

    // Close dropdown
    function closeDropdown() {
        searchDropdown.classList.add('d-none');
        searchInput.setAttribute('aria-expanded', 'false');
        searchInput.removeAttribute('aria-activedescendant');
        activeItemIndex = -1;
    }

    // Render results in dropdown body
    function renderResults(categories, query) {
        searchBody.innerHTML = '';
        currentItems = [];
        activeItemIndex = -1;

        if (!categories || categories.length === 0) {
            searchBody.innerHTML = `
                <div class="p-4 text-center text-muted">
                    <i class="bi bi-search fs-3 text-secondary opacity-50 d-block mb-2"></i>
                    <p class="mb-1 fw-semibold text-dark">No matching results found</p>
                    <small>Try searching with another keyword or document number.</small>
                </div>
            `;
            openDropdown();
            return;
        }

        let itemIndex = 0;
        categories.forEach(cat => {
            if (!cat.items || cat.items.length === 0) return;

            const groupEl = document.createElement('div');
            groupEl.className = 'global-search-group';

            const headerEl = document.createElement('div');
            headerEl.className = 'global-search-group-header';
            headerEl.innerHTML = `<span>${escapeHtml(cat.name)}</span><span>${cat.items.length}</span>`;
            groupEl.appendChild(headerEl);

            cat.items.forEach(item => {
                const itemEl = document.createElement('a');
                itemEl.className = 'global-search-item';
                itemEl.href = item.url;
                itemEl.setAttribute('role', 'option');
                itemEl.id = `search-opt-${itemIndex}`;
                itemEl.dataset.index = itemIndex;

                const iconClass = item.icon || 'bi-link-45deg';

                itemEl.innerHTML = `
                    <div class="global-search-item-left">
                        <div class="global-search-icon-box">
                            <i class="bi ${escapeHtml(iconClass)}"></i>
                        </div>
                        <div class="global-search-item-info">
                            <div class="global-search-item-title">${highlightMatch(item.title, query)}</div>
                            ${item.subtitle ? `<div class="global-search-item-subtitle">${highlightMatch(item.subtitle, query)}</div>` : ''}
                        </div>
                    </div>
                    <i class="bi bi-arrow-right-short text-muted opacity-50 fs-5"></i>
                `;

                // Item click navigation
                itemEl.addEventListener('click', (e) => {
                    e.preventDefault();
                    window.location.href = item.url;
                });

                groupEl.appendChild(itemEl);
                currentItems.push(itemEl);
                itemIndex++;
            });

            searchBody.appendChild(groupEl);
        });

        openDropdown();
    }

    // Render suggestions when query is empty but focused
    function renderInitialCommands() {
        searchBody.innerHTML = `
            <div class="p-3 text-muted">
                <div class="small fw-bold text-uppercase text-muted mb-2 px-2" style="font-size: 0.725rem; letter-spacing: 0.05em;">Quick Shortcuts</div>
                <div class="list-group list-group-flush">
                    <a href="/documents/new?type=INVOICE" class="global-search-item text-decoration-none">
                        <div class="global-search-item-left">
                            <div class="global-search-icon-box"><i class="bi bi-plus-circle text-primary"></i></div>
                            <div class="global-search-item-info">
                                <div class="global-search-item-title">Create New Invoice</div>
                                <div class="global-search-item-subtitle">Draft and issue an invoice</div>
                            </div>
                        </div>
                    </a>
                    <a href="/documents/new?type=QUOTATION" class="global-search-item text-decoration-none">
                        <div class="global-search-item-left">
                            <div class="global-search-icon-box"><i class="bi bi-file-earmark-text text-info"></i></div>
                            <div class="global-search-item-info">
                                <div class="global-search-item-title">Create New Quotation</div>
                                <div class="global-search-item-subtitle">Draft a sales proposal</div>
                            </div>
                        </div>
                    </a>
                    <a href="/reports" class="global-search-item text-decoration-none">
                        <div class="global-search-item-left">
                            <div class="global-search-icon-box"><i class="bi bi-bar-chart-line text-success"></i></div>
                            <div class="global-search-item-info">
                                <div class="global-search-item-title">Financial Reports</div>
                                <div class="global-search-item-subtitle">Balance sheet, P&L, Ledger</div>
                            </div>
                        </div>
                    </a>
                    <a href="/settings" class="global-search-item text-decoration-none">
                        <div class="global-search-item-left">
                            <div class="global-search-icon-box"><i class="bi bi-gear text-secondary"></i></div>
                            <div class="global-search-item-info">
                                <div class="global-search-item-title">Organization Settings</div>
                                <div class="global-search-item-subtitle">GST, Bank, and Defaults</div>
                            </div>
                        </div>
                    </a>
                </div>
            </div>
        `;
        currentItems = Array.from(searchBody.querySelectorAll('.global-search-item'));
        currentItems.forEach((el, idx) => {
            el.dataset.index = idx;
            el.id = `search-opt-${idx}`;
            el.setAttribute('role', 'option');
        });
        activeItemIndex = -1;
        openDropdown();
    }

    // Execute search request
    async function performSearch(query) {
        const trimmed = (query || '').trim();
        if (trimmed.length < 2) {
            renderInitialCommands();
            return;
        }

        if (abortController) {
            abortController.abort();
        }
        abortController = new AbortController();

        setLoading(true);

        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
                signal: abortController.signal,
                headers: { 'Accept': 'application/json' }
            });

            if (!res.ok) {
                throw new Error(`Search request failed (${res.status})`);
            }

            const data = await res.json();
            setLoading(false);

            if (data && data.success) {
                renderResults(data.categories, trimmed);
            }
        } catch (err) {
            if (err.name === 'AbortError') return;
            setLoading(false);
            searchBody.innerHTML = `
                <div class="p-3 text-center text-danger">
                    <i class="bi bi-exclamation-triangle fs-4 d-block mb-1"></i>
                    <p class="mb-0 small fw-semibold">Failed to fetch search results</p>
                </div>
            `;
            openDropdown();
        }
    }

    // Set highlighted active item via arrow navigation
    function setActiveItem(newIndex) {
        if (currentItems.length === 0) return;

        if (activeItemIndex >= 0 && activeItemIndex < currentItems.length) {
            currentItems[activeItemIndex].classList.remove('active');
            currentItems[activeItemIndex].setAttribute('aria-selected', 'false');
        }

        if (newIndex < 0) {
            newIndex = currentItems.length - 1;
        } else if (newIndex >= currentItems.length) {
            newIndex = 0;
        }

        activeItemIndex = newIndex;
        const activeEl = currentItems[activeItemIndex];
        if (activeEl) {
            activeEl.classList.add('active');
            activeEl.setAttribute('aria-selected', 'true');
            searchInput.setAttribute('aria-activedescendant', activeEl.id);

            // Scroll into view if needed
            activeEl.scrollIntoView({ block: 'nearest' });
        }
    }

    // Keyboard navigation
    searchInput.addEventListener('keydown', (e) => {
        if (searchDropdown.classList.contains('d-none')) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                performSearch(searchInput.value);
                e.preventDefault();
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setActiveItem(activeItemIndex + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                setActiveItem(activeItemIndex - 1);
                break;
            case 'Enter':
                e.preventDefault();
                if (activeItemIndex >= 0 && activeItemIndex < currentItems.length) {
                    const activeEl = currentItems[activeItemIndex];
                    if (activeEl && activeEl.href) {
                        window.location.href = activeEl.href;
                    }
                }
                break;
            case 'Escape':
                e.preventDefault();
                closeDropdown();
                searchInput.blur();
                break;
            case 'Tab':
                closeDropdown();
                break;
        }
    });

    // Input typing with debounce
    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            performSearch(searchInput.value);
        }, 220);
    });

    // Focus triggers search/shortcuts
    searchInput.addEventListener('focus', () => {
        if (!searchInput.value.trim()) {
            renderInitialCommands();
        } else {
            performSearch(searchInput.value);
        }
    });

    if (searchBtn) {
        searchBtn.addEventListener('click', () => {
            searchInput.focus();
            if (!searchInput.value.trim()) {
                renderInitialCommands();
            } else {
                performSearch(searchInput.value);
            }
        });
    }

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!searchContainer.contains(e.target)) {
            closeDropdown();
        }
    });

    // Global keyboard shortcut: Ctrl+K or Cmd+K
    document.addEventListener('keydown', (e) => {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const isKShortcut = (isMac ? e.metaKey : e.ctrlKey) && (e.key === 'k' || e.key === 'K');

        if (isKShortcut) {
            // Do not trigger if typing inside another input/textarea
            const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
            if (activeTag === 'input' && document.activeElement !== searchInput) {
                return;
            }
            if (activeTag === 'textarea') {
                return;
            }

            e.preventDefault();
            searchInput.focus();
            searchInput.select();
            if (!searchInput.value.trim()) {
                renderInitialCommands();
            } else {
                performSearch(searchInput.value);
            }
        }
    });
})();
