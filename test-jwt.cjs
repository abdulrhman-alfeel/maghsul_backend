require('dotenv').config({ path: '.env.test' });
const jwt = require('jsonwebtoken');
console.log("JWT_SECRET is:", process.env.JWT_SECRET);
const token = jwt.sign({ test: 'test' }, process.env.JWT_SECRET);
console.log("Token:", token);
