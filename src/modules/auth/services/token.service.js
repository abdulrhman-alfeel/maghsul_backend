import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import ApiError from '../../../helpers/apiError.js';

export const TokenService = {
  /**
   * Generates a secure random 256-bit string in hex.
   */
  generateSecureToken() {
    return crypto.randomBytes(32).toString('hex');
  },

  /**
   * Hashes a secure token using SHA256 (for Refresh Tokens and Invitations).
   */
  hashSecureToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  },

  /**
   * Signs a JWT Access Token.
   * @param {Object} payload 
   * @param {string} expiresIn e.g., '15m'
   */
  signAccessToken(payload, expiresIn = "15m") {
    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) {
      throw new Error('ACCESS_TOKEN_SECRET is not configured');
    }
    
    // Create JWT with specific allowed claims
    const claims = {
      jti: crypto.randomUUID(),
      sessionId: payload.sessionId,
      identityId: payload.identityId,
      sessionType: payload.sessionType,
    };

    if (payload.purpose) claims.purpose = payload.purpose;
    if (payload.washerId) claims.washerId = payload.washerId;
    if (payload.branchId) claims.branchId = payload.branchId;
    if (payload.staffMembershipId) claims.staffMembershipId = payload.staffMembershipId;
    if (payload.customerMembershipId) claims.customerMembershipId = payload.customerMembershipId;
    if (payload.applicationId) claims.applicationId = payload.applicationId;
    if (payload.appType) claims.appType = payload.appType;

    return jwt.sign(claims, secret, { 
      expiresIn,
      algorithm: 'HS256',
      issuer: process.env.ACCESS_TOKEN_ISSUER || 'laundry-api',
      audience: process.env.ACCESS_TOKEN_AUDIENCE || 'laundry-app'
    });
  },

  /**
   * Verifies an Access Token.
   * @param {string} token 
   */
  verifyAccessToken(token, expectedSessionType = null) {
    const secret = process.env.ACCESS_TOKEN_SECRET;
    try {
      const decoded = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        issuer: process.env.ACCESS_TOKEN_ISSUER || 'laundry-api',
        audience: process.env.ACCESS_TOKEN_AUDIENCE || 'laundry-app'
      });
      if (expectedSessionType && decoded.sessionType !== expectedSessionType) {
        throw new Error('Invalid session type');
      }
      return decoded;
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw new ApiError(401, 'TOKEN_EXPIRED', 'Token expired');
      }
      throw new ApiError(401, 'INVALID_TOKEN', 'Invalid token: ' + err.message);
    }
  }
};
