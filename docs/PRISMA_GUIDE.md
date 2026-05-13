# دليل Prisma للمبتدئين (من SQL إلى Prisma)

دليل عملي يربط بين كتابة SQL التقليدية واستخدام Prisma ORM.

---

## 1. الفكرة الأساسية

| SQL | Prisma |
|-----|--------|
| **جدول (Table)** | **Model** في `schema.prisma` |
| **عمود (Column)** | **حقل (Field)** في الـ Model |
| **مفتاح أساسي (Primary Key)** | `@id` |
| **مفتاح أجنبي (Foreign Key)** | `@relation` |
| **قيمة افتراضية** | `@default(...)` |

---

## 2. الاتصال بقاعدة البيانات

**SQL:** تفتح اتصال وتنفذ استعلامات.

**Prisma:** تستورد كائن `prisma` جاهز:

```javascript
import prisma from './config/db.js';

// prisma.user    = جدول User
// prisma.order   = جدول Order
// prisma.washer  = جدول Washer
// ... إلخ
```

---

## 3. مقارنة العمليات الأساسية (CRUD)

### INSERT (إدراج سجل جديد)

**SQL:**
```sql
INSERT INTO "OtpCode" (id, phone, codeHash, expiresAt)
VALUES ('abc123', '966500000001', 'hash...', '2025-03-07 12:00:00');
```

**Prisma:**
```javascript
await prisma.otpCode.create({
  data: {
    phone: '966500000001',
    codeHash: 'hash...',
    expiresAt: new Date('2025-03-07 12:00:00')
  }
});
// id يُنشأ تلقائياً بسبب @default(cuid())
```

---

### SELECT واحد (بحث بسجل واحد بالـ ID)

**SQL:**
```sql
SELECT * FROM "User" WHERE id = 'clxyz123' LIMIT 1;
```

**Prisma:**
```javascript
const user = await prisma.user.findUnique({
  where: { id: 'clxyz123' }
});
```

---

### SELECT مع شرط (أول سجل يطابق الشرط)

**SQL:**
```sql
SELECT * FROM "OtpCode"
WHERE phone = '966500000001' AND verified = false
ORDER BY "createdAt" DESC
LIMIT 1;
```

**Prisma:**
```javascript
const otp = await prisma.otpCode.findFirst({
  where: { phone: '966500000001', verified: false },
  orderBy: { createdAt: 'desc' }
});
```

---

### SELECT عدة سجلات (findMany)

**SQL:**
```sql
SELECT * FROM "Order"
WHERE "customerId" = 'user123'
ORDER BY "createdAt" DESC;
```

**Prisma:**
```javascript
const orders = await prisma.order.findMany({
  where: { customerId: 'user123' },
  orderBy: { createdAt: 'desc' }
});
```

---

### UPDATE (تحديث سجل)

**SQL:**
```sql
UPDATE "OtpCode"
SET attempts = attempts + 1, verified = true
WHERE id = 'otp123';
```

**Prisma:**
```javascript
await prisma.otpCode.update({
  where: { id: 'otp123' },
  data: {
    attempts: { increment: 1 },
    verified: true
  }
});
```

---

### DELETE (حذف سجل)

**SQL:**
```sql
DELETE FROM "OtpCode" WHERE id = 'otp123';
```

**Prisma:**
```javascript
await prisma.otpCode.delete({
  where: { id: 'otp123' }
});
```

---

### UPSERT (إدراج أو تحديث)

**SQL:** تحتاج عدة استعلامات أو `INSERT ... ON CONFLICT`.

**Prisma:**
```javascript
const user = await prisma.user.upsert({
  where: { phone: '966500000001' },
  update: { name: 'أحمد' },
  create: { phone: '966500000001', name: 'أحمد', role: 'customer' }
});
// إن وُجد سجل بنفس phone → يحدّث
// إن لم يُوجد → ينشئ سجلاً جديداً
```

---

