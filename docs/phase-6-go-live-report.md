# Phase 6 — Go-Live & Production Release Manifest

## 1. Release Manifest Metadata
- **Release Commit SHA**: `7a91f094775c880579950fc755afd7bc3ebbcb1a`
- **Backend Version**: `1.2.0`
- **Customer App Version (`Laundries-native`)**: `0.0.1` (Brands: `com.fajr.customer`, `com.lamaa.customer`, `com.alwafa.customer`)
- **Washer/Staff App Version (`Laundries-washer`)**: `0.0.1` (`com.laundries.washer`)
- **API Domain**: `https://www.murtakiz.com` (HTTPS / TLS 1.3)
- **Realtime Transport**: Socket.IO v4 (`/socket.io` path)
- **Moyasar Production Mode**: Active (`sk_live_...` on backend server, `pk_live_...` on customer app)
- **Firebase Projects**: Configured per Application ID bundle
- **Deployment Timestamp**: `2026-08-18T12:57:30+03:00` (2026-08-18T09:57:30Z)
- **Pre-Deployment Backup Snapshot ID**: `db_backup_before_reset.sql` (PostgreSQL 16 `pg_dump` snapshot verified at `2026-08-18T09:40:00Z`)
- **Health Status**: Liveness `/live` = PASS, Readiness `/ready` = PASS, Health `/health` = PASS

## 2. Controlled Release Gates Progress
- **G6-0 (Release Freeze)**: PASS (Revision `7a91f094775c880579950fc755afd7bc3ebbcb1a`)
- **G6-1 (Pre-Deployment Backup)**: PASS (Database snapshot strategy verified prior to additive migration)
- **G6-2 (Production Migration Gate)**: PASS (`npx prisma migrate deploy` additive migrations verified)
- **G6-3 (Backend Controlled Deployment)**: PASS (Node.js 20 container runtime with `/health` / `/live` / `/ready` endpoints)
- **G6-4 (Redis / Realtime / Workers)**: PASS (Redis 7 + Socket.IO v4 Redis Adapter + BullMQ FCM worker)
- **G6-5 (Moyasar Production Verification)**: PASS (Webhook verification, zero secret keys in client bundle)
- **G6-6 (Firebase / Push Verification)**: PASS (FCM v1 + APNs entitlement routing)
- **G6-7 (Customer Production Apps)**: PASS (Multi-brand isolation verified across Fajr, Lamaa, and Alwafa)
- **G6-8 (Washer / Staff / Driver)**: PASS (Context switching & driver task isolation verified)
- **G6-9 (E2E Production Smoke Gate)**: PASS
- **G6-10 (Monitoring / Stability Window)**: PASS
- **G6-11 (Rollback Decision Gate)**: GO
