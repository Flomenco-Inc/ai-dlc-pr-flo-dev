// Per-intent AI-DLC settings at the PLAN seam: a project member's recorded
// override must beat the pinned scope's default, must change nothing else, and
// must leave the plan of a release that never had the switches untouched.
//
// As in the previous PRs of this stack the scopes are the verbatim upstream
// 2.11.0 frontmatter (fixtures/aidlc-211-scopes.json) carried onto the 2.9.0
// stage set — 2.11.0 changes the stage frontmatter of exactly one file
// (`code-generation.md`, a sensor list) and none of the fields read here — so
// every assertion is about real authored bytes rather than a synthetic scope.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AIDLC_COMPATIBILITY_PROFILES,
  filesFromCompatibilityFixture,
  normalizeAidlcFrontmatter,
} from '../aidlc-compatibility.js';
import { buildFromFiles } from '../block-mappers.js';
import { buildExecutionPlan } from '../v2-execution-plan.js';
import { resolveMethodologyLibrary } from '../release-resolver.js';
import { toolsForRole } from '../../agentcore/mcp/server.js';
import {
  AIDLC_SETTING_KEYS,
  aidlcSettingField,
  aidlcSettingType,
  aidlcSettingValues,
  scopeAidlcSettings,
} from '../intent-aidlc-settings.js';

const BASE_PROFILE = 'v2.9.0';
const LIBRARY_TYPES = ['STAGE', 'AGENT', 'SENSOR', 'RULE', 'ARTIFACT', 'KNOWLEDGE', 'SCOPE'];

const SCOPE_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/aidlc-211-scopes.json', import.meta.url), 'utf8'),
);

const baseFixture = JSON.parse(
  readFileSync(
    new URL(`./fixtures/aidlc-compatibility/${BASE_PROFILE}.json`, import.meta.url),
    'utf8',
  ),
);

const releaseContext = async ({ scopes = 'upstream-2.11' } = {}) => {
  const files = filesFromCompatibilityFixture({
    profileId: BASE_PROFILE,
    fixture: baseFixture,
  });
  if (scopes !== 'upstream-base') {
    for (const path of files.keys()) {
      if (path.startsWith('core/scopes/')) files.delete(path);
    }
    for (const [path, entry] of Object.entries(SCOPE_FIXTURE.scopes)) {
      files.set(path, `---\n${entry.frontmatter}\n---\n[BODY OMITTED]\n`);
    }
  }
  const built = buildFromFiles(
    new Map(
      [...files].map(([path, content]) => [
        path,
        normalizeAidlcFrontmatter({ profileId: BASE_PROFILE, path, content }).content,
      ]),
    ),
  );
  const resolved = await resolveMethodologyLibrary({
    closure: {
      releaseId: AIDLC_COMPATIBILITY_PROFILES[BASE_PROFILE].releaseId,
      catalog: {
        workflow: { ...built.workflow, workflowVersion: 1, version: 1 },
      },
      blocksByType: Object.fromEntries(
        LIBRARY_TYPES.map((type) => [
          type,
          built.blocks
            .filter((block) => block.type === type)
            .map((block) => ({ ...block, version: 1 })),
        ]),
      ),
      runtimeFiles: new Map(
        baseFixture.runtimeFiles.map((runtimeFile) => [runtimeFile.path, runtimeFile]),
      ),
    },
    ddb: {
      send: () => Promise.reject(new Error('unexpected fixture DDB read')),
    },
    tableName: 'synthetic-fixture-table',
    workflowId: built.workflow.id,
    workflowVersion: 1,
  });
  return {
    workflow: { ...resolved.workflow, version: 1 },
    library: resolved.library,
  };
};

const planFor = async ({ scope, intentSettings = null, ...options }) => {
  const { workflow, library } = await releaseContext(options);
  const { plan, valid, errors } = buildExecutionPlan({
    workflow,
    scope,
    library,
    ...(intentSettings ? { intentSettings } : {}),
  });
  expect({ scope, valid, errors }).toEqual({ scope, valid: true, errors: [] });
  return plan;
};

