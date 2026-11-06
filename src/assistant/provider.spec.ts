import {
  AI_TOOLS,
  UnconfiguredAiProvider,
  boundedAiDecision,
  type AiProvider,
} from './provider.js';
it('fails closed without credentials and exposes no payment, confirmation or SQL execution tool', async () => {
  const p = new UnconfiguredAiProvider();
  expect(p.available()).toBe(false);
  expect(p.upperBoundCostCents()).toBeNull();
  expect(AI_TOOLS.some((t) => /sql|pay|confirm|discount/.test(t))).toBe(false);
  await expect(
    p.decide({
      instructions: '',
      untrustedMessage: '',
      maxInputTokens: 100,
      maxOutputTokens: 50,
      timeoutMs: 1000,
      allowedTools: AI_TOOLS,
    }),
  ).rejects.toThrow('NOT_CONFIGURED');
});
it('bounds provider response time so an unavailable provider cannot hold the worker indefinitely', async () => {
  const p: AiProvider = {
    id: 'LOCAL_TEST_TIMEOUT',
    available: () => true,
    upperBoundCostCents: () => 1,
    decide: () => new Promise(() => {}),
  };
  await expect(
    boundedAiDecision(p, {
      instructions: '',
      untrustedMessage: '',
      maxInputTokens: 100,
      maxOutputTokens: 50,
      timeoutMs: 5,
      allowedTools: AI_TOOLS,
    }),
  ).rejects.toThrow('TIMEOUT');
});
