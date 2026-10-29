import { api } from '../api';
import { traceLinkUrl } from '../traceLink';
import { useAsync } from './useAsync';

/** The trace in the environment's log tool, in a new tab; nothing when TRACE_LINK_TEMPLATE is not set. */
export function ExternalTraceLink({ traceId, className }: { traceId: string; className?: string }) {
  const config = useAsync(() => api.config(), []);
  if (config.status !== 'ok' || !config.data.traceLink) return null;
  const { template, label } = config.data.traceLink;
  return (
    <a className={className} href={traceLinkUrl(template, traceId)} target="_blank" rel="noreferrer">
      {label} <span aria-hidden="true">↗</span>
    </a>
  );
}
