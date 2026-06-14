# توثيق واجهات الـ API و هيكلية النظام (Production-Grade)

> **تحديث معماري شامل (2026-04-03)**: تم تحويل النظام من MVP (SQLite) إلى معمارية موزعة وقابلة للتوسع (Production-Grade). يهدف هذا التحديث لضمان استقرار النظام تحت الضغط العالي وتوفير أدوات مراقبة احترافية.

---

## 🚀 التحديثات المعمارية الجديدة

### 1. قاعدة البيانات والـ ORM
- **المحرك**: الانتقال من SQLite إلى **PostgreSQL**.
- **ORM**: استخدام **Prisma** كطبقة وصول موحدة مع دعم الـ Migrations.
- **البيئة**: يتم تشغيل قاعدة البيانات عبر Docker.

### 2. المعالجة الخلفية (Async Processing)
- **BullMQ + Redis**: تم فصل العمليات الثقيلة (مثل إرسال الإشعارات، ومعالجة الصور، وإدارة الـ Cache) عن مسار الطلب الأساسي باستخدام نظام طوابير مهام (Queues).

### 3. التواصل اللحظي (Real-time)
- **Socket.IO + Redis Adapter**: للسماح للنظام بالعمل عبر عدة خوادم (Horizontal Scaling).

### 4. التخزين الموحد (Cloud Storage)
- **AWS S3 Support**: خدمة تخزين في `src/config/storage.js` تدعم S3 بشكل أساسي مع لوكال ديسك كـ Fallback.

### 5. طبقة التخزين المؤقت (Caching)
- **Redis Cache**: طبقة Caching متطورة لتسريع استجابة الواجهات (المنتجات، الإعدادات، الجداول الزمنية).

### 6. المراقبة والأمان (Observability)
- **Winston & Sentry**: سجلات مهيكلة وتتبع للأخطاء البرمجية بشكل لحظي.
- **Rate Limiting**: حماية الـ APIs من الطلبات المكثفة.

---

## 📱 تحديث تطبيق المغسلة (Laundries-washer)
### نظام إدارة الأصناف الجديد (4-Step Flow)

تم استبدال نظام إضافة الأصناف القديم بنظام تدفق احترافي (مستوحى من التصميم المرجعي):
1.  **WasherManageItems**: شاشة عرض موحدة للأصناف مع خيار التعديل.
2.  **WasherPickItem**: اختيار صنف من قالب جاهز (Grid).
3.  **WasherAddItemSettings**: ضبط السعر والتصنيف للصنف المختار.
4.  **WasherAddCustomItem**: إضافة صنف مخصص (اسم + سعر + صورة).

---

## 🛠️ المتطلبات التقنية
- **Node.js**: v18+
- **PostgreSQL**, **Redis**, **Docker**.

---

## 🐳 دليل أوامر Docker الشامل (محدث للمشروع)

هذا القسم يوفر مرجعاً سريعاً لأهم أوامر Docker المستخدمة في هذا المشروع تحديداً لإدارة حاويات التطبيق، قاعدة البيانات (PostgreSQL)، و Redis.

> **هام جداً**: تأكد أولاً من الانتقال إلى مجلد الواجهة الخلفية حيث يوجد ملف `docker-compose.yml` باستخدام الطرفية:
> `cd /Users/pro/Desktop/landryapp/laundry-nodejs-structure-v3`

### 1. أوامر التشغيل والإغلاق الأساسية (Docker Compose)

| الأمر | الوصف |
| :--- | :--- |
| `docker-compose up --build` | تشغيل جميع الخدمات (App, DB, Redis) مع بناء الصورة (Image) في حال وجود أية تعديلات. |
| `docker-compose up -d --build` | تشغيل جميع الخدمات في الخلفية (Background) لكي تتمكن من استخدام نفس النافذة في الطرفية. |
| `docker-compose down` | إيقاف جميع الحاويات وحذفها مع الشبكات المرتبطة (البيانات تظل محفوظة في الـ Volumes). |
| `docker-compose down -v` | إيقاف الحاويات مع **حذف الـ Volumes** (سيؤدي ذلك إلى حذف بيانات قاعدة البيانات بالكامل). |
| `docker-compose restart app` | إعادة تشغيل حاوية التطبيق (`app`) فقط في حال أجريت تعديل بسيط أرددت تطبيقه. |

### 2. أوامر المتابعة وإدارة الحاويات

