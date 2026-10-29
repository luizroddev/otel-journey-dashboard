import { useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { api, type Change, type FlowStat, type Overview, type PeriodKey, type Rate } from '../api';
import { LineChart, Sparkline, Tip, useNow } from '../components/charts';
import { useAsync } from '../components/useAsync';
import { fmtAgo, fmtCount, fmtDuration, fmtPct, fmtPp, fmtSlot, fmtSlotLong, humanize, platformName, versionName } from '../format';

const PERIODS: { key: PeriodKey; label: string; ms: number }[] = [
  { key: '24h', label: 'Últimas 24 horas', ms: 86_400_000 },
  { key: '7d', label: 'Últimos 7 dias', ms: 7 * 86_400_000 },
  { key: '30d', label: 'Últimos 30 dias', ms: 30 * 86_400_000 },
];
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const rate = (r: Rate) => (r.n > 0 ? r.failure / r.n : 0);
/** A rate per slot, or nothing when the slot has too little volume to mean anything. */
const slotRate = (num: number, den: number) => (den >= 5 ? num / den : null);

export function OverviewPage() {
  const [params] = useSearchParams();
  // Links from before the overview existed (/?deviceId=...) open the sessions list.
  if (['deviceId', 'installationId', 'userId', 'sessionId'].some((k) => params.has(k))) {
    return <Navigate to={`/sessions?${params}`} replace />;
  }
  return <OverviewView />;
}

function OverviewView() {
  const [params, setParams] = useSearchParams();
  const period = PERIODS.find((p) => p.key === params.get('period')) ?? PERIODS[0]!;
  const compare = period.key === '24h' && params.get('compare') === 'week' ? 'week' : 'previous';
  const dims = { service: params.get('service') ?? '', version: params.get('version') ?? '', platform: params.get('platform') ?? '' };
  const [refresh, setRefresh] = useState(0);
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - period.ms).toISOString(), to: to.toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.key, refresh]);
  const facets = useAsync(() => api.facets(range.from, range.to), [range]);
  const data = useAsync(
    () => api.overview({ period: period.key, compare, tz: timeZone, ...dims }),
    [params.toString(), refresh],
  );
  const now = useNow(10_000);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  /** The sessions behind a number: same period and filters, plus [extra]. */
  const sessions = (extra: Record<string, string | null | undefined> = {}) => {
    const q = new URLSearchParams({ period: period.key });
    for (const [k, v] of Object.entries({ ...dims, ...extra })) if (v) q.set(k, v);
    return `/sessions?${q}`;
  };

  return (
    <div className="page overview">
      <div className="page-head">
        <h1>Visão geral</h1>
        <p className="lede">Como as jornadas foram no período e o que mudou. Cada número abre as sessões que o formam.</p>
      </div>

      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="o-period">Período</label>
          <select id="o-period" value={period.key} onChange={(e) => set('period', e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {period.key === '24h' && (
          <div className="field">
            <label htmlFor="o-compare">Comparar com</label>
            <select id="o-compare" value={compare} onChange={(e) => set('compare', e.target.value === 'week' ? 'week' : '')}>
              <option value="previous">24 horas anteriores</option>
              <option value="week">Mesmas horas da semana passada</option>
            </select>
          </div>
        )}
        {(['service', 'version', 'platform'] as const).map((key) => {
          const options = facets.status === 'ok' ? facets.data[key === 'service' ? 'services' : key === 'version' ? 'versions' : 'platforms'] : [];
          return (
            <div className="field" key={key}>
              <label htmlFor={`o-${key}`}>{key === 'service' ? 'App' : key === 'version' ? 'Versão' : 'Plataforma'}</label>
              <select id={`o-${key}`} value={dims[key]} onChange={(e) => set(key, e.target.value)}>
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
        <p className="freshness">
          {data.status === 'ok' && data.data.updatedAt ? `Atualizado ${fmtAgo(data.data.updatedAt, now)} · 100% dos eventos de jornada` : ''}
        </p>
        <button type="button" className="ghost" onClick={() => setRefresh((n) => n + 1)}>
          Atualizar
        </button>
      </form>

      {data.status === 'loading' && <p className="empty">Carregando a visão geral…</p>}
      {data.status === 'error' && <p className="empty error">Não foi possível carregar a visão geral: {data.error.message}.</p>}
      {data.status === 'ok' && <Body o={data.data} sessions={sessions} />}
    </div>
  );
}

type SessionsLink = (extra?: Record<string, string | null | undefined>) => string;

/** The comparison period, with the articles Portuguese needs around it. */
interface Vs {
  plain: string;
  of: string;
  with: string;
  in: string;
  to: string;
}

function compareText(o: Overview): Vs {
  const [plain, fem] =
    o.previous.key === 'week'
      ? ['mesmas horas da semana passada', true]
      : o.period.key === '24h'
        ? ['24 h anteriores', true]
        : [o.period.key === '7d' ? '7 dias anteriores' : '30 dias anteriores', false];
  return fem
    ? { plain, of: `das ${plain}`, with: `as ${plain}`, in: `nas ${plain}`, to: `às ${plain}` }
    : { plain, of: `dos ${plain}`, with: `os ${plain}`, in: `nos ${plain}`, to: `aos ${plain}` };
}

const flowName = (f: { code: string; label: string | null }) => f.label ?? humanize(f.code);

function Body({ o, sessions }: { o: Overview; sessions: SessionsLink }) {
  if (o.sessions.now === 0 && o.flows.length === 0) {
    return (
      <div className="empty">
        <p>Nenhum evento de jornada neste período.</p>
        <p>
          Os números aparecem cerca de um minuto depois de os eventos chegarem. Sem app apontado para o receptor, gere dados
          fictícios com <code>npm run seed</code>.
        </p>
      </div>
    );
  }
  const vs = compareText(o);
  const hasBefore = o.sessions.before > 0 || o.flows.some((f) => f.before.started > 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const flowsNow = { started: sum(o.flows.map((f) => f.started)), failure: sum(o.flows.map((f) => f.failure)), open: sum(o.flows.map((f) => f.open)) };
  const flowsBefore = {
    started: sum(o.flows.map((f) => f.before.started)),
    failure: sum(o.flows.map((f) => f.before.failure)),
    open: sum(o.flows.map((f) => f.before.open)),
  };
  const bySlot = (pick: (f: FlowStat, i: number) => number) => o.slots.map((_, i) => sum(o.flows.map((f) => pick(f, i))));
  const startedBySlot = bySlot((f, i) => f.series.started[i]!);
  const failureBySlot = bySlot((f, i) => f.series.failure[i]!);
  const openBySlot = bySlot((f, i) => Math.max(0, f.series.started[i]! - f.series.ended[i]!));

  return (
    <>
      <section className="kpis" aria-label="Indicadores">
        <Kpi
          label="Sessões"
          value={fmtCount(o.sessions.now)}
          delta={hasBefore ? countDelta(o.sessions.now, o.sessions.before, vs) : null}
          series={o.sessions.series}
          to={sessions()}
        />
        <Kpi
          label="Sessões com falha"
          value={fmtPct(rate({ n: o.sessions.now, failure: o.failedSessions.now }))}
          delta={hasBefore ? rateDelta({ n: o.sessions.now, failure: o.failedSessions.now }, { n: o.sessions.before, failure: o.failedSessions.before }, vs) : null}
          series={o.sessions.series.map((n, i) => slotRate(o.failedSessions.series[i]!, n))}
          to={sessions({ onlyErrors: 'true' })}
        />
        <Kpi
          label="Fluxos com falha"
          value={fmtPct(rate({ n: flowsNow.started, failure: flowsNow.failure }))}
          delta={hasBefore ? rateDelta({ n: flowsNow.started, failure: flowsNow.failure }, { n: flowsBefore.started, failure: flowsBefore.failure }, vs) : null}
          series={startedBySlot.map((n, i) => slotRate(failureBySlot[i]!, n))}
          to="#fluxos"
        />
        <Kpi
          label="Fluxos sem conclusão"
          value={fmtPct(rate({ n: flowsNow.started, failure: flowsNow.open }))}
          delta={hasBefore ? rateDelta({ n: flowsNow.started, failure: flowsNow.open }, { n: flowsBefore.started, failure: flowsBefore.open }, vs) : null}
          series={startedBySlot.map((n, i) => slotRate(openBySlot[i]!, n))}
          to="#fluxos"
        />
      </section>

      <Changes o={o} vs={vs} hasBefore={hasBefore} sessions={sessions} />
      <FlowHealth o={o} vs={vs} sessions={sessions} />
      <FlowDetail o={o} sessions={sessions} />
      <div className="two">
        <Versions o={o} sessions={sessions} />
        <SlowActions o={o} vs={vs} />
      </div>
    </>
  );
}

interface Delta {
  text: string;
  tone: 'bad' | 'good' | 'flat';
}

function countDelta(now: number, before: number, vs: Vs): Delta {
  if (before <= 0) return { text: `sem dados ${vs.of}`, tone: 'flat' };
  const d = (now - before) / before;
  return { text: `${d >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(d)).replace(',0%', '%')} vs ${vs.plain}`, tone: 'flat' };
}

/** Two-proportion z score: how unlikely the difference is to be chance. */
function zScore(a: Rate, b: Rate): number {
  const p = (a.failure + b.failure) / (a.n + b.n);
  const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  return se > 0 ? (rate(a) - rate(b)) / se : 0;
}

/** A rate where up is worse: colored only when the change is unlikely to be chance and big enough to matter. */
function rateDelta(now: Rate, before: Rate, vs: Vs): Delta {
  if (before.n <= 0) return { text: `sem dados ${vs.of}`, tone: 'flat' };
  const d = rate(now) - rate(before);
  const matters = Math.abs(zScore(now, before)) >= 3 && Math.abs(d) >= 0.005;
  if (!matters) return { text: `${d >= 0 ? '▲' : '▼'} ${fmtPp(d)} · dentro da variação normal`, tone: 'flat' };
  return d > 0 ? { text: `▲ ${fmtPp(d)} · pior que ${vs.in}`, tone: 'bad' } : { text: `▼ ${fmtPp(d)} · melhor que ${vs.in}`, tone: 'good' };
}

function Kpi(props: { label: string; value: string; delta: Delta | null; series: (number | null)[]; to: string }) {
  const body = (
    <>
      <span className="kpi-label">{props.label}</span>
      <span className="kpi-value">{props.value}</span>
      {props.delta && <span className={`kpi-delta ${props.delta.tone}`}>{props.delta.text}</span>}
      <Sparkline values={props.series} />
    </>
  );
  return props.to.startsWith('#') ? (
    <a className="card kpi" href={props.to}>
      {body}
    </a>
  ) : (
    <Link className="card kpi" to={props.to}>
      {body}
    </Link>
  );
}

function Triangle({ up, tone }: { up: boolean; tone: 'bad' | 'good' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`tri ${tone}`}>
      <path d={up ? 'M6 1 11 10H1z' : 'M6 11 1 2h10z'} />
    </svg>
  );
}

function Changes({ o, vs, hasBefore, sessions }: { o: Overview; vs: Vs; hasBefore: boolean; sessions: SessionsLink }) {
  const shown = o.changes.slice(0, 6);
  return (
    <section className="card" aria-labelledby="changes-title">
      <h2 id="changes-title">O que mudou</h2>
      <p className="sub">Comparação com {vs.with}, por fluxo, versão, plataforma e motivo.</p>
      {!hasBefore ? (
        <p className="quiet">Ainda não há dados {vs.of} para comparar.</p>
      ) : shown.length === 0 ? (
        <p className="quiet">Nada mudou além do normal.</p>
      ) : (
        <div className="changes">
          {shown.map((c) => (
            <ChangeCard key={`${c.type}:${c.code}`} c={c} o={o} sessions={sessions} />
          ))}
        </div>
      )}
      <p className="fine">
        Só compara grupos com pelo menos {fmtCount(o.minVolume)} execuções nos dois períodos e só mostra diferenças improváveis de serem
        acaso. Aponta onde olhar; a causa se confirma abrindo as sessões e os traces.
      </p>
    </section>
  );
}

function ChangeCard({ c, o, sessions }: { c: Change; o: Overview; sessions: SessionsLink }) {
  const worse = c.direction === 'worse';
  const name = c.label ?? humanize(c.code);
  const kind = (
    <span className="change-kind">
      <Triangle up={worse} tone={worse ? 'bad' : 'good'} />
      {worse ? 'Piorou' : 'Melhorou'}
    </span>
  );
  if (c.type === 'duration') {
    return (
      <article className={`change ${worse ? 'worse' : 'better'}`}>
        {kind}
        <h3>
          {name} {worse ? 'mais lento' : 'mais rápido'}: p95 {fmtDuration(c.beforeMs)} → {fmtDuration(c.nowMs)}
        </h3>
        <p>
          {fmtCount(c.measured)} execuções medidas pelo app no período. O trace de uma execução mostra se o tempo está no app ou no
          servidor.
        </p>
        <div className="change-links">
          <a href="#acoes">Ver ações mais lentas</a>
        </div>
      </article>
    );
  }
  const reasonText = c.reason ? (c.reason.reason ?? `error.type ${c.reason.errorType}`) : null;
  const where = c.where;
  return (
    <article className={`change ${worse ? 'worse' : 'better'}`}>
      {kind}
      <h3>
        Falhas em {name}: {fmtPct(rate(c.before))} → {fmtPct(rate(c.now))}
        {c.since ? ` desde ${o.slot === 'hour' ? 'as ' : ''}${fmtSlot(c.since, o.slot)}` : ''}
      </h3>
      <p>
        {where && (
          <>
            {fmtPct(where.share).replace(',0%', '%')} da {worse ? 'alta' : 'queda'} vem do {versionName(where.platform, where.version)}.{' '}
          </>
        )}
        {c.reason && (where && c.reason.beforeScope === 'flow' ? (
          <>
            Nessa versão, <code>{reasonText}</code> é {fmtPct(c.reason.shareNow)} das falhas; antes, era {fmtPct(c.reason.shareBefore)} no
            fluxo todo.
          </>
        ) : (
          <>
            {where ? 'Nessa versão, o' : 'O'} motivo <code>{reasonText}</code> passou de {fmtPct(c.reason.shareBefore)} para{' '}
            {fmtPct(c.reason.shareNow)} das falhas.
          </>
        ))}
        {!where && !c.reason && <>A mudança está espalhada por versões e motivos.</>}
      </p>
      <div className="change-links">
        <Link to={sessions({ failedFlow: c.code, ...(where ? { version: where.version, platform: where.platform } : {}), ...(c.reason?.reason ? { reason: c.reason.reason } : {}) })}>
          Ver sessões com essa falha
        </Link>
        {where && <Link to={sessions({ failedFlow: c.code })}>Todas as falhas de {name}</Link>}
      </div>
    </article>
  );
}

const PARTS = [
  { key: 'success', label: 'Sucesso' },
  { key: 'cancelled', label: 'Cancelado' },
  { key: 'completed', label: 'Concluído' },
  { key: 'open', label: 'Sem conclusão' },
  { key: 'failure', label: 'Falhou' },
] as const;

function FlowHealth({ o, vs, sessions }: { o: Overview; vs: Vs; sessions: SessionsLink }) {
  const [asTable, setAsTable] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; flow: FlowStat; part: (typeof PARTS)[number] } | null>(null);
  const flows = o.flows.slice(0, 12);
  const present = PARTS.filter((p) => flows.some((f) => f[p.key] > 0));
  const rates = flows.map((f) => f.series.started.map((n, i) => slotRate(f.series.failure[i]!, n)));
  const max = Math.max(0, ...rates.flat().filter((v): v is number => v !== null));
  const totalOf = (f: FlowStat) => PARTS.reduce((n, p) => n + f[p.key], 0) || 1;
  return (
    <section className="card" id="fluxos" aria-labelledby="flows-title">
      <div className="card-head">
        <div>
          <h2 id="flows-title">Saúde dos fluxos</h2>
          <p className="sub">
            Como terminou cada execução iniciada no período. “Sem conclusão” é início sem fim recebido: app fechado, telemetria perdida,
            fim não instrumentado ou execução ainda em andamento.
          </p>
        </div>
        <button type="button" className="toggle" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Ver gráfico' : 'Ver números'}
        </button>
      </div>
      {asTable ? (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Fluxo</th>
                <th scope="col" className="num">
                  Iniciados
                </th>
                {present.map((p) => (
                  <th key={p.key} scope="col" className="num">
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {flows.map((f) => (
                <tr key={f.code}>
                  <td>{flowName(f)}</td>
                  <td className="num">{fmtCount(f.started)}</td>
                  {present.map((p) => (
                    <td key={p.key} className="num">
                      {fmtCount(f[p.key])} ({fmtPct(f[p.key] / totalOf(f))})
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="legend">
            {present.map((p) => (
              <span key={p.key}>
                <i className={`swatch ${p.key}`} />
                {p.label}
              </span>
            ))}
          </div>
          <div className="table-scroll chart-host" onPointerLeave={() => setTip(null)}>
            <table className="data flows">
              <thead>
                <tr>
                  <th scope="col">Fluxo</th>
                  <th scope="col" className="num">
                    Iniciados
                  </th>
                  <th scope="col" className="stack-col">
                    Resultado
                  </th>
                  <th scope="col" className="num">
                    Falhou
                  </th>
                  <th scope="col" className="num">
                    vs anterior
                  </th>
                  <th scope="col" className="num">
                    Duração p95
                  </th>
                  <th scope="col">Falha por {o.slot === 'hour' ? 'hora' : 'dia'}</th>
                </tr>
              </thead>
              <tbody>
                {flows.map((f, row) => {
                  const total = totalOf(f);
                  const d = f.before.started > 0 ? rate({ n: f.started, failure: f.failure }) - rate({ n: f.before.started, failure: f.before.failure }) : null;
                  const tone = d === null || Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'bad' : 'good';
                  return (
                    <tr key={f.code}>
                      <td>
                        <Link className="flow-link" to={sessions({ flow: f.code })}>
                          {flowName(f)}
                        </Link>
                      </td>
                      <td className="num">{fmtCount(f.started)}</td>
                      <td className="stack-col">
                        <div className="stack">
                          {PARTS.filter((p) => f[p.key] > 0).map((p) => (
                            <span
                              key={p.key}
                              className={p.key}
                              style={{ width: `${(f[p.key] / total) * 100}%` }}
                              tabIndex={0}
                              aria-label={`${flowName(f)}: ${p.label} ${fmtPct(f[p.key] / total)}`}
                              onPointerEnter={(e) => place(e.currentTarget, f, p)}
                              onFocus={(e) => place(e.currentTarget, f, p)}
                              onBlur={() => setTip(null)}
                            >
                              {p.key === 'success' && f[p.key] / total >= 0.15 && <b>{fmtPct(f[p.key] / total)}</b>}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="num">
                        <Link to={sessions({ failedFlow: f.code })} className="quiet-link">
                          {fmtPct(f.failure / total)}
                        </Link>
                      </td>
                      <td className={`num delta ${tone}`}>{d === null ? '—' : `${d >= 0 ? '▲' : '▼'} ${fmtPp(d)}`}</td>
                      <td className="num">{f.p95Ms === null ? '—' : fmtDuration(f.p95Ms)}</td>
                      <td>
                        <Sparkline values={rates[row]!} max={max} height={24} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Tip at={tip}>
              {tip && (
                <>
                  <div className="tip-title">
                    {flowName(tip.flow)} · {fmtCount(tip.flow.started)} iniciados
                  </div>
                  <div className="tip-row">
                    <span className={`key box ${tip.part.key}`} />
                    <b>{fmtPct(tip.flow[tip.part.key] / totalOf(tip.flow))}</b>
                    <span>
                      {tip.part.label} ({fmtCount(tip.flow[tip.part.key])})
                    </span>
                  </div>
                </>
              )}
            </Tip>
          </div>
          <p className="fine">Variação da taxa de falha em relação {vs.to}. A linha de cada fluxo usa a mesma escala.</p>
        </>
      )}
    </section>
  );

  function place(el: HTMLElement, flow: FlowStat, part: (typeof PARTS)[number]) {
    const host = el.closest('.chart-host')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setTip({ x: Math.min(r.left - host.left, host.width - 220), y: r.bottom - host.top + 6, flow, part });
  }
}

function FlowDetail({ o, sessions }: { o: Overview; sessions: SessionsLink }) {
  const firstChange = o.changes.find((c): c is Extract<Change, { type: 'failure' }> => c.type === 'failure' && c.direction === 'worse');
  const worst = [...o.flows].filter((f) => f.failure > 0).sort((a, b) => b.failure / b.started - a.failure / a.started)[0];
  const [picked, setPicked] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  const flow = o.flows.find((f) => f.code === picked) ?? o.flows.find((f) => f.code === firstChange?.code) ?? worst ?? o.flows[0];
  if (!flow) return null;
  const name = flowName(flow);
  const change = o.changes.find((c): c is Extract<Change, { type: 'failure' }> => c.type === 'failure' && c.code === flow.code);
  const versions = flow.byVersion.filter((v) => v.started >= 10).slice(0, 6);
  const overall = (v: (typeof versions)[number]) => rate({ n: v.started, failure: v.failure });
  const focusKey =
    change?.where
      ? `${change.where.platform}|${change.where.version}`
      : [...versions].sort((a, b) => overall(b) - overall(a)).map((v) => `${v.platform}|${v.version}`)[0];
  const series = versions.map((v) => ({
    key: `${v.platform}|${v.version}`,
    name: versionName(v.platform, v.version),
    values: v.series.started.map((n, i) => slotRate(v.series.failure[i]!, n)),
    focus: versions.length > 1 && `${v.platform}|${v.version}` === focusKey,
  }));
  const focus = series.find((s) => s.focus);
  const others = series.filter((s) => !s.focus);
  const unit = o.slot === 'hour' ? 'hora' : 'dia';

  const failures = flow.reasons.filter((r) => r.outcome === 'failure');
  const totalNow = failures.reduce((n, r) => n + r.now, 0);
  const totalBefore = failures.reduce((n, r) => n + r.before, 0);
  const top = Math.max(0, ...failures.map((r) => r.now / (totalNow || 1)));

  return (
    <div className="two">
      <section className="card" aria-labelledby="trend-title">
        <div className="card-head">
          <div>
            <h2 id="trend-title">
              Falha em{' '}
              <select className="inline-select" aria-label="Fluxo" value={flow.code} onChange={(e) => setPicked(e.target.value)}>
                {o.flows.map((f) => (
                  <option key={f.code} value={f.code}>
                    {flowName(f)}
                  </option>
                ))}
              </select>{' '}
              por {unit}
            </h2>
            <p className="sub">Por versão e plataforma{focus ? `; ${focus.name} em destaque` : ''}.</p>
          </div>
          <button type="button" className="toggle" onClick={() => setAsTable((v) => !v)}>
            {asTable ? 'Ver gráfico' : 'Ver tabela'}
          </button>
        </div>
        {asTable ? (
          <div className="table-scroll tall">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">{unit === 'hora' ? 'Hora' : 'Dia'}</th>
                  {series.map((s) => (
                    <th key={s.key} scope="col" className="num">
                      {s.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {o.slots.map((slot, i) => (
                  <tr key={slot}>
                    <td>{fmtSlotLong(slot, o.slot)}</td>
                    {series.map((s) => (
                      <td key={s.key} className="num">
                        {s.values[i] === null ? '—' : fmtPct(s.values[i]!)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            {series.length > 1 && (
              <div className="legend">
                {focus && (
                  <span>
                    <i className="swatch line focus" />
                    {focus.name}
                  </span>
                )}
                {others.length > 0 && (
                  <span>
                    <i className="swatch line" />
                    {focus ? 'Outras: ' : ''}
                    {others.map((s) => s.name).join(', ')}
                  </span>
                )}
              </div>
            )}
            <LineChart
              slots={o.slots}
              series={series.length === 1 ? [{ ...series[0]!, focus: true }] : series}
              xLabel={(i) => fmtSlot(o.slots[i]!, o.slot)}
              tipTitle={(i) => fmtSlotLong(o.slots[i]!, o.slot)}
              format={(v) => fmtPct(v).replace(',0%', '%')}
              ariaLabel={`Taxa de falha de ${name} por ${unit}, por versão e plataforma`}
            />
            {change?.since && (
              <p className="fine">
                A alta começa {o.slot === 'hour' ? 'às' : 'em'} {fmtSlot(change.since, o.slot)}. Intervalos com menos de 5 execuções ficam
                em branco.
              </p>
            )}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="reasons-title">
        <h2 id="reasons-title">Por que {name} falhou</h2>
        <p className="sub">
          {fmtCount(totalNow)} falhas por <code>journey.outcome_reason</code>; sem motivo, pelo <code>error.type</code>.
        </p>
        {failures.length === 0 ? (
          <p className="quiet">Nenhuma falha no período.</p>
        ) : (
          <ul className="bars">
            {failures.slice(0, 8).map((r) => {
              const share = r.now / (totalNow || 1);
              const before = totalBefore ? r.before / totalBefore : null;
              const d = before === null ? null : share - before;
              const tone = d === null || Math.abs(d) < 0.05 ? 'flat' : d > 0 ? 'bad' : 'good';
              const label = r.reason ?? `error.type ${r.errorType}`;
              return (
                <li key={`${r.reason}|${r.errorType}`}>
                  <Link
                    to={sessions({ failedFlow: flow.code, ...(r.reason ? { reason: r.reason } : { errorType: r.errorType }) })}
                    aria-label={`${label}: ${fmtCount(r.now)} falhas, ${fmtPct(share)}. Abrir as sessões.`}
                  >
                    <span className="code">{label}</span>
                    <span className="reason-track">
                      <span className={`bar${r.reason ? '' : ' context'}`} style={{ width: `${(share / (top || 1)) * 78}%` }} />
                      <span className="val">
                        {fmtCount(r.now)} · {fmtPct(share)}
                      </span>
                    </span>
                    <span className={`num delta ${tone}`}>{d === null ? '' : `${d >= 0 ? '▲' : '▼'} ${fmtPp(d)}`}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <p className="fine">A barra é a parte das falhas; ao lado, a mudança dessa parte em relação ao período anterior. Clique para ver as sessões.</p>
      </section>
    </div>
  );
}

function Versions({ o, sessions }: { o: Overview; sessions: SessionsLink }) {
  const flows = o.flows.slice(0, 2);
  const highlight = o.changes.find((c): c is Extract<Change, { type: 'failure' }> => c.type === 'failure' && c.direction === 'worse' && !!c.where)?.where;
  return (
    <section className="card" aria-labelledby="versions-title">
      <h2 id="versions-title">Por versão e plataforma</h2>
      <p className="sub">Uma versão nova com problema aparece aqui primeiro.</p>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Versão</th>
              <th scope="col" className="num">
                Sessões
              </th>
              <th scope="col" className="num">
                Sessões com falha
              </th>
              {flows.map((f) => (
                <th key={f.code} scope="col" className="num">
                  Falha em {flowName(f)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {o.versions.map((v) => {
              const hl = highlight && highlight.version === v.version && highlight.platform === v.platform;
              const filter = { version: v.version, platform: v.platform };
              return (
                <tr key={`${v.platform}|${v.version}`} className={hl ? 'hl' : undefined}>
                  <td>{versionName(v.platform, v.version)}</td>
                  <td className="num">{fmtCount(v.sessions)}</td>
                  <td className="num">
                    <Link className="quiet-link" to={sessions({ ...filter, onlyErrors: 'true' })}>
                      {fmtPct(rate({ n: v.sessions, failure: v.failedSessions }))}
                    </Link>
                  </td>
                  {flows.map((f) => {
                    const r = v.flows[f.code];
                    return (
                      <td key={f.code} className="num">
                        {r && r.n > 0 ? (
                          <Link className={`quiet-link${hl && f.code === flows[0]?.code ? ' strong' : ''}`} to={sessions({ ...filter, failedFlow: f.code })}>
                            {fmtPct(rate(r))}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SlowActions({ o, vs }: { o: Overview; vs: Vs }) {
  const actions = o.actions.filter((a) => a.p95Ms !== null).slice(0, 6);
  return (
    <section className="card" id="acoes" aria-labelledby="slow-title">
      <h2 id="slow-title">Ações mais lentas</h2>
      <p className="sub">p95 da duração medida pelo app (<code>Journey.track</code>), comparado com {vs.with}.</p>
      {actions.length === 0 ? (
        <p className="quiet">Nenhuma ação medida com volume suficiente.</p>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Ação</th>
                <th scope="col" className="num">
                  p95
                </th>
                <th scope="col" className="num">
                  vs anterior
                </th>
                <th scope="col" className="num">
                  Medidas
                </th>
                <th scope="col" className="num">
                  Falhas
                </th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => {
                const ratio = a.before.p95Ms ? a.p95Ms! / a.before.p95Ms - 1 : null;
                const tone = ratio === null || Math.abs(ratio) < 0.25 ? 'flat' : ratio > 0 ? 'bad' : 'good';
                return (
                  <tr key={a.code}>
                    <td>{a.label ?? humanize(a.code)}</td>
                    <td className="num">{fmtDuration(a.p95Ms)}</td>
                    <td className={`num delta ${tone}`}>{ratio === null ? '—' : `${ratio >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(ratio)).replace(',0%', '%')}`}</td>
                    <td className="num">{fmtCount(a.measured)}</td>
                    <td className="num">{fmtPct(a.n ? a.failure / a.n : 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">O p95 vem de faixas de duração; a margem é de alguns por cento.</p>
    </section>
  );
}

