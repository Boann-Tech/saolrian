import { useState } from 'react';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import './auth.css';

/** Sign-up / sign-in against the PocketBase 'users' collection. */

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
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <span className="auth-mark">S</span>
        <h1>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>

        <label className="field">
          <span className="field-label">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {err && (
          <div className="auth-err" role="alert">
            {err}
          </div>
        )}

        <button className="btn btn-primary btn-md" type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setErr('');
          }}
        >
          {mode === 'signin' ? 'Need an account? Sign up' : 'Already registered? Sign in'}
        </button>
      </form>
    </div>
  );
}
