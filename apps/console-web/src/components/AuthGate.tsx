import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import type { SessionContext } from "../api";
import { apiBaseUrl, authenticatedFetch, authRequest } from "../http";
import { SaasLoginFrame } from "./SaasLoginFrame";
import { UiIcon } from "./ProductIdentity";

interface Status {
  initialized: boolean;
  setupAllowed: boolean;
  tokenRequired: boolean;
  sso?: { enabled: boolean; label?: string; startPath?: string };
}

function invitationTokenFromHash(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash.split("?")[0] !== "join") return "";
  return new URLSearchParams(hash.split("?")[1] ?? "").get("token") ?? "";
}

export function AuthGate({
  children,
}: {
  children: (session: SessionContext, logout: () => Promise<void>) => ReactNode;
}) {
  const [session, setSession] = useState<SessionContext | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [joinToken, setJoinToken] = useState(invitationTokenFromHash);
  const [joinPassword, setJoinPassword] = useState("");
  const [joinLogoutBusy, setJoinLogoutBusy] = useState(false);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await authRequest<Status>("status");
      setStatus(next);
      if (next.initialized) {
        const response = await authenticatedFetch(
          `${apiBaseUrl}/api/auth/session`,
          {},
          false,
        );
        if (response.ok) setSession((await response.json()) as SessionContext);
        else if (response.status !== 401)
          throw new Error("Anmeldung gerade nicht erreichbar.");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Anmeldung gerade nicht erreichbar.",
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("sso_error") === "1") {
      setError("Single Sign-On ist fehlgeschlagen oder der Zugang hat keine Plattform-Admin-Berechtigung.");
      params.delete("sso_error");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
    void load();
    const syncInvitation = () => setJoinToken(invitationTokenFromHash());
    const expired = () => {
      setSession(null);
      setPassword("");
      setError("Deine Sitzung ist abgelaufen. Bitte erneut anmelden.");
    };
    window.addEventListener("koiforge:unauthorized", expired);
    window.addEventListener("hashchange", syncInvitation);
    return () => {
      window.removeEventListener("koiforge:unauthorized", expired);
      window.removeEventListener("hashchange", syncInvitation);
    };
  }, []);
  const logout = async () => {
    try {
      await authRequest("logout", {});
      setSession(null);
      setPassword("");
      setJoinPassword("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Abmelden fehlgeschlagen.");
      throw err;
    }
  };
  const logoutForInvitation = async () => {
    if (joinLogoutBusy) return;
    setJoinLogoutBusy(true);
    try {
      await logout();
    } catch {
      // logout keeps the existing error message visible in the access frame.
    } finally {
      setJoinLogoutBusy(false);
    }
  };
  const setup = status && !status.initialized;
  const sso = status?.sso;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (joinToken) {
        if (joinPassword.length < 15) throw new Error("Das Passwort muss mindestens 15 Zeichen lang sein.");
        const next = await authRequest<SessionContext>("join", { token: joinToken, password: joinPassword });
        setJoinPassword("");
        setJoinToken("");
        window.history.replaceState(null, "", "#/projects");
        setSession(next);
        return;
      }
      const next = await authRequest<SessionContext>(
        setup ? "setup" : "login",
        { email, password, displayName, workspaceName, setupToken },
      );
      setPassword("");
      setSetupToken("");
      setStatus(current => ({
        initialized: true,
        setupAllowed: false,
        tokenRequired: false,
        sso: current?.sso,
      }));
      setSession(next);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Anmeldung fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (session && joinToken) return (
    <SaasLoginFrame
      product="koiforge"
      title="Einladung für einen anderen Zugang"
      description="Du bist bereits angemeldet. Melde dich ausdrücklich ab, bevor du die Einladung für diesen Zugang annimmst."
    >
      <div className="nf-access-form">
        <p className="nf-access-hint">Deine aktuelle Sitzung bleibt unverändert, solange du hier nicht abmeldest.</p>
        <button className="nf-access-primary" type="button" disabled={joinLogoutBusy} onClick={() => void logoutForInvitation()}>
          {joinLogoutBusy ? "Wird abgemeldet…" : "Abmelden und Einladung öffnen"}
          <UiIcon name="arrow" />
        </button>
      </div>
    </SaasLoginFrame>
  );
  if (session) return <>{children(session, logout)}</>;
  return (
    <SaasLoginFrame
      product="koiforge"
      title={joinToken ? "Einladung annehmen" : setup ? "Arbeitsbereich einrichten" : "Willkommen zurück"}
      description={
        joinToken
          ? "Lege deinen persönlichen Lesezugang an. Projekte werden separat für dich freigegeben."
          : setup
          ? "Lege den ersten Zugang für deine Firma an."
          : "Melde dich an, um in deinem Arbeitsbereich weiterzuarbeiten."
      }
    >
      {loading ? (
        <p role="status">Anmeldung wird geprüft…</p>
      ) : !status && !joinToken ? (
        <>
          <p role="alert">{error}</p>
          <button onClick={() => void load()}>Erneut versuchen</button>
        </>
      ) : joinToken ? (
        <form className="nf-access-form" onSubmit={submit}>
          <p className="nf-access-hint">Dieser Einladungslink ist einmalig. Dein Passwort bleibt mindestens 15 Zeichen lang.</p>
          <label htmlFor="join-password">Passwort</label>
          <input id="join-password" type="password" autoComplete="new-password" minLength={15} maxLength={256} value={joinPassword} onChange={(e) => setJoinPassword(e.target.value)} required autoFocus aria-describedby="join-password-hint" />
          <p id="join-password-hint" className="nf-access-hint">Mindestens 15 Zeichen, zum Beispiel eine lange, eigene Passphrase.</p>
          {error && <p role="alert">{error}</p>}
          <button className="nf-access-primary" disabled={busy}>
            {busy ? "Bitte warten…" : "Einladung annehmen"}
            <UiIcon name="arrow" />
          </button>
        </form>
      ) : setup && !status.setupAllowed ? (
        <p>
          Die Einrichtung übernimmt der Betreiber. Bitte wende dich an deine
          Ansprechperson.
        </p>
      ) : (
        <form className="nf-access-form" onSubmit={submit}>
          {!setup && sso?.enabled && sso.startPath && (
            <>
              <button
                className="nf-access-primary"
                type="button"
                onClick={() => {
                  const returnTo = window.location.hash.startsWith("#/") ? window.location.hash : "#/monitoring";
                  window.location.assign(`${apiBaseUrl}${sso!.startPath}?returnTo=${encodeURIComponent(returnTo)}`);
                }}
              >
                {sso.label ?? "NeuroFunken SSO"}
                <UiIcon name="arrow" />
              </button>
              <p className="nf-access-hint">Einmal bei NeuroFunken anmelden; KoiForge übernimmt danach nur die serverseitig bestätigte Plattform-Admin-Identität.</p>
              <div aria-hidden="true" style={{ borderTop: "1px solid rgba(120,140,170,.18)", margin: "6px 0 2px" }} />
              <p className="nf-access-hint">Lokaler Zugang (Break-glass)</p>
            </>
          )}
          {setup && (
            <>
              <label htmlFor="account-name">Dein Name</label>
              <input
                id="account-name"
                autoComplete="name"
                maxLength={100}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
              <label htmlFor="workspace-name">Firma</label>
              <input
                id="workspace-name"
                autoComplete="organization"
                maxLength={100}
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                required
              />
            </>
          )}
          <label htmlFor="email">E-Mail</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus={!setup}
          />
          <label htmlFor="password">Passwort</label>
          <input
            id="password"
            type="password"
            autoComplete={setup ? "new-password" : "current-password"}
            minLength={setup ? 15 : undefined}
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            aria-describedby={setup ? "password-hint" : undefined}
          />
          {setup && (
            <p id="password-hint" className="nf-access-hint">
              Mindestens 15 Zeichen, zum Beispiel eine lange, eigene Passphrase.
            </p>
          )}
          {setup && status.tokenRequired && (
            <>
              <label htmlFor="setup-token">Einrichtungscode</label>
              <input
                id="setup-token"
                type="password"
                autoComplete="off"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                required
              />
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <button className="nf-access-primary" disabled={busy}>
            {busy
              ? "Bitte warten…"
              : setup
                ? "Arbeitsbereich einrichten"
                : "Anmelden"}
            <UiIcon name="arrow" />
          </button>
          {!setup && (
            <p className="nf-access-hint">
              Du brauchst einen Zugang? Wende dich an die Person, die deinen
              Arbeitsbereich verwaltet.
            </p>
          )}
        </form>
      )}
    </SaasLoginFrame>
  );
}
