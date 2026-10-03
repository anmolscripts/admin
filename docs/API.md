# REST & HTTP API Reference

## 1. Overview & General Conventions

All API endpoints are mounted under `/api/` (except authentication and web presentation routes).

### Common Headers
- **Content-Type:** `application/json` (or `application/x-www-form-urlencoded` for standard forms)
- **Cookie:** `spark.sid=<session_cookie>` (required for all authenticated endpoints)
- **x-csrf-token:** `<csrf_token>` (required for all `POST`, `PUT`, `PATCH`, `DELETE` requests)

### Standard Success Response
```json
{
  "success": true,
  "data": { ... }
}
```

### Standard Error Response
```json
{
  "success": false,
  "error": "Descriptive human-readable error message"
}
```

---

## 2. Authentication Endpoints

### 2.1. `POST /login`
- **Auth Required:** No
- **CSRF Required:** Yes (`_csrf` in body)
- **Rate Limited:** Yes (10 attempts / 15 mins)
- **Payload:**
  ```json
  {
    "email": "admin@email.com",
    "password": "your-password",
    "_csrf": "csrf_token_here"
  }
  ```
- **Responses:**
  - `302 Found`: Redirects to `/dashboard` on successful credentials. Sets `spark.sid` session cookie.
  - `401 Unauthorized`: Invalid credentials.
  - `429 Too Many Requests`: Exceeded rate limit.

### 2.2. `POST /logout`
- **Auth Required:** Yes
- **CSRF Required:** Yes
- **Responses:**
  - `302 Found`: Destroys session, clears cookie, redirects to `/login`.

---

## 3. Documents API (`/api/invoices`)

### 3.1. `GET /api/invoices`
- **Description:** Retrieve paginated and filtered list of quotations and invoices.
- **Query Parameters:**
  - `page` (default: 1)
  - `limit` (default: 10, max: 100)
  - `documentType` (`QUOTATION` | `INVOICE`)
  - `status` (`ACTIVE` | `INACTIVE` | `VOID` | `DELETED`)
  - `search` (Search query matching document number or client name)
  - `startDate`, `endDate` (ISO date filter on `invoiceDate`)
- **Response:** `200 OK`
  ```json
  {
    "success": true,
    "data": [
      {
        "id": 1,
        "documentType": "INVOICE",
        "invoiceNumber": "INV-2026-0001",
        "clientName": "Acme Corp",
        "invoiceDate": "2026-10-01",
        "dueDate": "2026-10-31",
        "grandTotal": 11800.00,
        "paidAmount": 0.00,
        "outstandingAmount": 11800.00,
        "status": "ACTIVE"
      }
    ],
    "pagination": { "page": 1, "limit": 10, "total": 1, "totalPages": 1 }
  }
  ```

### 3.2. `GET /api/invoices/:id`
- **Description:** Retrieve full document object with items, revisions, and payment ledger.
- **Response:** `200 OK` with full document graph, or `404 Not Found`.

### 3.3. `POST /api/invoices`
- **Description:** Create a new quotation or invoice.
- **Payload:**
  ```json
  {
    "documentType": "INVOICE",
    "invoiceDate": "2026-10-02",
    "dueDate": "2026-11-01",
    "clientId": 5,
    "clientName": "Acme Corp",
    "clientEmail": "billing@acme.com",
    "clientPhone": "+91 9876543210",
    "clientGSTIN": "27AABCU9603R1ZM",
    "placeOfSupplyStateCode": "27",
    "billingAddress": "42 High Street, Mumbai",
    "shippingAddress": "42 High Street, Mumbai",
    "gstEnabled": true,
    "gstRate": 18,
    "termsAndConditions": "Payment due within 30 days.",
    "remarks": "Thank you for your business.",
    "items": [
      {
        "lineNumber": 1,
        "name": "Cloud Architecture Consulting",
        "quantity": 10,
        "unit": "HOURS",
        "rate": 2500,
        "hsnSac": "998313"
      }
    ]
  }
  ```
