/**
 * accountDeletion.worker.js
 * Job دوري يعمل كل يوم الساعة 2 صباحاً لتنفيذ الحذف النهائي
 * للحسابات التي انتهت مهلة الـ 30 يوم.
 *
 * Apple Guideline 5.1.1(v) — الحذف تلقائي بدون تدخل يدوي.
 */

import { Worker, Queue } from 'bullmq';
import { randomBytes } from 'crypto';
import { createWorkerRedisClient } from '../config/redis.js';
import prisma from '../config/db.js';
import logger from '../config/logger.js';

const QUEUE_NAME = 'accountDeletion';

let deletionQueue = null;
let worker = null;
let queueRedis = null;
let workerRedis = null;

/**
 * Standalone executor for account deletion cleanup.
 * Can be called by the BullMQ worker or directly in integration tests.
 *
 * @param {Date} [referenceDate]
 * @returns {Promise<{ processed: number, successCount: number, errorCount: number }>}
 */
export async function executeAccountDeletionCleanup(referenceDate = new Date()) {
  const now = referenceDate;

  // جلب جميع الهويات المجدولة للحذف التي انتهت مهلتها
  const expiredIdentities = await prisma.identity.findMany({
    where: {
      status: 'pending_deletion',
      scheduledDeletionAt: { lte: now },
    },
    select: { id: true, name: true, phone: true },
  });

  if (expiredIdentities.length === 0) {
    logger.info('AccountDeletion: No expired accounts found');
    return { processed: 0, successCount: 0, errorCount: 0 };
  }

  logger.info(`AccountDeletion: Found ${expiredIdentities.length} accounts to anonymize`);

  let successCount = 0;
  let errorCount = 0;

  for (const identity of expiredIdentities) {
    try {
      const anonSuffix = randomBytes(12).toString('hex'); // 24 hex characters

      await prisma.$transaction([
        // 1. Anonymize Identity
        prisma.identity.update({
          where: { id: identity.id },
          data: {
            status: 'deleted',
            name: 'مستخدم محذوف',
            phone: `anon_${anonSuffix}`,
            avatarUrl: null,
            deletedAt: now,
            anonymizedAt: now,
          },
        }),
        // 2. Revoke all active Sessions
        prisma.session.updateMany({
          where: { identityId: identity.id, isRevoked: false },
          data: {
            isRevoked: true,
            revokedReason: 'account_deleted',
            revokedAt: now,
          },
        }),
        // 3. Revoke all active RefreshTokens
        prisma.refreshToken.updateMany({
          where: { session: { identityId: identity.id }, isRevoked: false },
          data: {
            isRevoked: true,
            revokedReason: 'account_deleted',
            revokedAt: now,
          },
        }),
        // 4. Invalidate User Devices
        prisma.userDevice.updateMany({
          where: { identityId: identity.id },
          data: {
            tokenStatus: 'invalid',
            fcmToken: null,
          },
        }),
      ]);

      logger.info(`AccountDeletion: Anonymized identity ${identity.id}`);
      successCount++;
    } catch (err) {
      logger.error(`AccountDeletion: Failed to anonymize identity ${identity.id}`, {
        error: err.message,
      });
      errorCount++;
    }
  }

  logger.info(`AccountDeletion: Cleanup complete — success: ${successCount}, errors: ${errorCount}`);
  return { processed: expiredIdentities.length, successCount, errorCount };
}

// نتأكد من تسجيل الـ Job مرة واحدة فقط عند بدء التشغيل
async function scheduleCleanupJob() {
  try {
    const repeatableJobs = await deletionQueue.getRepeatableJobs();
    const alreadyScheduled = repeatableJobs.some(j => j.name === 'cleanup');
    if (!alreadyScheduled) {
      await deletionQueue.add(
        'cleanup',
        {},
        {
          repeat: { pattern: '0 2 * * *' }, // كل يوم الساعة 2:00 صباحاً
          jobId: 'account-deletion-cleanup',
        }
      );
      logger.info('AccountDeletion: Repeatable cleanup job scheduled (daily at 02:00)');
    }
  } catch (err) {
    logger.error('AccountDeletion: Failed to schedule cleanup job', { error: err.message });
  }
}

export async function startAccountDeletionWorker() {
  if (worker || deletionQueue) return;

  queueRedis = createWorkerRedisClient();
  workerRedis = createWorkerRedisClient();

  deletionQueue = new Queue(QUEUE_NAME, { connection: queueRedis });
  await scheduleCleanupJob();

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      logger.info('AccountDeletion: Starting cleanup job', { jobId: job.id });
      await executeAccountDeletionCleanup(new Date());
    },
    {
      connection: workerRedis,
      concurrency: 1, // معالجة واحدة في كل مرة لضمان السلامة
    }
  );

  worker.on('completed', (job) => {
    logger.info('AccountDeletion: Job completed', { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('AccountDeletion: Job failed', { jobId: job?.id, error: err.message });
  });
}

export async function stopAccountDeletionWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (deletionQueue) {
    await deletionQueue.close();
    deletionQueue = null;
  }
  if (workerRedis) {
    await workerRedis.quit().catch(() => {});
    workerRedis = null;
  }
  if (queueRedis) {
    await queueRedis.quit().catch(() => {});
    queueRedis = null;
  }
}

export default worker;
