import { TokenService } from '../../modules/auth/services/token.service.js';
import jwt from 'jsonwebtoken';
import { jest } from '@jest/globals';

describe('TokenService Unit Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.ACCESS_TOKEN_SECRET = 'a-very-long-secure-secret-key-12345';
    process.env.ACCESS_TOKEN_ISSUER = 'laundry-api';
    process.env.ACCESS_TOKEN_AUDIENCE = 'laundry-app';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should generate and verify a valid access token', () => {
    const payload = {
      sessionId: 's-123',
      identityId: 'id-123',
      sessionType: 'provisional'
    };
    const token = TokenService.signAccessToken(payload, '15m');
    const decoded = TokenService.verifyAccessToken(token, 'provisional');
    expect(decoded.sessionId).toBe('s-123');
  });

  it('should reject when expecting a different sessionType', () => {
    const payload = {
      sessionId: 's-123',
      identityId: 'id-123',
      sessionType: 'provisional'
    };
    const token = TokenService.signAccessToken(payload, '15m');
    
    try {
      TokenService.verifyAccessToken(token, 'operational');
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('INVALID_TOKEN');
    }
  });

  it('should reject a token signed with wrong algorithm', () => {
    // Generate HS512 which is NOT HS256
    const token = jwt.sign({ sessionId: 's-123' }, process.env.ACCESS_TOKEN_SECRET, {
      algorithm: 'HS512',
      issuer: process.env.ACCESS_TOKEN_ISSUER,
      audience: process.env.ACCESS_TOKEN_AUDIENCE
    });

    try {
      TokenService.verifyAccessToken(token);
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('INVALID_TOKEN');
    }
  });

  it('should reject a token with wrong issuer', () => {
    const token = jwt.sign({ sessionId: 's-123' }, process.env.ACCESS_TOKEN_SECRET, {
      algorithm: 'HS256',
      issuer: 'wrong-api',
      audience: process.env.ACCESS_TOKEN_AUDIENCE
    });

    try {
      TokenService.verifyAccessToken(token);
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('INVALID_TOKEN');
    }
  });

  it('should reject a token with wrong audience', () => {
    const token = jwt.sign({ sessionId: 's-123' }, process.env.ACCESS_TOKEN_SECRET, {
      algorithm: 'HS256',
      issuer: process.env.ACCESS_TOKEN_ISSUER,
      audience: 'wrong-app'
    });

    try {
      TokenService.verifyAccessToken(token);
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('INVALID_TOKEN');
    }
  });

  it('should reject an expired token with TOKEN_EXPIRED code', () => {
    const token = jwt.sign({ sessionId: 's-123' }, process.env.ACCESS_TOKEN_SECRET, {
      algorithm: 'HS256',
      issuer: process.env.ACCESS_TOKEN_ISSUER,
      audience: process.env.ACCESS_TOKEN_AUDIENCE,
      expiresIn: '-10s' // already expired
    });

    try {
      TokenService.verifyAccessToken(token);
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('TOKEN_EXPIRED');
    }
  });
});
