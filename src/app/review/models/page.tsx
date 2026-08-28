/** Model Evaluation 页面：选择离线评测 Stage/模型，并查看同一 Frozen Input 的人工差异。 */
import { getDatabasePool } from "@/db/index.js";
import { parseBriefDate } from "@/lib/brief-date.js";
import { resolveDailyScope } from "@/lib/daily-scope.js";
import { resolveEvaluationModels } from "@/lib/evaluation-model-config.js";
import { getEvaluationReviewData } from "@/lib/evaluation-review.js";
import { isEvaluationStage } from "@/lib/model-evaluation.js";
import { ModelEvaluationReview } from "../model-evaluation-review-client.js";
import { ReviewHeader } from "../review-header.js";
import styles from "../review.module.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ModelEvaluationPage(props: {
  searchParams: Promise<{ date?: string | string[]; stage?: string | string[] }>;
}) {
  const params = await props.searchParams;
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const rawStage = Array.isArray(params.stage) ? params.stage[0] : params.stage;
  const dailyDate = parseBriefDate(rawDate ?? "")?.date ?? resolveDailyScope(undefined).dailyDate;
  const stage = rawStage && isEvaluationStage(rawStage) ? rawStage : "stage1";
  const models = resolveEvaluationModels();
  const data = await getEvaluationReviewData(getDatabasePool(), dailyDate, stage);

  return (
    <main className={styles.page}>
      <ReviewHeader
        title="Model Evaluation"
        description="Human-triggered, isolated comparison of the same frozen Stage input."
        dailyDate={dailyDate}
        active="models"
        showDateControl={false}
      />
      <ModelEvaluationReview key={`${dailyDate}-${stage}`} data={data} models={models} />
    </main>
  );
}
