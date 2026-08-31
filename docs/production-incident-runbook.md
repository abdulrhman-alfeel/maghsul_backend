# Production Incident Runbooks & Emergency Procedures

## 1. Severity Classification
- **SEV-1 (Critical)**: Total API outage, database connectivity loss, cross-tenant data leakage, double payment / unauthorized refund, secret exposure, or critical data corruption.
- **SEV-2 (Major)**: Realtime dispatcher degradation, push notification queue backlog exceeding threshold, or partial Moyasar webhook delay.
- **SEV-3 (Minor)**: Isolated single-user client error, non-blocking UI rendering glitch, or minor log warning.

## 2. Emergency Runbooks

### Runbook 1: API Down or Unresponsive (SEV-1)
1. Check container/process status: `docker compose ps` or `pm2 status`.
2. Inspect health probe: `curl -i http://localhost:8080/live` and `/ready`.
3. Check container logs for uncaught exceptions or env errors: `docker compose logs --tail=100 app`.
4. Restart application container gracefully: `docker compose restart app`.

### Runbook 2: Database Connectivity Lost / P1001 (SEV-1)
1. Verify PostgreSQL container / instance status on port `5432` / `5433`.
2. Check database connection pool exhaustion or active locks.
3. Restart PostgreSQL service if frozen: `docker compose restart postgres-test`.
4. Verify connection recovery via `/ready` endpoint.

### Runbook 3: Redis / Realtime Degraded (SEV-2)
1. Verify Redis process on port `6379` / `6380`.
2. Check Redis memory consumption (`used_memory`).
3. Verify Socket.IO Redis Adapter pub/sub status.
4. *Rule*: Never execute `FLUSHALL` or `FLUSHDB` on production Redis instances.

### Runbook 4: Payment Webhook Mismatch or Delay (SEV-1 / SEV-2)
1. Inspect `WebhookEvent` ledger for stuck `pending` or `failed` records.
2. Verify Moyasar signature header authentication.
3. Validate amount and currency integrity against `Payment` and `Order` models.
4. *Rule*: Never manually retry ambiguous payment charges without financial reconciliation.

### Runbook 5: Cross-Tenant Isolation Breach (SEV-1)
1. Immediately isolate affected account / identity session.
2. Revoke active JWT refresh tokens (`RefreshToken.deleteMany({ where: { userId } })`).
3. Inspect `ApplicationRegistry` and `CustomerMembership` mapping logs.
4. Deploy urgent hotfix patch following change management guidelines.
