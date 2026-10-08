import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSensorRunner, isReleaseDependencyError, __test } from '../sensor-runner.js';

const { globToRegExp, resultFromScript } = __test;

describe('globToRegExp', () => {
  it('matches a brace-alternation code glob', () => {
    const re = globToRegExp('**/*.{ts,tsx}');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/a.tsx')).toBe(true);
    expect(re.test('src/a.js')).toBe(false);
  });
  it('matches an aidlc-docs path glob', () => {
    const re = globToRegExp('**/aidlc-docs/**');
    expect(re.test('aidlc-docs/x/y.md')).toBe(true);
    expect(re.test('src/aidlc-docs/z.md')).toBe(true);
    expect(re.test('src/other.md')).toBe(false);
  });
});

describe('resultFromScript', () => {
  it('reads the stdout JSON pass field over the exit code', () => {
    expect(resultFromScript({ exitCode: 0, stdout: '{"pass":false}' }).result).toBe('FAIL');
    expect(resultFromScript({ exitCode: 0, stdout: '{"pass":true}' }).result).toBe('PASS');
  });
  it('falls back to the exit code without JSON', () => {
    expect(resultFromScript({ exitCode: 2, stdout: '' }).result).toBe('INCONCLUSIVE');
  });
});

// A fake graph-writer returning canned artifact rows by type.
const fakeGraph = (byType) => ({
  lookupArtifacts: async ({ artifactType }) => byType[artifactType] ?? [],
});

describe('runStageSensors — graph kind', () => {
  it('passes required-sections when produced content has >= 2 H2s', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ requirements: [{ id: 'r1', content: '## A\n## B\n' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'requirements' }],
      stageId: 'requirements-analysis',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'graph', result: 'PASS', held: false });
  });

  it('a blocking required-sections that fails marks the verdict held', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ requirements: [{ id: 'r1', content: '## only one' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'blocking' }],
      outputArtifacts: [{ artifact: 'requirements' }],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ result: 'FAIL', held: true });
  });

  it('upstream-coverage flags an unreferenced consume', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ design: [{ id: 'd1', content: 'mentions requirements only' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'upstream-coverage', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [{ artifact: 'requirements' }, { artifact: 'security-design' }],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('FAIL');
    expect(verdicts[0].detail.artifacts[0].unreferenced).toEqual(['security-design']);
  });

  it('upstream-coverage skips expectedAbsent consumes (no false FAIL in lean scopes)', async () => {
    // `unit-of-work` is never produced in this scope (producer out of scope) —
    // the output can't legitimately reference it, so it must not be threaded
    // into the coverage check. Only the present input counts.
    const runner = createSensorRunner({
      graph: fakeGraph({ design: [{ id: 'd1', content: 'derived from requirements' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'upstream-coverage', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [
        { artifact: 'requirements', required: true },
        { artifact: 'unit-of-work', required: true, expectedAbsent: true },
      ],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('PASS');
  });

  it('graph-coverage runs intent-wide off getCoverage (not per produced artifact)', async () => {
    const runner = createSensorRunner({
      graph: {
        ...fakeGraph({}),
        getCoverage: async () => ({
          counts: { requirements: 1, stories: 1, mappings: 1, components: 0 },
          uncoveredRequirements: [],
          uncoveredMustHave: [{ slug: 'req-pay' }],
          unmappedStories: [],
          unknownReferences: [],
          componentCycles: [],
        }),
      },
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'graph-coverage', severity: 'advisory' }],
      // No produced artifacts needed — the report is intent-wide.
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'graph', result: 'FAIL', held: false });
    expect(verdicts[0].detail.uncovered_must_have).toEqual(['req-pay']);
  });

  it('graph-coverage degrades to INCONCLUSIVE when the writer lacks getCoverage', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({}),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'graph-coverage', severity: 'advisory' }],
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
  });

  it('INCONCLUSIVE when the stage produced no artifacts', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({}),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory' }],
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
  });
});

