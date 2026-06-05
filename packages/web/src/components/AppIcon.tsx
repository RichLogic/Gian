import { useState } from 'react';

/** A macOS application icon served by the host (`GET /api/apps/icon?name=`).
 *  Falls back to a neutral glyph square when the host can't extract one (404 —
 *  e.g. apps whose icon lives in an asset catalog, or non-macOS). */
export function AppIcon({ name, size = 16 }: { name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed || !name) {
    return <span className="app-icon app-icon-fallback" style={{ width: size, height: size }} aria-hidden />;
  }
  return (
    <img
      className="app-icon"
      style={{ width: size, height: size }}
      src={`/api/apps/icon?name=${encodeURIComponent(name)}`}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}
