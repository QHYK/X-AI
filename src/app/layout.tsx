import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "X-AI-field",
  description: "AI-driven information filtering system",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
