import prisma from '../../config/db.js';
import ApiError from '../../helpers/apiError.js';
import { signToken } from '../../utils/jwt.js';
import { toWesternDigits } from '../../utils/digits.js';

function normalizePhone(raw) {
  if (!raw) return raw;
  let phone = toWesternDigits(String(raw).trim());
  if (phone.startsWith('+966')) phone = phone.slice(4);
  else if (phone.startsWith('00966')) phone = phone.slice(5);
  if (phone.startsWith('0')) phone = phone.slice(1);
  return phone;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

async function pagedOrders(whereClause, orderBySpec, opts = {}) {
  const limitRaw = Number(opts.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = opts.afterId ? String(opts.afterId).trim() : null;
  const orderBy = Array.isArray(orderBySpec) ? orderBySpec : [orderBySpec];
  const hasId = orderBy.some((o) => 'id' in o);
  const finalOrderBy = hasId ? orderBy : [...orderBy, { id: 'asc' }];

  const rows = await prisma.order.findMany({
    where: whereClause,
    include: { items: true, customer: true },
    orderBy: finalOrderBy,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
  return { items, nextCursor };
}

import CacheService from '../../services/cache.service.js';

const WashersService = {
  /**
   * إنشاء مستخدم جديد بصفة أدمن ثم إنشاء المغسلة وربطها به — كل ذلك في استدعاء واحد.
   * body: adminPhone (إجباري), adminName (اختياري), name (اسم المغسلة إجباري), phone (هاتف المغسلة اختياري)
   */
  async createWasher(body) {
    const { adminPhone, adminName, name: washerName, phone: washerPhone } = body;
    const normalizedAdminPhone = normalizePhone(adminPhone);
    const normalizedWasherPhone = washerPhone ? normalizePhone(washerPhone) : null;

    const washer = await prisma.washer.create({
      data: { name: washerName, phone: normalizedWasherPhone }
    });

    const user = await prisma.user.upsert({
      where: { phone_washerId: { phone: normalizedAdminPhone, washerId: washer.id } },
      update: { name: adminName || undefined, role: 'washer_admin' },
      create: {
        phone: normalizedAdminPhone,
        name: adminName || null,
        role: 'washer_admin',
        washerId: washer.id
      }
    });

    const token = signToken({ userId: user.id, role: user.role, washerId: user.washerId });
    return { washer, user, token };
  },

  /** جلب كل المغاسل مع Pagination بالـ cursor */
  async listWashersPaged(query = {}) {
    const limitRaw = Number(query.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;
    const cursor = query.cursor ? String(query.cursor) : null;

    const rows = await prisma.washer.findMany({
      where: { status: 'active' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? String(items[items.length - 1]?.id ?? '') : null;

    return { items, nextCursor };
  },

  /**
   * List active branches for a washer (public — used by customer app for branch selection).
   */
  async listBranches(washerId) {
    const cacheKey = `branches:${washerId}`;
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const branches = await prisma.branch.findMany({
      where: { washerId, status: 'active' },
      select: { id: true, name: true, status: true, address: true, lat: true, lng: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });

    await CacheService.set(cacheKey, branches, 600); // cache 10 min
    return branches;
  },

  /**
   * Get coverage zones for a specific branch.
   * Requires staff context with access to the branch's washer.
   */
  async getBranchCoverage(authContext, branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new ApiError(404, 'branch_not_found', 'Branch not found');

    // Authorization: user must belong to the branch's washer
    if (!authContext.washerId || authContext.washerId !== branch.washerId) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    if (authContext.branchId && authContext.branchId !== branchId) {
      throw new ApiError(403, 'forbidden', 'Forbidden: Scope restricted to assigned branch');
    }

    const cacheKey = `coverage:branch:${branchId}`;
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const zones = await prisma.coverageZone.findMany({
      where: { branchId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }]
    });

    await CacheService.set(cacheKey, zones, 3600);
    return zones;
  },

  /**
   * Replace all coverage zones for a branch (delete + create).
   * Validates each zone's geometry before persisting.
   */
  async replaceBranchCoverage(authContext, branchId, zones) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new ApiError(404, 'branch_not_found', 'Branch not found');

    if (!authContext.washerId || authContext.washerId !== branch.washerId) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    if (authContext.branchId && authContext.branchId !== branchId) {
      throw new ApiError(403, 'forbidden', 'Forbidden: Scope restricted to assigned branch');
    }

    // Validate each zone
    if (!Array.isArray(zones)) throw new ApiError(400, 'invalid_zones', 'zones must be an array');

    const validZoneTypes = ['inclusion', 'exclusion'];
    const validCoverageTypes = ['circle', 'polygon', 'multi_polygon'];

    for (const z of zones) {
      if (z.zoneType && !validZoneTypes.includes(z.zoneType)) {
        throw new ApiError(400, 'invalid_zone_type', `Invalid zoneType: ${z.zoneType}`);
      }
      const ct = z.coverageType || 'circle';
      if (!validCoverageTypes.includes(ct)) {
        throw new ApiError(400, 'invalid_coverage_type', `Invalid coverageType: ${ct}`);
      }

      if (ct === 'circle') {
        if (z.centerLat === undefined || z.centerLat === null || z.centerLng === undefined || z.centerLng === null) {
          throw new ApiError(400, 'invalid_circle', 'Circle zones require centerLat and centerLng');
        }
        if (typeof z.centerLat !== 'number' || z.centerLat < -90 || z.centerLat > 90) {
          throw new ApiError(400, 'invalid_coordinates', 'centerLat must be a number between -90 and 90');
        }
        if (typeof z.centerLng !== 'number' || z.centerLng < -180 || z.centerLng > 180) {
          throw new ApiError(400, 'invalid_coordinates', 'centerLng must be a number between -180 and 180');
        }
        if (z.radiusMeters !== undefined && (typeof z.radiusMeters !== 'number' || z.radiusMeters <= 0)) {
          throw new ApiError(400, 'invalid_radius', 'radiusMeters must be a positive number');
        }
      }

      if (ct === 'polygon' || ct === 'multi_polygon') {
        if (!z.geoJson) {
          throw new ApiError(400, 'invalid_polygon', 'Polygon/MultiPolygon zones require geoJson');
        }
        const raw = typeof z.geoJson === 'string' ? JSON.parse(z.geoJson) : z.geoJson;
        const coords = raw.coordinates || raw;
        if (!Array.isArray(coords)) {
          throw new ApiError(400, 'invalid_polygon', 'geoJson must contain coordinates array');
        }
        if (ct === 'polygon') {
          if (!Array.isArray(coords[0]) || coords[0].length < 4) {
            throw new ApiError(400, 'invalid_polygon', 'Polygon outer ring must have at least 4 coordinate pairs');
          }
        }
      }
    }

    // Atomic replace: delete all existing + create new
    await prisma.$transaction(async (tx) => {
      await tx.coverageZone.deleteMany({ where: { branchId } });
      if (zones.length > 0) {
        await tx.coverageZone.createMany({
          data: zones.map((z) => ({
            branchId,
            name: z.name || null,
            zoneType: z.zoneType || 'inclusion',
            coverageType: z.coverageType || 'circle',
            bbMinLat: z.bbMinLat ?? null,
            bbMaxLat: z.bbMaxLat ?? null,
            bbMinLng: z.bbMinLng ?? null,
            bbMaxLng: z.bbMaxLng ?? null,
            centerLat: z.centerLat ?? null,
            centerLng: z.centerLng ?? null,
            radiusMeters: z.radiusMeters ?? null,
            geoJson: z.geoJson ?? null,
            isActive: z.isActive !== undefined ? z.isActive : true,
            priority: z.priority ?? 0
          }))
        });
      }
    });

    // Invalidate cache
    await CacheService.del(`coverage:branch:${branchId}`);

    return prisma.coverageZone.findMany({
      where: { branchId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }]
    });
  },

  /**
   * Clear all coverage zones for a branch.
   */
  async clearBranchCoverage(authContext, branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new ApiError(404, 'branch_not_found', 'Branch not found');

    if (!authContext.washerId || authContext.washerId !== branch.washerId) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    if (authContext.branchId && authContext.branchId !== branchId) {
      throw new ApiError(403, 'forbidden', 'Forbidden: Scope restricted to assigned branch');
    }

    await prisma.coverageZone.deleteMany({ where: { branchId } });
    await CacheService.del(`coverage:branch:${branchId}`);

    return { cleared: true };
  },

  async getPaymentMethods(user, washerId) {
    if (!user.washerId || user.washerId !== washerId || user.role !== 'washer_admin') {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }

    const allowed = ['visa', 'apple_pay', 'mada', 'bank_transfer', 'cash', 'tabby', 'tamara'];
    const existing = await prisma.washerPaymentMethod.findMany({ where: { washerId } });
    const map = new Map(existing.map((m) => [m.method, m.enabled]));

    return allowed.map((method) => ({
      method,
      enabled: map.get(method) ?? false
    }));
  },

  async savePaymentMethods(user, washerId, body) {
    if (!user.washerId || user.washerId !== washerId || user.role !== 'washer_admin') {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const methods = Array.isArray(body.methods) ? body.methods : [];

    await prisma.washerPaymentMethod.deleteMany({ where: { washerId } });

    if (methods.length) {
      await prisma.washerPaymentMethod.createMany({
        data: methods.map((m) => ({
          washerId,
          method: m.method,
          enabled: m.enabled !== false
        }))
      });
    }

    return this.getPaymentMethods(user, washerId);
  },

  async getLocation(user, washerId) {
    if (!user.washerId || user.washerId !== washerId || user.role !== 'washer_admin') {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const cacheKey = `washer:location:${washerId}`;
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const washer = await prisma.washer.findUnique({ where: { id: washerId } });
    if (!washer) throw new ApiError(404, 'Washer not found');
    const result = {
      lat: washer.serviceLat,
      lng: washer.serviceLng,
      radiusMeters: washer.serviceRadiusMeters ?? 1500
    };
    await CacheService.set(cacheKey, result, 3600);
    return result;
  },

  async saveLocation(user, washerId, body) {
    if (!user.washerId || user.washerId !== washerId || user.role !== 'washer_admin') {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const { lat, lng, radiusMeters } = body;
    const washer = await prisma.washer.update({
      where: { id: washerId },
      data: {
        serviceLat: lat,
        serviceLng: lng,
        serviceRadiusMeters: radiusMeters ?? 1500
      }
    });

    // Invalidate cache
    await CacheService.del(`washer:location:${washerId}`);

    return {
      lat: washer.serviceLat,
      lng: washer.serviceLng,
      radiusMeters: washer.serviceRadiusMeters ?? 1500
    };
  },

  async pendingOrders(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['pending', 'pending_pickup'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات وصلت للمغسلة — للاستلام (سائق سلّم أو في الطريق) */
  async ordersToReceive(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['accepted', 'picked_up', 'delivered_to_laundry'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات جاهزة للفرز — فقط بعد وصول الطلب للمغسلة أو بدء الفرز (لا يشمل picked_up قبل تسليم المغسلة) */
  async ordersToSort(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      {
        washerId,
        status: {
          in: ['delivered_to_laundry', 'received_in_laundry', 'sorting', 'sorting_in_progress']
        }
      },
      { createdAt: 'asc' },
      opts
    );
  },

  /**
   * طلبات بانتظار إيداع المغسلة: من إنشاء الطلب حتى قبل `delivered_to_laundry`.
   * يشمل غير المُسنَد للسائق، والمُسنَد، وبعد `picked_up` (استلام من العميل) ما دام السائق لم يُسلّم للمغسلة بعد.
   */
  async ordersAwaitingDriverPickup(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    const preHandoffToLaundry = [
      'pending',
      'accepted',
      'pending_pickup',
      'pickup_assigned',
      'driver_heading_to_pickup',
      'driver_arrived_pickup',
      /** مع السائق بعد الاستلام من العميل، حتى يضغط «تسليم للمغسلة» */
      'picked_up'
    ];
    return pagedOrders(
      {
        washerId,
        status: { in: preHandoffToLaundry }
      },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات تم تنفيذها (status = completed) */
  async ordersCompleted(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: 'completed' },
      [{ createdAt: 'desc' }, { id: 'desc' }],
      opts
    );
  },

  /** طلبات تم الفرز انتظار السداد */
  async ordersSortedAwaitingPayment(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['sorting_confirmed'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** جاري الغسيل */
  async ordersInWash(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['washing'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات قيد انتظار التوصيل */
  async ordersAwaitingDelivery(user, washerId, opts = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    return pagedOrders(
      { washerId, status: { in: ['ready', 'ready_for_delivery', 'delivering'] } },
      { createdAt: 'asc' },
      opts
    );
  },

  /** طلبات تم توصيلها للمغسلة (delivered_to_laundry) مع Pagination بالـ cursor */
  async deliveredToLaundryPaged(user, washerId, query = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');

    const limitRaw = Number(query.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;
    const cursor = query.cursor ? String(query.cursor) : null;

    const rows = await prisma.order.findMany({
      where: { washerId, status: 'delivered_to_laundry' },
      include: { items: true, customer: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? String(items[items.length - 1]?.id ?? '') : null;

    return { items, nextCursor };
  },

  /** طلبات منجزة (تم توصيلها للعميل) status=completed مع Pagination بالـ cursor */
  async completedPaged(user, washerId, query = {}) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');

    const limitRaw = Number(query.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;
    const cursor = query.cursor ? String(query.cursor) : null;

    const rows = await prisma.order.findMany({
      where: { washerId, status: 'completed' },
      include: { items: true, customer: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? String(items[items.length - 1]?.id ?? '') : null;

    return { items, nextCursor };
  },

  async createStaff(user, washerId, body) {
    if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    const { phone, name, role } = body;
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) throw new ApiError(400, 'phone_required', 'phone is required');

    return prisma.user.upsert({
      where: { phone_washerId: { phone: normalizedPhone, washerId } },
      update: { name: name || undefined, role },
      create: { phone: normalizedPhone, name: name || null, role, washerId }
    });
  },

  async getSchedule(user, washerId) {
    if (!user.washerId || user.washerId !== washerId || user.role !== 'washer_admin') {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const cacheKey = `washer:schedule:${washerId}`;
    const cached = await CacheService.get(cacheKey);
    if (cached) return cached;

    const schedule = await prisma.washerSchedule.findMany({
      where: { washerId },
      orderBy: [{ day: 'asc' }, { fromTime: 'asc' }],
    });
    await CacheService.set(cacheKey, schedule, 3600);
    return schedule;
  },

  async saveSchedule(user, washerId, rows) {
    if (!user.washerId || user.washerId !== washerId || user.role !== 'washer_admin') {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }

    await prisma.washerSchedule.deleteMany({ where: { washerId } });

    if (Array.isArray(rows) && rows.length) {
      await prisma.washerSchedule.createMany({
        data: rows.map((r) => ({
          washerId,
          day: r.day,
          fromTime: r.fromTime,
          toTime: r.toTime,
          enabled: r.enabled !== false,
        })),
      });
    }

    // Invalidate cache
    await CacheService.del(`washer:schedule:${washerId}`);

    return prisma.washerSchedule.findMany({
      where: { washerId },
      orderBy: [{ day: 'asc' }, { fromTime: 'asc' }],
    });
  },

  async getProfile(user, washerId) {
    if (!user.washerId || user.washerId !== washerId) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const washer = await prisma.washer.findUnique({ where: { id: washerId } });
    if (!washer) throw new ApiError(404, 'Washer not found');
    return washer;
  },

  async updateProfile(user, washerId, body) {
    if (!user.washerId || user.washerId !== washerId || user.role !== 'washer_admin') {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const {
      name,
      phone,
      email,
      address,
      logoUrl,
      isOpen,
      deliveryEnabled,
      minimumOrderAmount,
      deliveryFee,
      notes
    } = body;

    const normalizedPhone = phone ? normalizePhone(phone) : undefined;

    const washer = await prisma.washer.update({
      where: { id: washerId },
      data: {
        name: name !== undefined ? name : undefined,
        phone: normalizedPhone,
        email: email !== undefined ? email : undefined,
        address: address !== undefined ? address : undefined,
        logoUrl: logoUrl !== undefined ? logoUrl : undefined,
        isOpen: isOpen !== undefined ? !!isOpen : undefined,
        deliveryEnabled: deliveryEnabled !== undefined ? !!deliveryEnabled : undefined,
        minimumOrderAmount: minimumOrderAmount !== undefined ? Number(minimumOrderAmount) : undefined,
        deliveryFee: deliveryFee !== undefined ? Number(deliveryFee) : undefined,
        notes: notes !== undefined ? notes : undefined
      }
    });

    await CacheService.del(`washer:profile:${washerId}`);
    return washer;
  }
};

export default WashersService;
