#!/usr/bin/env bash
# Production & Staging PostgreSQL Backup Automation Script
# Uses DATABASE_URL environment variable (zero secret hardcoding)

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
BACKUP_FILE="${BACKUP_DIR}/db_backup_${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[$(date -u)] Starting PostgreSQL database backup..."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  exit 1
fi

pg_dump "${DATABASE_URL}" | gzip > "${BACKUP_FILE}"

if [ -f "${BACKUP_FILE}" ] && [ -s "${BACKUP_FILE}" ]; then
  echo "[$(date -u)] Database backup completed successfully: ${BACKUP_FILE}"
  
  # Retention cleanup: remove backups older than RETENTION_DAYS
  find "${BACKUP_DIR}" -name "db_backup_*.sql.gz" -type f -mtime +"${RETENTION_DAYS}" -delete || true
  echo "[$(date -u)] Backup retention policy enforced (${RETENTION_DAYS} days)."
else
  echo "ERROR: Backup file was not created or is empty!" >&2
  exit 1
fi
