import { describe, it, expect } from 'vitest';
import {
  SENSOR_RESULT,
  sensorKind,
  severityGate,
  sensorPathFlag,
  scriptTimeoutBound,
  validateScriptSpec,
  resultFromExit,
  buildScriptArgv,
  evalRequiredSections,
  evalUpstreamCoverage,
  evalGraphCoverage,
  parseBoltDag,
} from '../v2-sensor-contract.js';

describe('sensorKind', () => {
  it('routes the document-shape sensors in-process', () => {
    expect(sensorKind({ sensorId: 'required-sections' })).toBe('graph');
    expect(sensorKind({ sensorId: 'upstream-coverage' })).toBe('graph');
    expect(sensorKind({ sensorId: 'graph-coverage' })).toBe('graph');
  });
  it('routes code-quality sensors to the script path', () => {
    expect(sensorKind({ sensorId: 'linter', runtime: 'bun' })).toBe('script');
    expect(sensorKind({ sensorId: 'type-check', runtime: 'bun' })).toBe('script');
  });
  it('honours an explicit runtime:graph override', () => {
    expect(sensorKind({ sensorId: 'whatever', runtime: 'graph' })).toBe('graph');
  });
});

describe('severityGate', () => {
  it('advisory never holds, whatever the result', () => {
    for (const r of Object.values(SENSOR_RESULT)) {
      expect(severityGate(r, 'advisory')).toEqual({ continues: true, held: false });
    }
  });
  it('blocking holds on any non-PASS', () => {
    expect(severityGate(SENSOR_RESULT.PASS, 'blocking')).toEqual({ continues: true, held: false });
    expect(severityGate(SENSOR_RESULT.FAIL, 'blocking')).toEqual({ continues: false, held: true });
    expect(severityGate(SENSOR_RESULT.BLOCKED, 'blocking')).toEqual({
      continues: false,
      held: true,
    });
    expect(severityGate(SENSOR_RESULT.INCONCLUSIVE, 'blocking')).toEqual({
      continues: false,
      held: true,
    });
  });
});

