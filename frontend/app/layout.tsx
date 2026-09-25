import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { AppToaster } from "@/components/AppToaster";
import { OfflineBanner } from "@/components/OfflineBanner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

const SHARE_TITLE = "SupportMe — Get Tipped. Get Paid.";
const SHARE_DESCRIPTION =
  "A tipping platform built on Stellar. Supporters send XLM or USDC, you cash out to your bank.";

export const metadata: Metadata = {
  // Makes the generated og/twitter image URLs absolute, which X and other
  // crawlers require.
  metadataBase: new URL(SITE_URL),
  title: "Support Me",
  description: "Support your favorite Creator",
  applicationName: "SupportMe",
  // app/favicon.ico and app/manifest.ts are linked automatically; these add
  // the PNG sizes browsers prefer plus the iOS home-screen icon.
  icons: {
    icon: [
      { url: "/icons/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-48x48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "SupportMe",
    statusBarStyle: "default",
  },
  // og:image / twitter:image come from app/opengraph-image.tsx and
  // app/twitter-image.tsx.
  openGraph: {
    title: SHARE_TITLE,
    description: SHARE_DESCRIPTION,
    type: "website",
    siteName: "SupportMe",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: SHARE_TITLE,
    description: SHARE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#ffd84d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <OfflineBanner />
        <AuthProvider>
          {children}
        </AuthProvider>
        <AppToaster />
      </body>
    </html>
  );
}

