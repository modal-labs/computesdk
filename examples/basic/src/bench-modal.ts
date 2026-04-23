/**
 * Benchmark Modal sandbox time to interactivity (create + first command).
 *
 * Usage:
 *   mise exec -- pnpm tsx scripts/bench-modal.ts [trials] [label]
 *
 * Requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in environment or .env file.
 */

import { compute } from 'computesdk';
import { modal } from '@computesdk/modal';
import { config } from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config();

const TRIALS = parseInt(process.argv[2] ?? '5', 10);
const LABEL = process.argv[3] ?? 'run';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    stddev: Math.sqrt(variance),
  };
}

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    console.error('Please set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables');
    console.error('Run: modal token new');
    process.exit(1);
  }

  const credentials = {
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
  };

  const variants = [
    { label: `${LABEL}-after`,  lazyInit: false, logRequests: true },
    { label: `${LABEL}-before`, lazyInit: true,  logRequests: true },
  ];

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench-results');
  mkdirSync(outDir, { recursive: true });

  type Sample = { index: number; durationMs: number; exitCode: number | null };

  // Pre-configure a provider per variant so setConfig isn't called inside the loop
  const providers = variants.map((v) => ({
    ...v,
    provider: modal({ ...credentials, lazyInit: v.lazyInit, logRequests: v.logRequests }),
    samples: [] as Sample[],
  }));

  console.log(`\nCreate latency — ${TRIALS} trial(s) per variant, interleaved\n`);

  for (let i = 1; i <= TRIALS; i++) {
    for (const variant of providers) {
      compute.setConfig({ provider: variant.provider });
      process.stdout.write(`  [${variant.label}] Trial ${i}/${TRIALS} … `);
      const t0 = Date.now();
      let sandbox: any;
      let exitCode: number | null = null;
      try {
        sandbox = await compute.sandbox.create();
        const result = await sandbox.runCommand('echo hello');
        exitCode = result.exitCode;
        if (result.exitCode !== 0) {
          throw new Error(`command exited with code ${result.exitCode}: ${result.stderr.trim() || '(no stderr)'}`);
        }
        const durationMs = Date.now() - t0;
        variant.samples.push({ index: i, durationMs, exitCode });
        console.log(`${fmt(durationMs)} stdout="${result.stdout.trim()}"`);
      } catch (err) {
        const durationMs = Date.now() - t0;
        variant.samples.push({ index: i, durationMs, exitCode });
        console.log(`FAILED (${fmt(durationMs)}) — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (sandbox) {
          try { await sandbox.destroy(); } catch { /* ignore cleanup errors */ }
        }
      }
    }
  }

  for (const variant of providers) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = join(outDir, `${timestamp}-${variant.label}.json`);
    writeFileSync(outFile, JSON.stringify(variant.samples, null, 2));
    console.log(`\n  [${variant.label}] Results saved to ${outFile}`);

    const successful = variant.samples.filter((s) => s.exitCode === 0).map((s) => s.durationMs);
    if (successful.length === 0) {
      console.error(`  [${variant.label}] All trials failed — no stats to report.`);
      continue;
    }

    const s = stats(successful);
    const pad = (label: string) => label.padEnd(8);
    console.log(`\n  ${pad('trials')}  ${successful.length} / ${TRIALS}`);
    console.log(`  ${pad('min')}     ${fmt(s.min)}`);
    console.log(`  ${pad('max')}     ${fmt(s.max)}`);
    console.log(`  ${pad('mean')}    ${fmt(s.mean)}`);
    console.log(`  ${pad('median')}  ${fmt(s.median)}`);
    console.log(`  ${pad('p95')}     ${fmt(s.p95)}`);
    console.log(`  ${pad('stddev')}  ${fmt(s.stddev)}\n`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