describe('runStageSensors — script kind', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-ws-'));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  // A fake spawn that emits a JSON verdict on stdout and exits 0.
  const fakeSpawn =
    (stdout, code = 0) =>
    () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      }, 0);
      return child;
    };

  it('INCONCLUSIVE when no workspace file matches the glob', async () => {
    await writeFile(path.join(ws, 'README.md'), '# hi');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'console.log("{}")',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.{ts,js}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
    expect(verdicts[0].detail.reason).toBe('no files match');
  });

  it('spawns the materialized script per matching file and reads its verdict', async () => {
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const x = 1;');
    let scriptWritten = '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        scriptWritten = 'SENSOR_SCRIPT_BODY';
        return scriptWritten;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun <runtime-managed>/tools/aidlc-sensor-linter.ts',
          matches: '**/*.{ts,js}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'script', result: 'PASS', held: false });
    expect(verdicts[0].detail.files[0].file).toBe('src/a.ts');
  });

  it('BLOCKED when a script sensor has no script bytes', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => '',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ result: 'BLOCKED', held: true });
  });

  it('holds an advisory sensor on a typed release-integrity failure', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const error = Object.assign(new Error('release script digest mismatch'), {
      name: 'ReleaseResolverError',
      code: 'release_closure_mismatch',
    });
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        throw error;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
        },
      ],
      stageId: 's',
    });

    expect(verdicts[0]).toMatchObject({
      result: 'BLOCKED',
      severity: 'advisory',
      held: true,
      detail: {
        code: 'release_closure_mismatch',
        releaseIntegrityFailure: true,
      },
    });
  });

  it('keeps an advisory sensor non-blocking when its legacy script is absent', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => '',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 's',
    });

    expect(verdicts[0]).toMatchObject({
      result: 'BLOCKED',
      held: false,
      detail: { error: 'sensor has no script' },
    });
  });

  const advisoryScriptSensor = {
    sensorId: 'linter',
    severity: 'advisory',
    runtime: 'bun',
    command: 'bun x.ts',
    matches: '**/*.ts',
    timeoutSeconds: 5,
    scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
  };

  const runWithLoaderError = async (error) => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        throw error;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const [verdict] = await runner.runStageSensors({
      sensors: [advisoryScriptSensor],
      stageId: 's',
    });
    return verdict;
  };

  it('keeps an advisory sensor non-blocking when the legacy loader rejects', async () => {
    const verdict = await runWithLoaderError(new Error('NoSuchKey: blocks/scripts/sha256/abc123'));

    expect(verdict).toMatchObject({
      result: 'BLOCKED',
      held: false,
      detail: { error: 'sensor has no script' },
    });
    expect(verdict.detail).not.toHaveProperty('releaseIntegrityFailure');
  });

  // A release-pinned sensor whose user-tenant overlay cannot be resolved runs a
  // different check than the one the intent pinned, which is exactly the drift
  // a pin exists to prevent, so it holds like a digest mismatch.
  it.each(['user_block_missing', 'unpinned_user_block'])(
    'holds an advisory release sensor whose user overlay fails with %s',
    async (code) => {
      const verdict = await runWithLoaderError(
        Object.assign(new Error(`release overlay failed: ${code}`), {
          name: 'ReleaseResolverError',
          code,
        }),
      );

      expect(verdict).toMatchObject({
        result: 'BLOCKED',
        held: true,
        detail: { code, releaseIntegrityFailure: true },
      });
    },
  );

  it('does not hold an advisory sensor on an overlay code raised outside release resolution', async () => {
    const verdict = await runWithLoaderError(
      Object.assign(new Error('user block missing'), { code: 'user_block_missing' }),
    );

    expect(verdict).toMatchObject({
      result: 'BLOCKED',
      held: false,
      detail: { error: 'sensor has no script' },
    });
    expect(verdict.detail).not.toHaveProperty('releaseIntegrityFailure');
  });

  // Regression for the plan→runner scriptRef contract. The PROD loadBlockScript
  // reads sensor.scriptRef.s3Key from S3; here we mimic that (return bytes if
  // the sensor carries a scriptRef) instead of the argument-ignoring stub the
  // other tests use. A plan sensor that carries its scriptRef must run; one
  // whose scriptRef was stripped must BLOCK. This is the shape that
  // v2-execution-plan.resolveSensors now guarantees.
  it('runs a script sensor whose plan object carries a scriptRef (prod loader semantics)', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    // Mirrors block-loader.loadBlockScript: '' when there is no scriptRef.
    const loadBlockScript = async (sensor) =>
      sensor?.scriptRef?.s3Key ? 'SENSOR_SCRIPT_BODY' : '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript,
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'script', result: 'PASS' });
  });

  it('BLOCKS a script sensor whose plan object lost its scriptRef (prod loader semantics)', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    const loadBlockScript = async (sensor) =>
      sensor?.scriptRef?.s3Key ? 'SENSOR_SCRIPT_BODY' : '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript,
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          // scriptRef intentionally absent — the pre-fix regression shape.
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ result: 'BLOCKED' });
    expect(verdicts[0].detail.error).toBe('sensor has no script');
  });

  it('preserves typed release script errors on a blocked sensor verdict', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    const releaseError = Object.assign(new Error('release object digest mismatch'), {
      name: 'ReleaseResolverError',
      code: 'release_object_digest_mismatch',
      details: { key: 'runtime/sha256/script' },
    });
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        throw releaseError;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });

    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
        },
      ],
      stageId: 'code-generation',
    });

    expect(verdicts[0]).toMatchObject({
      result: 'BLOCKED',
      held: true,
      detail: { error: releaseError.message, code: releaseError.code, name: releaseError.name },
    });
  });
});

