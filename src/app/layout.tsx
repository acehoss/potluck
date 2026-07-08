import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getSessionUser } from "@/server/auth";
import { db } from "@/server/db";
import "./globals.css";
import { AppHeader } from "./app-header";
import { FirstRunConsent } from "./first-run-consent";
import { NavTracker } from "./nav-history";
import { Providers } from "./providers";
import { PwaSetup } from "./pwa-setup";
import { TabBar } from "./tab-bar";
import { VerifyBanner } from "./verify-banner";

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

/**
 * Header data is resolved server-side from the acting session (REWORK P4/Round
 * D). It's static per full page load — switching household reloads (A3b) — so
 * the chip and Receive target stay correct without a client fetch; the live
 * bell badge is a client query in AppHeader. Null (signed out) → no header.
 */
async function headerData() {
  const user = await getSessionUser();
  if (!user) return null;
  const pantries = await db.pantry.findMany({
    where: { householdId: user.householdId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return {
    householdName: user.household.name,
    activeHouseholdId: user.householdId,
    memberships: user.memberships.map((m) => ({
      householdId: m.householdId,
      householdName: m.household.name,
    })),
    canReceive: user.activeMembership.receiveStock,
    canAdjust: user.activeMembership.adjustInventory,
    pantries,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const header = await headerData();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-dvh flex flex-col">
        <Providers>
          <PwaSetup />
          <NavTracker />
          <AppHeader data={header} />
          <VerifyBanner />
          {children}
          <TabBar />
          <FirstRunConsent />
        </Providers>
      </body>
    </html>
  );
}
