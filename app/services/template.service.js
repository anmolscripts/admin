'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '../../data/templates');

// Ensure storage directory exists
if (!fs.existsSync(TEMPLATES_DIR)) {
    try {
        fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    } catch (_) {}
}

const BUILT_IN_TEMPLATES = [
    {
        id: 'rajesh-signature',
        name: 'Rajesh International · Navy & Gold',
        category: 'Signature Letterhead',
        description: 'Reference-inspired navy and metallic gold letterhead, supplied Rajesh International logo, infinity watermark, curved borders and dynamic contact details. For invoices and quotations.',
        accentColor: '#091e49',
        accentSubtle: '#fcf7ec',
        fontFamily: 'Arial, Helvetica, sans-serif',
        themeClass: 'theme-rajesh-signature',
        showHsn: true,
        showUpiQr: false,
        showDiscount: true,
        showUnit: true,
        isBuiltIn: true,
        customCss: '',
        brandLogo: 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../../assets/images/document-templates/rajesh-international-logo.png')).toString('base64')
    },
    {
        id: 'modern-minimal',
        name: 'Modern Minimalist',
        category: 'Modern',
        description: 'Contemporary tech-grade layout with sleek royal blue accents, clean typography, subtle grey headers, and borderless product table.',
        accentColor: '#2563eb',
        accentSubtle: '#eff6ff',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        themeClass: 'theme-modern-minimal',
        showHsn: true,
        showUpiQr: true,
        showDiscount: true,
        showUnit: true,
        isBuiltIn: true,
        customCss: ''
    },
    {
        id: 'classic-corporate',
        name: 'Classic Corporate',
        category: 'Corporate / CA',
        description: 'Formal corporate accounting format with deep navy border, structured table cells, and Chartered Accountant auditor sign-off box.',
        accentColor: '#1e3a8a',
        accentSubtle: '#f8fafc',
        fontFamily: 'Roboto, Arial, sans-serif',
        themeClass: 'theme-classic-corporate',
        showHsn: true,
        showUpiQr: true,
        showDiscount: false,
        showUnit: true,
        isBuiltIn: true,
        customCss: ''
    },
    {
        id: 'industrial-bold',
        name: 'Industrial Bold',
        category: 'Manufacturing / Trade',
        description: 'High-contrast crimson red header band, bold item descriptions, centered company branding, and heavy-duty parts/machinery layout.',
        accentColor: '#c8102e',
        accentSubtle: '#fef2f2',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        themeClass: 'theme-industrial-bold',
        showHsn: true,
        showUpiQr: false,
        showDiscount: true,
        showUnit: true,
        isBuiltIn: true,
        customCss: ''
    },
    {
        id: 'executive-emerald',
        name: 'Executive Emerald',
        category: 'Executive / Studio',
        description: 'Refined deep emerald/teal aesthetic with luxury typography, subtle borders, compact tables, and elegant totals card.',
        accentColor: '#0f766e',
        accentSubtle: '#f0fdfa',
        fontFamily: 'Helvetica Neue, Arial, sans-serif',
        themeClass: 'theme-executive-emerald',
        showHsn: true,
        showUpiQr: true,
        showDiscount: true,
        showUnit: true,
        isBuiltIn: true,
        customCss: ''
    }
];

function getBusinessConfigFile(businessId) {
    const safeId = parseInt(businessId, 10) || 1;
    return path.join(TEMPLATES_DIR, `business_${safeId}.json`);
}

function loadBusinessConfig(businessId) {
    const file = getBusinessConfigFile(businessId);
    if (!fs.existsSync(file)) {
        return {
            activeInvoiceTemplate: 'modern-minimal',
            activeQuotationTemplate: 'modern-minimal',
            customTemplates: []
        };
    }
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            activeInvoiceTemplate: parsed.activeInvoiceTemplate || 'modern-minimal',
            activeQuotationTemplate: parsed.activeQuotationTemplate || 'modern-minimal',
            customTemplates: Array.isArray(parsed.customTemplates) ? parsed.customTemplates : []
        };
    } catch (_) {
        return {
            activeInvoiceTemplate: 'modern-minimal',
            activeQuotationTemplate: 'modern-minimal',
            customTemplates: []
        };
    }
}

