import dotenv from "dotenv";
dotenv.config({ path: ".env.test" });
import redis from './src/config/redis.js';
console.log("Redis URL:", process.env.REDIS_URL);
console.log("Redis Test URL:", process.env.REDIS_URL_TEST);
console.log("Redis client options:", redis.options.host, redis.options.port);
process.exit(0);
