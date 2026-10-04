/**
 * why: agy payloads carry camelCase `conversationId` + a `workspacePaths` array and never a `hook_event_name` —
 * the event is named by the hook registration, not by the payload. Claude and Cursor payloads always carry
 * `hook_event_name`, so requiring its absence is what keeps the three detections disjoint by construction.
 */
export function detectAntigravity(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const value = raw as Record<string, unknown>;
  if ("hook_event_name" in value) {
    return false;
  }
  return typeof value.conversationId === "string" && Array.isArray(value.workspacePaths);
}
