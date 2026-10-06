'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/ui';
import { ShieldIcon } from '@/components/icons';

function safeNext(next: string | null): string {
  // Only same-site relative paths (no open redirect via //evil.example or /\evil).
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

function LoginForm() {
  const params = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: { username: username.trim(), password } });
      window.location.assign(safeNext(params.get('next')));
    } catch (err) {
      const e = err as ApiError;
      setError(e.status === 401 ? 'Incorrect username or password.' : e.message);
      setPassword('');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="w-full max-w-sm rounded-md border border-border bg-surface p-8 shadow-[var(--shadow-2)]">
      <div className="mb-6 flex items-center gap-2">
        <ShieldIcon className="h-6 w-6 text-primary" />
        <h1 className="type-h1">AgentGuard</h1>
      </div>
      <p className="mb-6 text-muted">Sign in to review agent activity.</p>
      <label htmlFor="username" className="type-label mb-1 block">
        Username
      </label>
      <input
        id="username"
        name="username"
        autoComplete="username"
        value={username}
        disabled={loading}
        onChange={(e) => setUsername(e.target.value)}
        aria-invalid={Boolean(error)}
        className={`mb-4 h-10 w-full rounded-sm border bg-bg px-3 text-text outline-none focus:ring-2 focus:ring-primary disabled:opacity-40 ${error ? 'border-error' : 'border-border'}`}
      />
      <label htmlFor="password" className="type-label mb-1 block">
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        disabled={loading}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'login-error' : undefined}
        className={`h-10 w-full rounded-sm border bg-bg px-3 text-text outline-none focus:ring-2 focus:ring-primary disabled:opacity-40 ${error ? 'border-error' : 'border-border'}`}
      />
      <div aria-live="assertive" className="min-h-6 pt-2">
        {error && (
          <p id="login-error" className="text-error">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" loading={loading} className="mt-2 w-full">
        Log in
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
