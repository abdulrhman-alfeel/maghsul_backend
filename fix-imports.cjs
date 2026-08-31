const fs = require('fs');
const files = [
  'src/tests/integration/customer-multi-washer-isolation.integration.test.js',
  'src/tests/integration/customer-order-payment-isolation.integration.test.js',
  'src/tests/integration/staff-multi-washer-context.integration.test.js',
  'src/tests/integration/order-idempotency-scope.integration.test.js'
];

files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  // Remove duplicates
  const lines = content.split('\n');
  const seen = new Set();
  const newLines = [];
  for (let line of lines) {
    if (line.startsWith('import ')) {
      if (!seen.has(line)) {
        seen.add(line);
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }
  fs.writeFileSync(f, newLines.join('\n'));
});