describe('validateScriptSpec', () => {
  it('accepts an allowed runtime + command + timeout', () => {
    const r = validateScriptSpec({
      sensorId: 'linter',
      runtime: 'bun',
      command: 'bun x.ts',
      timeoutSeconds: 30,
    });
    expect(r.ok).toBe(true);
    expect(r.spec.timeoutMs).toBe(30000);
  });
  it('rejects an unknown runtime (anti-interpreter-smuggling)', () => {
    const r = validateScriptSpec({ runtime: 'python', command: 'x', timeoutSeconds: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsupported runtime/);
  });
  it('clamps an oversized timeout to the ceiling', () => {
    const r = validateScriptSpec({ runtime: 'sh', command: 'echo', timeoutSeconds: 99999 });
    expect(r.spec.timeoutMs).toBe(600000);
  });
  it('rejects an empty command', () => {
    expect(validateScriptSpec({ runtime: 'bun', command: '  ', timeoutSeconds: 5 }).ok).toBe(false);
  });
  it('carries the authored budget and its bound, leaving the stage deadline to the runner', () => {
    const r = validateScriptSpec({ runtime: 'bun', command: 'bun x.ts', timeoutSeconds: 60 });
    expect(r.spec).toMatchObject({ timeoutSeconds: 60, timeoutMs: 60000, boundedBy: 'authored' });
  });
  it('routes the path flag the sensor contract declares', () => {
    const specFor = (inputSchema) =>
      validateScriptSpec({ runtime: 'bun', command: 'bun x.ts', timeoutSeconds: 5, inputSchema })
        .spec;
    expect(specFor({ output_path: 'string', stage_slug: 'string' }).pathFlag).toBe('--output-path');
    expect(specFor({ file_path: 'string' }).pathFlag).toBe('--file-path');
    expect(specFor(undefined).pathFlag).toBe('--file-path');
  });
  it('takes a path flag the plan already resolved', () => {
    const r = validateScriptSpec({
      runtime: 'bun',
      command: 'bun x.ts',
      timeoutSeconds: 5,
      pathFlag: '--output-path',
    });
    expect(r.spec.pathFlag).toBe('--output-path');
  });
});

// The bound one child launch gets. The three states of the remaining stage
// budget are NOT interchangeable: an unavailable deadline leaves the authored
// budget alone, while an exhausted one must stop the pass instead of restoring
// the whole authored allowance after the stage is already over.
describe('scriptTimeoutBound', () => {
  it('keeps the authored budget when no deadline is available', () => {
    for (const remaining of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(scriptTimeoutBound(60, remaining)).toEqual({
        timeoutMs: 60000,
        boundedBy: 'authored',
        exhausted: false,
      });
    }
  });
  it('clamps an absurd authored budget to the ceiling', () => {
    expect(scriptTimeoutBound(99999)).toEqual({
      timeoutMs: 600000,
      boundedBy: 'ceiling',
      exhausted: false,
    });
  });
  it('narrows to what is left of the stage, and names that bound', () => {
    expect(scriptTimeoutBound(600, 90000)).toEqual({
      timeoutMs: 90000,
      boundedBy: 'stage-deadline',
      exhausted: false,
    });
  });
  it('leaves the authored budget alone when more stage time remains than it asks for', () => {
    expect(scriptTimeoutBound(5, 90000)).toEqual({
      timeoutMs: 5000,
      boundedBy: 'authored',
      exhausted: false,
    });
  });
  it('reports an exhausted stage budget instead of restoring the authored one', () => {
    for (const remaining of [0, -1, -600000]) {
      expect(scriptTimeoutBound(600, remaining)).toEqual({
        timeoutMs: 0,
        boundedBy: 'stage-deadline',
        exhausted: true,
      });
    }
  });
});

describe('sensorPathFlag', () => {
  it('reads the declared contract, not the sensor id', () => {
    expect(sensorPathFlag({ file_path: 'string' })).toBe('--file-path');
    expect(sensorPathFlag({ output_path: 'string', stage_slug: 'string' })).toBe('--output-path');
  });
  it('keeps the file-path default when no contract is authored', () => {
    expect(sensorPathFlag(undefined)).toBe('--file-path');
    expect(sensorPathFlag(null)).toBe('--file-path');
    expect(sensorPathFlag({})).toBe('--file-path');
    expect(sensorPathFlag('output_path')).toBe('--file-path');
  });
});

describe('resultFromExit', () => {
  it('maps the convention', () => {
    expect(resultFromExit(0)).toBe(SENSOR_RESULT.PASS);
    expect(resultFromExit(2)).toBe(SENSOR_RESULT.INCONCLUSIVE);
    expect(resultFromExit(1)).toBe(SENSOR_RESULT.FAIL);
    expect(resultFromExit(null)).toBe(SENSOR_RESULT.BLOCKED);
  });
});

describe('buildScriptArgv', () => {
  it('runs the materialized script for bun/node (ignores the command path)', () => {
    const spec = { runtime: 'bun', command: 'bun <runtime-managed>/tools/aidlc-sensor-linter.ts' };
    expect(buildScriptArgv(spec, { scriptPath: '/ws/.aidlc/sensors/linter.ts' })).toEqual({
      file: 'bun',
      args: ['/ws/.aidlc/sensors/linter.ts'],
    });
  });
  it('runs sh -c with substitutions applied', () => {
    const spec = { runtime: 'sh', command: 'echo {{HARNESS_DIR}}' };
    expect(buildScriptArgv(spec, { substitutions: { HARNESS_DIR: '/opt/x' } })).toEqual({
      file: 'sh',
      args: ['-c', 'echo /opt/x'],
    });
  });
});

// A timestamp run record is one `Discovered: ...` line by specification, so the
// two-heading floor reported two findings on every to-spec file. The exemption
// applies only where the pinned catalog proves its record sensor covers run
// records, which is the authored change that shipped the exemption upstream.
describe('evalRequiredSections — a timestamp run record', () => {
  const TIMESTAMP_BODY = 'Discovered: 2026-10-08T00:00:00Z\n';
  const MARKER = 'practices-discovery-timestamp';

  it('reports two missing headings without the exemption', () => {
    const r = evalRequiredSections(TIMESTAMP_BODY, MARKER);
    expect(r).toMatchObject({ pass: false, result: SENSOR_RESULT.FAIL });
    expect(r.detail).toMatchObject({ h2_count: 0, findings_count: 2 });
  });

  it('passes with no findings under the exemption', () => {
    const r = evalRequiredSections(TIMESTAMP_BODY, MARKER, { recordTimestampExempt: true });
    expect(r).toMatchObject({ pass: true, result: SENSOR_RESULT.PASS });
    expect(r.detail).toMatchObject({ h2_count: 0, headings: [], findings_count: 0 });
  });

  it('exempts the marker whether or not the name carries the .md suffix', () => {
    for (const name of [MARKER, `${MARKER}.md`]) {
      expect(
        evalRequiredSections(TIMESTAMP_BODY, name, { recordTimestampExempt: true }).pass,
        name,
      ).toBe(true);
    }
  });

  it('keeps the floor on a questions marker, which upstream keeps', () => {
    const r = evalRequiredSections('One question?\n', 'requirements-questions', {
      recordTimestampExempt: true,
    });
    expect(r.pass).toBe(false);
    expect(r.detail.findings_count).toBe(2);
  });

  it('keeps the floor on an ordinary document', () => {
    const r = evalRequiredSections('## Only one\n', 'practices-discovery', {
      recordTimestampExempt: true,
    });
    expect(r.pass).toBe(false);
    expect(r.detail.findings_count).toBe(1);
  });

  it('leaves the unit-of-work DAG check untouched', () => {
    const name = 'unit-of-work-dependency';
    const cyclic = '## A\n## B\n```units\nunits:\n  - id: a\n    dependsOn: [a]\n```\n';
    const withExemption = evalRequiredSections(cyclic, name, { recordTimestampExempt: true });
    expect(withExemption).toEqual(evalRequiredSections(cyclic, name));
    expect(withExemption.pass).toBe(false);
  });
});

describe('evalRequiredSections', () => {
  it('passes at >= 2 distinct H2 headings', () => {
    const r = evalRequiredSections('## One\n\ntext\n\n## Two\n');
    expect(r.pass).toBe(true);
    expect(r.detail.h2_count).toBe(2);
  });
  it('fails below the threshold and counts findings', () => {
    const r = evalRequiredSections('## Only one\n\nbody');
    expect(r.pass).toBe(false);
    expect(r.detail.findings_count).toBe(1);
  });
  it('does not count ### deeper headings or duplicates', () => {
    const r = evalRequiredSections('## A\n### deeper\n## A\n## B');
    expect(r.detail.h2_count).toBe(2);
  });
  it('requires a valid units DAG for the unit-of-work-dependency artifact', () => {
    const good = [
      '## Units',
      '## Dependencies',
      '```yaml',
      'units:',
      '  - name: auth',
      '    depends_on: []',
      '  - name: api',
      '    depends_on: [auth]',
      '```',
    ].join('\n');
    const r = evalRequiredSections(good, 'unit-of-work-dependency');
    expect(r.pass).toBe(true);
    expect(r.detail.edge_block).toBe('ok');
  });
  it('fails the DAG artifact when the units block is absent', () => {
    const r = evalRequiredSections('## A\n## B\n', 'unit-of-work-dependency');
    expect(r.pass).toBe(false);
    expect(r.detail.edge_block).toBe('absent');
  });
  it('reports registered structured blocks when present', () => {
    const r = evalRequiredSections(
      [
        '## Stories',
        '## Traceability',
        '```yaml',
        'stories:',
        '  - id: s1',
        '    title: Login',
        '```',
      ].join('\n'),
      'stories',
    );
    expect(r.pass).toBe(true);
    expect(r.detail.structured_key).toBe('stories');
    expect(r.detail.structured_block).toBe('present');
    expect(r.detail.structured_items).toBe(1);
  });
  it('fails registered artifacts when a structured block is malformed', () => {
    const r = evalRequiredSections(
      ['## Stories', '## Traceability', '```yaml', 'stories:', '  - [', '```'].join('\n'),
      'stories',
    );
    expect(r.pass).toBe(false);
    expect(r.detail.structured_block).toBe('malformed');
  });
  it('an ABSENT structured block is a finding but passes by default (strictness ladder)', () => {
    const r = evalRequiredSections('## Stories\n## Traceability\nprose only', 'stories');
    expect(r.pass).toBe(true);
    expect(r.detail.structured_block).toBe('absent');
    expect(r.detail.findings_count).toBe(1);
  });
  it('strictStructuredBlocks flips an absent block to a FAIL (config, not code)', () => {
    const r = evalRequiredSections('## Stories\n## Traceability\nprose only', 'stories', {
      strictStructuredBlocks: true,
    });
    expect(r.pass).toBe(false);
    expect(r.detail.structured_block).toBe('absent');
    // Present blocks still pass under strict mode.
    const ok = evalRequiredSections(
      ['## Stories', '## More', '```yaml', 'stories:', '  - id: s1', '    title: T', '```'].join(
        '\n',
      ),
      'stories',
      { strictStructuredBlocks: true },
    );
    expect(ok.pass).toBe(true);
  });
});

describe('evalGraphCoverage', () => {
  it('is INCONCLUSIVE before any typed items exist (early stages must not fail)', () => {
    const r = evalGraphCoverage({ counts: {} });
    expect(r.result).toBe('INCONCLUSIVE');
  });

  it('passes a fully wired graph and reports non-must-have gaps without failing', () => {
    const r = evalGraphCoverage({
      counts: { requirements: 2, stories: 1, mappings: 1, components: 0 },
      uncoveredRequirements: [{ slug: 'req-theme' }], // could-have — reported only
      uncoveredMustHave: [],
      unmappedStories: [],
      unknownReferences: [],
      componentCycles: [],
    });
    expect(r.pass).toBe(true);
    expect(r.detail.uncovered_requirements).toEqual(['req-theme']);
    expect(r.detail.findings_count).toBe(0);
  });

  it('fails on uncovered must-haves, unknown references, and component cycles', () => {
    const r = evalGraphCoverage({
      counts: { requirements: 2, stories: 2, mappings: 1, components: 2 },
      uncoveredMustHave: [{ slug: 'req-pay' }],
      unmappedStories: [{ slug: 's-float' }],
      unknownReferences: [{ kind: 'story-covers-unknown-requirement', from: 's1', ref: 'ghost' }],
      componentCycles: ['a', 'b'],
    });
    expect(r.pass).toBe(false);
    expect(r.detail.findings_count).toBe(5);
    expect(r.detail.uncovered_must_have).toEqual(['req-pay']);
    expect(r.detail.component_cycles).toEqual(['a', 'b']);
  });

  it('ignores unmapped stories until a story map exists', () => {
    const r = evalGraphCoverage({
      counts: { requirements: 0, stories: 2, mappings: 0, components: 0 },
      uncoveredMustHave: [],
      unmappedStories: [{ slug: 's-a' }, { slug: 's-b' }],
      unknownReferences: [],
      componentCycles: [],
    });
    expect(r.pass).toBe(true);
    expect(r.detail.unmapped_stories).toEqual([]);
  });
});

describe('evalUpstreamCoverage', () => {
  it('passes when every consumed slug is referenced', () => {
    const body = 'We build on requirements and the [[domain-entities]] model.';
    const r = evalUpstreamCoverage(body, ['requirements', 'domain-entities']);
    expect(r.pass).toBe(true);
  });
  it('flags unreferenced upstream artifacts', () => {
    const r = evalUpstreamCoverage('only mentions requirements', [
      'requirements',
      'security-design',
    ]);
    expect(r.pass).toBe(false);
    expect(r.detail.unreferenced).toEqual(['security-design']);
  });
  it('passes trivially with no upstream', () => {
    expect(evalUpstreamCoverage('anything', []).detail.reason).toBe('no upstream');
  });
  it('accepts consume edge objects ({artifact})', () => {
    const r = evalUpstreamCoverage('mentions requirements', [{ artifact: 'requirements' }]);
    expect(r.pass).toBe(true);
  });
});

describe('parseBoltDag', () => {
  it('topo-sorts a valid DAG into batches', () => {
    const body =
      '```yaml\nunits:\n  - name: a\n    depends_on: []\n  - name: b\n    depends_on: [a]\n```';
    const r = parseBoltDag(body);
    expect(r.ok).toBe(true);
    expect(r.batches).toEqual([['a'], ['b']]);
  });
  it('detects a cycle', () => {
    const body =
      '```yaml\nunits:\n  - name: a\n    depends_on: [b]\n  - name: b\n    depends_on: [a]\n```';
    expect(parseBoltDag(body)).toMatchObject({ ok: false, reason: 'cyclic' });
  });
  it('rejects a dependency on an unknown unit', () => {
    const body = '```yaml\nunits:\n  - name: a\n    depends_on: [ghost]\n```';
    expect(parseBoltDag(body)).toMatchObject({ ok: false, reason: 'malformed' });
  });
  it('parses the optional per-unit kind (null when absent)', () => {
    const body =
      '```yaml\nunits:\n  - name: api\n    kind: service\n    depends_on: []\n  - name: docs\n    depends_on: [api]\n```';
    const r = parseBoltDag(body);
    expect(r.ok).toBe(true);
    expect(r.units).toEqual([
      { name: 'api', depends_on: [], kind: 'service' },
      { name: 'docs', depends_on: ['api'], kind: null },
    ]);
  });
  it('rejects an unknown kind loudly (never a silent full-matrix)', () => {
    const body = '```yaml\nunits:\n  - name: api\n    kind: microservice\n    depends_on: []\n```';
    const r = parseBoltDag(body);
    expect(r).toMatchObject({ ok: false, reason: 'malformed' });
    expect(r.detail).toContain('unknown kind "microservice"');
  });
});
