import type { CSSProperties } from 'react';
import type { FlowRun, JourneyStep } from '../api';
import { fmtDuration, fmtOffset, humanize, outcomeHelp, outcomeText, valueText } from '../format';

// One line color per flow, like lines on a transit map. Outcome colors are
// kept for results only.
const LINE_COLORS = ['#3B4CCA', '#1F6E8C', '#7A3E9D', '#8C5A1F', '#2F6B4F'];

export function lineColor(flowCode: string | null, codes: string[]): string {
  if (!flowCode) return 'var(--rule-strong)';
  const i = codes.indexOf(flowCode);
  return LINE_COLORS[(i < 0 ? 0 : i) % LINE_COLORS.length]!;
}

export function stepTitle(s: JourneyStep): string {
  if (s.label) return s.label;
  if (s.kind === 'session') return s.previousSessionId ? 'Nova sessão, continua a anterior' : 'Início da sessão';
  if (s.kind === 'event') return s.eventName ?? 'Evento';
  return humanize(s.code);
}

const extraText = (s: JourneyStep) =>
  s.extra
    .slice(0, 3)
    .map((a) => `${a.key.replace(/^app\./, '')} ${valueText(a.value)}`)
    .join(', ');

interface Props {
  steps: JourneyStep[];
  flows: FlowRun[];
  sessionStart: string;
  selected: string | null;
  onSelect: (id: string) => void;
}

/** The journey drawn as a line: screens are stations, actions are stops, each flow run is a colored stretch. */
export function JourneyRail({ steps, flows, sessionStart, selected, onSelect }: Props) {
  const codes = [...new Set(flows.map((f) => f.code ?? ''))];
  const runs = new Map(flows.map((f) => [f.instanceId, f]));

  return (
    <ol className="rail" aria-label="Jornada da sessão">
      {steps.map((s) => {
        // A session start is never part of a flow, even in the middle of one.
        const run = s.flowInstanceId && s.kind !== 'session' ? runs.get(s.flowInstanceId) : undefined;
        const style = { '--line': lineColor(run?.code ?? null, codes) } as CSSProperties;
        const isSelected = selected === s.id;
        const common = {
          className: `stop kind-${s.kind}${s.outcome ? ` outcome-${s.outcome}` : ''}${isSelected ? ' selected' : ''}${run ? ' in-flow' : ''}`,
          style,
        };

        if (s.kind === 'flowStart' && run) {
          return (
            <li key={s.id} {...common}>
              <time className="offset" dateTime={s.time}>{fmtOffset(sessionStart, s.time)}</time>
              <span className="track" aria-hidden="true"><span className="node" /></span>
              <button type="button" className="stop-body flow-head" onClick={() => onSelect(s.id)} aria-pressed={isSelected}>
                <span className="flow-name">{run.label ?? humanize(run.code)}</span>
                {run.attempt > 1 && <span className="attempt">execução {run.attempt}</span>}
                <span className={`pill ${run.status}`} title={outcomeHelp[run.status]}>{outcomeText[run.status]}</span>
              </button>
            </li>
          );
        }

        if (s.kind === 'flowEnd') {
          const status = s.outcome ?? 'completed';
          return (
            <li key={s.id} {...common}>
              <time className="offset" dateTime={s.time}>{fmtOffset(sessionStart, s.time)}</time>
              <span className="track" aria-hidden="true"><span className="node" /></span>
              <button type="button" className="stop-body flow-foot" onClick={() => onSelect(s.id)} aria-pressed={isSelected}>
                <span>
                  {run?.label ?? humanize(s.code)} terminou: <strong className={`text-${status}`}>{outcomeText[status]}</strong>
                </span>
                {s.outcomeReason && <span className="reason mono">{s.outcomeReason}</span>}
                {s.durationMs !== null && <span className="dur">{fmtDuration(s.durationMs)}</span>}
              </button>
            </li>
          );
        }

        return (
          <li key={s.id} {...common}>
            <time className="offset" dateTime={s.time}>{fmtOffset(sessionStart, s.time)}</time>
            <span className="track" aria-hidden="true"><span className="node" /></span>
            <button type="button" className="stop-body" onClick={() => onSelect(s.id)} aria-pressed={isSelected}>
              <span className="stop-title">
                {s.kind === 'screen' && <span className="screen-tag">Tela</span>}
                {stepTitle(s)}
              </span>
              <span className="stop-meta">
                {s.measured && <span className="dur">{fmtDuration(s.durationMs)}</span>}
                {s.outcome && s.kind === 'action' && (
                  <span className={`pill ${s.outcome}`} title={outcomeHelp[s.outcome]}>{outcomeText[s.outcome]}</span>
                )}
                {s.outcomeReason && <span className="reason mono">{s.outcomeReason}</span>}
                {s.errorType && <span className="error-type mono">{s.errorType}</span>}
                {s.extra.length > 0 && <span className="extra">{extraText(s)}</span>}
                {s.source === 'native' && <span className="origin">nativo</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
