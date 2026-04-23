/**
 * Benchmark Modal sandbox time to interactivity (create + first command).
 *
 * Usage:
 *   mise exec -- pnpm tsx scripts/bench-modal.ts [trials]
 *
 * Requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in environment or .env file.
 */

import { compute } from 'computesdk';
import { modal } from '@computesdk/modal';
import { config } from 'dotenv';

config();

const TRIALS = parseInt(process.argv[2] ?? '5', 10);

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

  compute.setConfig({
    provider: modal({
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
    }),
  });

  console.log(`\nModal sandbox creation benchmark — ${TRIALS} trial(s)\n`);

  const samples: number[] = [];

  for (let i = 1; i <= TRIALS; i++) {
    process.stdout.write(`  Trial ${i}/${TRIALS} … `);
    const t0 = Date.now();
    let sandbox: any;
    try {
      sandbox = await compute.sandbox.create();
      const result = await sandbox.runCommand('echo hello');
      if (result.exitCode !== 0) {
        throw new Error(`command exited with code ${result.exitCode}: ${result.stderr.trim() || '(no stderr)'}`);
      }
      const stdout = result.stdout.trim();
      const totalMs = Date.now() - t0;

      samples.push(totalMs);
      console.log(`${fmt(totalMs)} stdout="${stdout}"`);
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      console.log(`FAILED (${fmt(elapsedMs)}) — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (sandbox) {
        try { await sandbox.destroy(); } catch { /* ignore cleanup errors */ }
      }
    }
  }

  if (samples.length === 0) {
    console.error('\nAll trials failed — no stats to report.\n');
    process.exit(1);
  }

  const s = stats(samples);
  const pad = (label: string) => label.padEnd(8);

  console.log(`\n  ${pad('trials')}  ${samples.length} / ${TRIALS}`);
  console.log(`  ${pad('min')}     ${fmt(s.min)}`);
  console.log(`  ${pad('max')}     ${fmt(s.max)}`);
  console.log(`  ${pad('mean')}    ${fmt(s.mean)}`);
  console.log(`  ${pad('median')}  ${fmt(s.median)}`);
  console.log(`  ${pad('p95')}     ${fmt(s.p95)}`);
  console.log(`  ${pad('stddev')}  ${fmt(s.stddev)}\n`);
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
