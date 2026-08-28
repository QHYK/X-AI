-- 修改 params 中的日期与两个 Provider / Model，汇总同一 Frozen Stage 2 input 的 merge 差异。
with params as (
  select
    '2026-08-28'::date as daily_date,
    'deepseek'::text as provider_a,
    'deepseek-v4-pro'::text as model_a,
    'kimi'::text as provider_b,
    'kimi-k3'::text as model_b
), runs as (
  select input.id as evaluation_input_id, run.provider, run.model, output.output_json
  from evaluation_inputs input
  join evaluation_runs run on run.evaluation_input_id = input.id and run.status = 'success'
  join evaluation_outputs output on output.evaluation_run_id = run.id and output.item_key is null
  join params on params.daily_date = input.daily_date
  where input.stage = 'stage2'
    and ((run.provider = params.provider_a and run.model = params.model_a)
      or (run.provider = params.provider_b and run.model = params.model_b))
)
select
  evaluation_input_id,
  provider,
  model,
  count(event.value) as event_group_count,
  count(event.value) filter (where jsonb_array_length(event.value->'sources') = 1) as singleton_count,
  coalesce(round(avg(jsonb_array_length(event.value->'sources'))::numeric, 2), 0) as average_group_size,
  coalesce(max(jsonb_array_length(event.value->'sources')), 0) as largest_group_size
from runs
left join lateral jsonb_array_elements(runs.output_json->'events') event on true
group by evaluation_input_id, provider, model
order by evaluation_input_id, provider, model;
