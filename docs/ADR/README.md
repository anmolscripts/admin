# Architecture Decision Records (ADR)

## What is an Architecture Decision Record?

An **Architecture Decision Record (ADR)** captures a critical architectural choice made in the codebase, along with its business context, technical rationale, and long-term consequences.

Whenever a foundational technical decision is made that constrains future design or must not be reversed casually, an ADR is authored.

---

## ADR Index

| ADR | Title | Status | Date |
| :--- | :--- | :--- | :--- |
| [0001](file:///c:/Users/User/Documents/project/admin/docs/ADR/0001-shared-document-model.md) | Shared Document Model for Quotations & Invoices | **ACCEPTED / FROZEN** | 2026-10-01 |
| [0002](file:///c:/Users/User/Documents/project/admin/docs/ADR/0002-server-authoritative-financial-calculation.md) | Server-Authoritative Financial & Tax Calculation | **ACCEPTED / FROZEN** | 2026-10-01 |
| [0003](file:///c:/Users/User/Documents/project/admin/docs/ADR/0003-shared-print-pdf-template.md) | Single Shared Template for Print and PDF | **ACCEPTED / FROZEN** | 2026-10-02 |
| [0004](file:///c:/Users/User/Documents/project/admin/docs/ADR/0004-item-master-snapshot-and-uniqueness.md) | Item Master Snapshot Isolation & Unique Identity | **ACCEPTED / FROZEN** | 2026-10-02 |
| [0005](file:///c:/Users/User/Documents/project/admin/docs/ADR/0005-single-process-production-baseline.md) | Single-Process Production Architecture Baseline | **ACCEPTED / FROZEN** | 2026-10-02 |

---

## Guidelines for Proposing Core Architectural Changes

If future business requirements demand changing an accepted ADR:
1. Do **not** modify active core code silently.
2. Author a new ADR proposing the change, explaining why the existing decision is insufficient.
3. Document data migration strategies and backward compatibility.
4. Obtain consensus and provide automated test coverage.
