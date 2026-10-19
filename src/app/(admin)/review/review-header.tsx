/** Human Review 页面共用的标题、说明与日期选择。 */
import styles from './review.module.css';

export function ReviewHeader(props: {
  title: string;
  description: string;
  dailyDate: string;
  action?: string;
  showDateControl?: boolean;
}) {
  return (
    <>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>X-AI-field · Human Review v1</p>
          <h1>{props.title}</h1>
          <p>{props.description}</p>
        </div>
        {props.showDateControl !== false ? (
          <form
            action={props.action}
            className={styles.dateForm}
          >
            <label htmlFor="review-date">Daily date</label>
            <input
              id="review-date"
              name="date"
              type="date"
              defaultValue={props.dailyDate}
            />
            <button type="submit">View</button>
          </form>
        ) : null}
      </header>
    </>
  );
}
