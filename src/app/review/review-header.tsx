/** Human Review 页面共用的日期选择与内部导航。 */
import styles from "./review.module.css";

export function ReviewHeader(props: {
  title: string;
  description: string;
  dailyDate: string;
  action: string;
  active: "events" | "long-form";
}) {
  return (
    <>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>X-AI-field · Human Review v1</p>
          <h1>{props.title}</h1>
          <p>{props.description}</p>
        </div>
        <form action={props.action} className={styles.dateForm}>
          <label htmlFor="review-date">Daily date</label>
          <input id="review-date" name="date" type="date" defaultValue={props.dailyDate} />
          <button type="submit">View</button>
        </form>
      </header>
      <nav className={styles.nav} aria-label="Review navigation">
        <a className={props.active === "events" ? styles.active : undefined} href={`./events?date=${props.dailyDate}`}>Event Ranking</a>
        <a className={props.active === "long-form" ? styles.active : undefined} href={`./long-form?date=${props.dailyDate}`}>Long-form Ranking</a>
        <a href="../dashboard">Dashboard</a>
      </nav>
    </>
  );
}
