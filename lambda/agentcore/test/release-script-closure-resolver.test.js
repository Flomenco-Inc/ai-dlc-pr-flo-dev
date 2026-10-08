// The sensor closure reader against the PRODUCTION release resolver.
//
// The unit tests above it inject a loader and an object reader, so they cannot
// see whether the reader calls the real resolver correctly. These publish a real
// release bundle (built from a real compatibility fixture, with real sensor and
// helper bodies) into an in-memory object store and drive the reader's DEFAULT
// `loadReleaseClosure` / `resolveRuntimeFile`. What they pin:
//
//   - a well-formed pin resolves its closure instead of being rejected before
//     storage is read;
//   - a manifest-listed object that is absent from storage is a RELEASE
//     INTEGRITY failure, not a best-effort advisory — an incompletely published
//     closure must not let a stage continue;
//   - a user-tenant SENSOR overlay, resolved through the production library
//     resolver and plan builder, is not asked for a methodology closure at all.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { filesFromCompatibilityFixture } from '../../shared/aidlc-compatibility.js';
import { buildReleaseBundle, publishReleaseBundle } from '../../shared/aidlc-release.js';
import { blockPk, buildScriptRef, versionSk } from '../../shared/blocks.js';
import {
  __test,
  loadReleaseClosure,
  methodologyReleasePinFromManifest,
  resolveMethodologyLibrary,
} from '../../shared/release-resolver.js';
import { buildExecutionPlan } from '../../shared/v2-execution-plan.js';
import {
  createReleaseScriptClosureReader,
  releaseOwnedSensorPredicate,
} from '../release-script-closure.js';
import { isReleaseDependencyError } from '../sensor-runner.js';

const BUCKET = 'artifacts-test';
const TABLE = 'blocks-test';
const PROFILE = 'current-stable';
const AIDLC_LIB = 'core/tools/aidlc-lib.ts';

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const store = new Map();

const noSuchKey = () => {
  const error = new Error('The specified key does not exist.');
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
};

const fixture = JSON.parse(
  readFileSync(
    new URL(`../../shared/test/fixtures/aidlc-compatibility/${PROFILE}.json`, import.meta.url),
    'utf8',
  ),
);
const bundle = buildReleaseBundle({
  profileId: PROFILE,
  files: filesFromCompatibilityFixture({ profileId: PROFILE, fixture }),
});
const pin = methodologyReleasePinFromManifest(bundle.manifest);

// The release's own `type-check` script and the helper it imports, as published.
const typeCheckScript = fixture.files['core/tools/aidlc-sensor-type-check.ts'].content;
const aidlcLib = fixture.files[AIDLC_LIB].content;

// The real transitive closure of 2.3.3's `type-check`: the helper it imports,
// plus everything that helper imports in turn (including its type-only
// specifiers, which the walk treats as imports because the spawned interpreter
// resolves them). None of these was ever written next to the script.
const TYPE_CHECK_SIBLINGS = [
  'aidlc-audit.ts',
  'aidlc-graph.ts',
  'aidlc-lib.ts',
  'aidlc-rule-schema.ts',
  'aidlc-sensor-schema.ts',
  'aidlc-stage-schema.ts',
];

// A user-tenant SENSOR overlay whose script imports the project's checked-out
// code, which the methodology release never published and never will.
const OVERLAY_SCRIPT = 'import { ok } from "../../src/helper.ts";\nconsole.log(ok);\n';
const overlayRow = {
  pk: blockPk('default', 'SENSOR', 'type-check'),
  sk: versionSk(7),
  type: 'SENSOR',
  blockId: 'type-check',
  id: 'type-check',
  tenantId: 'default',
  version: 7,
  command: 'bun <runtime-managed>/tools/aidlc-sensor-type-check.ts',
  runtime: 'bun',
  severity: 'advisory',
  matches: '**/*.ts',
  scriptRef: buildScriptRef(OVERLAY_SCRIPT),
};

const readerFor = (sensorsById, { resolveRuntimeFile } = {}) =>
  createReleaseScriptClosureReader({
    methodologyRelease: pin,
    releaseOwnsSensor: releaseOwnedSensorPredicate(sensorsById),
    s3,
    bucket: () => BUCKET,
    ...(resolveRuntimeFile ? { resolveRuntimeFile } : {}),
  });

