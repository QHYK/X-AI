'use client';

import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setPending(true);
    const form = event.currentTarget;
    const password = new FormData(form).get('password');
    try {
      const response = await fetch('./api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) throw new Error('登录失败，请检查密码后重试。');
      // A full navigation ensures the server checks the newly issued Session Cookie.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('./dashboard');
    } catch {
      setError('登录失败，请检查密码后重试。');
      setPending(false);
    }
  }

  return (
    <main className="shell">
      <section className="intro">
        <h1>管理员登录</h1>
        <form onSubmit={submit}>
          <label htmlFor="admin-password">密码</label>
          <input
            id="admin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <button
            type="submit"
            disabled={pending}
          >
            登录
          </button>
        </form>
        {error ? <p role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
