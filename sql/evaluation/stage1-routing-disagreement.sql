-- 修改 params 中的日期与两个 Provider / Model，比较同一 evaluation_input 的 Stage 1 routing。
with params as (
  select
    '2026-08-28'::date as daily_date,
    'deepseek'::text as provider_a,
    'deepseek-v4-pro'::text as model_a,
    'kimi'::text as provider_b,
    'kimi-k3'::text as model_b
), paired_runs as (
  select
    input.id as evaluation_input_id,
    run_a.id as run_a_id,
    run_b.id as run_b_id,
    input.input_json
  from evaluation_inputs input
  join params on params.daily_date = input.daily_date
  join evaluation_runs run_a on run_a.evaluation_input_id = input.id
    and run_a.provider = params.provider_a and run_a.model = params.model_a and run_a.status = 'success'
  join evaluation_runs run_b on run_b.evaluation_input_id = input.id
    and run_b.provider = params.provider_b and run_b.model = params.model_b and run_b.status = 'success'
  where input.stage = 'stage1'
)
select
  paired_runs.evaluation_input_id,
  article.value->>'temp_id' as temp_id,
  batch.value->'raw_article_ids'->>((article.ordinality - 1)::int) as raw_article_id,
  result_a.value->>'routing' as model_a_routing,
  result_b.value->>'routing' as model_b_routing,
  result_a.value->>'category' as model_a_category,
  result_b.value->>'category' as model_b_category,
  result_a.value->'generated_content'->>'title_zh' as model_a_title_zh,
  result_b.value->'generated_content'->>'title_zh' as model_b_title_zh,
  result_a.value->'generated_content'->>'summary_zh' as model_a_summary_zh,
  result_b.value->'generated_content'->>'summary_zh' as model_b_summary_zh
from paired_runs
join evaluation_outputs output_a on output_a.evaluation_run_id = paired_runs.run_a_id
join evaluation_outputs output_b on output_b.evaluation_run_id = paired_runs.run_b_id
  and output_b.item_key = output_a.item_key
cross join lateral jsonb_array_elements(paired_runs.input_json->'batches') batch
cross join lateral jsonb_array_elements(batch.value->'input'->'articles') with ordinality article(value, ordinality)
cross join lateral jsonb_array_elements(output_a.output_json->'results') result_a
cross join lateral jsonb_array_elements(output_b.output_json->'results') result_b
where output_a.item_key = batch.value->>'item_key'
  and result_a.value->>'temp_id' = article.value->>'temp_id'
  and result_b.value->>'temp_id' = article.value->>'temp_id'
  and result_a.value->>'routing' is distinct from result_b.value->>'routing'
order by paired_runs.evaluation_input_id, raw_article_id;