- **Response:** `201 Created` with created document object.
- **Errors:** `400 Bad Request` (validation errors: empty items, invalid dates, negative values).

### 3.4. `PUT /api/invoices/:id`
- **Description:** Update an existing quotation or invoice with optimistic locking.
- **Payload:** Same as create, with mandatory `version`:
  ```json
  {
    "version": 1,
    ...
  }
  ```
- **Response:** `200 OK` with updated document.
- **Errors:**
  - `400 Bad Request`: Validation failure.
  - `404 Not Found`: Nonexistent ID.
  - `409 Conflict`: Concurrency version mismatch (`Document has been modified by another user.`).

### 3.5. `PATCH /api/invoices/:id/status`
- **Description:** Transition document status.
- **Payload:** `{ "status": "INACTIVE" | "ACTIVE" | "VOID" }`
- **Response:** `200 OK`
- **Errors:** `400 Bad Request` if attempting prohibited transition or modifying `VOID`.

### 3.6. `DELETE /api/invoices/:id`
- **Description:** Soft-delete a document.
- **Payload:** `{ "reason": "Customer cancelled order" }`
- **Response:** `200 OK`

### 3.7. `POST /api/invoices/:id/restore`
- **Description:** Restore a soft-deleted document back to `ACTIVE`.
- **Response:** `200 OK`

### 3.8. `POST /api/invoices/:id/convert`
- **Description:** Convert an active `QUOTATION` into a new `INVOICE`.
- **Payload (Optional):** `{ "dueDate": "2026-11-15" }`
- **Response:** `201 Created` with newly created invoice record.

### 3.9. `GET /api/invoices/:id/copy`
- **Description:** Retrieve a sanitized draft template of an existing document suitable for cloning.
- **Response:** `200 OK` with cloned line items and client data (excluding ID, number, payments).

### 3.10. `GET /api/invoices/:id/history`
- **Description:** Retrieve append-only audit revisions for a document.
- **Response:** `200 OK` with ordered list of `InvoiceRevision` records.

---

## 4. Export Endpoints

### 4.1. `GET /api/invoices/:id/pdf`
- **Description:** Generate and stream high-fidelity PDF using headless Chromium.
- **Headers Returned:**
  - `Content-Type: application/pdf`
  - `Content-Disposition: attachment; filename="INV-2026-0001.pdf"`
- **Response:** Raw binary PDF buffer (`%PDF-` magic header).

