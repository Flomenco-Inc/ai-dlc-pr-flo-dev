// Materializes the sibling modules a pinned sensor script imports.
//
// A release's sensor script is one object in the closure; the modules it imports
// are others, published under the `runtime` role by path
// (`aidlc-release.js` `runtimeEntries`). The runtime wrote only the entry script
// next to the workspace, so a script importing `./aidlc-lib.ts` died at startup
// with `Cannot find module` before running its check. This resolves the closure
// with the same walk the compatibility analyzer uses to claim the closure is
// complete, and fails closed: a dependency the release does not publish, or one
// whose bytes do not match the recorded digest, is a release integrity failure
// naming the path — never a partial materialization and never a fallback to a
// SYSTEM copy of the same file.

import path from 'node:path';
import { s3 as defaultS3 } from './clients.js';
import { sensorScriptPath } from '../shared/block-mappers.js';
import { SYSTEM_TENANT } from '../shared/tenant.js';
import {
  loadReleaseClosure as defaultLoadReleaseClosure,
  ReleaseResolverError,
  resolveRuntimeFile as defaultResolveRuntimeFile,
} from '../shared/release-resolver.js';
import {
  dependencyClosure,
  importSpecifiers,
  resolveRelativeImport,
} from '../shared/script-closure.js';

const artifactsBucket = () => process.env.ARTIFACTS_BUCKET;

// Fetch every relative import reachable from the entry, then re-derive the
// closure with the analyzer's own function so an incomplete read is reported by
// the same rule the promotion guard applies.
export const resolveScriptClosure = async ({ entryPath, entryContent, publishes, read }) => {
  const files = new Map([[entryPath, entryContent]]);
  const queue = [entryPath];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const specifier of importSpecifiers(files.get(current))) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveRelativeImport({ has: publishes }, current, specifier);
      if (files.has(resolved)) continue;
      if (!publishes(resolved)) {
        throw new ReleaseResolverError(
          'release_script_dependency_missing',
          `release-script-closure: ${entryPath} imports ${specifier}, which release object ${resolved} does not publish`,
          { details: { entryPath, specifier, resolved } },
        );
      }
      files.set(resolved, await read(resolved));
      queue.push(resolved);
    }
  }
  const closure = dependencyClosure(files, entryPath);
  if (closure.missing.length > 0) {
    throw new ReleaseResolverError(
      'release_script_dependency_missing',
      `release-script-closure: ${entryPath} is missing ${closure.missing.join(', ')}`,
      { details: { entryPath, missing: closure.missing } },
    );
  }
  const entryDir = path.posix.dirname(entryPath);
  return closure.files
    .filter((item) => item !== entryPath)
    .map((item) => ({
      relativePath: path.posix.relative(entryDir, item),
      content: files.get(item),
    }));
};

// Whether a SENSOR the plan resolved belongs to the methodology release itself.
//
// A pinned intent's library is the release catalog plus explicit user-tenant
// overlays (`release-resolver.js` resolveMethodologyLibrary). Only the release's
// own sensors have a release closure to read: a user overlay's script resolves
// its relative imports against the workspace it is materialized into, which the
// release never published. Asking the release for them would report the
// project's own code as corruption of a release that never owned it. This is
// the same provenance test `loadBlockScript` applies to the script bytes.
export const releaseOwnedSensorPredicate = (sensorsById) => (sensorId) =>
  (sensorsById?.[sensorId]?.tenantId ?? SYSTEM_TENANT) === SYSTEM_TENANT;

// The runtime's reader: resolves a pinned sensor's import closure out of the
// intent's release closure. Returns [] in legacy mode, where a sensor script is
// a single self-contained object and there is no closure to read.
export const createReleaseScriptClosureReader = ({
  methodologyRelease = null,
  releaseOwnsSensor = null,
  s3 = defaultS3,
  bucket = artifactsBucket,
  loadReleaseClosure = defaultLoadReleaseClosure,
  resolveRuntimeFile = defaultResolveRuntimeFile,
} = {}) => {
  if (!methodologyRelease) return null;
  if (typeof releaseOwnsSensor !== 'function') {
    throw new TypeError(
      'release-script-closure: releaseOwnsSensor is required — a reader that cannot tell a release sensor from a user overlay would hold a stage on the project\u2019s own imports',
    );
  }
  return async (sensorId, entryContent) => {
    if (!releaseOwnsSensor(sensorId)) return [];
    // A self-contained script needs no closure, so it must not cost a closure
    // read: that keeps every release whose sensor scripts import nothing on
    // exactly the object reads it performs today.
    if (!importSpecifiers(entryContent).some((specifier) => specifier.startsWith('.'))) return [];
    const closure = await loadReleaseClosure({ s3, bucket: bucket(), methodologyRelease });
    return resolveScriptClosure({
      entryPath: sensorScriptPath(sensorId),
      entryContent,
      publishes: (repoPath) => closure.runtimeFiles?.has(repoPath) ?? false,
      read: async (repoPath) =>
        (await resolveRuntimeFile({ s3, bucket: bucket(), closure, repoPath })).content,
    });
  };
};

export default {
  createReleaseScriptClosureReader,
  releaseOwnedSensorPredicate,
  resolveScriptClosure,
};