// The flag a script sensor is spawned with comes from the plan, which resolved
// it from the sensor's declared contract. A document sensor spawned with the
// code sensors' --file-path exits before it runs its check.
describe('runStageSensors — script argv', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-argv-'));
    await mkdir(path.join(ws, 'aidlc-docs'), { recursive: true });
    await writeFile(path.join(ws, 'aidlc-docs', 'traceability.json'), '{}');
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  const spawnRecording = (calls) => (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('{"pass":true}'));
      child.emit('close', 0);
    }, 0);
    return child;
  };

  const runWith = async (sensor, runnerOptions = {}) => {
    const calls = [];
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      spawnFn: spawnRecording(calls),
      ...runnerOptions,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [sensor],
      stageId: 'intent-capture',
    });
    return { calls, verdicts };
  };

  const traceability = {
    sensorId: 'traceability',
    severity: 'advisory',
    runtime: 'bun',
    command: 'bun aidlc-sensor-traceability.ts',
    matches: '**/traceability.json',
    timeoutSeconds: 5,
  };

  it('spawns a document sensor on the output path its plan entry carries', async () => {
    const { calls, verdicts } = await runWith({ ...traceability, pathFlag: '--output-path' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      path.join(ws, '.aidlc', 'sensors', 'traceability.ts'),
      '--stage',
      'intent-capture',
      '--output-path',
      'aidlc-docs/traceability.json',
    ]);
    expect(verdicts[0].result).toBe('PASS');
  });

  it('spawns a sensor with no resolved flag on the file path, as before', async () => {
    const { calls } = await runWith(traceability);
    expect(calls[0].args.slice(-2)).toEqual(['--file-path', 'aidlc-docs/traceability.json']);
  });

  it('shortens a long budget to the stage deadline and says so in the verdict', async () => {
    const { calls, verdicts } = await runWith(
      { ...traceability, timeoutSeconds: 1200 },
      { remainingStageMs: () => 90000 },
    );
    expect(calls).toHaveLength(1);
    expect(verdicts[0].detail).toMatchObject({ timeoutMs: 90000, boundedBy: 'stage-deadline' });
  });

  it('reports no bound when the authored budget is the one that runs', async () => {
    const { verdicts } = await runWith(traceability, { remainingStageMs: () => 90000 });
    expect(verdicts[0].detail).not.toHaveProperty('boundedBy');
  });
});

