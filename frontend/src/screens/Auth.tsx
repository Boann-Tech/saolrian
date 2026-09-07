import { useState } from 'react';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import { Button, Field, TextInput } from '../components/ui';

/** Sign-up / sign-in against the PocketBase 'users' collection —
 * prototype-styled centered card with wordmark + display h1. */

export default function Auth() {
  const { endpoint, clearEndpoint, refreshProfile, refreshSlots } = useApp();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [notice, setNotice] = useState('');

  /** Host of the endpoint being signed in to. A stored endpoint routes every
   *  path here, so naming it is the only way a typo is visible. */
  const host = (() => {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  })();

  const requestReset = async () => {
    const address = email.trim();
    if (!address) {
      setNotice('');
      setErr('Enter your email address first, then tap Forgot password.');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      await getClient(endpoint).collection('users').requestPasswordReset(address);
    } catch {
      // Deliberately swallowed: reporting the failure would disclose whether
      // the address is registered.
    } finally {
      setBusy(false);
      setNotice('If that address has an account, a reset link is on its way.');
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    const pb = getClient(endpoint);
    try {
      if (mode === 'signup') {
        await pb.collection('users').create({ email, password, passwordConfirm: password });
        await pb.collection('users').authWithPassword(email, password);
        // The backend auto-creates the profile on signup — do not create one here.
      } else {
        await pb.collection('users').authWithPassword(email, password);
      }
      await refreshProfile();
      await refreshSlots();
      // Gate in main.tsx re-renders and routes to /today automatically.
    } catch (ex) {
      setErr(
        ex instanceof Error
          ? ex.message.replace(/^\w+:\s*/, '').slice(0, 200)
          : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex min-h-[100dvh] items-center justify-center px-6 py-7"
      style={{
        background:
          'radial-gradient(600px 320px at 85% -10%, var(--color-accent-soft), transparent 70%), var(--color-bg)',
      }}
    >
      <form className="flex w-full max-w-[380px] flex-col gap-3.5" onSubmit={submit}>
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.08em] text-text-muted">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-accent" />
          SAOLRIAN
        </div>
        <h1 className="mb-2.5 text-[30px] font-bold leading-[1.12] tracking-[-.024em]">
          {mode === 'signin' ? (
            <>
              Welcome{' '}
              <em
                className="italic text-accent"
                style={{ fontFamily: "'Fraunces','Georgia','Times New Roman',serif" }}
              >
                back.
              </em>
            </>
          ) : (
            <>
              Create your{' '}
              <em
                className="italic text-accent"
                style={{ fontFamily: "'Fraunces','Georgia','Times New Roman',serif" }}
              >
                account.
              </em>
            </>
          )}
        </h1>

        <Field label="Email">
          <TextInput
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters' : undefined}>
          <div className="relative">
            <TextInput
              type={reveal ? 'text' : 'password'}
              required
              minLength={8}
              className="pr-16"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-text-muted hover:text-accent-ink"
              onClick={() => setReveal((r) => !r)}
            >
              {reveal ? 'Hide password' : 'Show password'}
            </button>
          </div>
        </Field>

        {err && (
          <div
            className="rounded-lg border-[1.5px] border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm leading-normal text-danger"
            role="alert"
          >
            {err}
          </div>
        )}
        {notice && (
          <div
            className="rounded-lg border-[1.5px] border-border bg-surface px-3.5 py-2.5 text-sm leading-normal text-text-muted"
            role="status"
          >
            {notice}
          </div>
        )}

        <Button type="submit" loading={busy} block>
          {mode === 'signin' ? 'Sign in' : 'Sign up'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          block
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setErr('');
            setNotice('');
          }}
        >
          {mode === 'signin' ? 'Need an account? Sign up' : 'Already registered? Sign in'}
        </Button>

        {mode === 'signin' && (
          <button
            type="button"
            className="rounded-md text-xs font-semibold text-text-muted hover:text-accent-ink"
            onClick={() => void requestReset()}
          >
            Forgot password?
          </button>
        )}

        <div className="mt-2 flex flex-col items-center gap-1 border-t border-border pt-3 text-2xs text-text-faint">
          <span>
            Signing in to <b className="font-semibold text-text-muted">{host}</b>
          </span>
          <button
            type="button"
            className="rounded-md font-semibold text-text-muted hover:text-accent-ink"
            onClick={clearEndpoint}
          >
            Change server
          </button>
        </div>
      </form>
    </div>
  );
}
