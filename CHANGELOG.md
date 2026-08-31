# Changelog

All notable changes to the Laundry Platform backend and client applications will be documented in this file.

## [1.2.0] - 2026-08-18 (Go-Live Release)

### Added
- **Canonical Payment Realtime Event**: Standardized `payment.status_updated` (version `1`) realtime event envelope for Socket.IO dispatching.
- **Secure Token Persistence**: Encrypted Native Secure Storage integration for `refreshToken` handling process-death recovery on React Native 0.82.1.
- **Multi-Tenant Brand Pipeline**: Automated CLI branding pipeline supporting `com.fajr.customer`, `com.lamaa.customer`, and `com.alwafa.customer`.
- **Health & Readiness Endpoints**: Container probe endpoints `/live`, `/ready`, and `/health` for production orchestrators.
- **Outbox Recovery & Deduplication**: LRU event deduplication and outbox processing for Socket.IO events and FCM push notifications.

### Security & Hardening
- Zero server secrets in client bundles (verified 0 occurrences of `MOYASAR_SECRET_KEY`, `JWT_SECRET`, `DATABASE_URL`).
- Timing-safe Moyasar webhook signature verification (`crypto.timingSafeEqual`).
- Strict additive database migration policy (`npx prisma migrate deploy`).
- BOLA/IDOR protection enforcing identity and washer ownership on every API endpoint.

### Testing & Quality Baseline
- Backend Regression: 57 Test Suites PASS, 553 Tests PASS.
- Combined Frontend: 17 Test Suites PASS, 80 Tests PASS.
