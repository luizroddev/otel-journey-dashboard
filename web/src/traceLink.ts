// Link from a trace to the log tool the environment already uses
// (TRACE_LINK_TEMPLATE). No imports, so the tests can load it.

/** The template with every `{traceId}` replaced by the URL-encoded trace id. */
export const traceLinkUrl = (template: string, traceId: string) => template.replaceAll('{traceId}', encodeURIComponent(traceId));
