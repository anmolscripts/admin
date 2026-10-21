'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ejs = require('ejs');
const file = require.resolve('../app/views/layouts/header.ejs');
const source = fs.readFileSync(file, 'utf8');
const navigation = source.slice(0, source.indexOf('</ul>') + 5);

test('organization pages highlight only Organizations even when title says settings', () => {
    for (const currentPath of ['/admin/businesses', '/admin/businesses/1']) {
        const html = ejs.render(navigation, { currentPath, pageTitle: 'Organization Settings', user: { role: 'ADMIN' } });
        const links = [...html.matchAll(/<a[^>]+class="sidebar-menu-link\s+active"[^>]+id="([^"]+)"/g)].map(match => match[1]);
        assert.deepEqual(links, ['menu-admin-businesses']);
    }
});
test('organization profile and template settings still highlight Settings', () => {
    for (const currentPath of ['/settings', '/settings/templates']) {
        const html = ejs.render(navigation, { currentPath, pageTitle: 'Organization Profile & Settings', user: { role: 'ADMIN' } });
        const links = [...html.matchAll(/<a[^>]+class="sidebar-menu-link\s+active"[^>]+id="([^"]+)"/g)].map(match => match[1]);
        assert.deepEqual(links, ['menu-settings']);
    }
});
