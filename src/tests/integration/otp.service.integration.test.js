import { jest } from "@jest/globals";
import { OtpService, getSmsProvider } from '../../modules/auth/services/otp.service.js';
import { setupTestDb, teardownTestDb } from './test-utils.js';
import prisma from '../../config/db.js';

describe('OtpService Integration', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await prisma.otpCode.deleteMany();
    // Use jest fake timers? Let's use real ones where needed or pass for simplicity.
  });

  it('should send OTP and allow verification', async () => {
    const phone = '+966500000001';
    await OtpService.sendOtp(phone, 'login');
    
    // Read from Mock
    const mockProvider = getSmsProvider();
    const code = mockProvider.getLastOtp();
    expect(code).toBeDefined();

    const result = await OtpService.verifyOtp(phone, code, 'login');
    expect(result).toBe(true);
    
    // Ensure it's verified in DB
    const otp = await prisma.otpCode.findFirst({ where: { phone } });
    expect(otp.verified).toBe(true);
  });

  it('should block multiple sends within cooldown window', async () => {
    const phone = '+966500000002';
    process.env.OTP_RESEND_COOLDOWN_SECONDS = 60;
    
    await OtpService.sendOtp(phone, 'login');
    
    try {
      await OtpService.sendOtp(phone, 'login');
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('OTP_RESEND_COOLDOWN');
    }
  });

  it('should increment attempts on invalid code and block on max attempts', async () => {
    const phone = '+966500000003';
    process.env.OTP_MAX_ATTEMPTS = 3;
    await OtpService.sendOtp(phone, 'login');
    
    try {
      await OtpService.verifyOtp(phone, '0000', 'login');
    } catch (err) { expect(err.code).toBe('OTP_INVALID'); }
    try {
      await OtpService.verifyOtp(phone, '0000', 'login');
    } catch (err) { expect(err.code).toBe('OTP_INVALID'); }
    try {
      await OtpService.verifyOtp(phone, '0000', 'login');
    } catch (err) { expect(err.code).toBe('OTP_MAX_ATTEMPTS'); }
    
    // Now even with correct code it should fail
    const code = getSmsProvider().getLastOtp();
    try {
      await OtpService.verifyOtp(phone, code, 'login');
    } catch (err) { expect(err.code).toBe('OTP_EXPIRED'); }
  });

  it('should invalidate old unverified codes when sending a new one', async () => {
    const phone = '+966500000004';
    process.env.OTP_RESEND_COOLDOWN_SECONDS = 0; // disable cooldown
    
    await OtpService.sendOtp(phone, 'login');
    const code1 = getSmsProvider().getLastOtp();
    
    await OtpService.sendOtp(phone, 'login'); // Sends new one
    
    try {
      await OtpService.verifyOtp(phone, code1, 'login');
    } catch (err) {
      expect(err.code).toBe('OTP_INVALID');
    }
  });

});
