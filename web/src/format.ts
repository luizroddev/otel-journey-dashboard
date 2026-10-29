import type { FlowStatus } from './api';

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
const time = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' });
const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const percent1 = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hourFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

/** 2.878, or 486 mil from 10 thousand on. */
export const fmtCount = (n: number) => (Math.abs(n) >= 10_000 ? compact.format(n) : integer.format(n));
/** 6,9%. */
export const fmtPct = (x: number) => percent1.format(x);
/** Signed difference of two rates in percentage points: 2,1 p.p. */
export const fmtPp = (d: number) => `${decimal.format(Math.abs(d) * 100)} p.p.`;
/** Start of an hourly slot (14:00) or a daily one (28/10). */
export const fmtSlot = (iso: string, slot: 'hour' | 'day') =>
  slot === 'hour' ? hourFmt.format(new Date(iso)) : dayFmt.format(new Date(iso));
export const fmtSlotLong = (iso: string, slot: 'hour' | 'day') =>
  slot === 'hour'
    ? `${dayFmt.format(new Date(iso))}, ${hourFmt.format(new Date(iso))} às ${hourFmt.format(new Date(Date.parse(iso) + 3_600_000))}`
    : weekdayFmt.format(new Date(iso));
/** "há 40 s", "há 3 min". */
export function fmtAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  return `há ${decimal.format(s / 3600)} h`;
}

export const fmtDateTime = (iso: string) => dateTime.format(new Date(iso));
export const fmtTime = (iso: string) => time.format(new Date(iso));

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1) return '< 1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${decimal.format(ms / 1000)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return `${m} min ${s.toString().padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${(m % 60).toString().padStart(2, '0')} min`;
}

/** Offset from the session start, like +1:05. */
export function fmtOffset(fromIso: string, iso: string): string {
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toString().padStart(2, '0');
  return h ? `+${h}:${m.toString().padStart(2, '0')}:${r}` : `+${m}:${r}`;
}

export const outcomeText: Record<FlowStatus, string> = {
  success: 'Sucesso',
  failure: 'Falhou',
  cancelled: 'Cancelado',
  completed: 'Concluído',
  open: 'Sem conclusão',
};

export const outcomeHelp: Record<FlowStatus, string> = {
  success: 'O app informou que deu certo.',
  failure: 'Houve exceção ou o app informou que não deu certo.',
  cancelled: 'O usuário ou o app cancelou.',
  completed: 'O código terminou, mas o app não informou o resultado de negócio.',
  open: 'Começou e não recebemos o fim. Pode ser app fechado, telemetria perdida ou fim não instrumentado; não indica abandono.',
};

export const shortId = (id: string, n = 8) => (id.length > n ? id.slice(0, n) : id);

/** A readable name from a code: chooseBiometric -> Choose biometric. */
export function humanize(code: string | null): string {
  if (!code) return '';
  const s = code
    .replace(/^\/+/, '')
    .replace(/[._/-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : code;
}

export function valueText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** iOS 1.4.0 */
export const versionName = (platform: string | null, version: string | null) =>
  [platform ? platformName(platform) : null, version].filter(Boolean).join(' ') || 'desconhecida';

export const platformName = (p: string) =>
  ({ ios: 'iOS', android: 'Android', darwin: 'iOS', linux: 'Android' })[p] ?? p;
