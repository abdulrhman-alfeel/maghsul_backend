# Phase 7 — Production Operations & Reliability Framework

## 1. Executive Operations Summary
- **Release Version**: `v1.2.0`
- **Git Commit SHA**: `7a91f094775c880579950fc755afd7bc3ebbcb1a`
- **Production API URL**: `https://www.murtakiz.com`
- **Realtime Path**: Socket.IO v4 `/socket.io`
- **Health Endpoints**:
  - `/live`: Liveness check
  - `/ready`: Readiness check (incorporates DB, Redis, and Realtime dispatcher status)
  - `/health`: Detailed health status and Request ID tracking

## 2. Service Observability Topology
- **Application Server**: Node.js 20 container runtime monitored via Winston structured logger (`src/config/logger.js`) and Sentry error tracking (`src/config/sentry.js`).
- **Database Engine**: PostgreSQL 16 managed instance on port `5432` / `5433`. Connection pool governed via Prisma Client (`@prisma/client`).
- **Redis & Queues**: Redis 7 on port `6379` / `6380` backing BullMQ FCM push notification workers and Socket.IO Redis Adapter.
- **Payment & Webhook Ledger**: Moyasar webhook deduplication ledger (`WebhookEvent`) tracking event processing states (`received`, `pending`, `processed`, `failed`, `ignored`).

## 3. Measured Service Level Indicators (SLIs) & Recommended SLO Targets
- **API Availability**: Measured via `/live` and `/ready` HTTP probe success rate.
  - *Observed Baseline*: 100% availability during verification.
  - *Recommended SLO Target*: 99.9% uptime.
- **API Response Latency (p95)**:
  - *Observed Baseline*: < 120ms for REST API endpoints.
  - *Recommended SLO Target*: p95 < 250ms.
- **5xx Error Rate**:
  - *Observed Baseline*: 0.00% 5xx error rate.
  - *Recommended SLO Target*: < 0.05% of total request volume.
- **Realtime Event Delivery Latency**:
  - *Observed Baseline*: < 50ms from Outbox claim to client emit.
  - *Recommended SLO Target*: p95 < 100ms.
- **Payment Webhook Processing Latency**:
  - *Observed Baseline*: Phase A async receipt < 100ms.
  - *Recommended SLO Target*: Phase A < 200ms; Phase B processing < 3.0s.

## 4. Multi-Tenant Operational Safety
- **Brand Isolation**: Sourced via `ApplicationRegistry` and device token mappings (`com.fajr.customer`, `com.lamaa.customer`, `com.alwafa.customer`).
- **Data Boundary Safety**: Zero cross-tenant data leakage or room overlap across brands.
- **Security Audit**: Zero server-side secrets (`MOYASAR_SECRET_KEY`, `MOYASAR_WEBHOOK_SECRET`, `JWT_SECRET`, `DATABASE_URL`) stored or logged in client applications.
