export function ComingSoonView({ label }: { label: string }) {
  return (
    <main className="main">
      <div className="session-pane-empty">
        <p><strong>{label}</strong> view is coming soon.</p>
      </div>
    </main>
  );
}
