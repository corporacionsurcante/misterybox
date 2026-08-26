import type { Metadata, Viewport } from 'next';
import Header from '@/components/Header';
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
      <body className="antialiased">
        <a
          href="#contenido"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:font-semibold focus:text-slate-900"
        >
          Ir al contenido
        </a>
        <Header />
        <div id="contenido">{children}</div>
      </body>
    </html>
  );
}
