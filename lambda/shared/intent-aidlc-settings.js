// Per-intent AI-DLC settings — the four 2.11.0 scope switches a project member
// may choose for one intent.
//
// A setting is a TEAM decision about one intent, and it is ORDINARY DRAFT
// SELECTION STATE: it lives beside `scope`, `composedGrid` and `skipStageIds` in
// the collaborative document, travels in the same debounced `PATCH` under the
// same draft-revision CAS, and is flushed by the same barrier before Start.
// There is deliberately no second write path, no server answer published back
// into the shared document and no per-setting provenance record — those were the
// mechanisms that made the settings race the selection they depend on.
//
// Three consequences worth stating, because they are the contract:
//   - it is read-only once the intent leaves DRAFT (the intents API answers 409
//     `settings_locked`), because a mid-run settings change is refused by name
//     in the dialect annex;
//   - no MCP tool writes it — the only write path is the authenticated intent
//     API, which is asserted against the tool surface;
//   - ONLY DELTAS FROM THE SCOPE DEFAULT ARE STORED. A value equal to the
//     scope's own default is not an override, so it is not persisted. That is
//     what makes every later statement about a setting's origin true: there is
//     no stored state capable of claiming a value came from a scope that does
//     not supply it. The cost is that an explicit choice which happens to equal
//     the default is not retained across a later scope change — the same
//     semantics `composedGrid` already has relative to `scope`.
//
// Who changed a setting is recorded in the intent's append-only timeline by the
// `PATCH` that changed it, and shown live by the existing awareness presence. It
// is never frozen into a pinned plan.
//
// The legal values are NOT duplicated here: each setting names the capability
// registry entry whose value set the importer already validates, so the API's
// 400, the plan's `policy_enum_invalid` and the UI's options are one vocabulary.

import { capabilityFor } from './aidlc-capabilities.js';

// setting key (and plan/META key) → the SCOPE capability it overrides.
const AIDLC_SETTING_CAPABILITIES = Object.freeze({
  guardPolicy: 'SCOPE:guard_policy',
  planApproval: 'SCOPE:plan_approval',
  collaborators: 'SCOPE:collaborators',
  existingCode: 'SCOPE:existing_code',
});

const AIDLC_SETTING_KEYS = Object.freeze(Object.keys(AIDLC_SETTING_CAPABILITIES));

const aidlcSettingValues = (key) =>
  Object.keys(capabilityFor(AIDLC_SETTING_CAPABILITIES[key])?.values ?? {});

// The type the methodology authors the setting as, from the same registry entry
// that owns its values. Three settings are text switches; `existing_code` is a
// YAML boolean.
const aidlcSettingType = (key) =>
  capabilityFor(AIDLC_SETTING_CAPABILITIES[key])?.authoredType ?? 'string';

// The authored field name the methodology itself uses, for a prompt or a notice
// that has to speak the scope file's words rather than ours.
const aidlcSettingField = (key) => capabilityFor(AIDLC_SETTING_CAPABILITIES[key])?.field ?? key;

// The authored value of each setting the resolved SCOPE block carries. Absent
// keys are omitted rather than nulled: "the release does not author this
// setting" and "the release authored it off" are different facts, and only the
// first one may hide the setting from a human.
const scopeAidlcSettings = (scopeBlock) => {
  const authored = {};
  if (!scopeBlock) return authored;
  for (const key of AIDLC_SETTING_KEYS) {
    if (scopeBlock[key] != null) authored[key] = scopeBlock[key];
  }
  return authored;
};

export {
  AIDLC_SETTING_CAPABILITIES,
  AIDLC_SETTING_KEYS,
  aidlcSettingField,
  aidlcSettingType,
  aidlcSettingValues,
  scopeAidlcSettings,
};
