import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { PwaSetup } from "./pwa-setup";
import { TabBar } from "./tab-bar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Potluck",
  description: "Share your pantry with people you trust, at cost.",
  // iOS installed-PWA chrome (blueprint 04 §4). The apple-touch-icon is a
  // committed PNG in public/ (regenerate via scripts/generate-icons.ts).
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Potluck",
  },
  icons: {
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  // viewport-fit=cover so standalone mode paints under the iOS notch; the
  // body/tab-bar take env(safe-area-inset-*) padding (globals.css, tab-bar).
  viewportFit: "cover",
  // Browser chrome follows the active scheme; the manifest's single
  // theme_color only drives the install splash (stone-900 per blueprint 02).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1917" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>
          <PwaSetup />
          {children}
          <TabBar />
        </Providers>
      </body>
    </html>
  );
}
