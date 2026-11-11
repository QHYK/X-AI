import { NewsletterParser } from './newsletter-parser.js';
import styles from './newsletter-parser.module.css';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export default function NewsletterParserPage() {
  return (
    <main className={styles.page}>
      <header>
        <p>X-AI-field · Administration</p>
        <h1>Newsletter Parser</h1>
        <p>
          检查数据库已采集邮件并下载人工标注；不修改采集内容或
          Pipeline。邮件预览禁用脚本和远程资源。
        </p>
      </header>
      <NewsletterParser />
    </main>
  );
}
