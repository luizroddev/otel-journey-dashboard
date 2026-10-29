import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type FlowRun, type JourneyResponse, type JourneyStep } from '../api';
import { Attributes } from '../components/Attributes';
import { ExternalTraceLink } from '../components/ExternalTraceLink';
import { JourneyRail, lineColor, stepTitle } from '../components/JourneyRail';
import { useAsync } from '../components/useAsync';
import { Waterfall } from '../components/Waterfall';
import { fmtDateTime, fmtDuration, fmtOffset, humanize, outcomeHelp, outcomeText, platformName, shortId } from '../format';

export function SessionPage() {
  const { id = '' } = useParams();
  const journey = useAsync(() => api.journey(id), [id]);

  if (journey.status === 'loading') return <p className="empty page">Carregando a jornada…</p>;
  if (journey.status === 'error')
    return (
      <div className="page empty">
        <p>{journey.error.message === 'not found' ? 'Sessão não encontrada ou já expirada.' : `Não foi possível carregar: ${journey.error.message}.`}</p>
        <Link to="/sessions">Voltar às sessões</Link>
      </div>
    );
  return <SessionView data={journey.data} />;
}

const KIND_TEXT: Record<JourneyStep['kind'], string> = {
  session: 'Início de sessão',
  screen: 'Entrada em tela',
  action: 'Ação',
  flowStart: 'Início de fluxo',
  flowEnd: 'Fim de fluxo',
  lifecycle: 'Estado do app',
  event: 'Evento',
};

