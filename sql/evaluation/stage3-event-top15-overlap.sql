-- 修改 params 中的日期与两个 Provider / Model，比较同一 Frozen Event input 的 Top 15。
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
), ranked as (
  select evaluation_input_id, 'a'::text as model_side, id, rank
  from paired cross join lateral jsonb_array_elements_text(output_a->'ordered_ids') with ordinality row(id, rank)
  union all
  select evaluation_input_id, 'b'::text, id, rank
  from paired cross join lateral jsonb_array_elements_text(output_b->'ordered_ids') with ordinality row(id, rank)
), top15 as (
  select * from ranked where rank <= 15
), overlap as (
  select evaluation_input_id, id from top15 group by evaluation_input_id, id having count(*) = 2
)
select
  paired.evaluation_input_id,
  (select count(*) from overlap where overlap.evaluation_input_id = paired.evaluation_input_id) as intersection_count,
  round((select count(*) from overlap where overlap.evaluation_input_id = paired.evaluation_input_id)::numeric / 15, 3) as overlap_ratio,
  coalesce((select array_agg(id order by id) from top15 where evaluation_input_id = paired.evaluation_input_id and model_side = 'a' and id not in (select id from overlap where evaluation_input_id = paired.evaluation_input_id)), '{}') as only_in_model_a,
  coalesce((select array_agg(id order by id) from top15 where evaluation_input_id = paired.evaluation_input_id and model_side = 'b' and id not in (select id from overlap where evaluation_input_id = paired.evaluation_input_id)), '{}') as only_in_model_b
from paired;