// What is left of the stage's wall-clock budget bounds EVERY child, not just the
// first. A sensor matching several files handed each of them the allowance the
// first one found, and an already-expired budget restored the whole authored
// allowance instead of stopping the pass — so the bound protected nothing.
describe('runStageSensors — the stage budget bounds every child', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-budget-'));
    await writeFile(path.join(ws, 'a.ts'), 'export const a = 1;');
    await writeFile(path.join(ws, 'b.ts'), 'export const b = 2;');
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  const typeCheck = {
    sensorId: 'type-check',
    severity: 'advisory',
    runtime: 'bun',
    command: 'bun aidlc-sensor-type-check.ts',
    matches: '**/*.ts',
    timeoutSeconds: 600,
  };

  // Returns each value in turn, then repeats the last one — so a test can say
  // "there was time for the first file and none for the second".
  const remainingSequence = (values, reads) => () => {
    const value = values[Math.min(reads.length, values.length - 1)];
    reads.push(value);
    return value;
  };

  const runWith = async ({ sensor = typeCheck, remaining = null } = {}) => {
    const calls = [];
    const reads = [];
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      spawnFn: (file, args) => {
        calls.push({ file, args });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from('{"pass":true}'));
          child.emit('close', 0);
        }, 0);
        return child;
      },
      ...(remaining ? { remainingStageMs: remainingSequence(remaining, reads) } : {}),
    });
    const verdicts = await runner.runStageSensors({ sensors: [sensor], stageId: 'construction' });
    return { calls, reads, verdict: verdicts[0] };
  };

  it('re-reads what is left of the stage before each file, not once for the pass', async () => {
    const { calls, reads, verdict } = await runWith({ remaining: [300000, 120000] });
    expect(calls).toHaveLength(2);
    expect(reads).toEqual([300000, 120000]);
    expect(verdict.detail).toMatchObject({ timeoutMs: 120000, boundedBy: 'stage-deadline' });
  });

  it('stops the sweep when the budget runs out part-way, and says which file it never read', async () => {
    const { calls, verdict } = await runWith({ remaining: [300000, -1] });
    expect(calls).toHaveLength(1);
    expect(verdict.result).toBe('BLOCKED');
    expect(verdict.detail.stageBudgetExhausted).toBe(true);
    expect(verdict.detail.files).toHaveLength(2);
    expect(verdict.detail.files[1]).toMatchObject({
      result: 'BLOCKED',
      detail: { error: expect.stringContaining('stage budget was exhausted') },
    });
    expect(verdict.detail).toMatchObject({ timeoutMs: 300000, boundedBy: 'stage-deadline' });
  });

  it('launches nothing at all once the stage deadline has already passed', async () => {
    const { calls, verdict } = await runWith({ remaining: [-1] });
    expect(calls).toEqual([]);
    expect(verdict.result).toBe('BLOCKED');
    expect(verdict.detail).toMatchObject({ stageBudgetExhausted: true });
    expect(verdict.detail.files.map((f) => f.result)).toEqual(['BLOCKED', 'BLOCKED']);
    expect(verdict.detail).not.toHaveProperty('timeoutMs');
    expect(verdict.detail).not.toHaveProperty('boundedBy');
  });

  it('reports exhaustion without a launch bound when the earlier child kept its authored budget', async () => {
    const { calls, verdict } = await runWith({ remaining: [900000, 0] });
    expect(calls).toHaveLength(1);
    expect(verdict.detail).toMatchObject({ stageBudgetExhausted: true });
    expect(verdict.detail.files.map((f) => f.result)).toEqual(['PASS', 'BLOCKED']);
    expect(verdict.detail).not.toHaveProperty('timeoutMs');
    expect(verdict.detail).not.toHaveProperty('boundedBy');
  });

  it('holds the stage on an exhausted budget when the sensor is blocking', async () => {
    const { verdict } = await runWith({
      sensor: { ...typeCheck, severity: 'blocking' },
      remaining: [0],
    });
    expect(verdict.held).toBe(true);
  });

  it('leaves the authored budget alone when no deadline is available', async () => {
    const { calls, verdict } = await runWith();
    expect(calls).toHaveLength(2);
    expect(verdict.result).toBe('PASS');
    expect(verdict.detail).not.toHaveProperty('boundedBy');
    expect(verdict.detail).not.toHaveProperty('stageBudgetExhausted');
  });
});

// A release failure the runner must hold the stage on, whatever the sensor's
// severity: the pinned check could not be run at all. `runtime_file_missing`
// is the resolver's code for a manifest-listed object that is absent from
// storage, and it carries no `release_` prefix — an incompletely published
// closure used to be classified as a best-effort loader error, which let an
// advisory sensor continue on a release that cannot be run.
describe('isReleaseDependencyError', () => {
  const resolverError = (code) => ({ name: 'ReleaseResolverError', code });

  it('holds on an unreadable, mismatched, or incompletely published closure', () => {
    for (const code of [
      'release_closure_mismatch',
      'release_object_unreadable',
      'release_script_dependency_missing',
      'runtime_file_missing',
      'unpinned_user_block',
      'user_block_missing',
    ]) {
      expect(isReleaseDependencyError(resolverError(code)), code).toBe(true);
    }
  });

  it('leaves an ordinary loader failure best-effort', () => {
    expect(isReleaseDependencyError(new Error('NoSuchKey'))).toBe(false);
    expect(isReleaseDependencyError({ name: 'Error', code: 'runtime_file_missing' })).toBe(false);
    expect(isReleaseDependencyError(null)).toBe(false);
  });
});
