export const zeroDayDbFixture = {
  "id": "zero-day-db",
  "version": 1,
  "title": "Vulnerability database: CVE lifecycle, CVSS v3.1 scoring, CPE matching, and temporal adjustments",
  "description": "Repair four cooperating modules for a vulnerability intelligence database: CVE record lifecycle management with ID validation and state machine transitions, CVSS v3.1 base score computation from attack vector metrics, CPE 2.3 URI parsing and matching with wildcard and version range support, and temporal/environmental score adjustments with prioritized sorting.",
  "checkType": "zero-day-db",
  "objective": "Repair all four ES modules in src/ according to README.md. In src/cve.mjs, fix createCve to validate CVE ID format with regex /^CVE-\\d{4}-\\d{4,}$/; fix updateStatus to enforce the state machine transitions (new->analyzing, analyzing->confirmed|rejected, confirmed->published, published->updated) and set publishedDate on publish; fix addReference to validate URL prefix and reference type and reject duplicate URLs; fix searchCves to implement proper AND-combined filtering instead of returning everything. In src/cvss.mjs, fix parseVector to validate the CVSS:3.1 prefix and all 8 metrics; fix baseScore to implement the full CVSS v3.1 formula with ISS, impact, exploitability, scope-dependent PR weights, and roundUp; fix severity to return correct thresholds (None/Low/Medium/High/Critical); fix compareVulnerabilities to return actual scores and comparison. In src/cpe.mjs, fix parseCpe to split on colons (not slashes) and validate 13 total fields; fix matchCpe to do case-insensitive field matching with wildcard support; fix versionInRange to compare as dot-separated integers instead of strings; fix findAffected to filter using both CPE match and version range. In src/temporal.mjs, fix temporalScore to apply actual ECM/RL/RC multiplier values; fix environmentalScore to apply CR/IR/AR requirement modifiers; fix prioritize to sort by environmental DESC, temporal DESC, base DESC, then CVE ID ASC. All functions are documented in README.md.",
  "constraints": [
    "CVSS scores must be rounded up to the nearest 0.1 per the specification: roundUp(x) = Math.ceil(x * 10) / 10.",
    "CVE IDs must match the exact regex /^CVE-\\d{4}-\\d{4,}$/.",
    "CPE matching must handle * (any) and - (NA) wildcards per CPE 2.3 spec.",
    "Never mutate input objects or arrays — return new copies.",
    "Preserve existing test files and package.json scripts.test unchanged; add new tests separately."
  ],
  "files": {
    "package.json": "{\n  \"name\": \"fixture-zero-day-db\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": {\n    \"test\": \"node test/smoke.mjs\"\n  }\n}\n",
    "src/cve.mjs": `export function createCve(id, opts) {
  return {
    id,
    ...opts,
    status: 'new',
    publishedDate: null,
    references: []
  };
}

export function updateStatus(cve, newStatus, { now } = {}) {
  return {
    ...cve,
    status: newStatus
  };
}

export function addReference(cve, ref) {
  return {
    ...cve,
    references: [...cve.references, ref]
  };
}

export function searchCves(cves, filters) {
  return [...cves];
}
`,
    "src/cvss.mjs": `const AV_WEIGHTS = { N: 0.85, A: 0.62, L: 0.55, P: 0.20 };
const AC_WEIGHTS = { L: 0.77, H: 0.44 };
const PR_UNCHANGED = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED = { N: 0.85, L: 0.68, H: 0.50 };
const UI_WEIGHTS = { N: 0.85, R: 0.62 };
const CIA_WEIGHTS = { N: 0, L: 0.22, H: 0.56 };

export function parseVector(str) {
  const parts = str.split('/');
  const metrics = {};
  for (const part of parts) {
    const [key, val] = part.split(':');
    metrics[key] = val;
  }
  return metrics;
}

export function baseScore(vector) {
  const m = typeof vector === 'string' ? parseVector(vector) : vector;
  const c = CIA_WEIGHTS[m.C] || 0;
  const i = CIA_WEIGHTS[m.I] || 0;
  const a = CIA_WEIGHTS[m.A] || 0;
  return Math.round((c + i + a) * 10) / 10;
}

export function severity(score) {
  return 'Medium';
}

export function compareVulnerabilities(a, b) {
  return {
    aScore: 0,
    bScore: 0,
    moreSevere: 'equal',
    riskDelta: 0
  };
}
`,
    "src/cpe.mjs": `export function parseCpe(uri) {
  const parts = uri.split('/');
  return {
    part: parts[0] || '*',
    vendor: parts[1] || '*',
    product: parts[2] || '*',
    version: parts[3] || '*',
    update: parts[4] || '*',
    edition: parts[5] || '*',
    language: parts[6] || '*',
    swEdition: parts[7] || '*',
    targetSw: parts[8] || '*',
    targetHw: parts[9] || '*',
    other: parts[10] || '*'
  };
}

export function matchCpe(cpe, pattern) {
  const fields = ['part', 'vendor', 'product', 'version', 'update',
    'edition', 'language', 'swEdition', 'targetSw', 'targetHw', 'other'];
  for (const f of fields) {
    if (pattern[f] !== '*' && cpe[f] !== pattern[f]) return false;
  }
  return true;
}

export function versionInRange(version, { min, max, includeMin = true, includeMax = false } = {}) {
  if (min !== undefined) {
    if (includeMin ? version < min : version <= min) return false;
  }
  if (max !== undefined) {
    if (includeMax ? version > max : version >= max) return false;
  }
  return true;
}

export function findAffected(cpes, advisory) {
  return [...cpes];
}
`,
    "src/temporal.mjs": `export function temporalScore(base, modifiers) {
  const ecm = 1.0;
  const rl = 1.0;
  const rc = 1.0;
  return Math.ceil(base * ecm * rl * rc * 10) / 10;
}

export function environmentalScore(base, temporal, requirements) {
  return temporal;
}

export function prioritize(vulns) {
  return [...vulns].sort((a, b) => (b.baseScore || 0) - (a.baseScore || 0));
}
`,
    "src/index.mjs": "export { createCve, updateStatus, addReference, searchCves } from './cve.mjs';\nexport { parseVector, baseScore, severity, compareVulnerabilities } from './cvss.mjs';\nexport { parseCpe, matchCpe, versionInRange, findAffected } from './cpe.mjs';\nexport { temporalScore, environmentalScore, prioritize } from './temporal.mjs';\n",
    "test/smoke.mjs": "import assert from 'node:assert/strict';\nimport { createCve, parseVector, baseScore } from '../src/index.mjs';\nconst cve = createCve('CVE-2024-0001', { description: 'test', vendor: 'v', product: 'p', versions: ['1.0'], discoveredDate: '2024-01-01' });\nassert.equal(cve.status, 'new');\nassert.ok(typeof baseScore === 'function');\nconsole.log('Smoke test passed; independent probes cover CVE lifecycle, CVSS scoring, CPE matching, and temporal adjustments.');\n",
    "README.md": `# Vulnerability Database

Repair these four modules for a vulnerability intelligence platform. All data is in-memory. No network or database access. Pure data transformations.

## CVE Management (src/cve.mjs)

Exports: createCve, updateStatus, addReference, searchCves.

### createCve(id, opts)

Create a new CVE record.

Parameters:
- id: string, must match the regex /^CVE-\\d{4}-\\d{4,}$/ (e.g., 'CVE-2024-12345'). Throw Error on invalid format.
- opts: object with required fields:
  - description: nonempty string.
  - vendor: nonempty string.
  - product: nonempty string.
  - versions: nonempty array of strings.
  - discoveredDate: string (ISO date format 'YYYY-MM-DD').
  Throw Error if any required field is missing or invalid.

Returns a NEW object:
{
  id, description, vendor, product, versions, discoveredDate,
  status: 'new',
  publishedDate: null,
  references: []
}

Never mutate opts.

### updateStatus(cve, newStatus, options)

Transition a CVE record to a new lifecycle status.

Parameters:
- cve: CVE record object.
- newStatus: string — the target status.
- options.now: string (ISO date) — used as publishedDate when transitioning to 'published'.

Valid state transitions (enforce strictly, throw Error on invalid):
- 'new' -> 'analyzing'
- 'analyzing' -> 'confirmed'
- 'analyzing' -> 'rejected'
- 'confirmed' -> 'published' (sets publishedDate to options.now)
- 'published' -> 'updated'

Any other transition is invalid and must throw.

Returns a NEW object with the updated status (and publishedDate if applicable). Never mutate input.

### addReference(cve, ref)

Add a reference link to a CVE record.

Parameters:
- cve: CVE record object.
- ref: { url: string, type: string }
  - url must start with 'http://' or 'https://'. Throw Error on invalid.
  - type must be one of: 'advisory', 'exploit', 'patch', 'writeup'. Throw Error on invalid.
  - No duplicate URLs allowed. Throw Error if cve.references already contains a ref with the same url.

Returns a NEW object with the reference appended. Never mutate input.

### searchCves(cves, filters)

Search an array of CVE records using AND-combined filters.

Parameters:
- cves: array of CVE record objects.
- filters: object with optional fields:
  - vendor: string — case-insensitive substring match against record.vendor.
  - product: string — case-insensitive substring match against record.product.
  - minYear: integer — the year parsed from the CVE ID (the 4-digit number after 'CVE-') must be >= minYear.
  - maxYear: integer — the year from the CVE ID must be <= maxYear.
  - status: string — exact match against record.status.

All provided filters must match (AND logic). Omitted filters are ignored.

Returns a new array of matching records (never mutate input array).

## CVSS v3.1 Scoring (src/cvss.mjs)

Exports: parseVector, baseScore, severity, compareVulnerabilities.

### parseVector(str)

Parse a CVSS v3.1 vector string.

Parameters:
- str: string in format "CVSS:3.1/AV:X/AC:X/PR:X/UI:X/S:X/C:X/I:X/A:X"

Validation:
- Must start with "CVSS:3.1/". Throw Error if not.
- Must contain exactly 8 metric components after the prefix. Throw Error if not.
- Valid metric keys and values:
  - AV: N, A, L, P
  - AC: L, H
  - PR: N, L, H
  - UI: N, R
  - S: U, C
  - C: N, L, H
  - I: N, L, H
  - A: N, L, H
  Throw Error on unknown keys or values.

Returns: object { AV, AC, PR, UI, S, C, I, A } with string values.

### baseScore(vector)

Compute the CVSS v3.1 base score.

Parameters:
- vector: string (CVSS vector) or parsed object from parseVector.

Metric weights:
- AV: N=0.85, A=0.62, L=0.55, P=0.20
- AC: L=0.77, H=0.44
- PR (Scope Unchanged): N=0.85, L=0.62, H=0.27
- PR (Scope Changed): N=0.85, L=0.68, H=0.50
- UI: N=0.85, R=0.62
- C/I/A: N=0, L=0.22, H=0.56

Algorithm:
1. Parse vector if it's a string.
2. ISS (Impact Sub-Score) = 1 - ((1 - CIA_WEIGHTS[C]) * (1 - CIA_WEIGHTS[I]) * (1 - CIA_WEIGHTS[A]))
3. If ISS <= 0, base score is 0.0.
4. Impact:
   - If Scope is 'U' (Unchanged): Impact = 6.42 * ISS
   - If Scope is 'C' (Changed): Impact = 7.52 * (ISS - 0.029) - 3.25 * Math.pow(ISS - 0.02, 15)
5. Exploitability = 8.22 * AV_WEIGHT * AC_WEIGHT * PR_WEIGHT * UI_WEIGHT
   - IMPORTANT: PR weight depends on Scope. Use PR_CHANGED weights when S='C', PR_UNCHANGED when S='U'.
6. If Impact <= 0, base score is 0.0.
7. If Scope is 'U': score = roundUp(Math.min(Impact + Exploitability, 10))
   If Scope is 'C': score = roundUp(Math.min(1.08 * (Impact + Exploitability), 10))
8. roundUp(x) = Math.ceil(x * 10) / 10.

Returns: number (0.0 to 10.0).

### severity(score)

Map a CVSS score to a severity rating.

Parameters:
- score: number (0.0 to 10.0).

Thresholds:
- 0.0: 'None'
- 0.1 - 3.9: 'Low'
- 4.0 - 6.9: 'Medium'
- 7.0 - 8.9: 'High'
- 9.0 - 10.0: 'Critical'

Returns: string.

### compareVulnerabilities(a, b)

Compare two CVSS vectors.

Parameters:
- a: string (CVSS vector) or parsed metrics object.
- b: string (CVSS vector) or parsed metrics object.

Returns: {
  aScore: number (base score of a),
  bScore: number (base score of b),
  moreSevere: 'a' | 'b' | 'equal',
  riskDelta: number (absolute difference, rounded to 1 decimal)
}

## CPE 2.3 Matching (src/cpe.mjs)

Exports: parseCpe, matchCpe, versionInRange, findAffected.

### parseCpe(uri)

Parse a CPE 2.3 formatted string.

Parameters:
- uri: string in format "cpe:2.3:part:vendor:product:version:update:edition:language:swEdition:targetSw:targetHw:other"

There are 13 fields total when split on ':' — the first two are "cpe" and "2.3", then 11 component fields.

Validation:
- Must start with 'cpe:2.3:'. Throw Error if not.
- Must have exactly 13 colon-separated fields. Throw Error if not.

Returns: { part, vendor, product, version, update, edition, language, swEdition, targetSw, targetHw, other }

### matchCpe(cpe, pattern)

Match a CPE against a pattern, field by field.

Parameters:
- cpe: parsed CPE object.
- pattern: parsed CPE object (may contain '*' wildcards).

Rules:
- For each of the 11 fields: if the pattern field is '*', it matches anything.
- Otherwise, compare case-insensitively (lowercase both sides).
- All fields must match for the overall match to be true.

Returns: boolean.

### versionInRange(version, options)

Check if a dot-separated version string falls within a range.

Parameters:
- version: string (e.g., '2.4.49').
- options.min: string (minimum version, inclusive by default).
- options.max: string (maximum version, exclusive by default).
- options.includeMin: boolean (default true).
- options.includeMax: boolean (default false).

Version comparison: split both versions on '.', parse each segment as an integer, compare segment by segment left to right. A missing segment is treated as 0 (so '1.0' equals '1.0.0').

Returns: boolean.

### findAffected(cpes, advisory)

Find CPE entries affected by an advisory.

Parameters:
- cpes: array of CPE URI strings.
- advisory: { cpe: string (CPE pattern URI), versionRange: { min, max, includeMin, includeMax } }

Algorithm:
1. Parse the advisory.cpe pattern.
2. For each CPE string in cpes:
   a. Parse it.
   b. Check if it matches the advisory pattern (using matchCpe, ignoring the version field in the pattern — set it to '*' for matching).
   c. If it matches the pattern, check if its version falls within advisory.versionRange using versionInRange.
   d. Include it in the result if both checks pass.

Returns: array of matching CPE URI strings.

## Temporal/Environmental Scores (src/temporal.mjs)

Exports: temporalScore, environmentalScore, prioritize.

### temporalScore(base, modifiers)

Compute the temporal score by applying modifier multipliers to the base score.

Parameters:
- base: number (CVSS base score).
- modifiers: { ECM: string, RL: string, RC: string }

Exploit Code Maturity (ECM) values:
- 'X' (Not Defined): 1.00
- 'U' (Unproven): 0.91
- 'P' (Proof-of-Concept): 0.94
- 'F' (Functional): 0.97
- 'H' (High): 1.00

Remediation Level (RL) values:
- 'X' (Not Defined): 1.00
- 'O' (Official Fix): 0.95
- 'T' (Temporary Fix): 0.96
- 'W' (Workaround): 0.97
- 'U' (Unavailable): 1.00

Report Confidence (RC) values:
- 'X' (Not Defined): 1.00
- 'U' (Unknown): 0.92
- 'R' (Reasonable): 0.96
- 'C' (Confirmed): 1.00

Formula: temporalScore = roundUp(base * ECM * RL * RC)
roundUp(x) = Math.ceil(x * 10) / 10.

Returns: number.

### environmentalScore(base, temporal, requirements)

Apply environmental requirement modifiers.

Parameters:
- base: number (base score).
- temporal: number (temporal score).
- requirements: { CR: string, IR: string, AR: string }

Requirement values (CR = Confidentiality Requirement, IR = Integrity, AR = Availability):
- 'X' (Not Defined): 1.00
- 'L' (Low): 0.50
- 'M' (Medium): 1.00
- 'H' (High): 1.50

Formula: envScore = roundUp(temporal * ((CR + IR + AR) / 3))
Capped at 10.0.

Returns: number.

### prioritize(vulns)

Sort vulnerabilities by priority.

Parameters:
- vulns: array of objects, each having at least { id: string (CVE ID), baseScore: number }. May also have temporalScore and environmentalScore.

Sort order (all descending except ID):
1. environmentalScore DESC (treat undefined/null as 0).
2. temporalScore DESC (treat undefined/null as 0).
3. baseScore DESC.
4. id ASC (lexicographic string comparison).

Returns: new sorted array (never mutate input).

## Bugs in current implementation

- cve.mjs: createCve performs no ID validation — accepts any string. updateStatus does not enforce the state machine — accepts any status transition. addReference does not validate URL prefix, reference type, or check for duplicate URLs. searchCves returns the entire input array without any filtering.
- cvss.mjs: parseVector does not validate the CVSS:3.1 prefix or check for the required 8 metrics — it just blindly splits on '/'. baseScore sums C+I+A weights directly instead of computing ISS, Impact, and Exploitability per the CVSS v3.1 formula; it also ignores Scope for PR weights. severity always returns 'Medium' regardless of score. compareVulnerabilities returns zeros and 'equal' without computing actual scores.
- cpe.mjs: parseCpe splits on '/' instead of ':' (CPE 2.3 uses colons). matchCpe does case-sensitive comparison (should be case-insensitive). versionInRange compares versions as strings (lexicographic) instead of as dot-separated integers (so '2.10' < '2.9' wrongly). findAffected returns all CPEs without filtering.
- temporal.mjs: temporalScore hardcodes all multipliers to 1.0 instead of looking up ECM/RL/RC values. environmentalScore returns the temporal score unchanged without applying requirement modifiers. prioritize sorts only by baseScore, ignoring temporal, environmental, and CVE ID tiebreaking.
`
  }
};
