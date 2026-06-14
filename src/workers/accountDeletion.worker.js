/**
 * accountDeletion.worker.js
 * Job دوري يعمل كل يوم الساعة 2 صباحاً لتنفيذ الحذف النهائي
 * للحسابات التي انتهت مهلة الـ 30 يوم.
 *
 * Apple Guideline 5.1.1(v) — الحذف تلقائي بدون تدخل يدوي.
 */

import { Worker, Queue } from 'bullmq';
import { randomBytes } from 'crypto';
import ioredis from '../config/redis.js';
import prisma from '../config/db.js';
import logger from '../config/logger.js';

const QUEUE_NAME = 'accountDeletion';
const connection = ioredis;

// ── إنشاء Queue وإضافة Job متكرر (يومي الساعة 2 صباحاً) ──────────────
const deletionQueue = new Queue(QUEUE_NAME, { connection });

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

scheduleCleanupJob();

// ── Worker الذي ينفذ الحذف الفعلي ─────────────────────────────────────
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    logger.info('AccountDeletion: Starting cleanup job', { jobId: job.id });

    const now = new Date();

    // جلب جميع الحسابات المجدولة للحذف التي انتهت مهلتها
    const expiredUsers = await prisma.user.findMany({
      where: {
        status: 'pending_deletion',
        scheduledDeletionAt: { lte: now },
      },
      select: { id: true, name: true, role: true, washerId: true },
    });

    if (expiredUsers.length === 0) {
      logger.info('AccountDeletion: No expired accounts found');
      return;
    }

    logger.info(`AccountDeletion: Found ${expiredUsers.length} accounts to anonymize`);

    let successCount = 0;
    let errorCount = 0;

    for (const user of expiredUsers) {
      try {
        // anonymization: بيانات عشوائية لا تحتوي أي معلومة حقيقية
        const anonSuffix = randomBytes(12).toString('hex'); // 24 حرف عشوائي

        await prisma.user.update({
          where: { id: user.id },
          data: {
            status: 'deleted',
            name: 'مستخدم محذوف',
            // phone يصبح سلسلة عشوائية لكسر unique constraint بأمان
            phone: `anon_${anonSuffix}`,
            fcmToken: null,
            deviceType: null,
            tokenUpdatedAt: null,
            avatarUrl: null,
            deletedAt: now,
            anonymizedAt: now,
          },
        });

        logger.info(`AccountDeletion: Anonymized user ${user.id} (role: ${user.role})`);
        successCount++;
      } catch (err) {
        logger.error(`AccountDeletion: Failed to anonymize user ${user.id}`, {
          error: err.message,
        });
        errorCount++;
      }
    }

    logger.info(`AccountDeletion: Cleanup complete — success: ${successCount}, errors: ${errorCount}`);
  },
  {
    connection,
    concurrency: 1, // معالجة واحدة في كل مرة لضمان السلامة
  }
);

worker.on('completed', (job) => {
  logger.info('AccountDeletion: Job completed', { jobId: job.id });
});

worker.on('failed', (job, err) => {
  logger.error('AccountDeletion: Job failed', { jobId: job?.id, error: err.message });
});

export default worker;
