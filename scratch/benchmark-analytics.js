import { performance } from 'perf_hooks';
import http from 'http';

/**
 * Safe local micro-benchmark script for measuring API endpoint latency.
 */
async function runLocalBenchmark() {
  console.log('=== Local API Endpoint Benchmark ===');
  
  const iterations = 50;
  const latencies = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await new Promise((resolve) => {
      http.get('http://127.0.0.1:3000/health', (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }).on('error', () => resolve());
    });
    const end = performance.now();
    latencies.push(end - start);
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;

  console.log(`Measured iterations: ${iterations}`);
  console.log(`Measured p50 latency: ${p50.toFixed(2)} ms`);
  console.log(`Measured p95 latency: ${p95.toFixed(2)} ms`);
  console.log(`Measured p99 latency: ${p99.toFixed(2)} ms`);
}

runLocalBenchmark().catch(console.error);
