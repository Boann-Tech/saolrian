import { useState } from 'react';
import { useApp } from '../state/AppContext';
import { HOSTED_ENDPOINT, isValidHttpUrl, normalizeUrl, probeEndpoint } from '../lib/pb';
import { Button, Spinner, TextInput } from '../components/ui';
import { cn } from '../lib/cn';

/** First-run screen — prototype onboarding: wordmark, display h1 with
 * accent em, radio option cards, self-host URL field, connecting state,
 * success check + "Continue". Behavior unchanged. */

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

  if (connected) {
    return (
      <div className="mx-auto flex min-h-[100dvh] max-w-[640px] flex-col items-center bg-bg px-6 pt-[52px] pb-6 text-center">
        <div className="flex h-[74px] w-[74px] items-center justify-center rounded-full bg-accent-soft text-accent">
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            className="h-[34px] w-[34px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4.5 12.5l5 5 10-11" />
          </svg>
        </div>
        <h2 className="mt-4 text-2xl font-bold tracking-[-.02em]">Connected</h2>
        <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-semibold text-text-muted">
          <span className="inline-block h-[7px] w-[7px] rounded-full bg-good shadow-[0_0_6px_rgba(62,207,142,.8)]" />
          <span>{new URL(typeof window !== 'undefined' ? localStorage.getItem('saolrian-endpoint') || '' : '').host}</span>
        </div>
        <div className="flex-1" />
        <Button block onClick={() => setConnected(false)}>
          Continue →
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-[640px] flex-col bg-bg px-6 pt-8 pb-6">
      <span className="wordmark inline-flex items-center gap-2 text-2xs font-bold uppercase tracking-[.06em] text-text-faint">
        <span className="inline-block h-[11px] w-[11px] rounded-[3px] bg-accent" />
        SAOLRIAN
      </span>
      <h1 className="mt-9 text-[32px] font-bold leading-[1.1] tracking-[-.024em] text-text">
        Your life, <em className="italic text-accent [font-family:'Fraunces','Georgia',serif]">tracked.</em>
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-text-muted">
        Calories, training, and everything in between — in one calm place.
      </p>

      <div
        className="mt-8 cursor-pointer rounded-lg border border-border bg-raised p-4 transition hover:border-accent-line"
        role="button"
        tabIndex={0}
        onClick={chooseHosted}
        onKeyDown={(e) => {
          if (e.key === 'Enter') chooseHosted();
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-[1.5px]',
              mode === 'hosted' ? 'border-accent' : 'border-border',
            )}
          >
            {mode === 'hosted' && <span className="h-2.5 w-2.5 rounded-full bg-accent" />}
          </span>
          <div>
            <div className="text-base font-semibold text-text">Hosted — saolrian.com</div>
            <div className="mt-0.5 text-sm text-text-faint">We host it. Works everywhere. Export anytime.</div>
          </div>
        </div>
      </div>

      <div
        className={cn(
          'mt-3.5 cursor-pointer rounded-lg border p-4 transition',
          mode === 'self' ? 'border-accent bg-accent-soft' : 'border-border bg-raised hover:border-accent-line',
        )}
        role="button"
        tabIndex={0}
        onClick={chooseSelf}
        onKeyDown={(e) => {
          if (e.key === 'Enter') chooseSelf();
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-[1.5px]',
              mode === 'self' ? 'border-accent' : 'border-border',
            )}
          >
            {mode === 'self' && <span className="h-2.5 w-2.5 rounded-full bg-accent" />}
          </span>
          <div>
            <div className="text-base font-semibold text-text">Self-hosted — your own server</div>
            <div className="mt-0.5 text-sm text-text-faint">Your data, your hardware. Same app, full control.</div>
          </div>
        </div>
        {mode === 'self' && (
          <div className="mt-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitSelf();
              }}
            >
              <TextInput
                type="url"
                placeholder="https://saolrian.example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <div className="mt-2 text-xs text-text-faint">
                Point me at your instance — everything stays on your server.
              </div>
              <Button type="submit" loading={connecting} block className="mt-3">
                Continue
              </Button>
            </form>
          </div>
        )}
      </div>

      {(mode === 'hosted' || connecting) && (
        <div className="mt-4 flex items-center gap-2 text-sm text-text-muted">
          {mode === 'hosted' && <Spinner />}
          Connecting to {mode === 'hosted' ? HOSTED_ENDPOINT : 'your server'}…
        </div>
      )}

      {err && (
        <div
          className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          <p className="mb-2.5">{err}</p>
          <Button
            variant="outline"
            onClick={() => {
              setMode('pick');
              setErr('');
              setConnecting(false);
            }}
          >
            Change endpoint
          </Button>
        </div>
      )}

      <div className="flex-1" />
      <p className="mt-auto pt-6 text-center text-2xs text-text-faint">
        Your data stays on the server you choose.
      </p>
    </div>
  );
}
