import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Outreach Agent',
    short_name: 'Outreach',
    description: 'Private outreach workspace',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0e1511',
    theme_color: '#0e1511',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
