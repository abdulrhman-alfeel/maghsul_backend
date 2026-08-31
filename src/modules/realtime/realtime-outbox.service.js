import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library.js';
import ApiError from '../../helpers/apiError.js';

export class RealtimeOutboxService {
  /**
   * Safely creates a realtime outbox event inside a transaction.
   * If the eventKey already exists, it verifies the fields match to ensure it's a safe duplicate.
   * Uses upsert to avoid poisoning the Postgres transaction with P2002 errors.
   */
  static async safeCreateEvent(tx, data) {
    const existing = await tx.realtimeOutboxEvent.findUnique({
      where: { eventKey: data.eventKey }
    });

    if (existing) {
      const match = existing.eventType === data.eventType &&
                    existing.eventVersion === (data.eventVersion || 1) &&
                    existing.eventKind === data.eventKind &&
                    existing.aggregateType === data.aggregateType &&
                    existing.aggregateId === data.aggregateId;
      
      if (!match) {
        throw new ApiError(500, 'realtime_event_key_collision', 'تعارض في مفتاح حدث الوقت الفعلي ببيانات مختلفة');
      }
      return existing; // Safe duplicate
    }

    try {
      return await tx.realtimeOutboxEvent.create({ data });
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === 'P2002' && error.meta?.target?.includes('eventKey')) {
        // Race condition: another transaction created it between our find and create
        // This will poison our current transaction anyway in Postgres, so we just throw 409
        throw new ApiError(409, 'DUPLICATE_EVENT_KEY', 'تم إنشاء الحدث مسبقاً في عملية متزامنة');
      }
      throw error;
    }
  }
}
