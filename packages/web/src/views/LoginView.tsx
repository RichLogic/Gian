import { useState } from 'react';
import { login } from '../api.js';
import { useT } from '../i18n/index.js';

export function LoginView({ onLoginOk }: { onLoginOk: () => void }) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(username, password);
      if (result) {
        onLoginOk();
      } else {
        setError(t('login.error.invalid'));
      }
    } catch {
      setError(t('login.error.network'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1 className="login-brand">Gian</h1>
        <form className="login-form" onSubmit={e => void handleSubmit(e)}>
          <div className="login-field">
            <label className="login-label" htmlFor="username">{t('login.username.label')}</label>
            <input
              id="username"
              className="login-input"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={loading}
              required
            />
          </div>
          <div className="login-field">
            <label className="login-label" htmlFor="password">{t('login.password.label')}</label>
            <input
              id="password"
              className="login-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={loading}
              required
            />
          </div>
          {error && <p className="login-error">{error}</p>}
          <button className="login-submit" type="submit" disabled={loading}>
            {loading ? t('login.submitting') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
