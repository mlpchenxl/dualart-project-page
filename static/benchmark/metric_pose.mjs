export const AS_STATES = Object.freeze([0, 0.25, 0.5, 0.75, 1]);

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function metricJointValue(metric, jointType, evalRange, normalizedState = 0) {
  if (String(metric).startsWith("RS-")) return 0;
  const state = clamp01(normalizedState);
  if (jointType === "continuous") return Math.PI * 2 * state;
  if (!Array.isArray(evalRange) || evalRange.length !== 2
    || !evalRange.every((value) => Number.isFinite(value))) return null;

  if (state === 0) return 0;
  const endpoint = Number(evalRange[1]);
  if (metric !== "AOR" && jointType === "revolute") {
    return Math.sign(endpoint) * (Math.PI / 2) * state;
  }
  return endpoint * state;
}
