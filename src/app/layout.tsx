/**
 * Next.js 根布局与全站基础元数据。
 *
 * 为应用页面提供统一的中文文档语言和全局样式入口。
 */
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