| الأمر | الوصف |
| :--- | :--- |
| `docker-compose logs -f` | متابعة سجلات الأخطاء والرسائل (Logs) من **جميع** الخدمات بشكل مباشر (Real-time). |
| `docker-compose logs -f app` | متابعة سجلات مهام التطبيق (Node.js) **فقط**. |
| `docker-compose exec app sh` | الدخول إلى سطر الأوامر (Shell) الخاص بحاوية Node.js (مفيد لتشغيل أوامر Prisma يدوياً). |
| `docker ps` | عرض قائمة بجميع الحاويات الموجودة قيد التشغيل حالياً على جهازك. |

### 3. أوامر الصيانة والتنظيف العامة

| الأمر | الوصف |
| :--- | :--- |
| `docker system prune` | **(هام)** حذف جميع الحاويات المتوقفة والشبكات المهملة والصور غير المستخدمة لتوفير مساحة. |
| `docker image prune` | حذف الصور غير المستخدمة أو المعلقة (Dangling images). |
| `docker volume ls` | عرض جميع وحدات التخزين (Volumes) المحفوظة على جهازك. |

> **ملاحظات هامة حول المنافذ (Ports)**:
> يقوم `docker-compose.yml` بربط المنافذ التالية لتعمل على جهازك الشخصي:
> - **PostgreSQL**: على المنفذ `5433` (لتجنب التعارض مع أي قاعدة بيانات محلية تعمل على 5432).
> - **تطبيق Node.js**: على المنفذ `8080` (أو المنفذ المحدد في متغير `PORT`).
> - **Redis**: يعمل على المنفذ `6379`.

---

# (التوثيق الأصلي والمفصل للنظام)

> هذا الملف محدّث ليتوافق مع الكود الحالي. أي تعديل على الـ APIs يُنعكس هنا في الوصف.

## مفاهيم مشتركة

- **الـ Base URL**: `http://localhost:<PORT>` (افتراضيًا 8080).
- **استجابة النجاح**: `{ "ok": true, "message": "...", "data": ... }` — البيانات الفعلية داخل `data`.
- **استجابة الخطأ**: `{ "ok": false, "error": "رسالة الخطأ", "details": [...] }`.
- **التوثيق (Swagger)**: `GET /docs` لواجهة تجريب الـ APIs.
- **JWT (للطلبات المحمية)**:
  - الهيدر: `Authorization: Bearer <token>`
  - محتوى التوكن: `{ userId, role, washerId }` — يُستخدم في التحقق من الصلاحية.

- **حالات الطلب (OrderStatus)** — للمغسلة/السائق (مع الحالات القديمة للتوافق):
  - **استلام**: `pending_pickup` → (مطالبة سائق) → `pickup_assigned` → `picked_up` → `delivered_to_laundry`.
  - **المغسلة**: `received_in_laundry` → `sorting_in_progress` / `sorting` → (تأكيد الفرز) → `sorting_confirmed` → (إصدار فاتورة) → `washing` (يُنشأ سجل **Invoice** ويُرسل إشعار للعميل) → اختياري: `drying` → `ironing` → `packaging` → `ready` / `ready_for_delivery` (يُنشأ **مهمة توصيل مفتوحة**).
  - **توصيل**: `delivery_assigned` → `delivering` → `delivered` → `completed`.

- **حالات مهمة السائق (DriverTaskStatus)**: `open` → `assigned` → `in_progress` → `completed` | `cancelled`.

---

## 1) موديول Auth – تسجيل الدخول بـ OTP

### تطبيق العميل (Customer)
#### `POST /api/auth/customer/send-otp`
- **Body**: `{ "phone": "0550000000" }`
- **الاستجابة**: `{ sent, ttl, devCode }`

#### `POST /api/auth/customer/verify-otp`
- **Body**: `{ "phone": "0550000000", "code": "1234", "name": "الاسم (اختياري)", "washerId": "معرف المغسلة (مطلوب)" }`
- **الاستجابة**: `{ token, user }`

### تطبيق المغسلة (Washer)
#### `POST /api/auth/washer/send-otp`
#### `POST /api/auth/washer/verify-otp`
- **Body**: `{ "phone": "0550000000", "code": "1234", "name": "الاسم (اختياري)" }`

---