function saveBusinessConfig(businessId, config) {
    const file = getBusinessConfigFile(businessId);
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * List all available templates for a business (built-in + custom)
 */
function listTemplates(businessId) {
    const config = loadBusinessConfig(businessId);
    return [
        ...BUILT_IN_TEMPLATES,
        ...config.customTemplates
    ];
}

/**
 * Get active template selections for a business
 */
function getActiveTemplates(businessId) {
    const config = loadBusinessConfig(businessId);
    return {
        invoiceTemplate: config.activeInvoiceTemplate || 'modern-minimal',
        quotationTemplate: config.activeQuotationTemplate || 'modern-minimal'
    };
}

/**
 * Set active template selections for a business
 */
function setActiveTemplates(businessId, { invoiceTemplate, quotationTemplate }) {
    const config = loadBusinessConfig(businessId);
    if (invoiceTemplate) config.activeInvoiceTemplate = String(invoiceTemplate).trim();
    if (quotationTemplate) config.activeQuotationTemplate = String(quotationTemplate).trim();
    saveBusinessConfig(businessId, config);
    return getActiveTemplates(businessId);
}

/**
 * Retrieve a template by ID for a business
 */
function getTemplate(templateId, businessId) {
    const all = listTemplates(businessId);
    const found = all.find(t => t.id === templateId);
    if (found) {
        if (found.themeClass === 'theme-rajesh-signature' && !found.brandLogo) {
            return { ...found, brandLogo: BUILT_IN_TEMPLATES.find(t => t.id === 'rajesh-signature').brandLogo };
        }
        return found;
    }
    return BUILT_IN_TEMPLATES.find(t => t.id === 'modern-minimal');
}

/**
 * Save or update a custom template
 */
function saveCustomTemplate(businessId, data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Template data is required.');
    }
    const name = String(data.name || '').trim();
    if (!name) {
        throw new Error('Template name is required.');
    }

    const config = loadBusinessConfig(businessId);
    const baseLayout = data.baseLayout || data.baseTemplate || 'modern-minimal';
    if (!BUILT_IN_TEMPLATES.some(t=>t.id===baseLayout)) throw new Error('Choose a valid base layout.');
    const accentColor = data.accentColor || '#2563eb';
    if (!/^#[0-9a-f]{6}$/i.test(accentColor)) throw new Error('Accent color must be a six-digit hex color.');
    if (data.accentSubtle && !/^#[0-9a-f]{6}$/i.test(data.accentSubtle)) throw new Error('Subtle color must be a six-digit hex color.');
    const fontFamily = data.fontFamily || 'Inter, -apple-system, sans-serif';
    const customCss = data.customCss ? String(data.customCss).trim() : '';
    const showHsn = data.showHsn !== undefined ? Boolean(data.showHsn) : true;
    const showUpiQr = data.showUpiQr !== undefined ? Boolean(data.showUpiQr) : true;
    const showDiscount = data.showDiscount !== undefined ? Boolean(data.showDiscount) : true;
    const showUnit = data.showUnit !== undefined ? Boolean(data.showUnit) : true;

    let targetId = data.id ? String(data.id).trim() : null;
    const isNew = !targetId || BUILT_IN_TEMPLATES.some(b => b.id === targetId);

    if (isNew) {
        targetId = `custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    }

    const customTemplate = {
        id: targetId,
        name,
        category: String(data.category || 'Custom').trim().slice(0,80),
        description: data.description ? String(data.description).trim() : `Custom business template based on ${baseLayout}.`,
        baseLayout,
        accentColor,
        accentSubtle: data.accentSubtle || `${accentColor}15`,
        fontFamily,
        themeClass: `theme-${baseLayout}`,
        showHsn,
        showUpiQr,
        showDiscount,
        showUnit,
        customCss,
        isBuiltIn: false,
        updatedAt: new Date().toISOString()
    };

    const existingIndex = config.customTemplates.findIndex(t => t.id === targetId);
    if (existingIndex >= 0) {
        config.customTemplates[existingIndex] = customTemplate;
    } else {
        config.customTemplates.push(customTemplate);
    }

    saveBusinessConfig(businessId, config);
    return customTemplate;
}

/**
 * Delete a custom template
 */
function deleteCustomTemplate(businessId, templateId) {
    if (BUILT_IN_TEMPLATES.some(b => b.id === templateId)) {
        throw new Error('Built-in system templates cannot be deleted.');
    }

    const config = loadBusinessConfig(businessId);
    config.customTemplates = config.customTemplates.filter(t => t.id !== templateId);

    if (config.activeInvoiceTemplate === templateId) {
        config.activeInvoiceTemplate = 'modern-minimal';
    }
    if (config.activeQuotationTemplate === templateId) {
        config.activeQuotationTemplate = 'modern-minimal';
    }

    saveBusinessConfig(businessId, config);
    return true;
}

/**
 * Build a realistic sample Document View Model for template previews
 */
function buildSampleViewModel(templateId, documentType = 'INVOICE', profile = {}) {
    const isQuotation = String(documentType).toUpperCase() === 'QUOTATION';
    const docNumber = isQuotation ? 'QT-2026-0042' : 'INV-2026-0089';
    const docTitle = isQuotation ? 'QUOTATION' : 'TAX INVOICE';

    const items = [
        {
            lineIndex: 1,
            itemName: 'Industrial Servo Drive Motor 5.5kW',
            description: 'Three-phase synchronous brushless motor with integrated optical encoder and IP65 enclosure.',
            hsnCode: '8501',
            quantity: '2.00',
            unitSymbol: 'PCS',
            unitRate: '34,500.00',
            totalAmount: '69,000.00'
        },
        {
            lineIndex: 2,
            itemName: 'Programmable Logic Controller (PLC) Unit',
            description: '24V DC modular CPU unit with 16 DI/16 DO, Ethernet/IP, and Modbus TCP support.',
            hsnCode: '8537',
            quantity: '1.00',
            unitSymbol: 'UNIT',
            unitRate: '42,000.00',
            totalAmount: '42,000.00'
        },
        {
            lineIndex: 3,
            itemName: 'Installation & Commissioning Engineering',
            description: 'On-site system calibration, field wiring verification, and load testing sign-off.',
            hsnCode: '9983',
            quantity: '16.00',
            unitSymbol: 'HRS',
            unitRate: '1,500.00',
            totalAmount: '24,000.00'
        }
    ];

    const subtotalNum = 135000.00;
    const cgstNum = 12150.00;
    const sgstNum = 12150.00;
    const grandTotalNum = 159300.00;

    return {
        id: 9999,
        documentType: isQuotation ? 'QUOTATION' : 'INVOICE',
        documentTitle: docTitle,
        typeLabel: isQuotation ? 'Quotation' : 'Invoice',
        invoiceNumber: docNumber,
        status: 'ACTIVE',
        statusClass: 'badge-active',
        watermark: null,
        isQuotation,
        isNote: false,
        themeColor: '#2563eb',
        themeBg: '#eff6ff',
        themeBorder: '#bfdbfe',
        dates: {
            invoiceDate: '17 Oct 2026',
            invoiceDateRaw: new Date('2026-10-17'),
            dueOrExpiryDate: isQuotation ? '01 Nov 2026' : '16 Nov 2026',
            dueOrExpiryLabel: isQuotation ? 'Valid Until' : 'Due Date'
        },
        seller: {
            name: profile.legalName || 'Spark Industrial Technologies Pvt Ltd',
            gstin: profile.gstin || '27AABCS1429B1ZB',
            address: profile.address || 'Plot 42, Tech Park Central, Bandra Kurla Complex, Mumbai 400051',
            email: profile.email || 'billing@sparktech.io',
            phone: profile.phone || '+91 98765 43210',
            website: profile.website || '',
            stateCode: profile.stateCode || '27',
            bankName: profile.bankName || 'HDFC Bank Ltd',
            accountNumber: profile.accountNumber || '50200012345678',
            ifscCode: profile.ifsc || 'HDFC0001234',
            branch: profile.branch || 'BKC Mumbai Corporate Branch',
            upiId: profile.upiId || 'sparktech@okhdfcbank',
            hasBankDetails: true
        },
        client: {
            name: 'Apex Precision Engineering Works',
            email: 'procurement@apexprecision.com',
            phone: '+91 98220 11223',
            gstin: '27AAACP4455Q1ZT',
            billingAddress: 'Gala 14, MIDC Industrial Area, Phase II, Turbhe, Navi Mumbai 400705',
            shippingAddress: 'Plant 2, Plot 89, TTC Industrial Zone, Rabale, Navi Mumbai 400701',
            placeOfSupply: 'State Code 27 (Maharashtra)'
        },
        items: items.map((item, index) => ({
            ...item, lineNumber: index + 1, name: item.itemName, hsnSac: item.hsnCode,
            unit: item.unitSymbol, formattedRate: '₹' + item.unitRate,
            formattedAmount: '₹' + item.totalAmount
        })),
        financials: {
            subtotal: subtotalNum.toFixed(2),
            formattedSubtotal: '₹1,35,000.00',
            gstEnabled: true,
            gstRate: 18.00,
            cgst: cgstNum.toFixed(2),
            formattedCgst: '₹12,150.00',
            sgst: sgstNum.toFixed(2),
            formattedSgst: '₹12,150.00',
            igst: '0.00',
            formattedIgst: '₹0.00',
            gstTotal: (cgstNum + sgstNum).toFixed(2),
            formattedGstTotal: '₹24,300.00',
            roundOff: '0.00',
            formattedRoundOff: '₹0.00',
            grandTotal: grandTotalNum.toFixed(2),
            formattedGrandTotal: '₹1,59,300.00',
            isInterState: false,
            formattedCgstAmount: '₹12,150.00',
            formattedSgstAmount: '₹12,150.00',
            formattedIgstAmount: '₹0.00',
            formattedPaidAmount: '₹0.00',
            formattedOutstandingAmount: '₹1,59,300.00'
        },
        terms: profile.defaultTerms || '1. Goods once sold will not be taken back without prior written RMA authorization.\n2. Payment is due strictly within the agreed credit term.\n3. Delayed payments are subject to commercial interest @ 18% per annum.',
        notes: profile.defaultRemarks || 'Thank you for your business. For any technical or delivery inquiries, please reference the document number.',
        footer: profile.invoiceFooter || 'This is an authorized computer-generated document and valid without physical signature.'
    };
}

module.exports = {
    BUILT_IN_TEMPLATES,
    listTemplates,
    getTemplate,
    getActiveTemplates,
    setActiveTemplates,
    saveCustomTemplate,
    deleteCustomTemplate,
    buildSampleViewModel
};

