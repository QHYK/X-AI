-- 修改日期即可观察所有 Evaluation runs；token 字段为 NULL 表示当前 Provider 调用层没有可用数据。
select
  input.daily_date,
  input.stage,
  run.provider,
  run.model,
  run.status,
  run.duration_ms,
  run.input_tokens,
  run.output_tokens,
  run.error,
  run.started_at,
  run.completed_at
from evaluation_runs run
join evaluation_inputs input on input.id = run.evaluation_input_id
where input.daily_date = '2026-08-28'::date
order by input.stage, run.started_at, run.provider, run.model;
