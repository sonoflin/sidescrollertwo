import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "Riftbound Arena";
  const description = "Race, power up, and break your rival in a best-of-three online convergence duel.";
  return {
    title,
    description,
    icons: { icon: "/assets/characters/astra.png" },
    openGraph: { title, description, type: "website", url: origin, images: [{ url: `${origin}/og.png`, width: 1672, height: 939, alt: "Riftbound Arena — Two Paths. One Core." }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