## 4. شروط WHERE المتقدمة

### مقارنات

| SQL | Prisma |
|-----|--------|
| `WHERE price > 100` | `where: { price: { gt: 100 } }` |
| `WHERE price >= 100` | `where: { price: { gte: 100 } }` |
| `WHERE price < 100` | `where: { price: { lt: 100 } }` |
| `WHERE price <= 100` |  `where: { price: { lte: 100 } }` |
| `WHERE name LIKE '%أحمد%'` | `where: { name: { contains: 'أحمد' } }` |
| `WHERE status IN ('pending','accepted')` | `where: { status: { in: ['pending','accepted'] } }` |
| `WHERE id IN (ids)` | `where: { id: { in: ids } }` |

### مثال من مشروعك

**SQL:**
```sql
SELECT * FROM "WasherProduct"
WHERE "washerId" = 'washer1' AND id IN ('wp1', 'wp2', 'wp3');
```

**Prisma:**
```javascript
const products = await prisma.washerProduct.findMany({
  where: {
    washerId: 'washer1',
    id: { in: ['wp1', 'wp2', 'wp3'] }
  }
});
```

---

## 5. العلاقات (JOIN) – include

**SQL:**
```sql
SELECT o.*, oi.*
FROM "Order" o
LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id
WHERE o.id = 'order123';
```

**Prisma:**
```javascript
const order = await prisma.order.findUnique({
  where: { id: 'order123' },
  include: {
    items: true,
    events: { orderBy: { createdAt: 'asc' } },
    payments: true
  }
});
// order.items    = عناصر الطلب
// order.events   = أحداث الطلب
// order.payments = الدفعات
```

---

## 6. إنشاء سجلات مرتبطة (Nested Create)

**SQL:** تحتاج عدة `INSERT` أو استعلامات معقدة.

**Prisma:**
```javascript
await prisma.order.create({
  data: {
    customerId: 'user1',
    washerId: 'washer1',
    pickupLat: 24.7,
    pickupLng: 46.6,
    deliveryLat: 24.8,
    deliveryLng: 46.7,
    status: 'pending',
    totalPrice: 5000,
    items: {
      createMany: {
        data: [
          { name: 'قميص', quantity: 2, price: 1200 },
          { name: 'بنطلون', quantity: 1, price: 1500 }
        ]
      }
    },
    events: {
      create: { to: 'pending', byUserId: 'user1', note: 'created' }
    }
  }
});
```

---

## 7. ملخص دوال Prisma الشائعة

| الدالة | SQL تقريباً | الاستخدام |
|--------|-------------|-----------|
| `create()` | INSERT | إدراج سجل جديد |
| `findUnique()` | SELECT ... WHERE unique_field = ? | سجل واحد بحقل فريد (مثل id) |
| `findFirst()` | SELECT ... WHERE ... LIMIT 1 | أول سجل يطابق الشرط |
| `findMany()` | SELECT ... WHERE ... | عدة سجلات |
| `update()` | UPDATE ... WHERE | تحديث سجل |
| `updateMany()` | UPDATE ... WHERE | تحديث عدة سجلات |
| `delete()` | DELETE ... WHERE | حذف سجل |
| `deleteMany()` | DELETE ... WHERE | حذف عدة سجلات |
| `upsert()` | INSERT ... ON CONFLICT | إدراج أو تحديث |
| `count()` | SELECT COUNT(*) | عدد السجلات |

---

## 8. اختيار أعمدة معينة (select)

**SQL:**
```sql
SELECT id, name, phone FROM "User" WHERE id = 'user1';
```

**Prisma:**
```javascript
const user = await prisma.user.findUnique({
  where: { id: 'user1' },
  select: { id: true, name: true, phone: true }
});
```

---

## 9. الترقيم (Pagination)

**SQL:**
```sql
SELECT * FROM "Order"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 20;
```

**Prisma:**
```javascript
const orders = await prisma.order.findMany({
  orderBy: { createdAt: 'desc' },
  skip: 20,
  take: 10
});
```