### 4.2. `GET /api/invoices/export/excel`
- **Description:** Export documents as formatted multi-sheet Excel workbook.
- **Query Parameters:** `documentType`, `status`, `search`, `dateFrom`, `dateTo`.
- **Headers Returned:**
  - `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- **Response:** Raw binary XLSX buffer.

---

## 5. Payments API

### 5.1. `GET /api/invoices/:id/payments`
- **Description:** Retrieve all recorded payments for an invoice.
- **Response:** `200 OK` with array of payment records.

### 5.2. `POST /api/invoices/:id/payments`
- **Description:** Record a payment receipt against an active invoice.
- **Payload:**
  ```json
  {
    "amount": 5000.00,
    "paymentDate": "2026-10-02",
    "method": "BANK_TRANSFER",
    "reference": "UTR9988221100",
    "notes": "First milestone payment"
  }
  ```
- **Response:** `201 Created`
- **Errors:** `400 Bad Request` if invoice is void/inactive or amount exceeds outstanding balance.

### 5.3. `POST /api/payments/:id/void`
- **Description:** Void a previously recorded payment transaction.
- **Payload:** `{ "reason": "Bounced cheque" }`
- **Response:** `200 OK`

---

## 6. Item Master API (`/api/items`)

### 6.1. `GET /api/items/search?q=query`
- **Description:** Asynchronous autocomplete search matching item names.
- **Response:** `200 OK` with array of matching items.

### 6.2. `GET /api/items`
- **Description:** Paginated catalog listing with search and active status filters.

### 6.3. `POST /api/items`
- **Description:** Create catalog item.
- **Payload:** `{ "name": "Standard Hosting", "unit": "MONTH", "rate": 1500, "gstRate": 18 }`

### 6.4. `PUT /api/items/:id`
- **Description:** Update catalog item properties.

---

## 7. Clients API (`/api/clients`)

- `GET /api/clients`: Paginated directory.
- `GET /api/clients/search?q=query`: Fast client autocomplete.
- `GET /api/clients/:id`: Single client details.
- `POST /api/clients`: Create client (`name` required; `email` and `phone` optional).
- `PUT /api/clients/:id`: Update client.
- `PATCH /api/clients/:id/status`: Toggle active status.

---

## 8. Unit Master API (`/api/units`)

### 8.1. `GET /api/units/active`
- **Description:** Retrieve list of active measurement units for document editor dropdowns.
- **Response:** `200 OK`
  ```json
  {
    "success": true,
    "data": [
      { "id": 1, "name": "Piece", "symbol": "PCS", "active": true },
      { "id": 2, "name": "Meter", "symbol": "m", "active": true },
      { "id": 3, "name": "Unit", "symbol": "unit", "active": true }
    ]
  }
  ```

### 8.2. `GET /api/units`
- **Description:** Paginated list of all measurement units with search and active status filters.

### 8.3. `POST /api/units`
- **Description:** Create new measurement unit.
- **Payload:** `{ "name": "Kilowatt Hour", "symbol": "kWh", "description": "Energy consumption" }`

### 8.4. `PUT /api/units/:id`
- **Description:** Update measurement unit details or toggle status.

### 8.5. `PATCH /api/units/:id/status`
- **Description:** Toggle active/inactive status.
- **Payload:** `{ "active": true }`

### 8.6. `DELETE /api/units/:id`
- **Description:** Delete a measurement unit.

---

## 9. Dashboard & System Endpoints

### 9.1. `GET /api/dashboard/metrics`
- **Query Parameters:** `range` (`today` | `this_week` | `this_month` | `this_quarter` | `this_year` | `custom`), `from`, `to`.
- **Response:** `200 OK` with counts, sums, overdue totals, and 6-point chart series.

### 9.2. `GET /health`
- **Auth Required:** No
- **Response:** `200 OK` `{ "status": "ok", "timestamp": "...", "uptime": 1234, "database": "connected" }`

---

## 10. Team & Role-Based Access Control API (`/api/team*`)

All team management endpoints require authentication and corresponding RBAC permissions (`TEAM:VIEW`, `TEAM:MANAGE`).

### 10.1. `GET /api/team`
- **Permission Required:** `TEAM:VIEW`
- **Description:** Retrieve paginated list of team members with assigned roles, statuses, and custom permission counts.
- **Query Parameters:** `page`, `limit`, `search`, `role`, `status` (`ACTIVE` | `INACTIVE` | `INVITED`)
- **Response:** `200 OK`
  ```json
  {
    "success": true,
    "data": [
      {
        "id": 1,
        "name": "Jane Owner",
        "email": "owner@company.com",
        "role": { "name": "OWNER", "description": "Full organization owner" },
        "active": true,
        "customPermissionsCount": 0
      }
    ],
    "pagination": { "page": 1, "limit": 10, "total": 1, "totalPages": 1 }
  }
  ```

### 10.2. `GET /api/team/:id`
- **Permission Required:** `TEAM:VIEW`
- **Description:** Retrieve individual team member details, role assignment, and direct user permissions.
- **Response:** `200 OK`

### 10.3. `POST /api/team`
- **Permission Required:** `TEAM:MANAGE`
- **Description:** Invite a new team member and dispatch an onboarding invitation token.
- **Payload:**
  ```json
  {
    "name": "Alex Smith",
    "email": "alex@company.com",
    "roleId": 3,
    "permissions": [1, 2, 5]
  }
  ```
- **Response:** `201 Created`
  ```json
  {
    "success": true,
    "data": { "id": 5, "email": "alex@company.com", "invitationToken": "..." }
  }
  ```

### 10.4. `PUT /api/team/:id`
- **Permission Required:** `TEAM:MANAGE`
- **Description:** Update member profile details, role, or base assignment.
- **Security Rule:** Cannot modify own profile via this endpoint. Target user role rank must be lower than actor role rank. Cannot grant permissions not held by actor.
- **Response:** `200 OK`

### 10.5. `PATCH /api/team/:id/status`
- **Permission Required:** `TEAM:MANAGE`
- **Description:** Activate or deactivate a team member account.
- **Payload:** `{ "active": false }`
- **Security Rule:** Cannot deactivate self. Cannot deactivate the last active OWNER or last active admin holding `TEAM:MANAGE`.
- **Response:** `200 OK`

### 10.6. `PUT /api/team/:id/permissions`
- **Permission Required:** `TEAM:MANAGE`
- **Description:** Explicitly assign or override granular permissions for a user.
- **Payload:** `{ "permissionIds": [3, 7, 12] }`
- **Security Rule:** Non-owners cannot grant permissions that they themselves do not possess.
- **Response:** `200 OK`

### 10.7. `POST /api/team/:id/invite/resend`
- **Permission Required:** `TEAM:MANAGE`
- **Description:** Regenerate and resend invitation link for pending invited members.
- **Response:** `200 OK`

### 10.8. `POST /api/team/:id/invite/revoke`
- **Permission Required:** `TEAM:MANAGE`
- **Description:** Revoke pending invitation token.
- **Response:** `200 OK`

### 10.9. `DELETE /api/team/:id`
- **Permission Required:** `TEAM:MANAGE`
- **Description:** Soft-delete or remove a team member.
- **Security Rule:** Cannot delete self. Cannot delete last active OWNER or administrator.
- **Response:** `200 OK`

### 10.10. `GET /api/team-roles` & `GET /api/team-permissions`
- **Permission Required:** `TEAM:VIEW`
- **Description:** Retrieve available role definitions (`OWNER`, `ADMIN`, `MANAGER`, `MEMBER`, `VIEWER`) and permission dictionary grouped by module.
- **Response:** `200 OK`

---

## 11. User Activity & Audit API (`/api/team-*`)

### 11.1. `GET /api/team-activity`
- **Permission Required:** `TEAM:ACTIVITY_VIEW`
- **Description:** Retrieve append-only audit trail of user activities and system mutations.
- **Query Parameters:** `page`, `limit`, `actorUserId`, `module` (`AUTH` | `DOCUMENTS` | `PAYMENTS` | `CLIENTS` | `ITEMS` | `UNITS` | `TEAM` | `SETTINGS`), `action`, `startDate`, `endDate`
- **Response:** `200 OK`
  ```json
  {
    "success": true,
    "data": [
      {
        "id": 142,
        "action": "CREATE_USER",
        "module": "TEAM",
        "targetType": "USER",
        "targetId": "12",
        "actor": { "id": 1, "name": "Admin", "email": "admin@company.com" },
        "ipAddress": "127.0.0.1",
        "metadata": { "email": "newuser@company.com", "role": "MANAGER" },
        "createdAt": "2026-10-03T12:00:00.000Z"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 142, "totalPages": 8 }
  }
  ```

### 11.2. `GET /api/team-analytics`
- **Permission Required:** `TEAM:ACTIVITY_VIEW`
- **Description:** Aggregated activity volume by module, top actors, and mutation velocity.
- **Response:** `200 OK`

---

## 12. Invitation & Account Activation API

### 12.1. `GET /invite/:token`
- **Auth Required:** No
- **Description:** Validate invitation token and present account password setup form.
- **Responses:**
  - `200 OK`: Form rendered if token is valid and unexpired.
  - `400 Bad Request`: Token invalid, expired, or already used.

### 12.2. `POST /invite/:token`
- **Auth Required:** No
- **CSRF Required:** Yes
- **Description:** Complete invitation by establishing password and activating the account.
- **Payload:** `{ "password": "secure-new-password", "_csrf": "..." }`
- **Response:** `302 Found` redirecting to `/login` upon success.
