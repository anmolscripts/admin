'use strict';

/**
 * Authoritative Navigation Registry & RBAC Resolver
 */

const NAV_ITEMS = [
    {
        id: 'menu-dashboard',
        label: 'Dashboard',
        url: '/dashboard',
        icon: 'bi-grid-fill',
        requiredModule: 'DASHBOARD',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path === '/dashboard' || title.toLowerCase().includes('dashboard')
    },
    {
        id: 'menu-documents',
        label: 'Documents',
        url: '/documents',
        icon: 'bi-file-earmark-text-fill',
        requiredModule: 'DOCUMENTS',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => {
            const t = title.toLowerCase();
            return (path.startsWith('/documents') || path === '/' || t.includes('quotation') || t.includes('invoice')) &&
                   !t.includes('client') && !t.includes('item') && !t.includes('unit') && !t.includes('team');
        }
    },
    {
        id: 'menu-notes',
        label: 'Credit & Debit Notes',
        url: '/credit-debit-notes',
        icon: 'bi-receipt',
        requiredModule: 'CREDIT_DEBIT_NOTES',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path.startsWith('/credit-debit-notes') || title.toLowerCase().includes('credit & debit')
    },
    {
        id: 'menu-projects',
        label: 'Projects',
        url: '/projects',
        icon: 'bi-kanban-fill',
        requiredModule: 'PROJECTS',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path.startsWith('/projects') || title.toLowerCase().includes('project')
    },
    {
        id: 'menu-reports',
        label: 'Reports & Accounting',
        url: '/reports',
        icon: 'bi-bar-chart-line-fill',
        requiredModule: 'REPORTS',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => {
            const t = title.toLowerCase();
            return path.startsWith('/reports') || t.includes('report') || t.includes('ledger') ||
                   t.includes('trial balance') || t.includes('balance sheet') || t.includes('profit & loss') ||
                   t.includes('receivables') || t.includes('journal');
        }
    },
    {
        id: 'menu-financial-years',
        label: 'Financial Years',
        url: '/financial-years',
        icon: 'bi-calendar2-range',
        requiredModule: 'FINANCIAL_YEARS',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path.startsWith('/financial-years') || title.toLowerCase().includes('financial year')
    },
    {
        id: 'menu-clients',
        label: 'Clients',
        url: '/clients',
        icon: 'bi-people-fill',
        requiredModule: 'CLIENTS',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path.startsWith('/clients') || title.toLowerCase().includes('client')
    },
    {
        id: 'menu-items',
        label: 'Items',
        url: '/items',
        icon: 'bi-box-seam-fill',
        requiredModule: 'ITEMS',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path.startsWith('/items') || title.toLowerCase().includes('item')
    },
    {
        id: 'menu-units',
        label: 'Units',
        url: '/units',
        icon: 'bi-rulers',
        requiredModule: 'UNITS',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path.startsWith('/units') || title.toLowerCase().includes('unit')
    },
    {
        id: 'menu-team',
        label: 'Team',
        url: '/team',
        icon: 'bi-person-badge-fill',
        requiredModule: 'TEAM',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path.startsWith('/team') || title.toLowerCase().includes('team')
    },
    {
        id: 'menu-workbench',
        label: 'Reporting Workbench',
        url: '/reports/workbench',
        icon: 'bi-clipboard-data-fill',
        requiredModule: 'REPORTS',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path.startsWith('/reports/workbench') || title.toLowerCase().includes('workbench')
    },
    {
        id: 'menu-admin-businesses',
        label: 'Organizations',
        url: '/admin/businesses',
        icon: 'bi-buildings-fill',
        requiredModule: 'SETTINGS',
        requiredAction: 'MANAGE',
        isActive: (path, title = '') => path.startsWith('/admin/businesses') || title.toLowerCase().includes('organization')
    },
    {
        id: 'menu-admin-numbering',
        label: 'Document Numbering',
        url: '/admin/numbering',
        icon: 'bi-123',
        requiredModule: 'SETTINGS',
        requiredAction: 'MANAGE',
        isActive: (path, title = '') => path.startsWith('/admin/numbering') || title.toLowerCase().includes('numbering')
    },
    {
        id: 'menu-settings',
        label: 'Settings',
        url: '/settings',
        icon: 'bi-gear-fill',
        requiredModule: 'SETTINGS',
        requiredAction: 'VIEW',
        isActive: (path, title = '') => path.startsWith('/settings') || title.toLowerCase().includes('setting')
    }
];