---

## 10. تنفيذ SQL مباشر (Raw Query)

إذا احتجت استعلام SQL خام:

```javascript
// استعلام خام
const result = await prisma.$queryRaw`SELECT * FROM User WHERE phone = ${phone}`;

// تنفيذ أمر (INSERT/UPDATE/DELETE)
await prisma.$executeRaw`UPDATE User SET name = ${name} WHERE id = ${id}`;
```

---

## 11. أمثلة من مشروع Laundry

### من auth.service.js

```javascript
// إنشاء OTP
await prisma.otpCode.create({ data: { phone, codeHash, expiresAt } });

// البحث عن آخر OTP
const otp = await prisma.otpCode.findFirst({
  where: { phone, verified: false },
  orderBy: { createdAt: 'desc' }
});

// تحديث OTP
await prisma.otpCode.update({
  where: { id: otp.id },
  data: { attempts: { increment: 1 }, verified: isValid }
});

// إنشاء أو تحديث مستخدم
const user = await prisma.user.upsert({
  where: { phone },
  update: { name: name || undefined },
  create: { phone, name: name || null, role: 'customer' }
});
```

### من order.model.js

```javascript
// إنشاء طلب مع العناصر
prisma.order.create({
  data: { ... },
  include: { items: true }
});

// طلب مع علاقاته
prisma.order.findUnique({
  where: { id },
  include: {
    items: true,
    events: { orderBy: { createdAt: 'asc' } },
    payments: true
  }
});
```

### من order.service.js

```javascript
// التحقق من وجود مغسلة
const washer = await prisma.washer.findUnique({ where: { id: washerId } });

// البحث عن منتجات المغسلة
const washerProducts = await prisma.washerProduct.findMany({
  where: { washerId, id: { in: items.map(i => i.washerProductId) } },
  include: { product: true }
});

// تحديث حالة الطلب مع إنشاء حدث
await prisma.order.update({
  where: { id: orderId },
  data: {
    status: to,
    events: { create: { from: order.status, to, byUserId: user.userId, note } }
  }
});
```

---

## 12. أخطاء شائعة

1. **نسيان `await`** – دوال Prisma تعيد Promise:
   ```javascript
   const user = await prisma.user.findUnique(...);  // ✓
   const user = prisma.user.findUnique(...);        // ✗ user = Promise
   ```

2. **حقل غير موجود** – تأكد أن الحقل موجود في الـ schema.

3. **علاقة مطلوبة** – عند `create` تأكد أن كل الحقول المطلوبة (بدون `?`) مُمررة.

4. **إغلاق الاتصال** – في السكربتات (مثل seed):
   ```javascript
   await prisma.$disconnect();
   ```

---

## 13. أوامر Prisma CLI المفيدة

```bash
npx prisma generate      # إنشاء Prisma Client بعد تغيير schema
npx prisma migrate dev   # إنشاء وتطبيق migration
npx prisma studio        # واجهة رسومية لعرض وتعديل البيانات
npx prisma db push       # مزامنة schema مع DB بدون migrations (للتطوير)
```

---

## مرجع سريع

| أريد أن... | Prisma |
|------------|--------|
| أضيف سجلاً | `prisma.model.create({ data: {...} })` |
| أبحث بسجل واحد بالـ id | `prisma.model.findUnique({ where: { id } })` |
| أبحث بأول سجل يطابق شرطاً | `prisma.model.findFirst({ where: {...} })` |
| أبحث بعدة سجلات | `prisma.model.findMany({ where: {...} })` |
| أحدّث سجلاً | `prisma.model.update({ where: {...}, data: {...} })` |
| أحذف سجلاً | `prisma.model.delete({ where: {...} })` |
| أدرج أو أحدّث | `prisma.model.upsert({ where, update, create })` |
| أضم جدولاً مرتبطاً | `include: { relationName: true }` |
