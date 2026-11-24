import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow = JSON.parse(readFileSync(new URL('../MarketPulse-Secure/workflows/marketpulse-workflow-CURRENT.json', import.meta.url), 'utf8'));

// 2026-11-23 21:00 MYT: one Gemini request hung for 305 s before "fetch failed". The chain started
// its second try, and the 600 s workflow timeout cancelled the run before the Groq fallback could
// write the brief. A cancelled run also sends no error alert. The timeout must leave room for every
// retry of a hung primary model, and then for the fallback and the publish.
const HANG_MS = 305000;      // the observed hang: Node's default fetch timeout, about 300 s
const AFTER_PRIMARY_MS = 180000; // fetch (about 25-55 s), the Groq fallback and the publish
const tries = node => Math.min(5, Math.max(2, node.maxTries || 3)); // n8n core clamps retries this way

test('the workflow timeout outlasts a hung primary model on every retry, with room for the fallback', () => {
  const timeoutMs = workflow.settings.executionTimeout * 1000;
  const chains = workflow.nodes.filter(n => n.type === '@n8n/n8n-nodes-langchain.chainLlm' && n.retryOnFail);
  assert.ok(chains.length >= 2, 'the US and CN primary chains retry');
  for (const chain of chains) {
    const n = tries(chain);
    const worst = n * HANG_MS + (n - 1) * (chain.waitBetweenTries || 0) + AFTER_PRIMARY_MS;
    assert.ok(worst <= timeoutMs, chain.name + ': worst case ' + worst + ' ms exceeds the ' + timeoutMs + ' ms timeout');
  }
});
