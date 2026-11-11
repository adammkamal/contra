import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Contra: back-charges that reach the bill",
  description: "A hackathon concept for Ramp Bill Pay. Every Ramp screen is simulated.",
};

/** The document only. The screens' rail and presenter bar are app/(app)/layout.tsx; /login has neither. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preload" href="/fonts/InstrumentSans.woff" as="font" type="font/woff" crossOrigin="anonymous" />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to the screen
        </a>
        {children}
      </body>
    </html>
  );
}
