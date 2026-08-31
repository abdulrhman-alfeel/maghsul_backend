import fs from 'fs';
const content = fs.readFileSync('src/tests/integration/staff-multi-washer-context.integration.test.js', 'utf8');
const modified = content.replace(/expect\(res\.status\)\.toBe\(200\);/g, 'console.log("RESPONSE:", res.body); expect(res.status).toBe(200);');
fs.writeFileSync('src/tests/integration/staff-multi-washer-context.integration.test.js', modified);