const QUICK_COMMANDS = [
    { title: 'Dashboard', category: 'Navigation', icon: 'bi-grid-fill', url: '/dashboard', module: 'DASHBOARD', action: 'VIEW', keywords: ['home', 'kpi', 'metrics', 'analytics'] },
    { title: 'Quotations & Invoices', category: 'Navigation', icon: 'bi-file-earmark-text', url: '/documents', module: 'DOCUMENTS', action: 'VIEW', keywords: ['invoices', 'quotations', 'bills', 'sales'] },
    { title: 'Create New Invoice', category: 'Actions', icon: 'bi-plus-circle', url: '/documents/new?type=INVOICE', module: 'DOCUMENTS', action: 'CREATE', keywords: ['new invoice', 'add invoice', 'bill client'] },
    { title: 'Create New Quotation', category: 'Actions', icon: 'bi-plus-circle', url: '/documents/new?type=QUOTATION', module: 'DOCUMENTS', action: 'CREATE', keywords: ['new quotation', 'estimate', 'proposal'] },
    { title: 'Credit & Debit Notes', category: 'Navigation', icon: 'bi-receipt', url: '/credit-debit-notes', module: 'CREDIT_DEBIT_NOTES', action: 'VIEW', keywords: ['credit note', 'debit note', 'adjustments'] },
    { title: 'Projects Workspace', category: 'Projects', icon: 'bi-kanban-fill', url: '/projects', module: 'PROJECTS', action: 'VIEW', keywords: ['projects', 'costing', 'profitability', 'margin', 'labour'] },
    { title: 'Create New Project', category: 'Projects', icon: 'bi-plus-circle', url: '/projects/new', module: 'PROJECTS', action: 'CREATE', keywords: ['new project', 'add project', 'project costing'] },
    { title: 'Financial Reports & Accounting', category: 'Accounting', icon: 'bi-bar-chart-line', url: '/reports', module: 'REPORTS', action: 'VIEW', keywords: ['reports', 'financials'] },
    { title: 'General Ledger', category: 'Accounting', icon: 'bi-journal-text', url: '/reports/general-ledger', module: 'REPORTS', action: 'VIEW', keywords: ['ledger', 'accounts', 'entries'] },
    { title: 'Trial Balance', category: 'Accounting', icon: 'bi-calculator', url: '/reports/trial-balance', module: 'REPORTS', action: 'VIEW', keywords: ['trial balance', 'debit credit check'] },
    { title: 'Profit & Loss Statement', category: 'Accounting', icon: 'bi-graph-up-arrow', url: '/reports/profit-and-loss', module: 'REPORTS', action: 'VIEW', keywords: ['p&l', 'income statement', 'net profit'] },
    { title: 'Balance Sheet', category: 'Accounting', icon: 'bi-bank', url: '/reports/balance-sheet', module: 'REPORTS', action: 'VIEW', keywords: ['balance sheet', 'assets liabilities equity'] },
    { title: 'Journal Register', category: 'Accounting', icon: 'bi-book', url: '/reports/journal-register', module: 'REPORTS', action: 'VIEW', keywords: ['journal', 'posted journals'] },
    { title: 'Financial Years & Period Closing', category: 'Accounting', icon: 'bi-calendar2-range', url: '/financial-years', module: 'FINANCIAL_YEARS', action: 'VIEW', keywords: ['financial year', 'fy closing', 'lock period'] },
    { title: 'Clients Directory', category: 'Navigation', icon: 'bi-people', url: '/clients', module: 'CLIENTS', action: 'VIEW', keywords: ['customers', 'buyers', 'contacts'] },
    { title: 'Add New Client', category: 'Actions', icon: 'bi-person-plus', url: '/clients/new', module: 'CLIENTS', action: 'CREATE', keywords: ['new client', 'create customer'] },
    { title: 'Items Master', category: 'Navigation', icon: 'bi-box-seam', url: '/items', module: 'ITEMS', action: 'VIEW', keywords: ['products', 'services', 'inventory', 'hsn'] },
    { title: 'Units of Measure', category: 'Navigation', icon: 'bi-rulers', url: '/units', module: 'UNITS', action: 'VIEW', keywords: ['units', 'uom', 'measurements'] },
    { title: 'Purchase Orders', category: 'Purchasing', icon: 'bi-cart-check', url: '/purchases/orders', module: 'PURCHASE', action: 'VIEW', keywords: ['purchase orders', 'po', 'procurement', 'vendor order'] },
    { title: 'Create Purchase Order', category: 'Purchasing', icon: 'bi-cart-plus', url: '/purchases/orders/new', module: 'PURCHASE', action: 'CREATE', keywords: ['new purchase order', 'create po', 'buy'] },
    { title: 'Supplier Bills', category: 'Purchasing', icon: 'bi-receipt-cutoff', url: '/purchases/bills', module: 'PURCHASE', action: 'VIEW', keywords: ['supplier bills', 'vendor bills', 'payables', 'ap'] },
    { title: 'Operating Expenses', category: 'Financials', icon: 'bi-cash-coin', url: '/financials/expenses', module: 'EXPENSES', action: 'VIEW', keywords: ['expenses', 'operating expense', 'spend', 'petty cash'] },
    { title: 'Other Income', category: 'Financials', icon: 'bi-graph-up', url: '/financials/other-income', module: 'REPORTS', action: 'VIEW', keywords: ['other income', 'non invoice income', 'revenue'] },
    { title: 'Team & Staff Roles', category: 'Management', icon: 'bi-person-badge', url: '/team', module: 'TEAM', action: 'VIEW', keywords: ['users', 'roles', 'rbac', 'staff'] },
    { title: 'Organization Settings', category: 'Settings', icon: 'bi-gear', url: '/settings', module: 'SETTINGS', action: 'VIEW', keywords: ['company profile', 'gstin', 'bank details', 'branding'] },
    { title: 'My User Profile', category: 'Settings', icon: 'bi-person', url: '/profile', module: null, action: null, keywords: ['my account', 'change password', 'avatar'] }
];

