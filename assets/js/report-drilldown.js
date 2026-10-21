/**
 * SPARK ADMIN — UNIVERSAL REPORT TRANSACTION DRILLDOWN MODAL
 * Enables row-click detailed inspection and CSV export for any report transaction
 * (Invoices, Quotations, Credit/Debit Notes, Journal Entries, Bills, Orders).
 */

(function () {
  'use strict';

  let modalEl = null;
  let bsModal = null;
  let currentModalData = null;

  function escapeHtml(value) {
    const text = document.createElement('span');
    text.textContent = value == null ? '' : String(value);
    return text.innerHTML;
  }

  function formatMoney(amount) {
    const num = Number(amount);
    if (isNaN(num)) return '₹0.00';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(num);
  }

  function formatDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  function ensureModal() {
    if (modalEl) return;
    modalEl = document.getElementById('reportDetailModal');
    if (modalEl) {
      bsModal = window.bootstrap ? window.bootstrap.Modal.getOrCreateInstance(modalEl) : null;
      return;
    }

    const modalHtml = `
      <div class="modal fade" id="reportDetailModal" tabindex="-1" aria-labelledby="reportDetailModalLabel" aria-hidden="true">
        <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
          <div class="modal-content report-drilldown-modal-content shadow-lg border-0">
            <div class="modal-header report-drilldown-header border-bottom py-3 px-4 d-flex align-items-center justify-content-between">
              <div class="d-flex align-items-center gap-2 flex-wrap">
                <span class="badge bg-primary-subtle text-primary border border-primary-subtle px-2 py-1 font-monospace" id="reportModalTypeBadge">DOCUMENT</span>
                <h5 class="modal-title fw-bold font-monospace mb-0" id="reportDetailModalLabel">Loading...</h5>
                <span class="badge" id="reportModalStatusBadge"></span>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body p-4 report-drilldown-body" id="reportModalBody" style="max-height: calc(85vh - 130px); overflow-y: auto;">
              <div class="text-center py-5">
                <div class="spinner-border text-primary" role="status"></div>
                <div class="mt-2 text-muted small">Loading document details...</div>
              </div>
            </div>
            <div class="modal-footer report-drilldown-footer border-top py-2 px-4 d-flex justify-content-between align-items-center">
              <div class="d-flex gap-2">
                <button type="button" class="btn btn-sm btn-outline-success d-inline-flex align-items-center gap-1 rounded-pill px-3" id="reportModalExportBtn">
                  <i class="bi bi-file-earmark-spreadsheet"></i>
                  <span>Export CSV</span>
                </button>
                <button type="button" class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 rounded-pill px-3" id="reportModalPrintBtn">
                  <i class="bi bi-printer"></i>
                  <span>Print</span>
                </button>
              </div>
              <div class="d-flex gap-2">
                <a href="#" class="btn btn-sm btn-primary d-inline-flex align-items-center gap-1 rounded-pill px-3" id="reportModalOpenFullBtn" target="_blank">
                  <span>Open Full Record</span>
                  <i class="bi bi-arrow-up-right"></i>
                </a>
                <button type="button" class="btn btn-sm btn-secondary rounded-pill px-3" data-bs-dismiss="modal">Close</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    modalEl = document.getElementById('reportDetailModal');
    bsModal = window.bootstrap ? window.bootstrap.Modal.getOrCreateInstance(modalEl) : null;

    // Attach actions
    const exportBtn = document.getElementById('reportModalExportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', handleExportCsv);
    }
    const printBtn = document.getElementById('reportModalPrintBtn');
    if (printBtn) {
      printBtn.addEventListener('click', function () {
        window.print();
      });
    }
  }

  function handleExportCsv() {
    if (!currentModalData) return;
    const { title, rows, headers, summary } = currentModalData;

    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '""';
      const s = String(str).replace(/"/g, '""');
      return `"${s}"`;
    };

    const lines = [];
    lines.push(`"${title.replace(/"/g, '""')}"`);
    lines.push(`"Exported: ${new Date().toLocaleString('en-IN')}"`);
    if (summary) {
      Object.entries(summary).forEach(([k, v]) => {
        lines.push(`"${k}: ${String(v).replace(/"/g, '""')}"`);
      });
    }
    lines.push('');
    lines.push(headers.map(escapeCsv).join(','));

    rows.forEach((r) => {
      lines.push(r.map(escapeCsv).join(','));
    });

    const csvContent = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_details_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function openDrilldown(row) {
    ensureModal();
    if (!bsModal) return;

    const sourceType = (row.dataset.sourceType || '').trim().toUpperCase();
    const sourceId = (row.dataset.sourceId || '').trim();
    const journalId = (row.dataset.journalId || '').trim();
    const sourceRef = (row.dataset.sourceRef || '').trim();

    const titleEl = document.getElementById('reportDetailModalLabel');
    const typeBadge = document.getElementById('reportModalTypeBadge');
    const statusBadge = document.getElementById('reportModalStatusBadge');
    const bodyEl = document.getElementById('reportModalBody');
    const fullBtn = document.getElementById('reportModalOpenFullBtn');

    titleEl.textContent = sourceRef || 'Transaction Detail';
    typeBadge.textContent = sourceType || 'TRANSACTION';
    statusBadge.className = 'badge bg-secondary-subtle text-secondary';
    statusBadge.textContent = 'INSPECTING';
    bodyEl.innerHTML = `
      <div class="text-center py-5">
        <div class="spinner-border text-primary" role="status"></div>
        <div class="mt-2 text-muted small">Loading authoritative document data...</div>
      </div>
    `;

    bsModal.show();

    // 1. Invoices & Quotations
    if ((sourceType === 'INVOICE' || sourceType === 'QUOTATION' || sourceType === 'INVOICES') && sourceId) {
      try {
        const res = await fetch(`/api/invoices/${encodeURIComponent(sourceId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const doc = json.data || json;

        renderInvoiceDetail(doc);
        fullBtn.href = `/documents/${encodeURIComponent(doc.id)}`;
        fullBtn.classList.remove('d-none');
        return;
      } catch (err) {
        console.warn('[DRILLDOWN] Invoice fetch error, falling back to journal:', err);
      }
    }

    // 2. Credit & Debit Notes
    if ((sourceType === 'CREDIT_NOTE' || sourceType === 'DEBIT_NOTE' || sourceType === 'CREDIT' || sourceType === 'DEBIT' || sourceType === 'NOTE') && sourceId) {
      try {
        const res = await fetch(`/api/credit-debit-notes/${encodeURIComponent(sourceId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const note = json.data || json;

        renderNoteDetail(note);
        fullBtn.href = `/credit-debit-notes/${encodeURIComponent(note.id)}`;
        fullBtn.classList.remove('d-none');
        return;
      } catch (err) {
        console.warn('[DRILLDOWN] Note fetch error:', err);
      }
    }

    // 3. Journal Entry / Ledger Posting
    if (journalId || sourceType === 'JOURNAL' || sourceType === 'MANUAL') {
      const targetJId = journalId || sourceId;
      try {
        const res = await fetch(`/api/journals/${encodeURIComponent(targetJId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const journal = json.data || json;

        renderJournalDetail(journal);
        fullBtn.href = `/reports/journals/${encodeURIComponent(journal.id)}`;
        fullBtn.classList.remove('d-none');
        return;
      } catch (err) {
        console.warn('[DRILLDOWN] Journal fetch error:', err);
      }
    }

    // 4. Supplier Bill
    if ((sourceType === 'BILL' || sourceType === 'SUPPLIER_BILL') && sourceId) {
      try {
        const res = await fetch(`/api/supplier-bills/${encodeURIComponent(sourceId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const bill = json.data || json;

        renderBillDetail(bill);
        fullBtn.href = `/purchases/bills`;
        fullBtn.classList.remove('d-none');
        return;
      } catch (err) {
        console.warn('[DRILLDOWN] Bill fetch error:', err);
      }
    }

    // 5. Purchase Order
    if ((sourceType === 'PURCHASE_ORDER' || sourceType === 'ORDER') && sourceId) {
      try {
        const res = await fetch(`/api/purchase-orders/${encodeURIComponent(sourceId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const po = json.data || json;

        renderPoDetail(po);
        fullBtn.href = `/purchases/orders`;
        fullBtn.classList.remove('d-none');
        return;
      } catch (err) {
        console.warn('[DRILLDOWN] PO fetch error:', err);
      }
    }

    // Fallback: Generic Transaction Overview
    renderGenericDetail({
      sourceType,
      sourceId,
      journalId,
      sourceRef
    });
    fullBtn.classList.add('d-none');
  }

  function renderInvoiceDetail(doc) {
    const titleEl = document.getElementById('reportDetailModalLabel');
    const typeBadge = document.getElementById('reportModalTypeBadge');
    const statusBadge = document.getElementById('reportModalStatusBadge');
    const bodyEl = document.getElementById('reportModalBody');

    titleEl.textContent = doc.invoiceNumber;
    typeBadge.textContent = doc.documentType;
    typeBadge.className = doc.documentType === 'QUOTATION'
      ? 'badge bg-warning-subtle text-warning border border-warning-subtle px-2 py-1 font-monospace'
      : 'badge bg-primary-subtle text-primary border border-primary-subtle px-2 py-1 font-monospace';

    statusBadge.textContent = doc.status;
    statusBadge.className = doc.status === 'ACTIVE'
      ? 'badge bg-success-subtle text-success border border-success-subtle'
      : (doc.status === 'VOID' ? 'badge bg-danger-subtle text-danger border border-danger-subtle' : 'badge bg-secondary-subtle text-secondary');

    const items = doc.items || [];
    let itemsRows = '';
    const exportRows = [];

    items.forEach((item, idx) => {
      itemsRows += `
        <tr>
          <td class="text-muted font-monospace small">${escapeHtml(item.lineNumber || (idx + 1))}</td>
          <td class="fw-medium report-drilldown-val">${escapeHtml(item.name)}</td>
          <td class="font-monospace small text-muted">${escapeHtml(item.hsnSac || '—')}</td>
          <td class="text-end font-monospace">${Number(item.quantity).toFixed(2)}</td>
          <td><span class="badge bg-light border">${escapeHtml(item.unit || 'PCS')}</span></td>
          <td class="text-end font-monospace">${formatMoney(item.rate)}</td>
          <td class="text-end font-monospace fw-semibold">${formatMoney(item.amount)}</td>
        </tr>
      `;
      exportRows.push([
        item.lineNumber || (idx + 1),
        item.name,
        item.hsnSac || '',
        item.quantity,
        item.unit || 'PCS',
        item.rate,
        item.amount
      ]);
    });

    bodyEl.innerHTML = `
      <div class="row g-3 mb-4">
        <div class="col-sm-6 col-md-3">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Customer / Client</div>
          <div class="fw-bold report-drilldown-val fs-6">${escapeHtml(doc.clientName)}</div>
          ${doc.clientGSTIN ? `<div class="small font-monospace text-muted">GSTIN: ${escapeHtml(doc.clientGSTIN)}</div>` : ''}
        </div>
        <div class="col-sm-6 col-md-3">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Invoice Date</div>
          <div class="fw-semibold report-drilldown-val">${formatDate(doc.invoiceDate)}</div>
        </div>
        <div class="col-sm-6 col-md-3">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Due / Validity Date</div>
          <div class="fw-semibold report-drilldown-val">${formatDate(doc.dueDate || doc.validUntil)}</div>
        </div>
        <div class="col-sm-6 col-md-3">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">GST Registration</div>
          <div class="fw-semibold report-drilldown-val">${doc.gstEnabled ? `GST Registered (${Number(doc.gstRate).toFixed(2)}%)` : 'Non-GST'}</div>
        </div>
      </div>

      <div class="card border-0 shadow-sm mb-4 report-drilldown-surface">
        <div class="table-responsive">
          <table class="table align-middle mb-0">
            <thead class="report-drilldown-thead small text-uppercase">
              <tr>
                <th style="width: 40px;">#</th>
                <th>Item Description</th>
                <th style="width: 100px;">HSN/SAC</th>
                <th class="text-end" style="width: 90px;">Qty</th>
                <th style="width: 80px;">Unit</th>
                <th class="text-end" style="width: 120px;">Rate</th>
                <th class="text-end" style="width: 130px;">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRows || '<tr><td colspan="7" class="text-center py-3 text-muted">No line items.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="row g-3 justify-content-end">
        <div class="col-md-6 col-lg-5">
          <div class="p-3 rounded-3 report-drilldown-summary-box">
            <div class="d-flex justify-content-between py-1 small">
              <span class="text-muted">Subtotal (Taxable):</span>
              <span class="font-monospace fw-semibold">${formatMoney(doc.subtotal)}</span>
            </div>
            ${doc.gstEnabled ? `
              <div class="d-flex justify-content-between py-1 small">
                <span class="text-muted">GST Total (${Number(doc.gstRate).toFixed(2)}%):</span>
                <span class="font-monospace fw-semibold">${formatMoney(doc.gstAmount)}</span>
              </div>
            ` : ''}
            <div class="d-flex justify-content-between py-2 border-top mt-2">
              <span class="fw-bold">Grand Total:</span>
              <span class="font-monospace fw-bold fs-5 text-primary">${formatMoney(doc.grandTotal)}</span>
            </div>
            ${doc.documentType === 'INVOICE' ? `
              <div class="d-flex justify-content-between py-1 small border-top text-muted">
                <span>Paid Amount:</span>
                <span class="font-monospace text-success fw-semibold">${formatMoney(doc.paidAmount || 0)}</span>
              </div>
              <div class="d-flex justify-content-between py-1 small">
                <span class="fw-semibold">Outstanding Due:</span>
                <span class="font-monospace fw-bold ${Number(doc.outstandingAmount) > 0 ? 'text-danger' : 'text-success'}">
                  ${formatMoney(doc.outstandingAmount !== undefined ? doc.outstandingAmount : doc.grandTotal)}
                </span>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;

    currentModalData = {
      title: `${doc.documentType}_${doc.invoiceNumber}`,
      headers: ['Line #', 'Description', 'HSN/SAC', 'Quantity', 'Unit', 'Rate (INR)', 'Amount (INR)'],
      rows: exportRows,
      summary: {
        'Document Number': doc.invoiceNumber,
        'Client': doc.clientName,
        'Date': formatDate(doc.invoiceDate),
        'Subtotal': formatMoney(doc.subtotal),
        'GST Total': formatMoney(doc.gstAmount),
        'Grand Total': formatMoney(doc.grandTotal)
      }
    };
  }

  function renderNoteDetail(note) {
    const titleEl = document.getElementById('reportDetailModalLabel');
    const typeBadge = document.getElementById('reportModalTypeBadge');
    const statusBadge = document.getElementById('reportModalStatusBadge');
    const bodyEl = document.getElementById('reportModalBody');

    titleEl.textContent = note.noteNumber;
    typeBadge.textContent = `${note.noteType} NOTE`;
    typeBadge.className = note.noteType === 'CREDIT'
      ? 'badge bg-purple-subtle text-purple border border-purple-subtle px-2 py-1 font-monospace'
      : 'badge bg-info-subtle text-info border border-info-subtle px-2 py-1 font-monospace';

    statusBadge.textContent = note.status;
    statusBadge.className = note.status === 'ISSUED'
      ? 'badge bg-success-subtle text-success border border-success-subtle'
      : 'badge bg-secondary-subtle text-secondary';

    const items = note.items || [];
    let itemsRows = '';
    const exportRows = [];

    items.forEach((item, idx) => {
      itemsRows += `
        <tr>
          <td class="text-muted font-monospace small">${idx + 1}</td>
          <td class="fw-medium report-drilldown-val">${escapeHtml(item.name)}</td>
          <td class="font-monospace small text-muted">${escapeHtml(item.hsnSac || '—')}</td>
          <td class="text-end font-monospace">${Number(item.quantity).toFixed(2)}</td>
          <td class="text-end font-monospace">${formatMoney(item.rate)}</td>
          <td class="text-end font-monospace fw-semibold">${formatMoney(item.amount)}</td>
        </tr>
      `;
      exportRows.push([
        idx + 1,
        item.name,
        item.hsnSac || '',
        item.quantity,
        item.rate,
        item.amount
      ]);
    });

    bodyEl.innerHTML = `
      <div class="row g-3 mb-4">
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Customer / Client</div>
          <div class="fw-bold report-drilldown-val fs-6">${escapeHtml(note.client ? note.client.name : 'Client')}</div>
        </div>
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Referenced Sales Invoice</div>
          <div class="fw-bold font-monospace text-primary">${escapeHtml(note.originalInvoiceNumber || '—')}</div>
        </div>
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Issue Date</div>
          <div class="fw-semibold report-drilldown-val">${formatDate(note.noteDate)}</div>
        </div>
      </div>

      <div class="alert report-drilldown-callout border mb-4">
        <span class="fw-semibold text-muted small text-uppercase me-2">Reason for Adjustment:</span>
        <span class="report-drilldown-val">${escapeHtml(note.reason || 'Not specified')}</span>
      </div>

      <div class="card border-0 shadow-sm mb-4 report-drilldown-surface">
        <div class="table-responsive">
          <table class="table align-middle mb-0">
            <thead class="report-drilldown-thead small text-uppercase">
              <tr>
                <th style="width: 40px;">#</th>
                <th>Item Description</th>
                <th style="width: 100px;">HSN/SAC</th>
                <th class="text-end" style="width: 90px;">Qty</th>
                <th class="text-end" style="width: 120px;">Rate</th>
                <th class="text-end" style="width: 130px;">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRows || '<tr><td colspan="6" class="text-center py-3 text-muted">No items in note.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="row g-3 justify-content-end">
        <div class="col-md-6 col-lg-5">
          <div class="p-3 rounded-3 report-drilldown-summary-box">
            <div class="d-flex justify-content-between py-1 small">
              <span class="text-muted">Subtotal:</span>
              <span class="font-monospace fw-semibold">${formatMoney(note.subtotal)}</span>
            </div>
            <div class="d-flex justify-content-between py-1 small">
              <span class="text-muted">GST Adjustments:</span>
              <span class="font-monospace fw-semibold">${formatMoney(note.gstAmount)}</span>
            </div>
            <div class="d-flex justify-content-between py-2 border-top mt-2">
              <span class="fw-bold">Note Total:</span>
              <span class="font-monospace fw-bold fs-5 text-primary">${formatMoney(note.grandTotal)}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    currentModalData = {
      title: `${note.noteType}_NOTE_${note.noteNumber}`,
      headers: ['#', 'Description', 'HSN/SAC', 'Quantity', 'Rate (INR)', 'Amount (INR)'],
      rows: exportRows,
      summary: {
        'Note Number': note.noteNumber,
        'Type': note.noteType,
        'Referenced Invoice': note.originalInvoiceNumber,
        'Total Amount': formatMoney(note.grandTotal)
      }
    };
  }

  function renderJournalDetail(journal) {
    const titleEl = document.getElementById('reportDetailModalLabel');
    const typeBadge = document.getElementById('reportModalTypeBadge');
    const statusBadge = document.getElementById('reportModalStatusBadge');
    const bodyEl = document.getElementById('reportModalBody');

    titleEl.textContent = journal.entryNumber;
    typeBadge.textContent = 'JOURNAL ENTRY';
    typeBadge.className = 'badge bg-secondary-subtle text-secondary border border-secondary-subtle px-2 py-1 font-monospace';

    statusBadge.textContent = journal.status;
    statusBadge.className = journal.status === 'POSTED'
      ? 'badge bg-success-subtle text-success border border-success-subtle'
      : (journal.status === 'REVERSED' ? 'badge bg-danger-subtle text-danger border border-danger-subtle' : 'badge bg-light text-dark border');

    const lines = journal.lines || [];
    let linesRows = '';
    const exportRows = [];
    let totalDebit = 0;
    let totalCredit = 0;

    lines.forEach((line) => {
      const dr = Number(line.debit) || 0;
      const cr = Number(line.credit) || 0;
      totalDebit += dr;
      totalCredit += cr;

      const accCode = line.account ? line.account.code : '';
      const accName = line.account ? line.account.name : 'Account';
      const clientName = line.client ? line.client.name : '';

      linesRows += `
        <tr>
          <td class="font-monospace text-primary fw-bold small">${escapeHtml(accCode)}</td>
          <td>
            <div class="fw-semibold report-drilldown-val">${escapeHtml(accName)}</div>
            ${clientName ? `<div class="small text-muted"><i class="bi bi-person me-1"></i>${escapeHtml(clientName)}</div>` : ''}
            ${line.description ? `<div class="small text-muted fst-italic">${escapeHtml(line.description)}</div>` : ''}
          </td>
          <td class="text-end font-monospace ${dr > 0 ? 'text-primary fw-bold' : 'text-muted'}">${dr > 0 ? formatMoney(dr) : '—'}</td>
          <td class="text-end font-monospace ${cr > 0 ? 'text-success fw-bold' : 'text-muted'}">${cr > 0 ? formatMoney(cr) : '—'}</td>
        </tr>
      `;

      exportRows.push([
        accCode,
        accName,
        clientName,
        line.description || '',
        dr > 0 ? dr.toFixed(2) : '0.00',
        cr > 0 ? cr.toFixed(2) : '0.00'
      ]);
    });

    bodyEl.innerHTML = `
      <div class="row g-3 mb-4">
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Entry Date</div>
          <div class="fw-bold report-drilldown-val fs-6">${formatDate(journal.entryDate)}</div>
        </div>
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Source System</div>
          <div class="fw-semibold font-monospace">${escapeHtml(journal.sourceType || 'MANUAL')} ${journal.sourceId ? '#' + escapeHtml(journal.sourceId) : ''}</div>
        </div>
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Financial Year</div>
          <div class="fw-semibold font-monospace">${escapeHtml(journal.financialYear ? journal.financialYear.code : '—')}</div>
        </div>
      </div>

      <div class="alert report-drilldown-callout border mb-4">
        <span class="fw-semibold text-muted small text-uppercase me-2">Narration:</span>
        <span class="report-drilldown-val">${escapeHtml(journal.narration || 'No narration provided.')}</span>
      </div>

      <div class="card border-0 shadow-sm mb-4 report-drilldown-surface">
        <div class="table-responsive">
          <table class="table align-middle mb-0">
            <thead class="report-drilldown-thead small text-uppercase">
              <tr>
                <th style="width: 100px;">Account #</th>
                <th>Account Title & Particulars</th>
                <th class="text-end" style="width: 140px;">Debit (₹)</th>
                <th class="text-end" style="width: 140px;">Credit (₹)</th>
              </tr>
            </thead>
            <tbody>
              ${linesRows || '<tr><td colspan="4" class="text-center py-3 text-muted">No journal lines.</td></tr>'}
            </tbody>
            <tfoot class="report-drilldown-thead border-top fw-bold">
              <tr>
                <td colspan="2" class="text-end">Balanced Double-Entry Total:</td>
                <td class="text-end font-monospace text-primary">${formatMoney(totalDebit)}</td>
                <td class="text-end font-monospace text-success">${formatMoney(totalCredit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    `;

    currentModalData = {
      title: `JOURNAL_${journal.entryNumber}`,
      headers: ['Account Code', 'Account Name', 'Subledger Client', 'Description', 'Debit (INR)', 'Credit (INR)'],
      rows: exportRows,
      summary: {
        'Journal Number': journal.entryNumber,
        'Date': formatDate(journal.entryDate),
        'Total Debit': formatMoney(totalDebit),
        'Total Credit': formatMoney(totalCredit)
      }
    };
  }

  function renderBillDetail(bill) {
    const titleEl = document.getElementById('reportDetailModalLabel');
    const typeBadge = document.getElementById('reportModalTypeBadge');
    const statusBadge = document.getElementById('reportModalStatusBadge');
    const bodyEl = document.getElementById('reportModalBody');

    titleEl.textContent = bill.billNumber || `Bill #${bill.id}`;
    typeBadge.textContent = 'SUPPLIER BILL';
    typeBadge.className = 'badge bg-info-subtle text-info border border-info-subtle px-2 py-1 font-monospace';

    statusBadge.textContent = bill.status || 'ACTIVE';
    statusBadge.className = 'badge bg-success-subtle text-success border border-success-subtle';

    bodyEl.innerHTML = `
      <div class="row g-3 mb-4">
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Supplier</div>
          <div class="fw-bold report-drilldown-val fs-6">${escapeHtml(bill.supplier ? bill.supplier.name : 'Supplier')}</div>
        </div>
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Bill Date</div>
          <div class="fw-semibold report-drilldown-val">${formatDate(bill.billDate)}</div>
        </div>
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Grand Total</div>
          <div class="fw-bold font-monospace text-primary fs-5">${formatMoney(bill.grandTotal)}</div>
        </div>
      </div>
    `;

    currentModalData = {
      title: `BILL_${bill.billNumber || bill.id}`,
      headers: ['Bill #', 'Supplier', 'Date', 'Total'],
      rows: [[bill.billNumber, bill.supplier ? bill.supplier.name : '', formatDate(bill.billDate), bill.grandTotal]],
      summary: { Total: formatMoney(bill.grandTotal) }
    };
  }

  function renderPoDetail(po) {
    const titleEl = document.getElementById('reportDetailModalLabel');
    const typeBadge = document.getElementById('reportModalTypeBadge');
    const statusBadge = document.getElementById('reportModalStatusBadge');
    const bodyEl = document.getElementById('reportModalBody');

    titleEl.textContent = po.poNumber || `PO #${po.id}`;
    typeBadge.textContent = 'PURCHASE ORDER';
    typeBadge.className = 'badge bg-primary-subtle text-primary border border-primary-subtle px-2 py-1 font-monospace';

    statusBadge.textContent = po.status || 'ACTIVE';
    statusBadge.className = 'badge bg-success-subtle text-success border border-success-subtle';

    bodyEl.innerHTML = `
      <div class="row g-3 mb-4">
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Supplier</div>
          <div class="fw-bold report-drilldown-val fs-6">${escapeHtml(po.supplier ? po.supplier.name : 'Supplier')}</div>
        </div>
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Order Date</div>
          <div class="fw-semibold report-drilldown-val">${formatDate(po.orderDate)}</div>
        </div>
        <div class="col-sm-6 col-md-4">
          <div class="small text-muted text-uppercase fw-semibold" style="font-size: 0.72rem;">Grand Total</div>
          <div class="fw-bold font-monospace text-primary fs-5">${formatMoney(po.grandTotal)}</div>
        </div>
      </div>
    `;

    currentModalData = {
      title: `PO_${po.poNumber || po.id}`,
      headers: ['PO #', 'Supplier', 'Date', 'Total'],
      rows: [[po.poNumber, po.supplier ? po.supplier.name : '', formatDate(po.orderDate), po.grandTotal]],
      summary: { Total: formatMoney(po.grandTotal) }
    };
  }

  function renderGenericDetail(info) {
    const titleEl = document.getElementById('reportDetailModalLabel');
    const typeBadge = document.getElementById('reportModalTypeBadge');
    const statusBadge = document.getElementById('reportModalStatusBadge');
    const bodyEl = document.getElementById('reportModalBody');

    titleEl.textContent = info.sourceRef || 'Transaction';
    typeBadge.textContent = info.sourceType || 'POSTING';
    statusBadge.textContent = 'LOGGED';
    statusBadge.className = 'badge bg-info-subtle text-info border';

    bodyEl.innerHTML = `
      <div class="p-4 rounded-3 text-center report-drilldown-surface">
        <i class="bi bi-file-earmark-text fs-1 text-primary d-block mb-2"></i>
        <h6 class="fw-bold mb-1 report-drilldown-val">${escapeHtml(info.sourceRef || 'Transaction Reference')}</h6>
        <div class="text-muted small mb-3">Type: ${escapeHtml(info.sourceType || 'Standard Transaction')} ${info.sourceId ? '• Record ID: ' + escapeHtml(info.sourceId) : ''}</div>
        ${info.journalId ? `<a href="/reports/journals/${encodeURIComponent(info.journalId)}" class="btn btn-sm btn-outline-primary rounded-pill">Open Journal Entry #${escapeHtml(info.journalId)}</a>` : ''}
      </div>
    `;

    currentModalData = {
      title: info.sourceRef || 'Transaction',
      headers: ['Reference', 'Type', 'Record ID'],
      rows: [[info.sourceRef, info.sourceType, info.sourceId || '—']],
      summary: {}
    };
  }

  // Delegated click listener for any report table row with .report-row-clickable
  document.addEventListener('click', function (e) {
    // Ignore interactive element clicks
    if (e.target.closest('a, button, input, select, textarea, label, .dropdown')) {
      return;
    }

    const row = e.target.closest('tr.report-row-clickable');
    if (!row) return;

    e.preventDefault();
    openDrilldown(row);
  });

  // Export to window for explicit triggers
  window.SparkReportDrilldown = {
    open: openDrilldown
  };
})();
