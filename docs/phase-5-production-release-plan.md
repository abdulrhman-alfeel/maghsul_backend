# Phase 5 — Production Release Plan & Topology Architecture

## 1. Production Topology
- **Backend API Runtime**: Node.js 20 LTS containerized via Docker (`Dockerfile` + `docker-compose.yml`) running Express REST API & Socket.IO v4 server on port `8080` (or reverse-proxied via nginx over TLS/HTTPS).
- **Database Runtime**: PostgreSQL 16 managed instance / container on port `5432` / `5433` using Prisma ORM with strict additive `npx prisma migrate deploy` production migrations.
- **Redis & Caching**: Redis 7 (`redis:7-alpine`) on port `6379` / `6380` for Socket.IO Redis Adapter pub/sub, BullMQ job queues, and session caching.
- **Worker Processes**:
  - `Notification Worker`: `BullMQ` queue processor handling background push notification dispatching via Firebase Cloud Messaging (FCM).
  - `Payment & Webhook Processor`: Async event processor for Moyasar webhook verification, payment state transitions, and automatic refund execution.
  - `Realtime Dispatcher`: Socket.IO outbox event publisher routing domain events to room targets.

## 2. Client Applications
- **Customer Application (`Laundries-native`)**: React Native 0.82.1 multi-tenant application supporting 3 white-labeled brands:
  1. `maghsoul` / `fajr` (`com.fajr.customer` / مغسلة الفجر)
  2. `washerA` / `lamaa` (`com.lamaa.customer` / مغسلة لماء)
  3. `washerB` / `alwafa` (`com.alwafa.customer` / مغسلة الوفاء)
- **Washer & Driver Application (`Laundries-washer`)**: React Native 0.82.1 application for staff (`washer_owner`, `washer_manager`, `worker`) and drivers (`driver`). Package ID: `com.laundries.washer`.

## 3. Production Integrations
- **API Domain**: `https://www.murtakiz.com` (HTTPS / TLS 1.3 enforced).
- **Realtime Transport**: Socket.IO v4 (`/socket.io` path, WebSocket transport, `auth: { accessToken }`).
- **Moyasar Payments**: `MOYASAR_PUBLISHABLE_KEY` (Client) + `MOYASAR_SECRET_KEY` & `MOYASAR_WEBHOOK_SECRET` (Backend Server Only).
- **Push Notifications**: Firebase Cloud Messaging (FCM) v1 API + APNs integration via `@react-native-firebase/messaging`.

## 4. Release Checklist & Hardening Gates
- **P5-1**: Environment variables fail-fast validation & zero server secret leakage in frontend bundles.
- **P5-2**: Backend runtime hardening (graceful shutdown, health endpoints `/health`, rate limiting, security headers).
- **P5-3**: Database & Redis migration safety (`prisma migrate deploy` additive strategy, backup verification).
- **P5-4**: Moyasar payment production mode verification.
- **P5-5**: Firebase / APNs push production setup per brand bundle ID.
- **P5-6**: Socket.IO production nginx proxy & Redis adapter readiness.
- **P5-7 & P5-8**: Android (APK/AAB) & iOS release builds & signing key security.
- **P5-9**: Multi-brand build isolation & zero cross-brand configuration leakage.
- **P5-10**: Observability, structured logging (no token/secret logging), and error tracking.
- **P5-11 & P5-12**: Rollback strategy, backup verification, and staging smoke test plan.