function checkPermission(user, module, action, hasPermissionFn) {
    if (!module) return true; // public to all authenticated users
    if (typeof hasPermissionFn === 'function') {
        return hasPermissionFn(module, action);
    }
    if (user && (user.role === 'OWNER' || user.role === 'ADMIN')) {
        return true;
    }
    return false;
}

/**
 * Filter menu items for current user
 */
function getPermittedNavItems(user, hasPermissionFn) {
    return NAV_ITEMS.filter(item => {
        return checkPermission(user, item.requiredModule, item.requiredAction, hasPermissionFn);
    });
}

/**
 * Search commands matching a search query
 */
function searchCommands(query, user, hasPermissionFn) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return [];

    return QUICK_COMMANDS.filter(cmd => {
        if (!checkPermission(user, cmd.module, cmd.action, hasPermissionFn)) {
            return false;
        }

        if (cmd.title.toLowerCase().includes(q)) return true;
        if (cmd.category.toLowerCase().includes(q)) return true;
        if (cmd.keywords.some(k => k.includes(q))) return true;

        return false;
    }).map(cmd => ({
        id: `cmd-${cmd.url}`,
        title: cmd.title,
        subtitle: `${cmd.category} command`,
        category: 'Commands & Navigation',
        icon: cmd.icon,
        url: cmd.url
    }));
}

module.exports = {
    NAV_ITEMS,
    QUICK_COMMANDS,
    getPermittedNavItems,
    searchCommands,
    checkPermission
};
