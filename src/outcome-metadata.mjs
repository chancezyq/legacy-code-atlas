const CONFIGURED_OUTCOME_EDGE_TYPES = new Set([
  "forwards_to",
  "redirects_to",
  "uses_tile",
]);
const STRUTS_FRAMEWORKS = new Set(["struts1", "struts2"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function validEvidence(entry) {
  if (!isPlainObject(entry)) return false;
  try {
    return typeof entry.file === "string"
      && entry.file.trim().length > 0
      && Number.isInteger(entry.line)
      && entry.line > 0;
  } catch {
    return false;
  }
}

export function isValidOutcomeName(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeConfiguredOutcome(edge, edgeType = edge?.type) {
  if (!CONFIGURED_OUTCOME_EDGE_TYPES.has(edgeType)) return null;
  let metadata;
  try {
    metadata = edge?.data?.outcome;
  } catch {
    metadata = null;
  }
  if (!isPlainObject(metadata)) {
    return {
      framework: "",
      name: "",
      classification: "configured-candidate",
      codeEvidence: [],
    };
  }

  let framework = "";
  let name = "";
  let classification = "";
  let rawCodeEvidence = [];
  try {
    if (STRUTS_FRAMEWORKS.has(metadata.framework)) framework = metadata.framework;
    if (isValidOutcomeName(metadata.name)) name = metadata.name;
    classification = metadata.classification;
    if (Array.isArray(metadata.codeEvidence)) rawCodeEvidence = metadata.codeEvidence;
  } catch {
    return {
      framework: "",
      name: "",
      classification: "configured-candidate",
      codeEvidence: [],
    };
  }

  const codeEvidence = rawCodeEvidence.filter(validEvidence);
  const confirmed = framework
    && name
    && classification === "code-confirmed"
    && codeEvidence.length > 0;
  return {
    framework,
    name,
    classification: confirmed ? "code-confirmed" : "configured-candidate",
    codeEvidence: confirmed ? codeEvidence : [],
  };
}
