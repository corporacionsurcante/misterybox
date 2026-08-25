import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'MisteryBox — Cada compra tiene premio',
    template: '%s · MisteryBox',
  },
  description:
    'Comprá en tus tiendas favoritas desde MisteryBox y cada compra te desbloquea una caja sorpresa con premios reales.',
};

export const viewport: Viewport = {
  themeColor: '#020617',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <body className="antialiased">{children}</body>
    </html>
  );
}
