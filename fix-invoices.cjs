const fs = require('fs');
let content = fs.readFileSync('src/tests/integration/customer-order-payment-isolation.integration.test.js', 'utf8');
content = content.replace(/await prisma.invoice.create\({ data: { orderId: lamaaOrder.id, subtotal: 200, total: 200 } }\);\n    await prisma.invoice.create\({ data: { orderId: lamaaOrder.id, subtotal: 200, total: 200 } }\);/, 'await prisma.invoice.create({ data: { orderId: lamaaOrder.id, subtotal: 200, total: 200 } });');
fs.writeFileSync('src/tests/integration/customer-order-payment-isolation.integration.test.js', content);