beforeEach(async () => {
  s3Mock.reset();
  ddbMock.reset();
  store.clear();
  s3Mock.on(PutObjectCommand).callsFake((input) => {
    store.set(input.Key, String(input.Body));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (!store.has(input.Key)) throw noSuchKey();
    return { Body: { transformToString: async () => store.get(input.Key) } };
  });
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item:
      `${input.Key.pk}|${input.Key.sk}` === `${overlayRow.pk}|${overlayRow.sk}` ? overlayRow : null,
  }));
  ddbMock.on(QueryCommand).callsFake(() => ({ Items: [] }));
  // The closure cache is never invalidated in production (a closure is
  // immutable), so every test here starts from cold.
  __test.releaseClosureCache.clear();
  await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
});

describe('the reader against the production resolver', () => {
  it('resolves the real helper a release sensor imports, out of the published closure', async () => {
    const reader = readerFor({ 'type-check': { tenantId: 'SYSTEM' } });

    const closureFiles = await reader('type-check', typeCheckScript);

    expect(closureFiles.map((file) => file.relativePath).toSorted()).toEqual(TYPE_CHECK_SIBLINGS);
    expect(closureFiles.find((file) => file.relativePath === 'aidlc-lib.ts').content).toBe(
      aidlcLib,
    );
  });

  it('holds the stage when the manifest lists a dependency storage no longer has', async () => {
    const manifestEntry = bundle.manifest.runtimeFiles.find((file) => file.path === AIDLC_LIB);
    store.delete(manifestEntry.key);
    const reader = readerFor({ 'type-check': { tenantId: 'SYSTEM' } });

    const error = await reader('type-check', typeCheckScript).catch((caught) => caught);
    expect(error).toMatchObject({ name: 'ReleaseResolverError', code: 'runtime_file_missing' });
    expect(isReleaseDependencyError(error)).toBe(true);
  });

  it('holds the stage when a published dependency no longer matches its digest', async () => {
    const manifestEntry = bundle.manifest.runtimeFiles.find((file) => file.path === AIDLC_LIB);
    store.set(manifestEntry.key, `${aidlcLib}\n// tampered\n`);
    const reader = readerFor({ 'type-check': { tenantId: 'SYSTEM' } });

    const error = await reader('type-check', typeCheckScript).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'release_closure_mismatch' });
    expect(isReleaseDependencyError(error)).toBe(true);
  });
});

// The overlay half of the provenance rule, through the real library resolver and
// the real plan builder rather than a hand-built sensor bag.
describe('a user SENSOR overlay in a pinned intent', () => {
  const resolvedLibrary = async () => {
    const closure = await loadReleaseClosure({
      s3,
      bucket: BUCKET,
      methodologyRelease: pin,
      cache: new Map(),
    });
    return resolveMethodologyLibrary({
      closure,
      ddb,
      tableName: TABLE,
      workflowId: closure.catalog.workflow.id,
      workflowVersion: 1,
      methodologyPins: { SENSOR: { 'type-check': { tenantId: 'default', version: 7 } } },
    });
  };

  const sensorEntries = ({ workflow, library }, sensorId) => {
    const scopes = [
      ...new Set(
        (workflow.placements ?? []).flatMap((placement) =>
          Object.keys(placement.scopeMembership ?? {}),
        ),
      ),
    ].toSorted();
    return scopes.flatMap((scope) =>
      (buildExecutionPlan({ workflow, scope, library }).plan?.stages ?? []).flatMap((stage) =>
        (stage.sensors ?? []).filter((sensor) => sensor.sensorId === sensorId),
      ),
    );
  };

  it('replaces the release sensor and still reaches the plan', async () => {
    const resolved = await resolvedLibrary();

    expect(resolved.library.sensorsById['type-check']).toMatchObject({ tenantId: 'default' });
    expect(sensorEntries(resolved, 'type-check').length).toBeGreaterThan(0);
  });

  it('is never asked for a methodology closure, so its project import is not corruption', async () => {
    const resolved = await resolvedLibrary();
    const read = [];
    const reader = readerFor(resolved.library.sensorsById, {
      resolveRuntimeFile: async ({ repoPath }) => {
        read.push(repoPath);
        return { content: '' };
      },
    });

    expect(await reader('type-check', OVERLAY_SCRIPT)).toEqual([]);
    expect(read).toEqual([]);
  });
});
