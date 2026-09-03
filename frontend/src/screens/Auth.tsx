import { useState } from 'react';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import { Button, Field, TextInput } from '../components/ui';

/** Sign-up / sign-in against the PocketBase 'users' collection —
 * prototype-styled centered card with wordmark + display h1. */

export default function Auth() {
  const { endpoint, refreshProfile, refreshSlots } = useApp();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

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
        <Field label="Password">
          <TextInput
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {err && (
          <div
            className="rounded-lg border-[1.5px] border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm leading-normal text-danger"
            role="alert"
          >
            {err}
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
          }}
        >
          {mode === 'signin' ? 'Need an account? Sign up' : 'Already registered? Sign in'}
        </Button>
      </form>
    </div>
  );
}