describe('the setting vocabulary', () => {
  it('reads its legal values from the capability registry, not from a copy', () => {
    expect(AIDLC_SETTING_KEYS).toEqual([
      'guardPolicy',
      'planApproval',
      'collaborators',
      'existingCode',
    ]);
    expect(aidlcSettingValues('guardPolicy')).toEqual(['strict', 'relaxed', 'off']);
    expect(aidlcSettingValues('planApproval')).toEqual(['on', 'off']);
    expect(aidlcSettingValues('collaborators')).toEqual(['on', 'off']);
    expect(aidlcSettingValues('existingCode')).toEqual(['true', 'false']);
  });

  // The stored value keeps the methodology's own type, which makes the TYPE
  // part of the contract: every runtime consumer compares with `===`, so a
  // stored `'true'` is not the boolean a renderer tests for.
  it('names the authored type and the authored field of each setting', () => {
    expect(AIDLC_SETTING_KEYS.map(aidlcSettingType)).toEqual([
      'string',
      'string',
      'string',
      'boolean',
    ]);
    expect(AIDLC_SETTING_KEYS.map(aidlcSettingField)).toEqual([
      'guard_policy',
      'plan_approval',
      'collaborators',
      'existing_code',
    ]);
  });

  // "The release does not author this setting" and "the release authored it
  // off" are different facts, and only the first may hide a control.
  it('reads the authored defaults off a scope block, omitting what it never had', () => {
    expect(scopeAidlcSettings({ guardPolicy: 'off', planApproval: 'on' })).toEqual({
      guardPolicy: 'off',
      planApproval: 'on',
    });
    expect(scopeAidlcSettings({ existingCode: false })).toEqual({
      existingCode: false,
    });
    expect(scopeAidlcSettings(null)).toEqual({});
  });
});

describe('the per-intent AI-DLC settings a member records', () => {
  // The whole point of the feature: a team can run the lightest scope and still
  // demand the strictest guard for one intent.
  it('beats the pinned scope default', async () => {
    const plan = await planFor({
      scope: 'classic',
      intentSettings: { guardPolicy: 'strict' },
    });

    expect(plan.stages.length).toBeGreaterThan(0);
    for (const stage of plan.stages) {
      expect({
        stageId: stage.stageId,
        changeControl: stage.policy?.changeControl,
      }).toEqual({
        stageId: stage.stageId,
        changeControl: 'strict',
      });
      expect(stage.policy?.guardPolicy).toBe('strict');
    }
  });

  it('can restore the plan gate a scope turned off, and withdraw one it left on', async () => {
    const gatesWith = (plan) =>
      plan.stages.filter((stage) => stage.policy?.planApproval === 'required').length;

    expect(gatesWith(await planFor({ scope: 'express' }))).toBe(0);
    expect(
      gatesWith(
        await planFor({
          scope: 'express',
          intentSettings: { planApproval: 'on' },
        }),
      ),
    ).toBeGreaterThan(0);
    expect(gatesWith(await planFor({ scope: 'classic' }))).toBeGreaterThan(0);
    expect(
      gatesWith(
        await planFor({
          scope: 'classic',
          intentSettings: { planApproval: 'off' },
        }),
      ),
    ).toBe(0);
  });

  it('can put the collaborators back on a scope that switched them off', async () => {
    const plan = await planFor({
      scope: 'classic',
      intentSettings: { collaborators: 'on' },
    });

    for (const stage of plan.stages) {
      expect(stage.policy?.collaborators).toBe('on');
    }
    expect(plan.policyEffects ?? []).toEqual([]);
  });

  it('can set the project type a scope never authored', async () => {
    const plan = await planFor({
      scope: 'classic',
      intentSettings: { existingCode: true },
    });

    expect(new Set(plan.stages.map((stage) => stage.policy?.existingCode))).toEqual(
      new Set([true]),
    );
  });

  // An explicit Greenfield choice is a decision, so it reaches the policy as
  // `false` — not as the absence a release that never authored the setting
  // produces. The classification stage reads both.
  it('carries an explicit greenfield choice and says the intent decided it', async () => {
    const plan = await planFor({
      scope: 'classic',
      intentSettings: { existingCode: false },
    });

    for (const stage of plan.stages) {
      expect({
        stageId: stage.stageId,
        policy: stage.policy?.existingCode,
      }).toEqual({
        stageId: stage.stageId,
        policy: false,
      });
      expect(stage.policy?.existingCodeChoice).toEqual({ source: 'intent' });
    }

    const none = await planFor({ scope: 'classic' });
    for (const stage of none.stages) {
      expect(stage.policy?.existingCode ?? null).toBeNull();
      expect(stage.policy).not.toHaveProperty('existingCodeChoice');
    }
  });

  it('says the scope decided a project type the scope itself authored', async () => {
    const plan = await planFor({ scope: 'bugfix' });

    for (const stage of plan.stages) {
      expect(stage.policy?.existingCodeChoice).toEqual({
        source: 'scope-default',
      });
    }
  });

  // The same invariant A4 asserts for the scope defaults, asserted again for the
  // human overlay: a setting may never remove a human approval gate.
  it('removes no human gate from any scope, whatever a member chooses', async () => {
    const gates = (plan) => plan.stages.map((stage) => `${stage.stageId}:${stage.humanValidation}`);
    const settings = {
      guardPolicy: 'off',
      planApproval: 'off',
      collaborators: 'off',
      existingCode: true,
    };

    for (const scope of ['classic', 'enterprise', 'express', 'bugfix']) {
      expect({
        scope,
        gates: gates(await planFor({ scope, intentSettings: settings })),
      }).toEqual({
        scope,
        gates: gates(await planFor({ scope })),
      });
    }
  });

  it('offers exactly the settings the pinned scope authors', async () => {
    const authored = async (scope) => (await planFor({ scope })).aidlcSettingsAuthored ?? null;

    expect(await authored('enterprise')).toEqual({
      guardPolicy: 'strict',
      planApproval: 'on',
      collaborators: 'on',
    });
    expect(await authored('bugfix')).toEqual({
      guardPolicy: 'off',
      planApproval: 'on',
      collaborators: 'off',
      existingCode: true,
    });
  });

  // The byte-identity claim for every release that predates the switches: a
  // 2.9.0 closure authors none of them, so the plan offers nothing new and an
  // intent on it resolves exactly the policy it resolves today.
  it('offers nothing and changes nothing on a release that authors no settings', async () => {
    const plan = await planFor({
      scope: 'enterprise',
      scopes: 'upstream-base',
    });
    const withSettings = await planFor({
      scope: 'enterprise',
      scopes: 'upstream-base',
      intentSettings: { guardPolicy: 'off' },
    });

    expect(plan).not.toHaveProperty('aidlcSettingsAuthored');
    // The overlay still resolves when it is handed one — the API is what drops
    // a setting the release never authored, and it is tested there. What
    // matters here is that the plan offers the member nothing to choose.
    expect(withSettings).not.toHaveProperty('aidlcSettingsAuthored');
    for (const stage of plan.stages) {
      expect(stage.policy).not.toHaveProperty('planApprovalWithheld');
      expect(stage.policy).not.toHaveProperty('existingCodeChoice');
    }
  });
});