## 2) موديول Users – الملف الشخصي وإدارة المستخدمين
### `GET /api/users/me`
### `POST /api/users` (إنشاء موظف/عميل)
- **Body**: `{ "phone", "name", "role", "washerId?" }`
### `PUT /api/users/:userId`
- **Body**: `{ "phone?", "name?", "role?", "status?" }` (status: active/blocked)
### `DELETE /api/users/:userId`

---

## 3) موديول Washers – إدارة المغسلة والمناطق والموظفين
### `POST /api/washers/create`
- **Body**: `{ "adminPhone", "adminName", "name", "phone" }`
### `PUT /api/washers/:washerId/zones`
- **Body**: `{ "zones": [ { "name", "city" } ] }`
### `GET /api/washers/:washerId/zones`
### `GET /api/washers/:washerId/orders/pending`
### `GET /api/washers/:washerId/orders/to-receive`
### `GET /api/washers/:washerId/orders/to-sort`
### `POST /api/washers/:washerId/users` (إضافة موظفين)

---

## 4) موديول Products – المنتجات
### `GET /api/products/defaults` (المنتجات الافتراضية)
### `GET /api/products/washer/:washerId` (منتجات المغسلة الحالية)
### `POST /api/products/washer/:washerId` (إضافة أو تحديث صنف)
- **Body**: `{ "id?", "productId?", "price", "customName?", "customImage?" }`
- **ملاحظة**: عند إرسال `id` الصنف، يتم التحديث بدلاً من التكرار.
### `POST /api/products/upload-image`
- **Body**: `multipart/form-data` بحقل `image`.

---

## 5) موديول Orders – الطلبات
### `POST /api/orders/create`
- **Body**:
```json
{
  "washerId": "<id>",
  "pickup": { "lat", "lng", "zoneId?" },
  "delivery": { "lat", "lng", "zoneId?" },
  "paymentMethod": "cash_on_delivery",
  "serviceType": "piece",
  "notes": "..."
}
```
### `PUT /api/orders/:id/order-details` (إضافة القطع بعد الفرز)
- **Body**: `{ "items": [ { "name", "quantity", "price" } ] }`
### `GET /api/orders/my-orders`
### `GET /api/orders/:id`
### `GET /api/orders/:id/invoice` (جلب الفاتورة)
### `PUT /api/orders/:id/washer-status`
- **Body**: `{ "to": "accepted", "note" }`
### `PUT /api/orders/:id/driver-status`

---

## 6) موديول Drivers – واجهة السائق
### `GET /api/drivers/me/active` (الطلبات النشطة)
### `GET /api/drivers/me/available-pickup` (طلبات الاستلام المتاحة)
### `GET /api/drivers/me/available-delivery` (طلبات التوصيل المتاحة)
### `POST /api/drivers/claim-delivery` (استلام طلب توصيل)

---

## 7) موديول Payments – الدفع والمحفظة
### `POST /api/payments/moyasar/create` (دفع أونلاين)
### `POST /api/payments/order/:orderId/mark-paid` (دفع يدوي/كاش)
### `POST /api/payments/order/:orderId/driver/collect-cash` (تحصيل السائق)
### `GET /api/payments/washer/me/summary` (ملخص المحفظة)

---

## 8) خطة اختبار متكاملة (سيناريو عملي)
### أ) رحلة العميل
1. تسجيل دخول OTP.
2. اختيار مغسلة وإنشاء طلب (`POST /api/orders/create`).
3. متابعة الحالة حتى يتم الفرز.

### ب) رحلة المغسلة
1. قبول الطلب (`accepted`).
2. استلام الطلب من السائق (`sorting`).
3. إدخال القطع (`order-details`) وإصدار الفاتورة (`washing`).
4. تحديث الحالة لـ `ready`.

### ج) رحلة السائق
1. مشاهدة الطلبات المتاحة (`available-pickup`).
2. المطالبة بالطلب وتحديث حالته لـ `picked_up` ثم `delivered_to_laundry`.
3. المطالبة بالتوصيل (`claim-delivery`) والتحديث لـ `completed`.


# 1. تطبيق الجداول الجديدة
npm run db:migrate
# 2. توليد أكواد Prisma الجديدة
npm run db:generate
# 3. إعادة تشغيل السيرفر (مثال باستخدام PM2)
pm2 restart all
 
 # curl -4 ifconfig.me

# في حالة إضافة جدول جديد في Prisma schema
npx prisma migrate dev --name remove_cleaning_intensity

# مشكلة عدم تحديث قاعدة البيانات بعد عمل تعذيل عليها 

npx prisma db push

ثم:

npx prisma generate