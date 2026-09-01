// G2 (static): extract the interaction reverse-request schemas from the
// zcode.cjs bundle. Reproducible: reads the bundle, locates the zod schema
// fragments, and records them (with sha256 of the scanned bundle) as evidence.
import fs from 'node:fs';
import { BIN, sha256File, note } from './lib.mjs';

const bundle = fs.readFileSync(BIN, 'utf8');

function around(needle, before, after) {
  const idx = bundle.indexOf(needle);
  if (idx < 0) return null;
  return bundle.slice(Math.max(0, idx - before), idx + after).replace(/\n/g, ' ');
}

const findings = {
  bundleSha256: sha256File(BIN),
  requestPermissionParams: around('interaction/requestPermission', 200, 500),
  requestPermissionSchema: around('requestId:pe,sessionId:pe,turnId:pe.optional(),toolCallId:pe,toolName:pe,reason:f.string(),riskLevel', 80, 400),
  pendingPermissionStatus: around('toolCallId:pe,toolName:pe,status:f.enum(["pending","running","completed","failed","denied"])', 60, 220),
  permissionOptionSchema: around('jBe=f.object({optionId:pe,kind:pe,name:pe,description', 60, 300),
  decisionEnum: around('VLe=f.enum(["allow","deny","escalate","modify"])', 20, 120),
  permissionUpdatesSchema: around('GLe=f.object({type:f.literal("addRules")', 20, 260),
  optionsConstruction: around('kind:"allow_always",name:r?"Always allow', 400, 400),
  reverseRequestTimeout: around('yCt=15e3', 200, 200),
  e2eClockScale: around('ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE', 100, 300),
  requestUserInputMethod: around('interactionRequestUserInput:"interaction/requestUserInput"', 100, 200),
  requestRuntimePreferencesSchema: around('fWi=f.object({sessionId:pe,scope:gwn}).strict()', 150, 150),
};

for (const [k, v] of Object.entries(findings)) {
  if (v === null) note(`WARNING: pattern not found: ${k}`);
}

fs.writeFileSync(
  new URL('../../evidence/wp0/g2-interaction-static.json', import.meta.url).pathname,
  JSON.stringify({ gate: 'G2', scope: 'static bundle extraction', findings }, null, 2),
);
note('G2 static extraction done');