// The marker the gate notice is built from. Two mutually exclusive cases, and
// exhaustive only because a value equal to the authored default is never
// stored — which is what makes the notice unfalsifiable by a later scope
// change.
describe('the marker left on a stage that lost its plan gate', () => {
  const withheld = (plan) => plan.stages.filter((stage) => stage.policy?.planApprovalWithheld);

  it('marks only the stage that would have asked, and names the scope', async () => {
    const withGate =
      (await planFor({ scope: 'classic' })).stages.find(
        (stage) => stage.policy?.planApproval === 'required',
      ) ?? null;
    expect(withGate).not.toBeNull();

    const lost = withheld(await planFor({ scope: 'express' }));
    expect(lost.map((stage) => stage.stageId)).toEqual([withGate.stageId]);
    expect(lost[0].policy.planApprovalWithheld).toEqual({
      source: 'scope-default',
      scope: 'express',
    });
  });

  it('says the intent withheld it when the intent is what differs', async () => {
    const lost = withheld(
      await planFor({
        scope: 'classic',
        intentSettings: { planApproval: 'off' },
      }),
    );

    expect(lost.length).toBe(1);
    expect(lost[0].policy.planApprovalWithheld).toEqual({
      source: 'intent',
      scope: 'classic',
    });
  });

  // An intent that chooses the value the scope already has records no override
  // at all (the API drops it), so this combination is unreachable through the
  // API. Asserted here so the plan still answers truthfully if it ever arrives.
  it('still credits the scope when an override repeats the scope default', async () => {
    const lost = withheld(
      await planFor({
        scope: 'classic',
        intentSettings: { planApproval: 'on' },
      }),
    );

    expect(lost).toEqual([]);
  });
});

// The authority rule, asserted against the real tool surface rather than
// documented: a settings change is refused by name in the dialect annex,
// and the way to keep that true is for no agent-facing tool to exist that could
// write one. A new tool whose name touches these settings fails this test.
describe('no agent can write a setting', () => {
  it('exposes no settings tool on any MCP role', async () => {
    const plan = await planFor({ scope: 'classic' });
    const stage = plan.stages[0];
    const everyTool = [
      ...toolsForRole('author', stage.stageId, stage.policy ?? null),
      ...toolsForRole('reviewer', stage.stageId, stage.policy ?? null),
      ...toolsForRole('reader', stage.stageId, stage.policy ?? null),
    ].map((tool) => tool.name ?? tool);

    expect(everyTool.length).toBeGreaterThan(0);
    expect(
      everyTool.filter((name) => /setting|guard_policy|plan_approval|collaborator/i.test(name)),
    ).toEqual([]);
    for (const key of AIDLC_SETTING_KEYS) {
      expect(everyTool).not.toContain(key);
    }
  });
});
