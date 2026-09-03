import { useState } from 'react';
import { useApp } from '../state/AppContext';
import { HOSTED_ENDPOINT, isValidHttpUrl, normalizeUrl, probeEndpoint } from '../lib/pb';
import './onboarding.css';

/** First-run screen — prototype onboarding: wordmark, display h1 with
 * accent em, radio option cards, self-host URL field, connecting state,
 * success check + "Enter Saolrian". Behavior unchanged. */

type Mode = 'pick' | 'hosted' | 'self';

export default function Onboarding() {
  const { setEndpoint } = useApp();
  const [mode, setMode] = useState<Mode>('pick');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);

  const proceed = (endpoint: string) => {
    setErr('');
    setConnecting(true);
    // Any URL is accepted as the chosen endpoint; we probe to show a
    // connecting → failure state, but never block the user from continuing.
    void probeEndpoint(endpoint)
      .then((ok) => {
        if (ok) {
          setEndpoint(endpoint);
          setConnected(true);
        } else {
          setConnecting(false);
          setErr(`Couldn't reach ${endpoint}. Check the URL and that the server is running.`);
        }
      })
      .catch(() => {
        setConnecting(false);
        setErr(`Couldn't reach ${endpoint}. Check the URL and that the server is running.`);
      });
  };

  const chooseHosted = () => {
    setMode('hosted');
    proceed(HOSTED_ENDPOINT);
  };

  const chooseSelf = () => {
    setMode('self');
  };

  const submitSelf = () => {
    const clean = normalizeUrl(url);
    if (!isValidHttpUrl(clean)) {
      setErr('Enter a valid URL starting with http:// or https://');
      return;
    }
    proceed(clean);
  };

  return (
    <div className="onb">
      {connected ? (
        <div className="onb success show">
          <div className="ck">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M4.5 12.5l5 5 10-11" />
            </svg>
          </div>
          <h2>Connected</h2>
          <div className="pill">
            <span className="led" />
            <span>{new URL(typeof window !== 'undefined' ? localStorage.getItem('saolrian-endpoint') || '' : '').host}</span>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => setConnected(false)}>
            Continue →
          </button>
        </div>
      ) : (
        <div className="onb-form">
          <div className="wordmark">
            <span className="dot" />
            SAOLRIAN
          </div>
          <h1>
            Your life, <em>tracked.</em>
          </h1>
          <div className="tag">Calories, training, and everything in between — in one calm place.</div>

          <div className="opt" style={{ marginTop: 30 }} role="button" tabIndex={0} onClick={chooseHosted} onKeyDown={(e) => { if (e.key === 'Enter') chooseHosted(); }}>
            <div className="r">
              <span className={`radio${mode === 'hosted' ? ' sel' : ''}`}>
                <i />
              </span>
              <div>
                <div className="t">Hosted — saolrian.com</div>
                <div className="d">We host it. Works everywhere. Export anytime.</div>
              </div>
            </div>
          </div>

          <div
            className={`opt${mode === 'self' ? ' sel' : ''}`}
            role="button"
            tabIndex={0}
            onClick={chooseSelf}
            onKeyDown={(e) => {
              if (e.key === 'Enter') chooseSelf();
            }}
          >
            <div className="r">
              <span className={`radio${mode === 'self' ? ' sel' : ''}`}>
                <i />
              </span>
              <div>
                <div className="t">Self-hosted — your own server</div>
                <div className="d">Your data, your hardware. Same app, full control.</div>
              </div>
            </div>
            {mode === 'self' && (
              <div className="ep show">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitSelf();
                  }}
                >
                  <input
                    type="url"
                    placeholder="https://saolrian.example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <div className="hint">Point me at your instance — everything stays on your server.</div>
                  <button className="btn" type="submit" disabled={connecting} style={{ marginTop: 12 }}>
                    {connecting ? (
                      <>
                        <span className="spin" /> Connecting…
                      </>
                    ) : (
                      'Continue'
                    )}
                  </button>
                </form>
              </div>
            )}
          </div>

          {(mode === 'hosted' || connecting) && (
            <div className="onb-status">
              {mode === 'hosted' && <span className="spin ink" />}
              Connecting to {mode === 'hosted' ? HOSTED_ENDPOINT : 'your server'}…
            </div>
          )}

          {err && (
            <div className="onb-error" role="alert">
              <p>{err}</p>
              <button
                className="btn outline"
                onClick={() => {
                  setMode('pick');
                  setErr('');
                  setConnecting(false);
                }}
              >
                Change endpoint
              </button>
            </div>
          )}

          <div className="grow" />
          <p className="onb-foot">Your data stays on the server you choose.</p>
        </div>
      )}
    </div>
  );
}
