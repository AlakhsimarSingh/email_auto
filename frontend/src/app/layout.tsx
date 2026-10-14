import './globals.css';
import ServiceWorkerRegistration from './service-worker-registration';

export const metadata = {
  title: 'Outreach Agent',
  description: 'Private outreach workspace',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Outreach' },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
      <body><ServiceWorkerRegistration />{children}</body>
    </html>
  );
}
