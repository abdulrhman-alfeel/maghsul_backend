import { jest } from '@jest/globals';
import { createSocketContextResolver } from '../../modules/realtime/socket-context.resolver.js';
import { SOCKET_ERRORS } from '../../modules/realtime/socket.constants.js';
import { ApplicationRegistry } from '../../config/application.registry.js';

describe('RT-6: Context Resolver & Environment Mapping', () => {
  let mockTokenService;
  let mockSessionService;
  let mockPrisma;
  let resolveContext;

  beforeEach(() => {
    ApplicationRegistry['com.fajr.customer'] = { appType: 'customer', isActive: true, platform: 'ios/android', washerId: 'was_fajr_001' };
    mockTokenService = {
      verifyAccessToken: jest.fn()
    };
    mockSessionService = {
      getSessionState: jest.fn()
    };
    mockPrisma = {
      session: {
        findUnique: jest.fn()
      }
    };

    resolveContext = createSocketContextResolver({
      tokenService: mockTokenService,
      sessionService: mockSessionService,
      prisma: mockPrisma,
      permissionService: {} // Not strictly used for customer path in this test
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('fails if session is missing in DB (even if JWT is valid)', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sessionId: 'sess_1',
      identityId: 'id_1',
      applicationId: 'com.fajr.customer',
      appType: 'customer'
    });

    mockSessionService.getSessionState.mockResolvedValue('active');
    mockPrisma.session.findUnique.mockResolvedValue(null);

    let error;
    try {
      await resolveContext('fake_token');
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toBe('Session not found');
    expect(error.data.code).toBe(SOCKET_ERRORS.SOCKET_SESSION_NOT_FOUND);
  });

  it('fails if identity mismatch between token and DB session', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sessionId: 'sess_1',
      identityId: 'id_1',
      applicationId: 'com.fajr.customer',
      appType: 'customer'
    });

    mockSessionService.getSessionState.mockResolvedValue('active');
    mockPrisma.session.findUnique.mockResolvedValue({
      id: 'sess_1',
      identityId: 'id_DIFFERENT',
      sessionType: 'operational',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 10000),
      device: { applicationId: 'com.fajr.customer', appType: 'customer' },
      identity: { status: 'active' }
    });

    let error;
    try {
      await resolveContext('fake_token');
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toBe('Identity mismatch');
    expect(error.data.code).toBe(SOCKET_ERRORS.SOCKET_CONTEXT_INVALID);
  });

  it('resolves and freezes context when everything is valid (Customer mapping)', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sessionId: 'sess_1',
      identityId: 'id_1',
      applicationId: 'com.fajr.customer',
      appType: 'customer'
    });

    mockSessionService.getSessionState.mockResolvedValue('active');
    mockPrisma.session.findUnique.mockResolvedValue({
      id: 'sess_1',
      identityId: 'id_1',
      sessionType: 'operational',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 10000),
      device: { applicationId: 'com.fajr.customer', appType: 'customer' },
      identity: { status: 'active' }
    });

    const context = await resolveContext('fake_token');

    expect(context.identityId).toBe('id_1');
    expect(context.sessionId).toBe('sess_1');
    expect(context.applicationId).toBe('com.fajr.customer');
    expect(context.appType).toBe('customer');

    // Prove Object is frozen
    expect(Object.isFrozen(context)).toBe(true);

    expect(() => {
      context.identityId = 'hacked';
    }).toThrow();
  });
});
