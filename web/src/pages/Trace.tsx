import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../components/useAsync';
import { Waterfall } from '../components/Waterfall';
import { fmtDateTime, fmtDuration, humanize } from '../format';

export function TracePage() {
  const { traceId = '' } = useParams();
  const trace = useAsync(() => api.trace(traceId), [traceId]);

  if (trace.status === 'loading') return <p className="empty page">Carregando o trace…</p>;
  if (trace.status === 'error')
    return (
      <div className="page empty">
        <p>{trace.error.message === 'not found' ? 'Nenhum span ou evento com este trace id.' : `Não foi possível carregar: ${trace.error.message}.`}</p>
        <Link to="/">Voltar às sessões</Link>
      </div>
    );

  const t = trace.data;
  const sessionId = t.rows.find((r) => r.span.sessionId)?.span.sessionId;
  return (
    <div className="page">
      <div className="page-head">
        <p className="crumb">
          <Link to="/">Sessões</Link>
          {sessionId && (
            <>
              {' / '}
              <Link to={`/sessions/${sessionId}`}>Sessão do trace</Link>
            </>
          )}
        </p>
        <h1>
          Trace <span className="mono">{t.traceId}</span>
        </h1>
        <p className="lede">
          {t.start ? `${fmtDateTime(t.start)}, ` : ''}
          {fmtDuration(t.durationMs)}, {t.rows.length} spans em {t.services.join(', ') || 'serviço desconhecido'}
          {t.errorCount > 0 ? `, ${t.errorCount} com erro` : ''}
        </p>
        {t.events.length > 0 && (
          <p className="hint">
            Etapas da jornada neste trace:{' '}
            {t.events.map((e) => e.actionLabel ?? humanize(e.actionName ?? e.eventName)).join(', ')}
          </p>
        )}
      </div>
      {t.rows.length === 0 ? <p className="empty">O trace tem eventos de jornada, mas nenhum span chegou.</p> : <Waterfall trace={t} />}
    </div>
  );
}
