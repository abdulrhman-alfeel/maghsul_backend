import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });
console.log("DEBUG REDIS_URL:", process.env.REDIS_URL);
