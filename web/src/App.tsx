import { useState, type FormEvent } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { OverviewPage } from './pages/Overview';
import { SessionPage } from './pages/Session';
import { SessionsPage } from './pages/Sessions';
import { TracePage } from './pages/Trace';

function TopBar() {
  const navigate = useNavigate();
  const [traceId, setTraceId] = useState('');
  const open = (e: FormEvent) => {
    e.preventDefault();
    const id = traceId.trim().toLowerCase();
    if (/^[0-9a-f]{32}$/.test(id)) navigate(`/traces/${id}`);
  };
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <path d="M5 3v16" className="brand-rail" />
          <circle cx="5" cy="5" r="2.6" className="brand-stop" />
          <circle cx="5" cy="11" r="2.6" className="brand-stop" />
          <rect x="2.4" y="14.4" width="5.2" height="5.2" rx="1" className="brand-station" />
          <path d="M10 5h9M10 11h6M10 17h8" className="brand-text" />
        </svg>
        Jornadas
      </Link>
      <nav>
        <NavLink to="/" end>
          Visão geral
        </NavLink>
        <NavLink to="/sessions">Sessões</NavLink>
      </nav>
      <form className="trace-search" onSubmit={open} role="search">
        <label htmlFor="trace-search">Abrir trace</label>
        <input
          id="trace-search"
          value={traceId}
          onChange={(e) => setTraceId(e.target.value)}
          placeholder="trace id (32 caracteres hex)"
          spellCheck={false}
          className="mono"
        />
      </form>
    </header>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <TopBar />
      <main>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<SessionPage />} />
          <Route path="/traces/:traceId" element={<TracePage />} />
          <Route path="*" element={<p className="empty">Página não encontrada. <Link to="/sessions">Voltar às sessões</Link></p>} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
