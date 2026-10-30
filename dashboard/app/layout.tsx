import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Crumbs: to get the bread, you need to eat the crumbs',
  description: 'An autonomous Solana agent that earns the small keeper rewards big bots ignore. Every action is simulated first, inside hard spending limits, and verifiable on-chain.',
  openGraph: { images: ['/api/card'] },
  twitter: { card: 'summary_large_image', images: ['/api/card'] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
