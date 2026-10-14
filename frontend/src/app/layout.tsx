import './globals.css';
import AppShell from './app-shell';
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
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
      </head>
      <body><ServiceWorkerRegistration /><AppShell>{children}</AppShell></body>
    </html>
  );
}
