/**
 * SPARK ADMIN - Unified Date Range Picker Component
 * Uses Flatpickr to provide a consistent, premium date range selector
 * across all dashboard, document, report, and activity pages.
 */
(function () {
  'use strict';

  function formatDateDisplay(d) {
    if (!d) return '';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function formatISODate(d) {
    if (!d) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseISODate(str) {
    if (!str) return null;
    const parts = str.split('T')[0].split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
        return new Date(year, month, day);
      }
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  function initPicker(container) {
    if (!container || container._sparkDateRangeInit) return;
    container._sparkDateRangeInit = true;

    const triggerBtn = container.querySelector('.btn-date-picker') || container.querySelector('button');
    if (!triggerBtn) return;

    const labelEl = container.querySelector('.spark-daterange-label') || triggerBtn.querySelector('span');
    const clearBtn = container.querySelector('.btn-daterange-clear') || container.querySelector('.spark-daterange-clear');

    const fromInputName = container.dataset.fromName || 'fromDate';
    const toInputName = container.dataset.toName || 'toDate';
    const autoSubmit = container.dataset.autoSubmit === 'true';
    const defaultPlaceholder = container.dataset.placeholder || 'All Dates';

    // Find inputs within container or by ID
    let fromInput = container.querySelector(`input[name="${fromInputName}"]`) ||
                    container.querySelector('input[name="fromDate"]') ||
                    container.querySelector('input[name="dateFrom"]') ||
                    container.querySelector('#filter-date-from') ||
                    container.querySelector('#custom-date-from');

    let toInput = container.querySelector(`input[name="${toInputName}"]`) ||
                  container.querySelector('input[name="toDate"]') ||
                  container.querySelector('input[name="dateTo"]') ||
                  container.querySelector('#filter-date-to') ||
                  container.querySelector('#custom-date-to');

    function updateDisplay(startDate, endDate) {
      if (startDate && endDate) {
        const text = `${formatDateDisplay(startDate)} – ${formatDateDisplay(endDate)}`;
        if (labelEl) labelEl.textContent = text;
        triggerBtn.classList.add('is-active');
        if (clearBtn) clearBtn.classList.remove('d-none');
      } else if (startDate) {
        const text = `From ${formatDateDisplay(startDate)}`;
        if (labelEl) labelEl.textContent = text;
        triggerBtn.classList.add('is-active');
        if (clearBtn) clearBtn.classList.remove('d-none');
      } else {
        if (labelEl) labelEl.textContent = defaultPlaceholder;
        triggerBtn.classList.remove('is-active');
        if (clearBtn) clearBtn.classList.add('d-none');
      }
    }

    // Determine initial dates from inputs
    let initialDates = [];
    if (fromInput && fromInput.value) {
      const d1 = parseISODate(fromInput.value);
      if (d1) initialDates.push(d1);
    }
    if (toInput && toInput.value) {
      const d2 = parseISODate(toInput.value);
      if (d2) initialDates.push(d2);
    }

    if (initialDates.length > 0) {
      updateDisplay(initialDates[0], initialDates[1]);
    } else {
      updateDisplay(null, null);
    }

    if (typeof flatpickr !== 'function') {
      console.warn('Flatpickr is not loaded; skipping date range picker setup.');
      return;
    }

    const fp = flatpickr(triggerBtn, {
      mode: 'range',
      dateFormat: 'Y-m-d',
      defaultDate: initialDates.length === 2 ? initialDates : undefined,
      showMonths: window.innerWidth < 768 ? 1 : 2,
      onClose: function (selectedDates) {
        if (selectedDates.length === 2) {
          const fromStr = formatISODate(selectedDates[0]);
          const toStr = formatISODate(selectedDates[1]);
          if (fromInput) {
            fromInput.value = fromStr;
            fromInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (toInput) {
            toInput.value = toStr;
            toInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          updateDisplay(selectedDates[0], selectedDates[1]);
          if (autoSubmit) {
            const form = container.closest('form');
            if (form) form.submit();
          }
        } else if (selectedDates.length === 1) {
          const fromStr = formatISODate(selectedDates[0]);
          if (fromInput) {
            fromInput.value = fromStr;
            fromInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (toInput) {
            toInput.value = fromStr;
            toInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          updateDisplay(selectedDates[0], selectedDates[0]);
          if (autoSubmit) {
            const form = container.closest('form');
            if (form) form.submit();
          }
        }
      }
    });

    function handleClear(e) {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      fp.clear();
      if (fromInput) {
        fromInput.value = '';
        fromInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (toInput) {
        toInput.value = '';
        toInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      updateDisplay(null, null);
      if (autoSubmit) {
        const form = container.closest('form');
        if (form) form.submit();
      }
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', handleClear);
    }

    container._sparkDateRangePicker = {
      fp: fp,
      clear: handleClear,
      update: updateDisplay
    };
  }

  function initAll() {
    document.querySelectorAll('.spark-daterange-picker, [data-spark-daterange]').forEach(initPicker);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  window.SparkDateRange = {
    init: initPicker,
    initAll: initAll,
    formatDateDisplay: formatDateDisplay,
    formatISODate: formatISODate
  };
})();

