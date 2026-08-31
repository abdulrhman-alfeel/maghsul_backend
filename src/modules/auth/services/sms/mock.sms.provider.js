import { SmsProvider } from './sms.provider.js';
import logger from '../../../../config/logger.js';

export class MockSmsProvider extends SmsProvider {
  constructor() {
    super();
    this.lastOtpSent = null;
    this.lastMessageSent = null;
  }

  async sendSms(phone, message) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL: Cannot use MockSmsProvider in production');
    }

    // Extract OTP (assuming message contains digits)
    const match = message.match(/\d{4,6}/);
    if (match) {
      this.lastOtpSent = match[0];
    }
    this.lastMessageSent = message;

    if (process.env.ALLOW_MOCK_OTP_LOGGING === 'true') {
      logger.info(`[MOCK SMS] Sending to ${phone}: ${message}`);
    }
    
    return Promise.resolve(true);
  }

  getLastOtp() {
    return this.lastOtpSent;
  }

  getLastMessage() {
    return this.lastMessageSent;
  }
}
