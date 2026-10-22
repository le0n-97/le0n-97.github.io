import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Squares Duel · 好词，先到先得",
  description: "一个棋盘，两队灵感。组队共享 4 × 4 字母棋盘，抢先发现英文单词，也可以加入旁观。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
