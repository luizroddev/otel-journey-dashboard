import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type SessionSummary } from '../api';
import { useAsync } from '../components/useAsync';
import { fmtDateTime, fmtDuration, humanize, platformName, shortId } from '../format';

const PERIODS = [
  { key: '1h', label: 'Última hora', ms: 3_600_000 },
  { key: '24h', label: 'Últimas 24 horas', ms: 86_400_000 },
  { key: '7d', label: 'Últimos 7 dias', ms: 7 * 86_400_000 },
  { key: '30d', label: 'Últimos 30 dias', ms: 30 * 86_400_000 },
] as const;

/** Filters set by the overview's links, shown as removable chips. */
const DRILL = [
  { key: 'flow', label: (v: string) => `Passou por ${humanize(v)}` },
  { key: 'failedFlow', label: (v: string) => `Falhou em ${humanize(v)}` },
  { key: 'failedAction', label: (v: string) => `Ação ${humanize(v)} falhou` },
  { key: 'reason', label: (v: string) => `Motivo ${v}` },
  { key: 'errorType', label: (v: string) => `error.type ${v}` },
] as const;

/** `multiple`: several values at once (a person with several devices), as `a,b,c` in the URL. */
const TEXT_FILTERS = [
  { key: 'deviceId', label: 'Aparelho', placeholder: 'device.id, …', multiple: true },
  { key: 'installationId', label: 'Instalação', placeholder: 'app.installation.id, …', multiple: true },
  { key: 'userId', label: 'Usuário', placeholder: 'user.id, …', multiple: true },
  { key: 'sessionId', label: 'Sessão', placeholder: 'session.id', multiple: false },
] as const;
/** Same limit as the API (MAX_IDS). */
const MAX_IDS = 50;
/** Values separated by commas, spaces or new lines, without repeats. */
const splitIds = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

