export default function OfflinePage() {
  return (
    <main
      className="offline-page"
      style={{ display: 'grid', minHeight: '100vh', placeItems: 'center', background: '#0e1511', color: '#e6eee8', padding: 22 }}
    >
      <div
        className="offline-card"
        style={{ display: 'grid', justifyItems: 'start', width: 'min(440px, 100%)', gap: 14, border: '1px solid #29382f', borderRadius: 14, background: '#141d18', padding: 28 }}
      >
        <span className="brand-mark" style={{ marginBottom: 12 }}>E</span>
        <div className="section-kicker">OFFLINE MODE</div>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700 }}>You&apos;re offline</h1>
        <p style={{ margin: '0 0 7px', color: '#91a096', fontSize: 13, lineHeight: 1.6 }}>
          The private workspace needs a connection to load current data. Reconnect and try again.
        </p>
        <a className="approve-button" href="/" style={{ textDecoration: 'none' }}>Try again</a>
      </div>
    </main>
  );
}
