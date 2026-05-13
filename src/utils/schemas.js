function result(error, value) {
  return { error, value };
}

export const stringRequired = (field) => (data) => {
  if (!data || typeof data[field] !== 'string' || !data[field].trim()) return result(`${field} is required`);
  return result(null, data);
};

export const authSchemas = {
  sendOtpBody: (data) => {
    if (!data?.phone) return result('phone is required');
    return result(null, data);
  },
  verifyOtpBody: (data) => {
    if (!data?.phone || !data?.code) return result('phone and code are required');
    return result(null, data);
  },
  customerVerifyBody: (data) => {
    if (!data?.phone || !data?.code) return result('phone and code are required');
    if (!data?.washerId) return result('washerId is required');
    return result(null, data);
  },
  washerVerifyBody: (data) => {
    if (!data?.phone || !data?.code) return result('phone and code are required');
    return result(null, data);
  },
};

export const productSchemas = {
  washerProductBody: (data) => {
    if (data?.price === undefined || data?.price === null) return result('price is required');
    if (data?.productId) return result(null, data);
    const customName = typeof data?.customName === 'string' ? data.customName.trim() : '';
    if (!customName) return result('customName is required for custom product (or send productId for default product)');
    return result(null, { ...data, customName });
  }
};

export const orderSchemas = {
  createBody: (data) => {
    if (!data?.washerId || !data?.pickup || !data?.delivery) {
      return result('washerId, pickup and delivery are required');
    }
    const pickup = data.pickup;
    const delivery = data.delivery;
    if (typeof pickup?.lat !== 'number' || typeof pickup?.lng !== 'number' ||
        typeof delivery?.lat !== 'number' || typeof delivery?.lng !== 'number') {
      return result('pickup and delivery must have lat and lng');
    }
    return result(null, data);
  },
  statusBody: (data) => {
    if (!data?.to) return result('to is required');
    return result(null, data);
  },
  /** تفاصيل الطلب بعد الفرز (صاحب المغسلة) */
  setOrderDetailsBody: (data) => {
    if (!Array.isArray(data?.items)) return result('items must be an array');
    const normalized = [];
    for (let i = 0; i < data.items.length; i++) {
      const it = data.items[i];
      const name = typeof it?.name === 'string' ? it.name.trim() : '';
      if (!name) return result(`items[${i}]: name is required and must be non-empty`);
      if (typeof it?.quantity !== 'number' || it.quantity < 1) {
        return result(`items[${i}]: quantity (>= 1) is required`);
      }
      if (typeof it?.price !== 'number' || it.price < 0) {
        return result(`items[${i}]: price must be a non-negative number`);
      }
      normalized.push({ ...it, name });
    }
    return result(null, { ...data, items: normalized });
  }
};

export const washerSchemas = {
  /** إنشاء مغسلة + مستخدم أدمن جديد في طلب واحد */
  createBody: (data) => {
    if (!data?.adminPhone) return result('adminPhone is required');
    if (!data?.name) return result('name is required (washer name)');
    return result(null, data);
  },
  zonesBody: (data) => {
    if (!Array.isArray(data?.zones)) return result('zones must be an array');
    return result(null, data);
  },
  locationBody: (data) => {
    if (typeof data?.lat !== 'number' || typeof data?.lng !== 'number') {
      return result('lat and lng are required');
    }
    if (data?.radiusMeters !== undefined && typeof data.radiusMeters !== 'number') {
      return result('radiusMeters must be a number');
    }
    return result(null, data);
  },
  paymentMethodsBody: (data) => {
    if (!Array.isArray(data?.methods)) return result('methods must be an array');
    return result(null, data);
  },
  staffBody: (data) => {
    if (!data?.phone || !data?.role) return result('phone and role are required');
    return result(null, data);
  }
};

export const userSchemas = {
  createBody: (data) => {
    if (!data?.phone || !data?.role) return result('phone and role are required');

    const allowedRoles = ['customer', 'washer_admin', 'worker', 'driver'];
    if (!allowedRoles.includes(data.role)) return result('invalid role');

    return result(null, data);
  },

  updateBody: (data) => {
    if (!data || typeof data !== 'object') return result('body is required');

    const { phone, name, role, washerId, status } = data;

    if (phone === undefined && name === undefined && role === undefined && washerId === undefined && status === undefined) {
      return result('nothing to update');
    }

    const allowedRoles = ['customer', 'washer_admin', 'worker', 'driver'];
    if (role !== undefined && !allowedRoles.includes(role)) return result('invalid role');

    const allowedStatus = ['active', 'blocked'];
    if (status !== undefined && !allowedStatus.includes(status)) return result('invalid status');

    return result(null, data);
  }
};

export const paymentSchemas = {
  createMoyasarBody: (data) => {
    if (!data?.orderId) return result('orderId is required');
    return result(null, data);
  },
  markPaidBody: (data) => {
    if (data && data.method !== undefined && !['cod', 'manual'].includes(data.method)) {
      return result('method must be cod or manual');
    }
    return result(null, data || {});
  },
  switchToCodBody: (data) => {
    // لا نحتاج body حالياً، لكنه موجود للتوسع لاحقاً
    return result(null, data || {});
  }
};

export const notificationSchemas = {
  upsertFcmTokenBody: (data) => {
    if (!data || typeof data !== 'object') return result('body is required');
    if (!data.fcmToken || typeof data.fcmToken !== 'string' || !data.fcmToken.trim()) {
      return result('fcmToken is required');
    }
    // deviceType optional but helps backend تخزينه لأغراض التشخيص
    if (data.deviceType !== undefined && data.deviceType !== null && typeof data.deviceType !== 'string') {
      return result('deviceType must be a string');
    }
    return result(null, { fcmToken: data.fcmToken.trim(), deviceType: data.deviceType ?? null });
  },
};
