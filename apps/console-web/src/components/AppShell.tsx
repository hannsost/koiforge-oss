import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ProductBrand, UiIcon, type IconName } from './ProductIdentity';

export interface NavItem {
  id: string;
  label: string;
  group?: string;
  caption?: string;
  value?: string;
}

interface AppShellProps {
  activeView: string;
  hideHeading?: boolean;
  children: ReactNode;
  headerActions?: ReactNode;
  headerMeta?: ReactNode;
  sidebarSession?: ReactNode;
  navItems: NavItem[];
  onNavigate: (id: string) => void;
  subtitle: string;
  title: string;
  workspaceName?: string;
}

const NAV_ICONS: Record<string, IconName> = {
  projects: 'team',
  dataflows: 'workflow',
  missions: 'workflow',
  model: 'network',
  freshness: 'activity', overview: 'overview', data: 'source', objects: 'box', 'object-preview': 'source',
  boards: 'board', discovery: 'network', operations: 'lineage',
  insights: 'diagram', agents: 'settings', platform: 'settings', appstore: 'store', pipelines: 'workflow',
  checks: 'quality', aip: 'spark', workshop: 'workshop',
};

export function AppShell(props: AppShellProps) {
  const home = props.navItems.find(item => item.id === 'freshness') ?? props.navItems[0];
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const previousView = useRef(props.activeView);

  useEffect(() => {
    if (previousView.current !== props.activeView) {
      previousView.current = props.activeView;
      setMenuOpen(false);
      main.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    document.title = `KoiForge · ${props.title}`;
  }, [props.activeView, props.title]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menuOpen) {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);

  const navigate = (id: string) => {
    setMenuOpen(false);
    props.onNavigate(id);
    main.current?.focus({ preventScroll: true });
  };

  const renderItem = (item: NavItem) => {
    const icon = NAV_ICONS[item.id];
    return (
      <a
        key={item.id}
        href={`#/${item.id}`}
        data-testid={`nav-${item.id}`}
        className="kf-nav-link"
        aria-current={props.activeView === item.id ? 'page' : undefined}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate(item.id);
        }}
      >
        {icon && <UiIcon name={icon} size={20} />}
        <span>{item.label}</span>
        {item.value && <span className="kf-nav-count">{item.value}</span>}
      </a>
    );
  };

  return (
    <div className="kf-shell">
      <a className="kf-skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault();
        main.current?.focus();
      }}>Zum Inhalt springen</a>
      <aside className={`kf-sidebar${menuOpen ? ' menu-open' : ''}`} aria-label="Arbeitsbereich">
        <div className="kf-brand-row">
          <a className="kf-brand-link" href={`#/${home?.id ?? 'projects'}`} aria-label={`KoiForge ${home?.label ?? 'Projekte'}`}
            onClick={(event) => { event.preventDefault(); navigate(home?.id ?? 'projects'); }}>
            <ProductBrand product="koiforge" />
          </a>
          <button
            className="kf-menu-toggle"
            ref={menuButton}
            type="button"
            aria-controls="workspace-navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <UiIcon name={menuOpen ? 'close' : 'menu'} size={20} />
            {menuOpen ? 'Schließen' : 'Menü'}
          </button>
        </div>

        <div className="kf-workspace-context" aria-label="Aktueller Arbeitsbereich">
          <span>Aktueller Bereich</span>
          <strong title={props.workspaceName ?? 'Wird geladen…'}>{props.workspaceName ?? 'Wird geladen…'}</strong>
        </div>

        <div className="kf-sidebar-body" id="workspace-navigation">
          <div className="nf-sidebar-scroll">
          <nav aria-label="Hauptnavigation">
            {[...new Set(props.navItems.map((item) => item.group ?? 'Arbeitsbereich'))].map((group) => {
              const items = props.navItems.filter((item) => (item.group ?? 'Arbeitsbereich') === group);
              if (group === 'Arbeitsbereich') {
                return <div key={group} className="kf-nav-primary"><p className="kf-nav-label">Arbeitsbereich</p>{items.map(renderItem)}</div>;
              }
              return <NavGroup key={group} title={group} activeView={props.activeView} active={items.some((item) => item.id === props.activeView)}>{items.map(renderItem)}</NavGroup>;
            })}
          </nav>
          <footer className="kf-sidebar-footer">
            <span className="kf-alpha">In Entwicklung</span>
            <p>Daten verbinden.<br />Entscheidungen begründen.</p>
          </footer>
          </div>
          {props.sidebarSession && <footer className="nf-sidebar-session" aria-label="Dein Konto">{props.sidebarSession}</footer>}
        </div>
      </aside>

      <div className="kf-workspace-body">
        <header className="kf-workspace-header" aria-label="Seitenaktionen">
          <div className="kf-header-actions">
            {props.headerMeta}
            {props.headerActions}
          </div>
        </header>
        <main className="kf-main" id="main-content" ref={main} tabIndex={-1}>
          {!props.hideHeading && <div className="kf-page-heading" id="page-heading">
            <h1>{props.title}</h1>
            <p>{props.subtitle}</p>
          </div>}
          <div className="space-y-5">{props.children}</div>
        </main>
      </div>
    </div>
  );
}

function NavGroup(props: { title: string; active: boolean; activeView: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (props.active && ref.current) ref.current.open = true;
  }, [props.active, props.activeView]);

  return (
    <details className="kf-nav-group" ref={ref}>
      <summary>{props.title}<UiIcon name="chevron" size={20} /></summary>
      {props.children}
    </details>
  );
}