export function SessionsPage() {
  const [params, setParams] = useSearchParams();
  const period = PERIODS.find((p) => p.key === params.get('period')) ?? PERIODS[1];
  // Recomputed when the period or a refresh changes, not on every render.
  const [refresh, setRefresh] = useState(0);
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - period.ms).toISOString(), to: to.toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.key, refresh]);

  const filters = {
    deviceId: params.get('deviceId') ?? '',
    installationId: params.get('installationId') ?? '',
    userId: params.get('userId') ?? '',
    sessionId: params.get('sessionId') ?? '',
    service: params.get('service') ?? '',
    version: params.get('version') ?? '',
    platform: params.get('platform') ?? '',
    onlyErrors: params.get('onlyErrors') === 'true',
    ...Object.fromEntries(DRILL.map((d) => [d.key, params.get(d.key) ?? ''])),
  };
  const drill = DRILL.filter((d) => params.get(d.key));
  const [pages, setPages] = useState<string[]>([]);
  const before = pages[pages.length - 1];

  const set = (key: string, value: string | boolean) => {
    const next = new URLSearchParams(params);
    if (value === '' || value === false) next.delete(key);
    else next.set(key, String(value));
    setPages([]);
    setParams(next, { replace: true });
  };

  const facets = useAsync(() => api.facets(range.from, range.to), [range]);
  const sessions = useAsync(
    () => api.sessions({ ...range, ...filters, before, limit: '50' }),
    [range, params.toString(), before],
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Sessões</h1>
        <p className="lede">Encontre um aparelho, um usuário ou uma sessão e abra a jornada.</p>
      </div>

      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="f-period">Período</label>
          <select id="f-period" value={period.key} onChange={(e) => set('period', e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {TEXT_FILTERS.map((f) => (
          <TextFilter
            key={f.key}
            id={f.key}
            label={f.label}
            placeholder={f.placeholder}
            multiple={f.multiple}
            value={filters[f.key]}
            onCommit={(v) => set(f.key, v)}
          />
        ))}
        {(['service', 'version', 'platform'] as const).map((key) => {
          const options =
            facets.status === 'ok'
              ? facets.data[key === 'service' ? 'services' : key === 'version' ? 'versions' : 'platforms']
              : [];
          const label = key === 'service' ? 'App' : key === 'version' ? 'Versão' : 'Plataforma';
          return (
            <div className="field" key={key}>
              <label htmlFor={`f-${key}`}>{label}</label>
              <select id={`f-${key}`} value={filters[key]} onChange={(e) => set(key, e.target.value)}>
                <option value="">Todas</option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {key === 'platform' ? platformName(o) : o}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
        <label className="check">
          <input type="checkbox" checked={filters.onlyErrors} onChange={(e) => set('onlyErrors', e.target.checked)} />
          Só com falhas
        </label>
        <button type="button" className="ghost" onClick={() => { setPages([]); setRefresh((n) => n + 1); }}>
          Atualizar
        </button>
      </form>

      {drill.length > 0 && (
        <div className="chips" aria-label="Filtros vindos da visão geral">
          {drill.map((d) => (
            <span key={d.key} className="chip">
              {d.label(params.get(d.key)!)}
              <button type="button" aria-label={`Remover filtro ${d.label(params.get(d.key)!)}`} onClick={() => set(d.key, '')}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {sessions.status === 'loading' && <p className="empty">Carregando sessões…</p>}
      {sessions.status === 'error' && (
        <p className="empty error">Não foi possível carregar as sessões: {sessions.error.message}. Confira se a API está no ar.</p>
      )}
      {sessions.status === 'ok' && (
        <>
          {sessions.data.period.clamped && (
            <p className="notice">O período foi limitado ao máximo permitido pela API.</p>
          )}
          {sessions.data.items.length === 0 ? (
            <EmptySessions filtered={params.toString() !== '' && params.toString() !== `period=${period.key}`} />
          ) : (
            <SessionTable items={sessions.data.items} />
          )}
          <div className="pager">
            {pages.length > 0 && (
              <button type="button" className="ghost" onClick={() => setPages((p) => p.slice(0, -1))}>
                Mais recentes
              </button>
            )}
            {sessions.data.nextBefore && (
              <button type="button" className="ghost" onClick={() => setPages((p) => [...p, sessions.data.nextBefore!])}>
                Mais antigas
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TextFilter(props: {
  id: string;
  label: string;
  placeholder: string;
  multiple: boolean;
  value: string;
  onCommit: (v: string) => void;
}) {
  const ids = props.multiple ? splitIds(props.value) : [];
  const [draft, setDraft] = useState(ids.length ? ids.join(', ') : props.value);
  const [tooMany, setTooMany] = useState(0);
  const commit = () => {
    if (!props.multiple) return draft.trim() !== props.value && props.onCommit(draft.trim());
    const list = splitIds(draft);
    setTooMany(list.length > MAX_IDS ? list.length : 0);
    if (list.length > MAX_IDS) return;
    setDraft(list.join(', '));
    if (list.join(',') !== ids.join(',')) props.onCommit(list.join(','));
  };
  return (
    <div className="field">
      <label htmlFor={`f-${props.id}`}>
        {props.label}
        {ids.length > 1 && <span className="field-count"> ({ids.length})</span>}
      </label>
      <input
        id={`f-${props.id}`}
        className="mono"
        value={draft}
        placeholder={props.placeholder}
        title={props.multiple ? 'Um ou vários, separados por vírgula, espaço ou linha' : undefined}
        spellCheck={false}
        aria-invalid={tooMany > 0 || undefined}
        aria-describedby={tooMany ? `f-${props.id}-error` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onPaste={(e) => {
          // A text input drops line breaks: a pasted list would become one id.
          const text = e.clipboardData.getData('text');
          if (!props.multiple || !/[\r\n]/.test(text)) return;
          e.preventDefault();
          const el = e.currentTarget;
          const start = el.selectionStart ?? draft.length;
          setDraft(draft.slice(0, start) + splitIds(text).join(', ') + draft.slice(el.selectionEnd ?? start));
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {tooMany > 0 && (
        <p id={`f-${props.id}-error`} className="field-error">
          Até {MAX_IDS} por busca ({tooMany} informados)
        </p>
      )}
    </div>
  );
}

function EmptySessions({ filtered }: { filtered: boolean }) {
  return filtered ? (
    <p className="empty">Nenhuma sessão com esses filtros no período. Amplie o período ou limpe um filtro.</p>
  ) : (
    <div className="empty">
      <p>Nenhuma sessão recebida neste período.</p>
      <p>
        Aponte o app para o receptor OTLP (<code>http://localhost:4318</code>) ou gere dados fictícios com{' '}
        <code>npm run seed</code>. As sessões aparecem cerca de um minuto depois de os eventos chegarem.
      </p>
    </div>
  );
}

function SessionTable({ items }: { items: SessionSummary[] }) {
  return (
    <div className="table-wrap">
      <table className="sessions">
        <thead>
          <tr>
            <th scope="col">Início</th>
            <th scope="col">Duração</th>
            <th scope="col">Aparelho</th>
            <th scope="col">Usuário</th>
            <th scope="col">App</th>
            <th scope="col" className="num">Etapas</th>
            <th scope="col" className="num">Falhas</th>
            <th scope="col">Sessão</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s._id}>
              <td>
                <Link to={`/sessions/${s._id}`} className="row-link">
                  {fmtDateTime(s.firstSeen)}
                </Link>
              </td>
              <td className="num-left">{fmtDuration(Date.parse(s.lastSeen) - Date.parse(s.firstSeen))}</td>
              <td className="mono">
                {s.deviceId ??
                  (s.installationId ? (
                    <>
                      {s.installationId} <span className="id-kind">instalação</span>
                    </>
                  ) : (
                    <span className="muted">não informado</span>
                  ))}
              </td>
              <td className="mono">{s.userIds.length ? s.userIds.join(', ') : <span className="muted">não autenticou</span>}</td>
              <td>
                {s.platforms.map(platformName).join(', ')} {s.versions.join(', ')}
              </td>
              <td className="num">{s.eventCount}</td>
              <td className="num">{s.errorCount > 0 ? <span className="pill failure">{s.errorCount}</span> : <span className="muted">0</span>}</td>
              <td className="mono muted" title={s._id}>
                {shortId(s._id)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
