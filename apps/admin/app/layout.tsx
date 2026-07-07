import "./globals.css";
import Link from "next/link";
import { TokenBar } from "./token-bar";

export const metadata = { title: "知行·管理后台" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <nav>
          <strong>知行后台</strong>
          <Link href="/places">地点库</Link>
          <Link href="/cards">风物卡</Link>
          <Link href="/search-misses">搜索缺失</Link>
          <TokenBar />
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
