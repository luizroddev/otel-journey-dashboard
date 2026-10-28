import type { Attr } from '../api';
import { valueText } from '../format';

/** Attribute pairs as a two-column list. */
export function Attributes({ attrs, title }: { attrs: Attr[]; title?: string }) {
  if (attrs.length === 0) return null;
  const sorted = [...attrs].sort((a, b) => a.key.localeCompare(b.key));
  return (
    <div className="attrs">
      {title && <h4>{title}</h4>}
      <dl className="kv">
        {sorted.map((a) => (
          <div key={a.key} className="kv-row">
            <dt className="mono">{a.key}</dt>
            <dd className="mono">{valueText(a.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
