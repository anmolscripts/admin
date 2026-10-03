/**
 * Spark Admin - Reusable Unified DataTable Engine
 * Vanilla ES6 JavaScript Component (Zero jQuery Dependency)
 * Provides: Search (debounced), Multi-column Sorting (data-aware), 
 * Pagination with intelligent windowing, Page-Size Selector, 
 * Empty/Loading states, and Full Responsive Mobile Support.
 */

(function (window, document) {
  'use strict';

  class SparkDataTable {
    constructor(target, options = {}) {
      this.table = typeof target === 'string' ? document.querySelector(target) : target;
      if (!this.table || this.table.tagName !== 'TABLE') {
        console.warn('[SparkDataTable] Target is not a valid <table> element:', target);
        return;
      }

      // Avoid double initialization
      if (this.table._sparkDataTable) {
        return this.table._sparkDataTable;
      }

      this.options = Object.assign({
        id: this.table.id || 'dt_' + Math.random().toString(36).substring(2, 9),
        title: this.table.getAttribute('data-title') || '',
        searchable: true,
        sortable: true,
        paginated: true,
        defaultPageSize: 10,
        pageSizes: [10, 25, 50, 100],
        persistPageSize: true,
        emptyText: 'No records found',
        noMatchText: 'No matching records found',
        placeholder: 'Search table...',
        columns: null // Array of { index, sortable, type: 'string'|'number'|'date' }
      }, options);

      // Restore saved page size if available
      const savedPageSize = this.options.persistPageSize ? localStorage.getItem('spark_dt_page_size') : null;
      this.pageSize = savedPageSize ? parseInt(savedPageSize, 10) : this.options.defaultPageSize;
      if (!this.options.pageSizes.includes(this.pageSize)) {
        this.pageSize = this.options.defaultPageSize;
      }

      this.currentPage = 1;
      this.sortColumn = -1;
      this.sortDirection = 'none'; // 'none', 'asc', 'desc'
      this.searchQuery = '';
      this.debounceTimer = null;

      this.tbody = this.table.querySelector('tbody');
      this.thead = this.table.querySelector('thead');
      this.originalRows = [];
      this.filteredRows = [];

      this.init();
      this.table._sparkDataTable = this;
    }

    init() {
      // 1. Extract rows data
      this.extractData();

      // 2. Build DOM layout wrapper
      this.buildLayout();

      // 3. Initialize header sorting
      if (this.options.sortable && this.thead) {
        this.initSorting();
      }

      // 4. Perform initial render
      this.applyFilterAndSort();
    }

    extractData() {
      if (!this.tbody) return;
      const allRows = Array.from(this.tbody.querySelectorAll('tr'));
      // Filter out any server-rendered empty state or colspan placeholder rows
      const rowElements = allRows.filter(tr => {
        const firstTd = tr.querySelector('td');
        if (firstTd && firstTd.hasAttribute('colspan')) {
          return false;
        }
        return true;
      });
      
      this.originalRows = rowElements.map((tr, originalIndex) => {
        const cells = Array.from(tr.children);
        const cellValues = cells.map(td => {
          // Check data-sort or data-value first
          const rawSort = td.getAttribute('data-sort') || td.getAttribute('data-value');
          if (rawSort !== null) return rawSort.trim();
          return td.textContent.trim();
        });

        // Search text contains all text inside row
        const fullSearchText = tr.textContent.toLowerCase().replace(/\s+/g, ' ');

        return {
          element: tr,
          originalIndex,
          values: cellValues,
          searchText: fullSearchText
        };
      });

      this.filteredRows = [...this.originalRows];
    }

    buildLayout() {
      const parent = this.table.parentNode;
      this.wrapper = document.createElement('div');
      this.wrapper.className = 'spark-dt-card';
      this.wrapper.id = `${this.options.id}_wrapper`;

      // Top Toolbar
      this.toolbar = document.createElement('div');
      this.toolbar.className = 'spark-dt-toolbar';

      // Toolbar Left: Title / Counter
      const toolbarLeft = document.createElement('div');
      toolbarLeft.className = 'spark-dt-toolbar-left';
      if (this.options.title) {
        const titleEl = document.createElement('h6');
        titleEl.className = 'spark-dt-title';
        titleEl.innerHTML = `<i class="bi bi-table"></i> ${this.options.title}`;
        toolbarLeft.appendChild(titleEl);
      }
      this.countBadge = document.createElement('span');
      this.countBadge.className = 'spark-dt-count-badge';
      this.countBadge.textContent = `${this.originalRows.length} Total`;
      toolbarLeft.appendChild(this.countBadge);
      this.toolbar.appendChild(toolbarLeft);

      // Toolbar Right: Search + Page size
      const toolbarRight = document.createElement('div');
      toolbarRight.className = 'spark-dt-toolbar-right';

      if (this.options.searchable) {
        const searchWrap = document.createElement('div');
        searchWrap.className = 'spark-dt-search-wrapper';
        searchWrap.innerHTML = `
          <i class="bi bi-search spark-dt-search-icon" aria-hidden="true"></i>
          <input type="search" class="spark-dt-search-input" placeholder="${this.options.placeholder}" aria-label="Search records">
          <button type="button" class="spark-dt-search-clear d-none" aria-label="Clear search">
            <i class="bi bi-x-circle-fill"></i>
          </button>
        `;
        this.searchInput = searchWrap.querySelector('.spark-dt-search-input');
        this.searchClear = searchWrap.querySelector('.spark-dt-search-clear');

        this.searchInput.addEventListener('input', (e) => {
          clearTimeout(this.debounceTimer);
          const val = e.target.value.trim();
          this.searchClear.classList.toggle('d-none', !val);
          this.debounceTimer = setTimeout(() => {
            this.searchQuery = val.toLowerCase();
            this.currentPage = 1;
            this.applyFilterAndSort();
          }, 200);
        });

        this.searchClear.addEventListener('click', () => {
          this.searchInput.value = '';
          this.searchQuery = '';
          this.searchClear.classList.add('d-none');
          this.currentPage = 1;
          this.applyFilterAndSort();
          this.searchInput.focus();
        });

        toolbarRight.appendChild(searchWrap);
      }

      if (this.options.paginated) {
        const sizeWrap = document.createElement('div');
        sizeWrap.className = 'spark-dt-size-wrapper';
        sizeWrap.innerHTML = `
          <span>Show</span>
          <select class="spark-dt-size-select" aria-label="Select page size">
            ${this.options.pageSizes.map(s => `<option value="${s}" ${s === this.pageSize ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        `;
        this.sizeSelect = sizeWrap.querySelector('.spark-dt-size-select');
        this.sizeSelect.addEventListener('change', (e) => {
          this.pageSize = parseInt(e.target.value, 10);
          if (this.options.persistPageSize) {
            localStorage.setItem('spark_dt_page_size', this.pageSize);
          }
          this.currentPage = 1;
          this.render();
        });
        toolbarRight.appendChild(sizeWrap);
      }

      this.toolbar.appendChild(toolbarRight);
      this.wrapper.appendChild(this.toolbar);

      // Responsive Table Wrapper
      this.responsiveContainer = document.createElement('div');
      this.responsiveContainer.className = 'spark-dt-responsive';

      // If parent is a .table-responsive wrapper, replace it cleanly to avoid nested scrollbars
      let insertParent = parent;
      let insertBeforeNode = this.table;
      let removeOldContainer = null;
      if (parent && parent.classList.contains('table-responsive')) {
        insertParent = parent.parentNode;
        insertBeforeNode = parent;
        removeOldContainer = parent;
      }

      insertParent.insertBefore(this.wrapper, insertBeforeNode);
      this.responsiveContainer.appendChild(this.table);
      this.wrapper.appendChild(this.responsiveContainer);

      if (removeOldContainer) {
        removeOldContainer.remove();
      }

      // Add base styling class to table
      this.table.classList.add('spark-dt-table');

      // Empty State Box (hidden by default)
      this.emptyStateEl = document.createElement('div');
      this.emptyStateEl.className = 'spark-dt-empty-state d-none';
      this.emptyStateEl.innerHTML = `
        <div class="spark-dt-empty-icon"><i class="bi bi-inbox"></i></div>
        <div class="spark-dt-empty-title">${this.options.emptyText}</div>
        <div class="spark-dt-empty-desc">${this.options.noMatchText}</div>
        <button type="button" class="btn btn-sm btn-outline-secondary btn-clear-dt-search d-none">
          <i class="bi bi-x-circle me-1"></i> Clear Search
        </button>
      `;
      this.emptyClearBtn = this.emptyStateEl.querySelector('.btn-clear-dt-search');
      this.emptyClearBtn.addEventListener('click', () => {
        if (this.searchInput) {
          this.searchInput.value = '';
          this.searchQuery = '';
          this.searchClear.classList.add('d-none');
          this.currentPage = 1;
          this.applyFilterAndSort();
        }
      });
      this.wrapper.appendChild(this.emptyStateEl);

      // Bottom Footer Bar
      this.footer = document.createElement('div');
      this.footer.className = 'spark-dt-footer';
      this.footer.innerHTML = `
        <div class="spark-dt-info" aria-live="polite">Showing 0 to 0 of 0 entries</div>
        <nav class="spark-dt-pagination-nav" aria-label="Table pagination">
          <ul class="spark-dt-pagination"></ul>
        </nav>
      `;
      this.infoEl = this.footer.querySelector('.spark-dt-info');
      this.paginationList = this.footer.querySelector('.spark-dt-pagination');
      this.wrapper.appendChild(this.footer);
    }

    initSorting() {
      const headerRow = this.thead.querySelector('tr');
      if (!headerRow) return;

      const ths = Array.from(headerRow.querySelectorAll('th'));
      ths.forEach((th, index) => {
        // Determine if column is sortable
        let isSortable = true;
        if (this.options.columns && this.options.columns[index] && this.options.columns[index].sortable === false) {
          isSortable = false;
        } else if (th.getAttribute('data-sortable') === 'false' || th.classList.contains('no-sort') || th.textContent.trim() === '#' || th.textContent.toLowerCase().includes('action')) {
          isSortable = false;
        }

        if (isSortable) {
          th.classList.add('sortable');
          th.setAttribute('tabindex', '0');
          th.setAttribute('role', 'columnheader');
          th.setAttribute('aria-sort', 'none');
          th.setAttribute('title', `Sort by ${th.textContent.trim()}`);

          const indicator = document.createElement('span');
          indicator.className = 'spark-dt-sort-indicator';
          indicator.innerHTML = '<i class="bi bi-arrow-down-up" aria-hidden="true"></i>';
          th.appendChild(indicator);

          const triggerSort = () => this.handleHeaderClick(index, th);
          th.addEventListener('click', triggerSort);
          th.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              triggerSort();
            }
          });
        }
      });
    }

    handleHeaderClick(columnIndex, thElement) {
      if (this.sortColumn === columnIndex) {
        if (this.sortDirection === 'asc') {
          this.sortDirection = 'desc';
        } else if (this.sortDirection === 'desc') {
          this.sortDirection = 'none';
          this.sortColumn = -1;
        } else {
          this.sortDirection = 'asc';
        }
      } else {
        this.sortColumn = columnIndex;
        this.sortDirection = 'asc';
      }

      // Update all header indicators
      const ths = Array.from(this.thead.querySelectorAll('th'));
      ths.forEach((th, idx) => {
        const ind = th.querySelector('.spark-dt-sort-indicator');
        if (!ind) return;

        if (idx === this.sortColumn) {
          if (this.sortDirection === 'asc') {
            th.setAttribute('aria-sort', 'ascending');
            ind.innerHTML = '<i class="bi bi-arrow-up" aria-hidden="true"></i>';
          } else if (this.sortDirection === 'desc') {
            th.setAttribute('aria-sort', 'descending');
            ind.innerHTML = '<i class="bi bi-arrow-down" aria-hidden="true"></i>';
          } else {
            th.setAttribute('aria-sort', 'none');
            ind.innerHTML = '<i class="bi bi-arrow-down-up" aria-hidden="true"></i>';
          }
        } else {
          th.setAttribute('aria-sort', 'none');
          ind.innerHTML = '<i class="bi bi-arrow-down-up" aria-hidden="true"></i>';
        }
      });

      this.currentPage = 1;
      this.applyFilterAndSort();
    }

    applyFilterAndSort() {
      // 1. Filter
      if (this.searchQuery) {
        this.filteredRows = this.originalRows.filter(row => row.searchText.includes(this.searchQuery));
      } else {
        this.filteredRows = [...this.originalRows];
      }

      // 2. Sort
      if (this.sortColumn >= 0 && this.sortDirection !== 'none') {
        const colIdx = this.sortColumn;
        const dirMult = this.sortDirection === 'asc' ? 1 : -1;

        this.filteredRows.sort((a, b) => {
          let valA = a.values[colIdx] || '';
          let valB = b.values[colIdx] || '';

          // Clean currency symbols or commas for numeric comparisons
          const numA = parseFloat(valA.replace(/[₹$,]/g, '').trim());
          const numB = parseFloat(valB.replace(/[₹$,]/g, '').trim());

          if (!isNaN(numA) && !isNaN(numB) && !isNaN(valA) && !isNaN(valB)) {
            return (numA - numB) * dirMult;
          }

          // Date check
          const dateA = Date.parse(valA);
          const dateB = Date.parse(valB);
          if (!isNaN(dateA) && !isNaN(dateB) && isNaN(valA) && isNaN(valB) && valA.length > 5) {
            return (dateA - dateB) * dirMult;
          }

          // String comparison
          return valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' }) * dirMult;
        });
      } else if (this.sortDirection === 'none') {
        // Restore original order
        this.filteredRows.sort((a, b) => a.originalIndex - b.originalIndex);
      }

      this.render();
    }

    render() {
      const total = this.filteredRows.length;
      const totalPages = Math.ceil(total / this.pageSize) || 1;
      if (this.currentPage > totalPages) this.currentPage = totalPages;
      if (this.currentPage < 1) this.currentPage = 1;

      // Update badge
      if (this.countBadge) {
        this.countBadge.textContent = this.searchQuery
          ? `${total} of ${this.originalRows.length}`
          : `${this.originalRows.length} Total`;
      }

      // Check empty state
      if (total === 0) {
        this.table.classList.add('d-none');
        this.emptyStateEl.classList.remove('d-none');
        if (this.searchQuery) {
          this.emptyStateEl.querySelector('.spark-dt-empty-title').textContent = this.options.noMatchText;
          this.emptyStateEl.querySelector('.spark-dt-empty-desc').textContent = `No records matching "${this.searchQuery}" were found. Try a different term or clear your search.`;
          this.emptyClearBtn.classList.remove('d-none');
        } else {
          this.emptyStateEl.querySelector('.spark-dt-empty-title').textContent = this.options.emptyText;
          this.emptyStateEl.querySelector('.spark-dt-empty-desc').textContent = 'There are no entries currently in this table.';
          this.emptyClearBtn.classList.add('d-none');
        }
        this.infoEl.textContent = 'Showing 0 to 0 of 0 entries';
        this.paginationList.innerHTML = '';
        return;
      }

      this.table.classList.remove('d-none');
      this.emptyStateEl.classList.add('d-none');

      // Slice rows for current page
      const startIndex = (this.currentPage - 1) * this.pageSize;
      const endIndex = Math.min(startIndex + this.pageSize, total);
      const pageRows = this.filteredRows.slice(startIndex, endIndex);

      // Re-append page rows in order into tbody
      const fragment = document.createDocumentFragment();
      pageRows.forEach(row => {
        fragment.appendChild(row.element);
      });
      this.tbody.innerHTML = '';
      this.tbody.appendChild(fragment);

      // Update info text
      this.infoEl.textContent = `Showing ${startIndex + 1}–${endIndex} of ${total} entries`;

      // Build Pagination Controls
      this.buildPagination(totalPages);
    }

    buildPagination(totalPages) {
      this.paginationList.innerHTML = '';
      if (totalPages <= 1) return;

      const createBtn = (html, page, isDisabled = false, isActive = false, ariaLabel = '') => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `spark-dt-page-btn ${isActive ? 'active' : ''}`;
        btn.innerHTML = html;
        if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
        if (isActive) btn.setAttribute('aria-current', 'page');
        if (isDisabled) {
          btn.disabled = true;
          btn.setAttribute('aria-disabled', 'true');
        } else {
          btn.addEventListener('click', () => {
            this.currentPage = page;
            this.render();
            // Scroll table into view smoothly if scrolled down
            this.wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        }
        li.appendChild(btn);
        return li;
      };

      // 1. First Page Button
      this.paginationList.appendChild(
        createBtn('<i class="bi bi-chevron-double-left"></i>', 1, this.currentPage === 1, false, 'First page')
      );

      // 2. Previous Page Button
      this.paginationList.appendChild(
        createBtn('<i class="bi bi-chevron-left"></i>', this.currentPage - 1, this.currentPage === 1, false, 'Previous page')
      );

      // 3. Intelligent Window of Page Numbers
      const windowSize = 2; // Show current +- 2
      let startPage = Math.max(1, this.currentPage - windowSize);
      let endPage = Math.min(totalPages, this.currentPage + windowSize);

      if (startPage > 1) {
        this.paginationList.appendChild(createBtn('1', 1, false, this.currentPage === 1));
        if (startPage > 2) {
          const ellipsisLi = document.createElement('li');
          ellipsisLi.className = 'spark-dt-ellipsis-page';
          ellipsisLi.textContent = '…';
          this.paginationList.appendChild(ellipsisLi);
        }
      }

      for (let p = startPage; p <= endPage; p++) {
        this.paginationList.appendChild(createBtn(String(p), p, false, this.currentPage === p));
      }

      if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
          const ellipsisLi = document.createElement('li');
          ellipsisLi.className = 'spark-dt-ellipsis-page';
          ellipsisLi.textContent = '…';
          this.paginationList.appendChild(ellipsisLi);
        }
        this.paginationList.appendChild(createBtn(String(totalPages), totalPages, false, this.currentPage === totalPages));
      }

      // 4. Next Page Button
      this.paginationList.appendChild(
        createBtn('<i class="bi bi-chevron-right"></i>', this.currentPage + 1, this.currentPage === totalPages, false, 'Next page')
      );

      // 5. Last Page Button
      this.paginationList.appendChild(
        createBtn('<i class="bi bi-chevron-double-right"></i>', totalPages, this.currentPage === totalPages, false, 'Last page')
      );
    }

    /**
     * Re-read table if rows were dynamically inserted via AJAX or modals
     */
    refresh() {
      this.extractData();
      this.applyFilterAndSort();
    }
  }

  // Static Factory Helper
  SparkDataTable.init = function (target, options) {
    if (typeof target === 'string') {
      const elements = document.querySelectorAll(target);
      if (elements.length === 1) return new SparkDataTable(elements[0], options);
      return Array.from(elements).map(el => new SparkDataTable(el, options));
    }
    return new SparkDataTable(target, options);
  };

  // Auto-init for tables decorated with data-spark-datatable
  SparkDataTable.autoInit = function () {
    document.querySelectorAll('table[data-spark-datatable]').forEach(table => {
      if (!table._sparkDataTable) {
        SparkDataTable.init(table);
      }
    });
  };

  window.SparkDataTable = SparkDataTable;

  // Auto-run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', SparkDataTable.autoInit);
  } else {
    SparkDataTable.autoInit();
  }
})(window, document);
