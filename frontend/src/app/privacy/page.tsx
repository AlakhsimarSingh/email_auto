export const metadata = { title: 'Privacy Policy · Outreach Agent' };

const CONTACT = 'alakhsimar8@gmail.com';

const sections: Array<{ heading: string; body: React.ReactNode }> = [
  {
    heading: 'What this app is',
    body: 'Outreach Agent is a private, single-owner tool that helps one freelancer find small businesses, review their public websites, and send a small number of individually reviewed emails. It is not offered to the public; only allowlisted administrators can sign in.',
  },
  {
    heading: 'Google account data',
    body: (
      <>
        The owner connects one Gmail account using Google OAuth. The app uses that access only to send emails the owner has reviewed, to read replies in those email threads (to detect replies, bounces, and unsubscribe requests), and to label them. Google sign-in is used only to confirm an administrator&apos;s identity (email address and account ID). OAuth tokens are stored encrypted (AES-256-GCM) and are never shared. The app&apos;s use and transfer of information received from Google APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" style={{ color: '#7fd1a1' }}>Google API Services User Data Policy</a>, including the Limited Use requirements. Google user data is not sold, not used for advertising, and not used to train AI models.
      </>
    ),
  },
  {
    heading: 'Business contact data',
    body: 'Business information comes from public sources: OpenStreetMap, the business’s own website, and (for UK companies, when enabled) the Companies House register. Only business contact addresses published by the business are used. No purchased lists, no personal social-media scraping, and no open- or click-tracking pixels.',
  },
  {
    heading: 'Opting out',
    body: 'Every email includes a one-click unsubscribe link. Unsubscribes, complaints, and hard bounces are added to a permanent suppression list so the address is never contacted again. You can also reply asking to be removed, or write to the contact address below.',
  },
  {
    heading: 'Storage and retention',
    body: 'Data is stored in a private Postgres database (Supabase) and processed by the app’s backend (Render) and frontend (Vercel). Website screenshots are deleted after 30 days and in-app notifications after 180 days. Suppression records are kept indefinitely so that opt-outs are honoured. If an AI drafting provider is configured, only the minimum business facts needed to draft an email are sent to it.',
  },
  {
    heading: 'Your rights and contact',
    body: (
      <>
        To ask what data is held about you or your business, or to have it deleted, email <a href={`mailto:${CONTACT}`} style={{ color: '#7fd1a1' }}>{CONTACT}</a>. Deletion requests are handled promptly; your address is kept only on the suppression list so you are not contacted again.
      </>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <main style={{ minHeight: '100vh', background: '#0e1511', color: '#e6eee8', padding: '40px 16px' }}>
      <article style={{ width: 'min(720px, 100%)', margin: '0 auto', display: 'grid', gap: 22 }}>
        <header style={{ display: 'grid', gap: 8 }}>
          <div className="section-kicker">OUTREACH AGENT</div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>Privacy Policy</h1>
          <p style={{ margin: 0, color: '#91a096', fontSize: 13 }}>Last updated 15 October 2026</p>
        </header>
        {sections.map((section) => (
          <section key={section.heading} style={{ display: 'grid', gap: 6 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650 }}>{section.heading}</h2>
            <p style={{ margin: 0, color: '#b9c6bd', fontSize: 14, lineHeight: 1.7 }}>{section.body}</p>
          </section>
        ))}
      </article>
    </main>
  );
}
