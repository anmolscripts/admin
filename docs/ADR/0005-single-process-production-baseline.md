# ADR 0005: Single-Process Production Architecture Baseline

## Status
**ACCEPTED / FROZEN** (Core Baseline)

## Context
Spark Admin's operational baseline is designed for lean, high-reliability deployment on single Linux VPS servers (e.g., Ubuntu 24.04 LTS).

The current implementation utilizes:
- Express default session management (`MemoryStore`).
- In-memory sliding window rate limiting (`Map`).
- Local filesystem temporary buffers for headless Chromium PDF generation.

Deploying multiple worker processes (such as PM2 cluster mode or multi-container Kubernetes pods) without a distributed backing store causes immediate operational failure:
1. Sessions are not shared: requests hitting worker B fail authentication if logged into worker A.
2. Rate limits are fragmented: each process tracks separate counters.
3. PDF generation temp files could conflict without atomic sandboxing.

## Decision
We formally define the production operational baseline as a **Strictly Single-Process Node.js Architecture**:
1. In `systemd`, the application is configured as a single `simple` service without process clustering.
2. In PM2 (if used), execution is locked to `instances: 1` (fork mode only).
3. Horizontal scaling across multiple processes or containers is deferred until a distributed Redis tier is introduced.

## Consequences
### Positive
- Zero external infrastructure dependency on Redis or memcached.
- Ultra-low operational overhead, minimal server memory footprint (<150MB baseline).
- Simple backup, update, and logging workflows.

### Negative / Trade-offs
- CPU throughput is limited to a single Node.js event-loop core.
- Application restart clears active sessions in `MemoryStore` (forcing users to log in again).

## What Future Developers Must Not Casually Reverse
**Do NOT configure multi-process clustering (PM2 cluster mode, multiple replicas) without first migrating `express-session` and rate limiting to a distributed store (Redis).**
Attempting to scale horizontally without Redis will cause intermittent authentication drops for users.
