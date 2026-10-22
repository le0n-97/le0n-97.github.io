import { Grid2X2, LockKeyhole } from "lucide-react";
import "@/app/word-statistics.css";

type WordCountStat = { total: number; found: number; remaining: number };
export type WordStats = {
  byLength: (WordCountStat & { length: number })[];
  byInitial?: (WordCountStat & { letter: string })[];
  hintsUnlocked: boolean;
  unlockAt: number;
  found: number;
  total: number;
};

export function WordStatistics({ stats }: { stats?: WordStats | null }) {
  if (!stats?.byLength.length) return null;
  const needed = Math.max(0, stats.unlockAt - stats.found);
  return <section className="word-statistics" aria-label="本局普通计分词数量提示">
    <div className="word-statistics-heading"><h3>词数提示</h3><span>双方合计 · 不含 Bonus</span></div>
    <ul className="word-length-statistics" aria-label="按单词长度统计">
      {stats.byLength.map((item) => <li key={item.length} className={item.remaining === 0 ? "word-stat-complete" : ""} aria-label={`${item.length} 个字母：已找到 ${item.found} 个，共 ${item.total} 个，剩余 ${item.remaining} 个`}>
        <span className="word-stat-label">{item.length} 字母</span>
        <span className="word-stat-count"><strong>{item.found}</strong><span> / {item.total}</span></span>
        <span className="word-stat-remaining">剩余 {item.remaining} 个</span>
      </li>)}
    </ul>
    <p className="word-statistics-caption">上方数字为已找到 / 总数</p>
    {stats.hintsUnlocked ? <div className="word-board-hints"><Grid2X2 size={16} aria-hidden="true" /><div><p><strong>首格提示已显示在棋盘</strong><span className="word-hints-unlocked">已解锁</span></p><p>每格右上角数字：剩余多少个计分词的标准连法从此格开始。每词只计一次。</p></div></div> : <p className="word-hints-locked"><LockKeyhole size={14} aria-hidden="true" /><span>双方再找 <strong>{needed}</strong> 个普通计分词后，棋盘显示首格提示</span></p>}
    <p className="word-tile-caption">灰格不再用于剩余普通词的标准连法，仍可划选 Bonus 或其他合法连法。</p>
  </section>;
}

export default WordStatistics;
