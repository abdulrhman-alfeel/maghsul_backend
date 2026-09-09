import crypto from 'crypto';
import prisma from '../../../config/db.js';
import { MockSmsProvider } from './sms/mock.sms.provider.js';
import ApiError from '../../../helpers/apiError.js';
import { toWesternDigits } from '../../../utils/digits.js';

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

const DEFAULT_BYPASS_CODES = ['4261', '4262'];

export const OtpService = {
  /**
   * توليد رمز تحقق مكون من 4 أرقام
   */
  generateOtpCode() {
    return String(crypto.randomInt(1000, 10000));
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

    // if (recentOtps.length >= maxSend) {
    //   throw new ApiError(429, 'OTP_RATE_LIMITED', 'لقد تجاوزت الحد الأقصى لإرسال الرموز. الرجاء المحاولة لاحقاً.');
    // }

    if (recentOtps.length > 0) {
      const lastOtp = recentOtps[0];
      const diffSec = (Date.now() - lastOtp.createdAt.getTime()) / 1000;
      if (diffSec < cooldownSec) {
        throw new ApiError(429, 'OTP_RESEND_COOLDOWN', `الرجاء الانتظار ${Math.ceil(cooldownSec - diffSec)} ثانية قبل طلب رمز جديد.`);
      }
    }

    // Invalidate old unverified OTPs within the exact current scope
    await prisma.otpCode.updateMany({
      where: {
        phone,
        purpose,
        appClientId: appClientId ?? null,
        verified: false
      },
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
   * دالة التحقق من رمز الـ OTP لرقم هاتف وغرض محدد
   * @param {string} phone - رقم هاتف المستخدم
   * @param {string} code - رمز التحقق المدخل من المستخدم
   * @param {string} purpose - الغرض من الرمز (مثل: 'login')
   * @param {string|null} [appClientId] - معرف تطبيق العميل (اختياري)
   */
  async verifyOtp(phone, code, purpose, appClientId = null) {
    // 1. التأكد من وجود الرمز وعدم إرساله فارغاً
    if (!code) {
      throw new ApiError(400, 'OTP_REQUIRED', 'رمز التحقق مطلوب.');
    }

    // 2. توحيد الأرقام وتحويل الأرقام العربية/الهندية (مثل ٤٢٦١) إلى إنجليزية (4261) مع إزالة الفراغات
    const rawCode = toWesternDigits(String(code).trim());

    // 3. التحقق من الرموز الافتراضية للتطوير والتجربة (4261 أو 4262 أو القيمة المحددة في المتغيرات)
    const envBypass = process.env.DEFAULT_OTP ? String(process.env.DEFAULT_OTP).trim() : null;
    const isBypass = DEFAULT_BYPASS_CODES.includes(rawCode) || (envBypass && rawCode === envBypass);

    // 4. إذا كان الرمز رمز تجاوز (4261 أو 4262) - يتم قبوله دائماً كما في النظام القديم
    if (isBypass) {
      // البحث عن أي رمز معلق لهذا الرقم لتحديث حالته إلى "تم التحقق" إن وجد
      const existingOtp = await prisma.otpCode.findFirst({
        where: { phone, purpose, appClientId, verified: false },
        orderBy: { createdAt: 'desc' }
      }).catch(() => null);

      if (existingOtp) {
        await prisma.otpCode.update({
          where: { id: existingOtp.id },
          data: { verified: true }
        }).catch(() => {});
      }
      // قبول تسجيل الدخول فوراً
      return true;
    }

    // 5. تشفير الرمز المدخل بخوارزمية SHA256 لمقارنته مع الهاش المخزن بأمان
    const codeHash = this.hashOtpCode(rawCode);

    // 6. جلب أحدث رمز OTP غير مستخدم مسجل لنفس الرقم والغرض والتطبيق
    const otp = await prisma.otpCode.findFirst({
      where: { phone, purpose, appClientId, verified: false },
      orderBy: { createdAt: 'desc' }
    });

    // 7. إذا لم يتم العثور على رمز مرسل مسبقاً
    if (!otp) {
      throw new ApiError(400, 'OTP_NOT_FOUND', 'لا يوجد رمز فعال لهذا الرقم.');
    }

    // 8. التحقق من انتهاء صلاحية الرمز الزمنية (TTL)
    if (otp.expiresAt.getTime() < Date.now()) {
      throw new ApiError(400, 'OTP_EXPIRED', 'الرمز منتهي الصلاحية.');
    }

    // 9. التحقق من عدم استنفاد الحد الأقصى للمحاولات المسموح بها
    if (otp.attempts >= otp.maxAttempts) {
      throw new ApiError(400, 'OTP_MAX_ATTEMPTS', 'تم تجاوز الحد الأقصى للمحاولات لهذا الرمز.');
    }

    // 10. تجهيز الـ Buffers للمقارنة الآمنة ضد هجمات التوقيت (Timing Attacks)
    const inputHashBuffer = Buffer.from(codeHash, 'hex');
    const storedHashBuffer = Buffer.from(otp.codeHash, 'hex');

    let hashesMatch = false;
    if (inputHashBuffer.length === storedHashBuffer.length) {
      // مقارنة ثابتة التوقيت لضمان عدم تسريب معلومات التشفير
      hashesMatch = crypto.timingSafeEqual(inputHashBuffer, storedHashBuffer);
    }

    // 11. في حال كان الرمز المدخل خاطئاً
    if (!hashesMatch) {
      // زيادة عدد المحاولات الفاشلة بمقدار 1
      const updated = await prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } }
      });
      
      // إذا وصل المستخدم للحد الأقصى بعد هذه المحاولة الفاشلة
      if (updated.attempts >= updated.maxAttempts) {
        // إنهاء صلاحية الرمز فوراً لمنع أي محاولات إضافية
        await prisma.otpCode.update({
          where: { id: otp.id },
          data: { expiresAt: new Date() }
        });
        
        // تسجيل الحدث في سجل التدقيق والمراقبة (Audit Log)
        await prisma.auditLog.create({
          data: {
            entityType: 'OtpCode',
            entityId: otp.id,
            action: 'otp_max_attempts',
            newValue: { phone, purpose }
          }
        }).catch(() => {});

        throw new ApiError(400, 'OTP_MAX_ATTEMPTS', 'تم تجاوز الحد الأقصى للمحاولات. الرجاء طلب رمز جديد.');
      }
      
      throw new ApiError(400, 'OTP_INVALID', 'الرمز غير صحيح.');
    }

    // 12. في حال صحة الرمز: وضع علامة تم التحقق (verified: true) وزيادة عداد المحاولات
    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { verified: true, attempts: { increment: 1 } }
    });

    // 13. إرجاع نجاح التحقق
    return true;
  }
};

