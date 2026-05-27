import type { Metadata } from "next";
import { Syne, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const syne = Syne({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME ?? "blooming insights",
  description: "blooming insights",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${syne.variable} ${inter.variable} ${jetbrainsMono.variable} ${inter.className} min-h-full flex flex-col antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
