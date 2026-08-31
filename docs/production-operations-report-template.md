# Production Operations Periodic Status Report Template

**Reporting Window**: `[Start Date]` to `[End Date]`
**Release Version**: `v1.2.0` (Commit `7a91f094775c880579950fc755afd7bc3ebbcb1a`)

## 1. System Health & Availability Summary
- **API Availability Rate**: `[e.g. 99.98%]`
- **Average API Response Time (p95)**: `[e.g. 115ms]`
- **Total HTTP Requests**: `[Count]`
- **5xx Error Rate**: `[Percentage]`

## 2. Infrastructure & Operations Status
- **PostgreSQL Database Status**: `[HEALTHY / AT RISK]` (Connections: `[Active/Max]`, Storage: `[GB Used]`)
- **Redis & Queues Status**: `[HEALTHY / AT RISK]` (Memory: `[MB]`, Queue Backlog: `[Count]`)
- **Realtime Socket.IO Server**: `[HEALTHY / DEGRADED]` (Active Sockets: `[Count]`, Outbox Backlog: `[0]`)
- **FCM Push Notification Worker**: `[HEALTHY / AT RISK]` (Dispatched: `[Count]`, Failed: `[0]`)

## 3. Financial & Payment Webhook Operations
- **Total Webhook Events Processed**: `[Count]`
- **Webhook Failure / Mismatch Rate**: `[0.00%]`
- **Refund Operations Completed**: `[Count]`
- **Unresolved Financial Incidents**: `[0]`

## 4. Incidents & Action Items
- **SEV-1 Incidents**: `[0]`
- **SEV-2 Incidents**: `[0]`
- **SEV-3 Incidents**: `[0]`
- **Pending Maintenance / Operations Actions**: `[None]`
