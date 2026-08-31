import { SOCKET_ERRORS } from './socket.constants.js';
import { TokenService } from '../auth/services/token.service.js';
import logger from '../../config/logger.js';

export async function socketAuthMiddleware(socket, next) {
  const { auth, query } = socket.handshake;

  // Reject untrusted context fields in query or auth
  const untrustedFields = ['userId', 'identityId', 'sessionId', 'washerId', 'branchId', 'role', 'permissions', 'accessToken'];
  
  for (const field of untrustedFields) {
    if (query && query[field]) {
      const err = new Error('Query parameters must not contain untrusted context fields.');
      err.data = { code: SOCKET_ERRORS.SOCKET_CONTEXT_INVALID };
      return next(err);
    }
    // accessToken is allowed in auth, but others are not
    if (field !== 'accessToken' && auth && auth[field]) {
      const err = new Error('Auth object must not contain untrusted context fields.');
      err.data = { code: SOCKET_ERRORS.SOCKET_CONTEXT_INVALID };
      return next(err);
    }
  }

  const accessToken = auth?.accessToken;

  if (!accessToken) {
    const err = new Error('Access Token is required.');
    err.data = { code: SOCKET_ERRORS.SOCKET_AUTH_REQUIRED };
    return next(err);
  }

  if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 2000) {
    const err = new Error('Invalid Access Token format.');
    err.data = { code: SOCKET_ERRORS.SOCKET_TOKEN_INVALID };
    return next(err);
  }

  try {
    const decoded = await TokenService.verifyAccessToken(accessToken);
    
    // Pass it along to the resolver
    socket.data = socket.data || {};
    socket.data.rawAccessToken = accessToken;
    socket.data.decodedToken = decoded;
    
    next();
  } catch (error) {
    logger.warn('Socket authentication failed during token verification', { error: error.message });
    const err = new Error('Authentication failed');
    if (error.message === 'jwt expired' || error.message === 'Token expired') {
      err.data = { code: SOCKET_ERRORS.SOCKET_TOKEN_EXPIRED };
    } else {
      err.data = { code: SOCKET_ERRORS.SOCKET_TOKEN_INVALID };
    }
    return next(err);
  }
}
