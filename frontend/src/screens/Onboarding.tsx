import { useState } from 'react';
import { useApp } from '../state/AppContext';
import { HOSTED_ENDPOINT, isValidHttpUrl, normalizeUrl, probeEndpoint } from '../lib/pb';
import './onboarding.css';

/** First-run screen: pick Hosted or Self-hosted, validate reachability, persist endpoint. */

type Mode = 'pick' | 'hosted' | 'self';

export default function Onboarding() {
  const { setEndpoint } = useApp();
  const [mode, setMode] = useState<Mode>('pick');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [connecting, setConnecting] = useState(false);

  const proceed = (endpoint: string) => {
    setErr('');
    setConnecting(true);
    // Any URL is accepted as the chosen endpoint; we probe to show a
    // connecting → failure state, but never block the user from continuing.
    void probeEndpoint(endpoint)
      .then((ok) => {
        if (ok) {
          setEndpoint(endpoint);
        } else {
          setConnecting(false);
          setErr(
            `Couldn't reach ${endpoint}. Check the URL and that the server is running.`,
          );
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
      <div className="onb-card">
        <div className="onb-brand">
          <span className="onb-mark">S</span>
          <h1>Saolrian</h1>
          <p className="onb-tag">Calorie tracking you can host yourself.</p>
        </div>

        {mode === 'pick' && (
          <div className="onb-choices">
            <button className="onb-choice" onClick={chooseHosted}>
              <strong>Hosted</strong>
              <span>Use the managed Saolrian server — nothing to install.</span>
            </button>
            <button className="onb-choice" onClick={chooseSelf}>
              <strong>Self-hosted</strong>
              <span>Point the app at your own PocketBase instance.</span>
            </button>
          </div>
        )}

        {mode === 'self' && (
          <form
            className="onb-self"
            onSubmit={(e) => {
              e.preventDefault();
              submitSelf();
            }}
          >
            <label className="field">
              <span className="field-label">Server URL</span>
              <input
                autoFocus
                type="url"
                inputMode="url"
                placeholder="https://pb.example.com or http://192.168.1.20:8090"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <button className="btn btn-primary btn-md" type="submit" disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setMode('pick');
                setErr('');
              }}
            >
              Back
            </button>
          </form>
        )}

        {(mode === 'hosted' || connecting) && (
          <div className="onb-status">
            <span className="spinner" /> Connecting to {HOSTED_ENDPOINT}…
          </div>
        )}

        {err && (
          <div className="onb-error" role="alert">
            <p>{err}</p>
            <button
              className="btn btn-outline btn-sm"
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

        <p className="onb-foot">Your data stays on the server you choose.</p>
      </div>
    </div>
  );
}
