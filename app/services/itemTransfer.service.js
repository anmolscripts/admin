'use strict';
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const { embeddedCss, regularFont } = require('./font.service');

const columns = ['name', 'description', 'unit', 'hsnSac', 'rate', 'gstRate', 'active', 'itemCode', 'id', 'CREATED_BY', 'CREATED_AT', 'IP_ADDRESS'];
const editable = columns.slice(0, 8);
const sample = ['Sample item', 'Sample description', 'PCS', '7304', 100, 18, true, ''];
const safeCell = value => /^[=+\-@\t\r\n]/.test(String(value ?? '')) ? `'${value}` : (value ?? '');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function exportDate(date = new Date(), timeZone = 'Asia/Kolkata') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(date).map(p => [p.type, p.value]));
    return `${parts.day}-${parts.month.toUpperCase()}-${parts.year} | ${parts.hour}:${parts.minute} ${parts.dayPeriod.toUpperCase()}`;
}

function logoFile(url) {
    if (typeof url !== 'string' || !/^\/(uploads\/logos|images)\/[\w./-]+\.(png|jpe?g)$/i.test(url)) return null;
    const root = path.resolve(__dirname, '../../assets');
    const file = path.resolve(root, '.' + url);
    return file.startsWith(root + path.sep) && fs.existsSync(file) ? file : null;
}

async function readImport(buffer, filename = 'items.csv') {
    const workbook = new ExcelJS.Workbook();
    if (/\.xlsx$/i.test(filename)) await workbook.xlsx.load(buffer);
    else if (/\.csv$/i.test(filename)) await workbook.csv.read(Readable.from([buffer]), { map: value => value, parserOptions: { ignoreEmpty: true, maxRows: 1006 } });
    else throw new Error('Choose a CSV or XLSX file.');
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount > 1005) throw new Error('Import at most 1,000 items at a time.');
    const rows = [];
    sheet.eachRow(row => rows.push(row.values.slice(1).map(cell => {
        if (cell && typeof cell === 'object') {
            if (cell.richText) return cell.richText.map(part => part.text).join('');
            throw new Error('Import plain cell values; formulas and links are not supported.');
        }
        return cell ?? '';
    })));
    const headerIndex = rows.findIndex(row => row.some(cell => String(cell).trim().toLowerCase() === 'name'));
    if (headerIndex < 0 || rows.length <= headerIndex + 1) throw new Error('File must contain a name column and at least one item.');
    if (rows.length - headerIndex - 1 > 1000) throw new Error('Import at most 1,000 items at a time.');
    return rows.slice(headerIndex);
}

async function workbookFor(items, branding, isSample = false) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Items');
    if (!isSample) {
        sheet.addRow([branding.companyName, 'Item List', exportDate(new Date(), branding.timeZone), branding.logoUrl || ''].map(safeCell));
        sheet.getRow(1).height = 45;
        const logo = logoFile(branding.logoUrl);
        if (logo) sheet.addImage(workbook.addImage({ filename: logo, extension: /\.png$/i.test(logo) ? 'png' : 'jpeg' }), { tl: { col: 10, row: 0 }, ext: { width: 60, height: 40 } });
    }
    sheet.addRow(isSample ? editable : columns).font = { bold: true };
    if (isSample) sheet.addRow(sample);
    else for (const item of items) sheet.addRow(columns.map(key => safeCell(['rate','gstRate'].includes(key) ? Number(item[key] || 0) : item[key] instanceof Date ? item[key].toISOString() : item[key])));
    sheet.columns.forEach(column => { column.width = 22; });
    sheet.getColumn(1).width = 42;
    sheet.getColumn(2).width = 50;
    sheet.views = [{ state: 'frozen', ySplit: isSample ? 1 : 2 }];
    return workbook;
}

function printHtml(items, branding, date = new Date()) {
    const logo = logoFile(branding.logoUrl);
    return `<!doctype html><html><head><meta charset="utf-8"><title>Item List</title><style>${embeddedCss}body{font:12px Montserrat,sans-serif;color:#172b24}header{display:flex;align-items:center;gap:16px}img{max-width:80px;max-height:60px}table{width:100%;border-collapse:collapse;font-size:10px}th,td{padding:7px;border:1px solid #ccc;overflow-wrap:anywhere}thead{display:table-header-group}@page{size:A3 landscape;margin:12mm}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Print Item List</button><header>${logo ? `<img src="${escapeHtml(branding.logoUrl)}" alt="Brand logo">` : ''}<div><h1>${escapeHtml(branding.companyName)}</h1><h2>Item List</h2><p>Exported: ${exportDate(date, branding.timeZone)}</p></div></header><table><thead><tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${items.map(item => `<tr>${columns.map(c => `<td>${escapeHtml(item[c] instanceof Date ? item[c].toISOString() : item[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}

async function pdf(items, branding) {
    const doc = new PDFDocument({ size: 'A3', layout: 'landscape', margin: 30 });
    doc.font(regularFont);
    const chunks = [];
    const result = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
    const logo = logoFile(branding.logoUrl);
    if (logo) doc.image(logo, 30, 30, { fit: [65, 45] });
    doc.fontSize(18).text(branding.companyName, 110, 30).fontSize(14).text('Item List').fontSize(10).text(`Exported: ${exportDate(new Date(), branding.timeZone)}`).moveDown();
    doc.fontSize(8);
    doc.table({ columnStyles: [160, 190, 45, 60, 65, 45, 40, 75, 35, 65, 125, 110], data: [columns, ...items.map(item => columns.map(c => String(item[c] instanceof Date ? item[c].toISOString() : item[c] ?? '')))] });
    doc.end();
    return result;
}

module.exports = { columns, editable, readImport, workbookFor, printHtml, pdf, exportDate, safeCell };
