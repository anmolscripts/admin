# Spark Admin Documentation Directory

Welcome to the comprehensive technical and operational documentation for **Spark Admin**.

This directory contains the authoritative architecture specifications, database schemas, API references, development guidelines, security models, and lifecycle contracts for the application.

---

## Documentation Index

### Core Architecture & System Contracts
- [ARCHITECTURE.md](file:///c:/Users/User/Documents/project/admin/docs/ARCHITECTURE.md)
  *Detailed system architecture, layered design pattern (Express 5, Controllers, Services, Prisma ORM 7, MySQL 8), middleware pipeline, EJS templating, and boundary rules.*
- [CORE_CONTRACTS.md](file:///c:/Users/User/Documents/project/admin/docs/CORE_CONTRACTS.md)
  *The frozen core architectural baseline. Documents the 20 foundational invariants that must not be casually altered.*
- [DOCUMENT_LIFECYCLE.md](file:///c:/Users/User/Documents/project/admin/docs/DOCUMENT_LIFECYCLE.md)
  *Complete state transition matrix, terminal states, restoration rules, conversion rules, and optimistic locking mechanisms.*
- [RBAC.md](file:///c:/Users/User/Documents/project/admin/docs/RBAC.md)
  *Role-Based Access Control architecture: 5-tier role hierarchy, permission dictionary, delegation boundaries, invitation flows, and controller/middleware patterns.*
- [USER_ACTIVITY.md](file:///c:/Users/User/Documents/project/admin/docs/USER_ACTIVITY.md)
  *Operational user activity logging and security audit trail specification: atomic events, schema, sanitization rules, and analytics endpoints.*
- [DATABASE.md](file:///c:/Users/User/Documents/project/admin/docs/DATABASE.md)
  *Comprehensive database schema reference covering all production Prisma models, relations, indices, migrations history, and deployment policies.*

### API & Interface References
- [API.md](file:///c:/Users/User/Documents/project/admin/docs/API.md)
  *Exhaustive HTTP and REST API documentation detailing authentication, CSRF headers, request payloads, response bodies, and error status codes.*
- [USER_MANUAL.md](file:///c:/Users/User/Documents/project/admin/docs/USER_MANUAL.md)
  *End-to-end user manual explaining how to manage documents, clients, items, units, team members, RBAC permissions, audit histories, and exports.*

### Developer & Operational Handbooks
- [DEVELOPER_HANDBOOK.md](file:///c:/Users/User/Documents/project/admin/docs/DEVELOPER_HANDBOOK.md)
  *New developer onboarding guide: local prerequisites, environment setup, database provisioning, test suite execution, and workflow commands.*
- [DEVELOPMENT_WORKFLOW.md](file:///c:/Users/User/Documents/project/admin/docs/DEVELOPMENT_WORKFLOW.md)
  *Git branching model, commit guidelines, PR checklist, and policy on core vs. feature modifications.*
- [CODING_STANDARDS.md](file:///c:/Users/User/Documents/project/admin/docs/CODING_STANDARDS.md)
  *Project code conventions: CommonJS, async/await error handling, controller/service separation, secure EJS rendering, and prohibited antipatterns.*
- [TESTING.md](file:///c:/Users/User/Documents/project/admin/docs/TESTING.md)
  *Testing architecture using Node's native test runner (`node:test`), focused suite execution, concurrency testing, and resource teardown patterns.*
- [SECURITY.md](file:///c:/Users/User/Documents/project/admin/docs/SECURITY.md)
  *Security architecture: bcrypt salted hashing, timing attack mitigation, CSRF tokens, rate limiting, secure cookies, and single-process limitations.*
- [DEPLOYMENT.md](file:///c:/Users/User/Documents/project/admin/docs/DEPLOYMENT.md)
  *Production deployment guide for Linux VPS (Ubuntu 24.04/22.04 LTS): systemd service configuration, Nginx reverse proxy, TLS, backup, and restore.*
- [RELEASE_CHECKLIST.md](file:///c:/Users/User/Documents/project/admin/docs/RELEASE_CHECKLIST.md)
  *Rigorous step-by-step verification checklist required prior to tagging or releasing production builds.*
- [CHANGELOG.md](file:///c:/Users/User/Documents/project/admin/docs/CHANGELOG.md)
  *Chronological release history tracking Phase 1 through Phase 8.3 and the Core Baseline Freeze.*

### Architecture Decision Records (ADR)
- [ADR Index & Guidelines](file:///c:/Users/User/Documents/project/admin/docs/ADR/README.md)
  - [ADR 0001: Shared Document Model for Quotations & Invoices](file:///c:/Users/User/Documents/project/admin/docs/ADR/0001-shared-document-model.md)
  - [ADR 0002: Server-Authoritative Financial & Tax Calculations](file:///c:/Users/User/Documents/project/admin/docs/ADR/0002-server-authoritative-financial-calculation.md)
  - [ADR 0003: Single Shared Template for Print & PDF Rendering](file:///c:/Users/User/Documents/project/admin/docs/ADR/0003-shared-print-pdf-template.md)
  - [ADR 0004: Item Master Snapshot Isolation & Unique Identity](file:///c:/Users/User/Documents/project/admin/docs/ADR/0004-item-master-snapshot-and-uniqueness.md)
  - [ADR 0005: Single-Process Production Architecture Baseline](file:///c:/Users/User/Documents/project/admin/docs/ADR/0005-single-process-production-baseline.md)
  - [ADR 0006: Unit Master Management & Document-Level Client Snapshotting](file:///c:/Users/User/Documents/project/admin/docs/ADR/0006-unit-master-and-client-snapshot.md)
  - [ADR 0007: RBAC Hierarchy Enforcement, Delegation Boundaries, and Immutable Audit Trails](file:///c:/Users/User/Documents/project/admin/docs/ADR/0007-rbac-hierarchy-and-audit-security.md)

---

## Documentation Maintenance Rules
1. **Never Document Imagined APIs:** Documentation must strictly reflect active, tested production code.
2. **Never Commit Secrets:** Do not include real API keys, production passwords, or active session hashes in examples.
3. **Core Freeze Compliance:** Any proposed modification to core architectural contracts must follow the ADR creation process outlined in [docs/ADR/README.md](file:///c:/Users/User/Documents/project/admin/docs/ADR/README.md).
