import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Codex } from '../src/server/codex.ts';
import { OmpBackend } from '../src/server/omp.ts';
import {
  asAgentModelCapability,
  assertEffectiveProfile,
  type AgentBackend,
  type AgentModelCapability,
} from '../src/server/agent-backend.ts';

test('Codex remains assignable to the normalized AgentBackend seam', () => {
  const backend: AgentBackend = new Codex();
  assert.equal(typeof backend.start, 'function');
  assert.equal(typeof backend.thread, 'function');
  assert.equal(typeof backend.turn, 'function');
  assert.equal(typeof backend.createSession, 'function');
  assert.equal(typeof backend.resumeSession, 'function');
  assert.equal(typeof backend.modelCapabilities, 'function');
  assert.equal(typeof backend.probe, 'function');
  assert.equal(typeof backend.reconcileSteer, 'function');
});

test('OMP reports restricted capabilities and explicit allowance absence', async () => {
  const backend = new OmpBackend();
  assert.equal(backend.capabilities.streaming, true);
  assert.equal(backend.capabilities.hostTools, true);
  assert.equal(backend.capabilities.nestedAgents, false);
  assert.equal(backend.capabilities.extensions, false);
  assert.equal(backend.capabilities.rules, false);
  assert.equal(backend.capabilities.skills, false);
  assert.equal(backend.capabilities.accountAllowance, false);
  assert.equal((await backend.accountAllowance()).status, 'unavailable');
  assert.equal(await backend.reconcileSteer('missing-session', 'client-id'), 'unknown');
});

test('model normalization preserves exact model and effort capability metadata', () => {
  const model: AgentModelCapability = asAgentModelCapability({
    provider: 'fixture',
    id: 'fixture-model',
    name: 'Fixture',
    reasoning: true,
    thinking: { efforts: ['low', 'high'] },
  });
  assert.deepEqual(model.reasoningEfforts, ['low', 'high']);
  assert.deepEqual(model.supportedReasoningEfforts, [
    { reasoningEffort: 'low' },
    { reasoningEffort: 'high' },
  ]);
  assert.equal(model.id, 'fixture-model');
  assert.equal(model.model, 'fixture-model');
});

test('effective model validation rejects provider, model, or effort fallback', () => {
  assert.doesNotThrow(() =>
    assertEffectiveProfile(
      { model: { provider: 'fixture', id: 'fixture-model' }, thinkingLevel: 'low' },
      { provider: 'fixture', model: 'fixture-model', effort: 'low' },
    ),
  );
  assert.throws(
    () =>
      assertEffectiveProfile(
        { model: { provider: 'other', id: 'fixture-model' }, thinkingLevel: 'low' },
        { provider: 'fixture', model: 'fixture-model', effort: 'low' },
      ),
    /实际 Provider/,
  );
  assert.throws(
    () =>
      assertEffectiveProfile(
        { model: { provider: 'fixture', id: 'fallback-model' }, thinkingLevel: 'low' },
        { provider: 'fixture', model: 'fixture-model', effort: 'low' },
      ),
    /实际模型/,
  );
  assert.throws(
    () =>
      assertEffectiveProfile(
        { model: { provider: 'fixture', id: 'fixture-model' }, thinkingLevel: 'high' },
        { provider: 'fixture', model: 'fixture-model', effort: 'low' },
      ),
    /实际推理档位/,
  );
  assert.throws(
    () => assertEffectiveProfile({}, { model: 'fixture-model', effort: 'low' }),
    /实际模型/,
  );
  assert.throws(
    () =>
      assertEffectiveProfile(
        { model: { id: 'fixture-model' } },
        { provider: 'fixture', model: 'fixture-model', effort: 'low' },
      ),
    /实际 Provider/,
  );
  assert.throws(
    () =>
      assertEffectiveProfile(
        { model: { id: 'fixture-model', provider: 'fixture' } },
        { model: 'fixture-model', effort: 'low' },
      ),
    /实际推理档位/,
  );
});
