(function () {
    'use strict';
    const form = document.getElementById('item-import-form');
    if (!form) return;
    const result = document.getElementById('item-import-result');
    let rows = [];
    async function request(url, options) {
        const response = await fetch(url, { ...options, headers: { ...options.headers, 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || form.dataset.csrf } });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Import failed.');
        return data;
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        rows = [];
        result.replaceChildren();
        const button = form.querySelector('button');
        button.disabled = true;
        try {
            const file = document.getElementById('item-import-file').files[0];
            if (!file || file.size > 2 * 1024 * 1024) throw new Error('Choose a CSV or XLSX file up to 2 MB.');
            const body = new FormData();
            body.append('file', file);
            const data = await request('/api/items/import/preview', { method: 'POST', body });
            const summary = document.createElement('p');
            summary.textContent = `${data.summary.newCount} new, ${data.summary.updateCount} updates, ${data.summary.invalidCount} errors.`;
            result.append(summary);
            for (const error of data.errors) {
                const line = document.createElement('p');
                line.className = 'text-danger';
                line.textContent = `Row ${error.row}: ${error.error}`;
                result.append(line);
            }
            if (!data.errors.length && data.preview.length) {
                rows = data.preview;
                const table = document.createElement('table');
                table.className = 'table table-sm';
                const wrapper = document.createElement('div');
                wrapper.className = 'table-responsive';
                wrapper.style.maxHeight = '300px';
                const head = table.createTHead().insertRow();
                const keys = ['action','name','description','unit','hsnSac','rate','gstRate','active','itemCode'];
                keys.forEach(key => { const th = document.createElement('th'); th.textContent = key; head.append(th); });
                const tbody = table.createTBody();
                rows.forEach(row => { const tr = tbody.insertRow(); keys.forEach(key => { tr.insertCell().textContent = row[key] ?? ''; }); });
                wrapper.append(table);
                result.append(wrapper);
                const commit = document.createElement('button');
                commit.type = 'button';
                commit.className = 'btn btn-primary mt-2';
                commit.textContent = 'Confirm Import';
                commit.addEventListener('click', async () => {
                    commit.disabled = true;
                    try {
                        const data = await request('/api/items/import/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
                        result.textContent = `Imported ${data.created} items and updated ${data.updated}. Reloading…`;
                        window.location.reload();
                    } catch (error) { summary.textContent = error.message; commit.disabled = false; }
                });
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'btn btn-secondary mt-2 ms-2';
                cancel.textContent = 'Cancel';
                cancel.addEventListener('click', () => { rows = []; result.replaceChildren(); form.reset(); });
                result.append(commit, cancel);
            }
        } catch (error) { result.textContent = error.message; }
        finally { button.disabled = false; }
    });
})();
