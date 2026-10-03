# Spark Admin End-User Operations Manual

Welcome to the **Spark Admin** operator guide. This manual provides detailed, step-by-step instructions for managing quotations, invoices, payments, clients, items, and tax compliance.

---

## Table of Contents

1. [Signing In](#1-signing-in)
2. [Executive Dashboard](#2-executive-dashboard)
3. [Creating a Quotation](#3-creating-a-quotation)
4. [Selecting or Creating a Client](#4-selecting-or-creating-a-client)
5. [Adding Line Items](#5-adding-line-items)
6. [Item Master Autocomplete](#6-item-master-autocomplete)
7. [Keyboard Shortcuts for Rapid Entry](#7-keyboard-shortcuts-for-rapid-entry)
8. [Adding a Brand-New Uncataloged Item](#8-adding-a-brand-new-uncataloged-item)
9. [GST Tax Rules & Calculations](#9-gst-tax-rules--calculations)
10. [Billing & Shipping Addresses](#10-billing--shipping-addresses)
11. [Terms & Conditions and Remarks](#11-terms--conditions-and-remarks)
12. [Quotation Validity Date (Valid Until)](#12-quotation-validity-date-valid-until)
13. [Saving the Quotation](#13-saving-the-quotation)
14. [Viewing Document Details](#14-viewing-document-details)
15. [Editing an Existing Quotation](#15-editing-an-existing-quotation)
16. [Activating and Deactivating Documents](#16-activating-and-deactivating-documents)
17. [Cloning a Document (Copy)](#17-cloning-a-document-copy)
18. [Converting Quotation to Invoice](#18-converting-quotation-to-invoice)
19. [Creating a Direct Invoice](#19-creating-a-direct-invoice)
20. [Invoice Due Date & Overdue Tracking](#20-invoice-due-date--overdue-tracking)
21. [Recording Payments](#21-recording-payments)
22. [Voiding a Payment](#22-voiding-a-payment)
23. [Printing Documents](#23-printing-documents)
24. [Exporting to PDF](#24-exporting-to-pdf)
25. [Exporting Reports to Excel](#25-exporting-reports-to-excel)
26. [Audit Trail & Revision History](#26-audit-trail--revision-history)
27. [Deleting Documents (Soft Delete)](#27-deleting-documents-soft-delete)
28. [Restoring Deleted Documents](#28-restoring-deleted-documents)
29. [Searching, Filtering, and Pagination](#29-searching-filtering-and-pagination)
30. [Managing Business Profile & Settings](#30-managing-business-profile--settings)
31. [Managing Client Directory](#31-managing-client-directory)
32. [Managing Item Master Catalog](#32-managing-item-master-catalog)
33. [Managing Unit Master Catalog](#33-managing-unit-master-catalog)
34. [Managing Team Members](#34-managing-team-members)
35. [Roles and Permissions Matrix](#35-roles-and-permissions-matrix)
36. [Inviting Users and Password Setup](#36-inviting-users-and-password-setup)
37. [Activity Audit Trail & Security Logs](#37-activity-audit-trail--security-logs)

---

## 1. Signing In
1. Open your browser and navigate to `/login`.
2. Enter your registered administrative email address and password.
3. Click **Sign In**. On successful authentication, you will be redirected to the Executive Dashboard.
4. *Security Notice:* After 10 consecutive failed attempts, your IP will be temporarily rate-limited for 15 minutes.

---

## 2. Executive Dashboard
The dashboard provides real-time visibility into business performance:
- **KPI Summary Strip:** Total Revenue, Total Invoiced, Active Invoices, Outstanding Receivables, and Overdue Collections.
- **Date Range Filter:** Select preset ranges (**Today**, **This Week**, **This Month**, **This Quarter**, **This Year**) or enter custom date ranges.
- **Interactive Revenue Trends:** Visualizes quotation volume versus billed invoice amounts.
- **Recent Activity Ledger:** Displays recent document creations, status changes, and payment collections.

---

## 3. Creating a Quotation
1. In the left navigation menu, click **Documents** > **New Quotation** (or navigate to `/documents/new?type=QUOTATION`).
2. The document editor will load with Quotation mode selected.
3. Quotation numbers are assigned automatically upon save using the sequence format `QTN-YYYY-NNNN`.

---

## 4. Selecting or Creating a Client
- **Existing Client:** Click the **Client** dropdown or type the client name. Selecting a client auto-populates their GSTIN, Place of Supply state, billing address, and email.
## 4. Selecting or Creating a Client
- **Saved Client Selection:** Choose an existing customer from the **Choose Saved Client** dropdown. The system automatically populates:
  - Client / Company Name
  - Email Address (if on file)
  - Phone Number (if on file)
  - Client GSTIN (15 characters)
  - Place of Supply / State Code
  - Billing Address
  - Shipping Address
- **Clear Selection:** Click the `×` button next to the dropdown to clear fields and create a fresh client record.
- **Document-Level Client Snapshot:** The blue badge (`Document-level client snapshot`) indicates that the customer details are snapshotted specifically for this document. Modifying the address or contact info here will NOT alter the saved master client, and subsequent changes to the client master will NOT corrupt historical invoices.
- **Optional Contact Fields:** Client Name is **required**. Email Address and Phone Number are **optional**; if entered, strict format validation applies.

---

## 5. Adding Line Items
1. Click **+ Add Item** (or press `Enter` on the quantity field of the previous row) to insert a new line row.
2. Enter:
   - **Item Description / Name**
   - **Unit** (dynamically loaded from Unit Master: `PCS`, `m`, `unit`, `Hours`, `Project`, etc.)
   - **Rate** (Unit price in INR)
   - **Quantity** (e.g., `5`)
   - **HSN / SAC Code** (e.g., `7304` or `998313`)
   - **GST Rate** (if GST is enabled)
3. The row total calculates instantly in the browser. Server-side validation guarantees final exactness.

---

## 6. Item Master Autocomplete Portal
When typing in the **Item Description** field:
1. Type at least 2 characters of an existing catalog item (e.g. `pipe` or `valve`).
2. A high-contrast floating portal dropdown (`#item-autocomplete-portal`) appears instantly above the line items and surrounding sections.
3. The portal is immune to parent container clipping or scroll overflow traps.
4. Suggestions display the full item description, unit, and default rate.
5. Click a suggestion or use the keyboard to populate Description, Unit, Rate, and HSN/SAC code immediately.

---

## 7. Fast Keyboard Invoicing Workflow
Designed for rapid, touch-typist data entry without requiring mouse interaction:
- **`↓` / `↑` (Arrow Keys):** Move through autocomplete suggestions.
- **`Enter` on Autocomplete:** Selects the highlighted item, closes dropdown, and advances focus to **Unit**.
- **`Enter` on Unit:** Advances focus to **Rate**.
- **`Enter` on Rate:** Advances focus to **Quantity**.
- **`Enter` on Quantity:** Automatically creates the **next line item row** and immediately focuses its **Item Description** field.
- **`Esc`:** Closes the autocomplete suggestions without selecting.
- **`Tab`:** Standard forward navigation.

---

## 8. Adding a Brand-New Uncataloged Item
If you type an item name that does not exist in your Item Master:
- You do **not** need to leave the editor. Simply fill out the unit, rate, and quantity as normal.
- When you click **Save Document**, the backend automatically creates a new record in your Item Master.
- The next time you create an invoice, this new item will be available in autocomplete.

---

## 9. GST Tax Rules & Calculations

Spark Admin enforces standard Indian Goods & Services Tax (GST) rules:
- **Intra-State Supply (Same State):**
  - If your business state is **Maharashtra (27)** and the client's place of supply is **Maharashtra (27)**:
  - An 18% GST rate splits equally into **9% CGST** and **9% SGST**.
  - Example: Subtotal ₹10,000 + ₹900 CGST + ₹900 SGST = **₹11,800 Grand Total**.
- **Inter-State Supply (Different State):**
  - If your business state is **Maharashtra (27)** and the client's place of supply is **Karnataka (29)**:
  - The entire tax is applied as **18% IGST**.
  - Example: Subtotal ₹10,000 + ₹1,800 IGST = **₹11,800 Grand Total**.

---

## 10. Billing & Shipping Addresses
- **Billing Address:** Populates the client's legal address on printouts and tax invoices.
- **Shipping Address:** If delivery occurs at a warehouse or site different from billing, specify the shipping destination here.

---

## 11. Terms & Conditions and Remarks
- Pre-filled from your Business Profile defaults.
- You can customize remarks or payment instructions specifically for this quotation.

---

## 12. Quotation Validity Date (Valid Until)
- Quotations include an explicit **Valid Until** date.
- This represents the expiration date of your pricing commitment.
- *Data Integrity Guarantee:* The `validUntil` date is permanently stored and will be displayed on reloaded views and printouts.

---

## 13. Saving the Quotation
1. Review subtotals and totals at the bottom right.
2. Click **Save Quotation**.
3. The server validates line items, assigns a unique `QTN-YYYY-NNNN` sequence number, computes authoritative tax totals, and redirects to the Document View screen.

---

## 14. Viewing Document Details
The Document View screen (`/documents/:id`) serves as the administrative hub:
- Displays document status, client details, line items, and financial summary.
- Provides quick action buttons: **Edit**, **Print**, **PDF**, **Copy**, **Convert**, **Record Payment**, **Deactivate**, and **Void**.

---

## 15. Editing an Existing Quotation
1. From the document details screen, click **Edit**.
2. Modify line items, quantities, or terms as needed.
3. Click **Update Document**.
4. *Optimistic Concurrency Protection:* If another user updated the document while you had it open, the system alerts you and prevents accidental overwrites.

---

## 16. Activating and Deactivating Documents
- **Deactivate:** Temporarily pause a document (e.g., pending client approval). Inactive invoices cannot receive payments.
- **Activate:** Restore an inactive document to active status.

---

## 17. Cloning a Document (Copy)
1. Click **Copy** on any existing document.
2. A new editor draft opens with all client info and line items pre-filled.
3. Document numbers, payment histories, and revision logs are **never** cloned.
4. Click **Save** to create an entirely new, independent document.

---

## 18. Converting Quotation to Invoice
When a client approves a quotation:
1. Open the Quotation in Document View.
2. Click **Convert to Invoice**.
3. An invoice is generated instantly with an `INV-YYYY-NNNN` sequence number.
4. The source quotation remains preserved for audit history.
5. *Due Date Rule:* The quotation's `validUntil` date does **not** become the invoice due date; the invoice receives its own independent due date (30 days by default).

---

## 19. Creating a Direct Invoice
1. Click **Documents** > **New Invoice**.
2. Select client, enter line items, configure GST, and specify an explicit **Due Date**.
3. Click **Save Invoice**.

---

## 20. Invoice Due Date & Overdue Tracking
- Each invoice persists a dedicated **Due Date**.
- If an invoice remains unpaid past its due date, the system badges it with a red **OVERDUE** pill and includes its balance in dashboard overdue alerts.

---

## 21. Recording Payments
1. Open an active invoice.
2. In the Payment Ledger section, click **Record Payment**.
3. Enter:
   - **Amount:** Cannot exceed the remaining outstanding balance.
   - **Payment Date:** Defaults to today.
   - **Method:** `Bank Transfer`, `UPI`, `Cash`, `Cheque`, or `Card`.
   - **Reference / UTR:** Transaction identifier.
4. Click **Save Payment**. The invoice's `paidAmount` increases and `outstandingAmount` decreases immediately.

---

## 22. Voiding a Payment
If a payment was recorded erroneously (e.g., bounced cheque):
1. Click **Void** next to the specific payment record.
2. Provide a reason.
3. The payment is cancelled and the invoice's outstanding balance is automatically restored.

---

## 23. Printing Documents
1. Open the document and click **Print** (or navigate to `/documents/:id/print`).
2. A clean, styled document view opens with headers, seller branding, line items, and bank details.
3. Click **Print Document** or press `Ctrl + P` / `Cmd + P` to send to your local printer.

---

## 24. Exporting to PDF
1. From Document View or the Document Table, click **Download PDF**.
2. The server generates a PDF via headless Chromium using the identical shared EJS template.
3. The PDF downloads immediately with legal headers and metadata.

---

## 25. Exporting Reports to Excel
1. In the Documents directory (`/documents`), apply any desired search or date filters.
2. Click **Export Excel**.
3. A styled `.xlsx` workbook downloads containing all filtered documents with currency formatting and summary formulas.

---

## 26. Audit Trail & Revision History
- Scroll to the bottom of any document view to inspect the **Audit & Revision History**.
- Every edit, status transition, payment, or restoration is logged with timestamp, user name, IP address, and precise field changes.

---

## 27. Deleting Documents (Soft Delete)
1. Click **Delete Document**.
2. Enter an explanation for the deletion.
3. The document is archived into `DELETED` status and hidden from active lists.

---

## 28. Restoring Deleted Documents
1. Filter the document directory by status: **DELETED**.
2. Open the deleted document and click **Restore Document**.
3. The document returns to `ACTIVE` status with all line items and histories intact.

---

## 29. Searching, Filtering, and Pagination
- **Search:** Enter client name or document number in the search bar.
- **Type Filter:** Switch between **All**, **Invoices**, and **Quotations**.
- **Status Filter:** Filter by **Active**, **Inactive**, **Void**, or **Deleted**.
- **Pagination:** Navigate between pages using the bottom controls.

---

## 30. Managing Business Profile & Settings
Navigate to **Settings** (`/settings`) to update:
- Company Legal Name and Display Name
- GSTIN and State Code
- Registered Office Address, Phone, and Email
- Bank Account, IFSC Code, Branch, and UPI ID
- Default Terms and Conditions

---

## 31. Managing Client Directory
Navigate to **Clients** (`/clients`):
- Add new corporate or individual customers.
- Maintain GSTIN numbers and state codes for automatic tax determination.
- Store billing and delivery addresses.

---

## 32. Managing Item Master Catalog
Navigate to **Items** (`/items`):
- Maintain your standard product and service catalog (preloaded with 21 industrial master items).
- Set default unit rates, measurement units, HSN/SAC codes, and GST rates.
- Quickly toggle active/inactive status right from the table row.
- Deactivate obsolete products without impacting historical invoices.

---

## 33. Managing Unit Master Catalog
Navigate to **Units** (`/units`):
- Create, inspect, edit, and deactivate measurement units across the organization.
- Standard symbols (`PCS`, `m`, `unit`, `Hours`, `Project`, `KG`, etc.) with database-enforced uniqueness.
- Toggle units active or inactive instantly via the table switch without full page reloads.
- Active units populate the Invoice and Quotation editor dropdowns automatically.
- Historical invoices remain completely unaffected if a unit is subsequently edited or deactivated.

---

## 34. Managing Team Members
Navigate to **Team** (`/team`):
- View the complete organization directory with user roles, status badges, and last activity timestamps.
- Filter team members by role (`OWNER`, `ADMIN`, `MANAGER`, `MEMBER`, `VIEWER`) and account status (`ACTIVE`, `INACTIVE`, `INVITED`).
- Click on any team member to view their individual user profile, effective permissions, and recent audit activity.
- Quickly toggle account activation status or soft-delete members (subject to role hierarchy and safety protections).

---

## 35. Roles and Permissions Matrix
Spark Admin provides five standard roles designed for business operations:

1. **OWNER:** Full organizational authority. Can invite/manage all roles, alter business profile settings, delete documents, and manage billing.
2. **ADMIN:** High-level administrator. Can manage users below Owner, edit company defaults, configure units and items, and manage documents. Cannot delete the Owner or assign permissions beyond Admin capabilities.
3. **MANAGER:** Operational supervisor. Can create and edit invoices, record payments, manage clients, and inspect reports. Cannot edit business profile settings or administer user roles.
4. **MEMBER:** Standard operational user. Can create and edit invoices and add clients. Cannot void payments or delete documents.
5. **VIEWER:** Read-only access. Can inspect quotations, invoices, reports, and master data without mutation rights.

### Custom Permission Overrides
Administrators can grant or revoke specific granular permissions on an individual user basis:
1. Open the user profile or click **Edit Permissions**.
2. Select the desired module permissions (e.g. allowing a Manager to view the Team Activity log).
3. Save changes. Granular overrides take effect immediately upon subsequent requests.

---

## 36. Inviting Users and Password Setup
To onboard a new employee or team member:
1. On the **Team** screen, click **+ Invite Member**.
2. Enter their Full Name, Email Address, and select their primary Role.
3. Optionally select custom permission overrides.
4. Click **Send Invitation**.
5. The system generates a cryptographic invitation link (`/invite/<token>`).
6. The invitee opens the link in their browser, enters their chosen password, and confirms.
7. Upon successful setup, the account status transitions from `INVITED` to `ACTIVE` and the user is redirected to the login screen.
8. If an invitation expires or is misplaced, administrators can click **Resend Invitation** or **Revoke Invitation** from the member actions menu.

---

## 37. Activity Audit Trail & Security Logs
Navigate to **Activity Logs** (`/team/activity`):
- Full immutable timeline of business events, including:
  - Document creations, edits, status transitions, and deletions.
  - Payment records and void events.
  - Client and Item catalog modifications.
  - Team invitations, role changes, permission adjustments, and account deactivations.
  - Administrative logins and logouts.
- Search logs by actor name, filter by functional module, or select a date window.
- Detailed JSON change metadata allows auditing exact before-and-after values for financial compliance.
- Access the **Team Analytics** screen (`/team/analytics`) to inspect action frequency graphs and top active users.
