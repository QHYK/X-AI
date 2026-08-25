/**
 * Dashboard 内部运维入口：后台重跑默认 Daily Workflow。
 *
 * 请求不接收命令或日期参数，避免该 endpoint 演变为任意服务器命令执行器。
 */
import { startDailyWorkflowRetry } from "@/lib/daily-workflow-retry.js";

export const runtime = "nodejs";

/** 启动固定的 `npm run daily`，或返回已有 Daily 正在运行的状态。 */
export async function POST(): Promise<Response> {
  const result = await startDailyWorkflowRetry();
  const status = result.status === "failed" ? 500 : 202;
  return Response.json(result, { status });
}
