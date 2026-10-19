'use client';

import { useState } from 'react';

export function AdminLogoutButton({ apiUrl, loginUrl }: { apiUrl: string; loginUrl: string }) {
  const [pending, setPending] = useState(false);
  async function logout() {
    setPending(true);
    try {
      const response = await fetch(apiUrl, { method: 'POST' });
      if (!response.ok) throw new Error('Logout failed.');
      window.location.assign(loginUrl);
    } catch {
      setPending(false);
    }
  }
  return (
    <button
      type="button"
      onClick={logout}
      disabled={pending}
    >
      退出登录
    </button>
  );
}
