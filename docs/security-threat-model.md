# System Security Threat Model & Risk Assessment

## 1. Asset Classification
- **Tier A (Financial & Credentials)**: JWT Access/Refresh Secrets, Moyasar Webhook Secret, Database Credentials, Payment & Order Ledgers.
- **Tier B (Sensitive Customer PII)**: Customer phone numbers, delivery addresses, order histories.
- **Tier C (Operational Data)**: Washer item catalog, branch opening hours, coverage polygon zones.

## 2. Threat Vector Matrix & Mitigations

| Threat ID | Threat Category | Target | Vector / Description | Mitigation Status |
|---|---|---|---|---|
| **THREAT-01** | BOLA / IDOR | Order API | Customer A attempts to read/modify Order of Customer B | **MITIGATED**: Server-side `customerMembershipId` & `identityId` ownership check enforced on every query. |
| **THREAT-02** | Payment Tampering | Moyasar Webhook | Attacker sends fake webhook payload to set order as paid | **MITIGATED**: `crypto.timingSafeEqual` Moyasar Webhook Secret Token Authentication + webhook deduplication. |
| **THREAT-03** | Over-Refund | Refund API | Attacker issues multiple refunds exceeding original payment amount | **MITIGATED**: Cumulative refund check inside database transaction locks. |
| **THREAT-04** | Token Replay / Theft | Auth Session | Stolen refresh token used after logout or process death | **MITIGATED**: Refresh token rotation on use + Native Secure Storage (`EncryptedSharedPreferences` / `Keychain`). |
| **THREAT-05** | Driver Assignment Bypass | Driver Tasks | Driver A attempts to collect cash for Driver B's task | **MITIGATED**: Server checks `assignedDriverId` matches authenticated driver session ID. |
| **THREAT-06** | Realtime Event Injection | Socket.IO | Client emits fake `payment.status_updated` event to Socket server | **MITIGATED**: Inbound socket events cannot trigger business state transitions; server uses Outbox pattern only. |
