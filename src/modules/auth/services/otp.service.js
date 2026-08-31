import crypto from 'crypto';
import prisma from '../../../config/db.js';
import { MockSmsProvider } from './sms/mock.sms.provider.js';
import ApiError from '../../../helpers/apiError.js';

// Factory for SmsProvider
let smsProvider = null;
export function getSmsProvider() {
  if (smsProvider) return smsProvider;
  
  if (process.env.SMS_PROVIDER === 'mock') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL: Cannot use MockSmsProvider in production.');
    }
    smsProvider = new MockSmsProvider();
  } else {
    // Placeholder for real provider
    throw new Error('Real SMS provider not configured.');
  }
  return smsProvider;
}

export const OtpService = {
  /**
   * Generates a 4 digit OTP securely.
   */
  generateOtpCode() {
    return String(crypto.randomInt(100000, 1000000));
  },

  /**
   * Hashes the OTP using SHA256.
   */
  hashOtpCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
  },

  /**
   * Sends an OTP for a specific phone and purpose.
   * @param {string} phone 
   * @param {string} purpose enum OtpPurpose
   * @param {string} [appClientId] Optional AppClient context
   */
  async sendOtp(phone, purpose, appClientId = null) {
    const windowMin = Number(process.env.OTP_SEND_WINDOW_MINUTES || 60);
    const maxSend = Number(process.env.OTP_SEND_LIMIT || 5);
    const cooldownSec = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);
    const ttlMin = Number(process.env.OTP_TTL_MINUTES || 5);
    
    // Check Limits
    const windowStart = new Date(Date.now() - windowMin * 60 * 1000);
    const recentOtps = await prisma.otpCode.findMany({
      where: {
        phone,
        purpose,
        appClientId,
        createdAt: { gte: windowStart }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (recentOtps.length >= maxSend) {
      throw new ApiError(429, 'OTP_RATE_LIMITED', 'لقد تجاوزت الحد الأقصى لإرسال الرموز. الرجاء المحاولة لاحقاً.');
    }

    if (recentOtps.length > 0) {
      const lastOtp = recentOtps[0];
      const diffSec = (Date.now() - lastOtp.createdAt.getTime()) / 1000;
      if (diffSec < cooldownSec) {
        throw new ApiError(429, 'OTP_RESEND_COOLDOWN', `الرجاء الانتظار ${Math.ceil(cooldownSec - diffSec)} ثانية قبل طلب رمز جديد.`);
      }
    }

    // Invalidate old unverified OTPs
    await prisma.otpCode.updateMany({
      where: { phone, purpose, verified: false },
      data: { expiresAt: new Date() } // Expire immediately
    });

    const code = this.generateOtpCode();
    const codeHash = this.hashOtpCode(code);
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);
    const maxAttempts = Number(process.env.OTP_MAX_ATTEMPTS || 3);

    await prisma.otpCode.create({
      data: {
        phone,
        purpose,
        appClientId,
        codeHash,
        expiresAt,
        maxAttempts
      }
    });

    const provider = getSmsProvider();
    await provider.sendSms(phone, `رمز الدخول الخاص بك: ${code}`);

    return { sent: true };
  },

  /**
   * Verifies an OTP for a given phone and purpose.
   */
  async verifyOtp(phone, code, purpose, appClientId = null) {
    const rawCode = String(code).trim();
    const codeHash = this.hashOtpCode(rawCode);

    const otp = await prisma.otpCode.findFirst({
      where: { phone, purpose, appClientId, verified: false },
      orderBy: { createdAt: 'desc' }
    });

    if (!otp) {
      throw new ApiError(400, 'OTP_NOT_FOUND', 'لا يوجد رمز فعال لهذا الرقم.');
    }

    if (otp.expiresAt.getTime() < Date.now()) {
      throw new ApiError(400, 'OTP_EXPIRED', 'الرمز منتهي الصلاحية.');
    }

    if (otp.attempts >= otp.maxAttempts) {
      throw new ApiError(400, 'OTP_MAX_ATTEMPTS', 'تم تجاوز الحد الأقصى للمحاولات لهذا الرمز.');
    }

    const inputHashBuffer = Buffer.from(codeHash, 'hex');
    const storedHashBuffer = Buffer.from(otp.codeHash, 'hex');

    let hashesMatch = false;
    if (inputHashBuffer.length === storedHashBuffer.length) {
      hashesMatch = crypto.timingSafeEqual(inputHashBuffer, storedHashBuffer);
    }

    if (!hashesMatch) {
      // Increment attempts
      const updated = await prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } }
      });
      
      if (updated.attempts >= updated.maxAttempts) {
        // Invalidate on max attempts reached
        await prisma.otpCode.update({
          where: { id: otp.id },
          data: { expiresAt: new Date() }
        });
        
        // Audit log conceptually:
        await prisma.auditLog.create({
          data: {
            entityType: 'OtpCode',
            entityId: otp.id,
            action: 'otp_max_attempts',
            newValue: { phone, purpose }
          }
        });
        throw new ApiError(400, 'OTP_MAX_ATTEMPTS', 'تم تجاوز الحد الأقصى للمحاولات. الرجاء طلب رمز جديد.');
      }
      
      throw new ApiError(400, 'OTP_INVALID', 'الرمز غير صحيح.');
    }

    // Success
    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { verified: true, attempts: { increment: 1 } }
    });

    return true;
  }
};
