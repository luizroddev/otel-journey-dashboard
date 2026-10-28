import { useState } from 'react';
import type { Span, TraceResponse } from '../api';
import { fmtDuration, shortId } from '../format';
import { Attributes } from './Attributes';

const KIND: Record<number, string> = { 1: 'interno', 2: 'servidor', 3: 'cliente', 4: 'produtor', 5: 'consumidor' };

/** The span tree of one trace, as bars on a shared time axis. */
export function Waterfall({ trace, highlight }: { trace: TraceResponse; highlight?: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const total = Math.max(trace.durationMs, 0.001);
  const appService = trace.rows[0]?.span.service ?? null;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="waterfall">
      <div className="wf-head">
        <span>Operação</span>
        <div className="wf-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${t * 100}%` }}>
              {t === 0 ? '0' : fmtDuration(total * t)}
            </span>
          ))}
        </div>
      </div>
      <ol className="wf-rows">
        {trace.rows.map(({ span, depth, missingParent, offsetMs }) => {
          const failed = span.statusCode === 2;
          const isOpen = open === span.spanId;
          const left = (offsetMs / total) * 100;
          const width = Math.max((span.durationMs / total) * 100, 0.6);
          const external = !!span.service && span.service !== appService;
          return (
            <li key={span._id} className={`wf-row${failed ? ' failed' : ''}${highlight === span.spanId ? ' highlight' : ''}`}>
              <button
                type="button"
                className="wf-line"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : span.spanId)}
              >
                <span className="wf-name" style={{ paddingLeft: `${depth * 14}px` }}>
                  {depth > 0 && <span className="wf-elbow" aria-hidden="true" />}
                  <span className="wf-title">{span.name || '(sem nome)'}</span>
                  <span className="wf-meta">
                    {KIND[span.kind] ?? 'span'}
                    {external ? `, ${span.service}` : ''}
                    {missingParent && <span className="pill open" title="O pai deste span não foi recebido">pai ausente</span>}
                  </span>
                </span>
                <span className="wf-track">
                  <span className={`wf-bar${external ? ' external' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} />
                  <span className="wf-dur" style={{ left: `calc(${left + width}% + 6px)` }}>
                    {fmtDuration(span.durationMs)}
                  </span>
                </span>
              </button>
              {isOpen && <SpanDetail span={span} />}
            </li>
          );
        })}
      </ol>
      {trace.truncated && <p className="notice">Trace grande: só os primeiros spans foram carregados.</p>}
      {trace.missingParents > 0 && (
        <p className="notice">
          {trace.missingParents === 1 ? '1 span tem' : `${trace.missingParents} spans têm`} pai que não chegou ao
          receptor. Eles aparecem na raiz.
        </p>
      )}
    </div>
  );
}

function SpanDetail({ span }: { span: Span }) {
  return (
    <div className="span-detail">
      <dl className="kv">
        <dt>Span</dt>
        <dd className="mono">{span.spanId}</dd>
        {span.parentSpanId && (
          <>
            <dt>Pai</dt>
            <dd className="mono">{shortId(span.parentSpanId, 16)}</dd>
          </>
        )}
        <dt>Serviço</dt>
        <dd>{span.service ?? 'desconhecido'}</dd>
        <dt>Status</dt>
        <dd>{span.statusCode === 2 ? `Erro${span.statusMessage ? `: ${span.statusMessage}` : ''}` : span.statusCode === 1 ? 'OK' : 'Não definido'}</dd>
      </dl>
      <Attributes title="Atributos" attrs={span.attributes} />
      {span.events.length > 0 && (
        <div className="span-events">
          <h4>Eventos do span</h4>
          <ul>
            {span.events.map((e, i) => (
              <li key={i}>
                <strong>{e.name}</strong>
                <Attributes attrs={e.attributes} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