function SessionView({ data }: { data: JourneyResponse }) {
  const { session, steps, flows } = data;
  const [params, setParams] = useSearchParams();
  const fallback = steps.find((s) => s.outcome === 'failure') ?? steps.find((s) => s.measured) ?? steps[0];
  const selectedId = params.get('step') ?? fallback?.id ?? null;
  const selected = steps.find((s) => s.id === selectedId) ?? null;
  const select = (stepId: string) => {
    const next = new URLSearchParams(params);
    next.set('step', stepId);
    setParams(next, { replace: true });
  };
  const codes = [...new Set(flows.map((f) => f.code ?? ''))];
  const start = steps[0]?.time ?? session.firstSeen;

  return (
    <div className="page session-page">
      <div className="session-head">
        <div>
          <p className="crumb">
            <Link to="/sessions">Sessões</Link>
          </p>
          <h1>
            Sessão <span className="mono">{shortId(session._id, 12)}</span>
          </h1>
          <p className="lede">
            {fmtDateTime(session.firstSeen)}, durou {fmtDuration(Date.parse(session.lastSeen) - Date.parse(session.firstSeen))}
            {session.previousSessionId && (
              <>
                , continua a <Link to={`/sessions/${session.previousSessionId}`}>sessão {shortId(session.previousSessionId)}</Link>
              </>
            )}
          </p>
        </div>
        <dl className="facts">
          <div>
            <dt>Aparelho</dt>
            <dd className="mono">
              {session.deviceId ? (
                <Link to={`/sessions?deviceId=${encodeURIComponent(session.deviceId)}&period=30d`}>{session.deviceId}</Link>
              ) : (
                <span className="muted" title="device.id só vem do servidor, a partir do que ele autenticou">
                  não informado
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Instalação</dt>
            <dd className="mono">
              {session.installationId ? (
                <Link to={`/sessions?installationId=${encodeURIComponent(session.installationId)}&period=30d`}>{session.installationId}</Link>
              ) : (
                <span className="muted">não informada</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Usuário</dt>
            <dd className="mono">
              {session.userIds.length
                ? session.userIds.map((u, i) => (
                    <span key={u}>
                      {i > 0 && ', '}
                      <Link to={`/sessions?userId=${encodeURIComponent(u)}&period=30d`}>{u}</Link>
                    </span>
                  ))
                : 'não autenticou'}
            </dd>
          </div>
          <div>
            <dt>App</dt>
            <dd>
              {session.services.join(', ')} {session.versions.join(', ')}
            </dd>
          </div>
          <div>
            <dt>Plataforma</dt>
            <dd>{session.platforms.map(platformName).join(', ') || 'desconhecida'}</dd>
          </div>
        </dl>
      </div>

      {flows.length > 0 && <FlowStrip flows={flows} codes={codes} steps={steps} onSelect={select} />}

      {(data.limits.events.truncated || data.limits.rootSpans.truncated) && (
        <p className="notice">
          Sessão grande: foram carregados {data.limits.events.loaded} eventos. Etapas depois disso não aparecem aqui.
        </p>
      )}

      <div className="session-body">
        <section className="journey" aria-labelledby="journey-title">
          <h2 id="journey-title">Jornada</h2>
          {steps.length === 0 ? (
            <p className="empty">
              Esta sessão só tem spans técnicos, sem eventos de jornada. Use <code>Journey</code> no app para ver telas e ações aqui.
            </p>
          ) : (
            <JourneyRail steps={steps} flows={flows} sessionStart={start} selected={selected?.id ?? null} onSelect={select} />
          )}
          {data.otherTraces.length > 0 && (
            <div className="other-traces">
              <h3>Operações sem etapa de jornada</h3>
              <p className="hint">Traces desta sessão que não estão ligados a nenhuma ação.</p>
              <ul>
                {data.otherTraces.map((t) => (
                  <li key={t.traceId}>
                    <Link to={`/traces/${t.traceId}`}>{t.name}</Link>
                    <span className="muted">{fmtOffset(start, t.start)}</span>
                    <span className="dur">{fmtDuration(t.durationMs)}</span>
                    {t.statusCode === 2 && <span className="pill failure">Erro</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <aside className="detail" aria-live="polite">
          {selected ? <StepDetail step={selected} run={flows.find((f) => f.instanceId === selected.flowInstanceId)} start={start} lineColor={lineColor(selected.flow, codes)} /> : <p className="empty">Escolha uma etapa para ver o detalhe.</p>}
        </aside>
      </div>
    </div>
  );
}

function FlowStrip({ flows, codes, steps, onSelect }: { flows: FlowRun[]; codes: string[]; steps: JourneyStep[]; onSelect: (id: string) => void }) {
  return (
    <ol className="flow-strip" aria-label="Fluxos da sessão">
      {flows.map((f) => {
        const first = steps.find((s) => s.flowInstanceId === f.instanceId);
        return (
          <li key={f.instanceId} style={{ '--line': lineColor(f.code, codes) } as CSSProperties}>
            <button type="button" onClick={() => first && onSelect(first.id)} title={outcomeHelp[f.status]}>
              <span className="flow-name">{f.label ?? humanize(f.code)}</span>
              {f.attempt > 1 && <span className="attempt">execução {f.attempt}</span>}
              <span className={`pill ${f.status}`}>{outcomeText[f.status]}</span>
              {f.reason && <span className="reason mono">{f.reason}</span>}
              {f.durationMs !== null && <span className="dur">{fmtDuration(f.durationMs)}</span>}
              {f.failures > 0 && f.status !== 'failure' && (
                <span className="muted">{f.failures === 1 ? '1 falha no caminho' : `${f.failures} falhas no caminho`}</span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StepDetail({ step, run, start, lineColor: color }: { step: JourneyStep; run?: FlowRun; start: string; lineColor: string }) {
  const trace = useAsync(() => (step.traceId ? api.trace(step.traceId) : Promise.resolve(null)), [step.traceId]);
  const [showIds, setShowIds] = useState(false);
  useEffect(() => setShowIds(false), [step.id]);
  const status = step.kind === 'flowEnd' ? (step.outcome ?? 'completed') : step.outcome;

  return (
    <div className="step-detail" style={{ '--line': color } as CSSProperties}>
      <p className="detail-kind">{KIND_TEXT[step.kind]}</p>
      <h2>{stepTitle(step)}</h2>
      <p className="detail-when">
        <time dateTime={step.time}>{fmtDateTime(step.time)}</time>
        <span className="muted"> ({fmtOffset(start, step.time)} na sessão)</span>
      </p>

      {status && (
        <div className={`result result-${status}`}>
          <strong>{outcomeText[status]}</strong>
          {step.durationMs !== null && <span> em {fmtDuration(step.durationMs)}</span>}
          {step.errorType && (
            <span>
              , erro <code>{step.errorType}</code>
            </span>
          )}
          {step.outcomeReason && (
            <span>
              , motivo <code>{step.outcomeReason}</code>
            </span>
          )}
          <p>{outcomeHelp[status]}</p>
        </div>
      )}

      {step.kind === 'session' && (
        <p className="hint">
          {step.previousSessionId ? (
            <>
              A sessão anterior expirou com o app aberto; esta continua a{' '}
              <Link to={`/sessions/${step.previousSessionId}`}>sessão {shortId(step.previousSessionId)}</Link>.
            </>
          ) : (
            'Primeira sessão desde que o app abriu, ou depois de um logout.'
          )}
        </p>
      )}

      <dl className="kv context">
        <dt>Código</dt>
        <dd className="mono">{step.code ?? '—'}</dd>
        <dt>Tela</dt>
        <dd>{step.screen ? humanize(step.screen) : 'nenhuma'}</dd>
        <dt>Fluxo</dt>
        <dd>
          {run ? (
            <>
              {run.label ?? humanize(run.code)}
              {run.attempt > 1 ? `, execução ${run.attempt}` : ''} ({outcomeText[run.status].toLowerCase()})
            </>
          ) : (
            'fora de fluxo'
          )}
        </dd>
        <dt>Usuário</dt>
        <dd className="mono">{step.userId ?? 'não autenticado'}</dd>
        <dt>Origem</dt>
        <dd>{step.source === 'native' ? 'Nativo' : step.source === 'dart' ? 'Flutter' : (step.source ?? 'desconhecida')}</dd>
      </dl>

      <Attributes title="Contexto do app" attrs={step.extra} />

      <button type="button" className="link-button" onClick={() => setShowIds((v) => !v)} aria-expanded={showIds}>
        {showIds ? 'Ocultar identificadores' : 'Mostrar identificadores'}
      </button>
      {showIds && (
        <dl className="kv ids">
          {step.actionInstanceId && (
            <>
              <dt>Ação</dt>
              <dd className="mono">{step.actionInstanceId}</dd>
            </>
          )}
          {step.flowInstanceId && (
            <>
              <dt>Execução do fluxo</dt>
              <dd className="mono">{step.flowInstanceId}</dd>
            </>
          )}
          {step.traceId && (
            <>
              <dt>Trace</dt>
              <dd className="mono">{step.traceId}</dd>
            </>
          )}
          <dt>Evento</dt>
          <dd className="mono">{step.id}</dd>
        </dl>
      )}

      <section className="detail-trace" aria-label="Detalhe técnico">
        <div className="detail-trace-head">
          <h3>Detalhe técnico</h3>
          {step.traceId && (
            <span className="detail-trace-links">
              <Link to={`/traces/${step.traceId}`}>Abrir trace inteiro</Link>
              <ExternalTraceLink traceId={step.traceId} />
            </span>
          )}
        </div>
        {!step.traceId && (
          <p className="hint">
            {step.kind === 'action'
              ? 'Ação pontual: não tem duração nem trace.'
              : step.kind === 'session'
                ? 'O início de uma sessão não tem árvore de spans.'
                : step.kind === 'lifecycle'
                  ? 'Mudança de estado do app, registrada pelo sistema: não tem árvore de spans.'
                : 'Este acontecimento não estava dentro de uma operação medida, então não há árvore de spans.'}
          </p>
        )}
        {step.traceId && trace.status === 'loading' && <p className="hint">Carregando spans…</p>}
        {step.traceId && trace.status === 'error' && (
          <p className="hint">
            {trace.error.message === 'not found'
              ? 'Os spans deste trace não chegaram (amostragem, perda ou ainda em envio).'
              : `Não foi possível carregar o trace: ${trace.error.message}.`}
          </p>
        )}
        {trace.status === 'ok' && trace.data && <Waterfall trace={trace.data} highlight={step.spanId} />}
      </section>
    </div>
  );
}
