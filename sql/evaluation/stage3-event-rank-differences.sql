-- 修改 params 中的日期与两个 Provider / Model；Event ID 来自 Frozen Stage 3 input，不做 fuzzy match。
with params as (
  select
    '2026-08-28'::date as daily_date,
    'deepseek'::text as provider_a,
    'deepseek-v4-pro'::text as model_a,
    'kimi'::text as provider_b,
    'kimi-k3'::text as model_b
), paired as (
  select input.id as evaluation_input_id, output_a.output_json as output_a, output_b.output_json as output_b
  from evaluation_inputs input
  join params on params.daily_date = input.daily_date
  join evaluation_runs run_a on run_a.evaluation_input_id = input.id and run_a.provider = params.provider_a and run_a.model = params.model_a and run_a.status = 'success'
  join evaluation_runs run_b on run_b.evaluation_input_id = input.id and run_b.provider = params.provider_b and run_b.model = params.model_b and run_b.status = 'success'
  join evaluation_outputs output_a on output_a.evaluation_run_id = run_a.id and output_a.item_key is null
  join evaluation_outputs output_b on output_b.evaluation_run_id = run_b.id and output_b.item_key is null
  where input.stage = 'stage3_event'
), ranks_a as (
  select evaluation_input_id, id, rank from paired cross join lateral jsonb_array_elements_text(output_a->'ordered_ids') with ordinality row(id, rank)
), ranks_b as (
  select evaluation_input_id, id, rank from paired cross join lateral jsonb_array_elements_text(output_b->'ordered_ids') with ordinality row(id, rank)
)
select
  ranks_a.evaluation_input_id,
  ranks_a.id as event_id,
  ranks_a.rank as model_a_rank,
  ranks_b.rank as model_b_rank,
  abs(ranks_a.rank - ranks_b.rank) as absolute_rank_difference
from ranks_a
join ranks_b using (evaluation_input_id, id)
order by absolute_rank_difference desc, event_id;
