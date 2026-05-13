# Laundry Backend v3

## الجديد في هذه النسخة
- RBAC Helper أوضح
- Validation Middleware عام
- Logger / Request Id
- Response Helper موحد
- File Upload للصور
- Swagger + Postman + Seed

## التشغيل
```bash
cp .env.example .env
npm i
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm run dev
```

## روابط مهمة
- Health: `/health`
- Swagger: `/docs`
- ملفات مرفوعة: `/uploads/<filename>`

## الطلبات (Orders)
- **إنشاء طلب (عميل)**: `POST /orders/create` — لا يتطلب `items`؛ يُرسل تفاصيل الخدمة (نوع الغسيل، الصابون، الباقة، إلخ). السعر يُحدد لاحقاً بعد الفرز.
- **تفاصيل الطلب بعد الفرز (مغسلة)**: `PUT /orders/:id/order-details` — صاحب المغسلة يرسل قائمة القطع (اسم، كمية، سعر الوحدة) بعد الفرز؛ يُحدَّث الإجمالي تلقائياً.

بعد تعديل schema الطلبات شغّل: `npx prisma migrate dev --name add_order_preferences`
