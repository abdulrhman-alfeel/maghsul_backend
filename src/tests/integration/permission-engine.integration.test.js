import { jest } from '@jest/globals';
import { PermissionService } from '../../modules/auth/services/permission.service.js';
import { requirePermission } from '../../middlewares/requirePermission.js';
import prisma from '../../config/db.js';
import redis from '../../config/redis.js';

describe('Authorization Engine', () => {
  let washer, washer2, identity, identity2, branch, branch2, staffMembership, staffMembership2;
  let permInvite, permView, permOther;
  let branchAccess;

  beforeAll(async () => {
    // Basic setup
    washer = await prisma.washer.create({ data: { name: 'Perm Washer 1' } });
    washer2 = await prisma.washer.create({ data: { name: 'Perm Washer 2' } });

    identity = await prisma.identity.create({ data: { phone: `99${Date.now().toString().slice(-7)}`, status: 'active' } });
    identity2 = await prisma.identity.create({ data: { phone: `98${Date.now().toString().slice(-7)}`, status: 'active' } });

    branch = await prisma.branch.create({ data: { name: 'Perm Branch 1', washerId: washer.id } });
    branch2 = await prisma.branch.create({ data: { name: 'Perm Branch 2', washerId: washer.id } });
    
    staffMembership = await prisma.staffMembership.create({
      data: {
        identityId: identity.id,
        washerId: washer.id,
        role: 'washer_owner',
        status: 'active',
        hasFullWasherAccess: true
      }
    });

    staffMembership2 = await prisma.staffMembership.create({
      data: {
        identityId: identity2.id,
        washerId: washer.id,
        role: 'worker',
        status: 'suspended', // For suspended test
      }
    });

    branchAccess = await prisma.branchAccess.create({
      data: {
        staffMembershipId: staffMembership.id,
        branchId: branch.id
      }
    });

    // Setup Permissions
    permInvite = await prisma.permission.create({ data: { code: 'staff.invite', name: 'Invite', description: 'Invite', scope: 'washer' } });
    permView = await prisma.permission.create({ data: { code: 'staff.view', name: 'View', description: 'View', scope: 'washer' } });
    permOther = await prisma.permission.create({ data: { code: 'other.perm', name: 'Other', description: 'Other', scope: 'washer', isActive: false } });

    await prisma.rolePermission.createMany({
      data: [
        { role: 'washer_owner', permissionId: permInvite.id },
        { role: 'washer_owner', permissionId: permView.id },
        { role: 'washer_owner', permissionId: permOther.id }, // but it's inactive
      ]
    });
  });

  afterAll(async () => {
    await prisma.staffInvitation.deleteMany({ where: { washerId: { in: [washer.id, washer2.id] } } });
    await prisma.rolePermission.deleteMany({ where: { permissionId: { in: [permInvite.id, permView.id, permOther.id] } } });
    await prisma.branchPermissionOverride.deleteMany({ where: { branchAccessId: branchAccess.id } });
    await prisma.permission.deleteMany({ where: { id: { in: [permInvite.id, permView.id, permOther.id] } } });
    await prisma.branchAccess.deleteMany({ where: { staffMembershipId: { in: [staffMembership.id, staffMembership2.id] } } });
    await prisma.staffMembership.deleteMany({ where: { id: { in: [staffMembership.id, staffMembership2.id] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branch.id, branch2.id] } } });
    await prisma.identity.delete({ where: { id: identity.id } });
    await prisma.identity.delete({ where: { id: identity2.id } });
    await prisma.washer.delete({ where: { id: washer.id } });
    await prisma.washer.delete({ where: { id: washer2.id } });
  });

  afterEach(async () => {
    try { await redis.flushdb(); } catch (e) {}
    await prisma.branchPermissionOverride.deleteMany();
    jest.restoreAllMocks();
  });

  describe('PermissionService.resolvePermissions', () => {
    it('returns role permissions when no branch override exists', async () => {
      const perms = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      expect(perms.has('staff.invite')).toBe(true);
      expect(perms.has('staff.view')).toBe(true);
      // permOther is inactive, shouldn't be included
      expect(perms.has('other.perm')).toBe(false);
    });

    it('denies specific permissions if branch override is deny', async () => {
      await prisma.branchPermissionOverride.create({
        data: {
          branchAccessId: branchAccess.id,
          permissionId: permInvite.id,
          effect: 'deny'
        }
      });

      const perms = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      expect(perms.has('staff.invite')).toBe(false); // Denied
      expect(perms.has('staff.view')).toBe(true);    // Not overridden
    });

    it('Branch allow is treated as inherit only (cannot elevate Role)', async () => {
      // Role washer_owner does NOT have 'super.admin'
      const fakePerm = await prisma.permission.create({ data: { code: 'super.admin', name: 'Super', description: 'Super', scope: 'washer' } });
      await prisma.branchPermissionOverride.create({
        data: {
          branchAccessId: branchAccess.id,
          permissionId: fakePerm.id,
          effect: 'allow' // Explicit allow override
        }
      });

      const perms = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      expect(perms.has('super.admin')).toBe(false); // Can't elevate role

      await prisma.branchPermissionOverride.deleteMany();
      await prisma.permission.delete({ where: { id: fakePerm.id } });
    });

    it('hasFullWasherAccess does not elevate Role permissions', async () => {
      // Staff has full washer access, but role is washer_owner, so they shouldn't magically get unassigned perms
      const perms = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      expect(perms.has('non.existent')).toBe(false);
    });

    it('inactive membership returns empty permissions', async () => {
      const perms = await PermissionService.resolvePermissions(washer.id, staffMembership2.id, branch.id);
      expect(perms.size).toBe(0);
    });

    it('inactive permission is excluded', async () => {
      const perms = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      expect(perms.has('other.perm')).toBe(false);
    });

    it('Washer isolation: requesting perms for another washer returns empty', async () => {
      const perms = await PermissionService.resolvePermissions(washer2.id, staffMembership.id, branch.id);
      expect(perms.size).toBe(0);
    });

    it('Cross-branch isolation: overriding in branch 1 does not affect branch 2', async () => {
      // Deny in branch 1
      await prisma.branchPermissionOverride.create({
        data: { branchAccessId: branchAccess.id, permissionId: permInvite.id, effect: 'deny' }
      });

      // Branch 1 is denied
      const perms1 = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      expect(perms1.has('staff.invite')).toBe(false);

      // Branch 2 is NOT denied
      const perms2 = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch2.id);
      expect(perms2.has('staff.invite')).toBe(true);
    });

    it('uses cache on subsequent calls and permissionsVersion invalidates old cache', async () => {
      const getSpy = jest.spyOn(redis, 'get');
      const setSpy = jest.spyOn(redis, 'setex');
      
      const p1 = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      expect(setSpy).toHaveBeenCalledTimes(1);

      const p2 = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      expect(getSpy).toHaveBeenCalledTimes(2);
      expect(p1.size).toBe(p2.size);

      // Invalidate cache by updating washer
      await prisma.washer.update({
        where: { id: washer.id },
        data: { permissionsVersion: { increment: 1 } }
      });

      const p3 = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      // Set should be called again because version changed or Redis is down
      expect(setSpy.mock.calls.length).toBeGreaterThanOrEqual(2); 
    });

    it('falls back to DB if Redis fails to get or set', async () => {
      jest.spyOn(redis, 'get').mockRejectedValue(new Error('Redis connection failed'));
      jest.spyOn(redis, 'setex').mockRejectedValue(new Error('Redis connection failed'));

      const perms = await PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id);
      expect(perms.has('staff.invite')).toBe(true); // Still works!
    });

    it('fails closed (503) if DB fails', async () => {
      jest.spyOn(prisma.washer, 'findUnique').mockRejectedValue(new Error('DB failure'));

      await expect(PermissionService.resolvePermissions(washer.id, staffMembership.id, branch.id))
        .rejects
        .toMatchObject({ status: 503, message: 'SERVICE_UNAVAILABLE' });
    });
  });

  describe('requirePermission Middleware', () => {
    const mockReq = (overrides = {}) => ({
      authContext: {
        sessionType: 'operational',
        staffMembershipId: staffMembership.id,
        branchId: branch.id,
        washerId: washer.id,
        identityId: identity.id,
        ...overrides
      }
    });

    it('calls next if permission is granted', async () => {
      const req = mockReq();
      const res = {};
      const next = jest.fn();

      const middleware = requirePermission('staff.invite');
      await middleware(req, res, next);
      
      expect(next).toHaveBeenCalledWith(); // success
    });

    it('calls next(err) with 403 if permission is missing', async () => {
      const req = mockReq();
      const res = {};
      const next = jest.fn();

      const middleware = requirePermission('staff.super.action');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.status).toBe(403);
      expect(err.message).toBe('ليس لديك الصلاحية المطلوبة للقيام بهذا الإجراء');
    });

    it('throws error if operational session is missing branchId', async () => {
      const req = mockReq({ branchId: null });
      const res = {};
      const next = jest.fn();

      const middleware = requirePermission('staff.invite');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.status).toBe(403);
      expect(err.code).toBe('STAFF_SESSION_REQUIRED');
    });

    it('throws error if sessionType is not operational', async () => {
      const req = mockReq({ sessionType: 'provisional' });
      const res = {};
      const next = jest.fn();

      const middleware = requirePermission('staff.invite');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.status).toBe(403);
      expect(err.code).toBe('STAFF_SESSION_REQUIRED');
    });

    it('throws error if washerId mismatch in resolvePermissions', async () => {
      // By passing washer2.id, the resolvePermissions will return empty set because staff is not in washer2
      const req = mockReq({ washerId: washer2.id });
      const res = {};
      const next = jest.fn();

      const middleware = requirePermission('staff.invite');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeDefined();
      expect(err?.status).toBe(403);
      expect(err?.code).toBe('PERMISSION_DENIED');
    });
    
    it('throws error if staffMembershipId mismatch in resolvePermissions', async () => {
      // Passing staffMembership2 which is inactive
      const req = mockReq({ staffMembershipId: staffMembership2.id });
      const res = {};
      const next = jest.fn();

      const middleware = requirePermission('staff.invite');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.status).toBe(403);
      expect(err.code).toBe('PERMISSION_DENIED');
    });
  });
});
