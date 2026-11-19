-- =============================================================================
-- 0034_quiz_stable_choice_ids.sql
-- A shuffled quiz that can actually be graded.
--
-- app.training_quiz shuffles the choices per courier, so that answering by
-- position — or passing around "it's always the third one" — does not work.
-- But app.grade_training compared the submitted INDEX against correct_index
-- in the unshuffled array. The two disagreed by construction, so a courier
-- answering every question correctly still failed. The mandatory training was
-- impossible to pass.
--
-- The fix keeps the shuffle and makes the identity of a choice independent of
-- where it is shown: each choice carries its ORIGINAL index as a stable id.
-- The display order changes per courier, the id does not, and grading
-- compares ids. The client still cannot tell which id is correct, because the
-- ids are shuffled along with the labels.
-- =============================================================================

create or replace function app.training_quiz(p_seed integer default null)
returns table (question_id uuid, topic text, prompt text, choices jsonb)
language sql
stable
security definer
set search_path = public, app
as $$
  select q.id, q.topic, q.prompt,
         (select jsonb_agg(
                   jsonb_build_object('id', c.ordinality - 1, 'label', c.value)
                   order by md5(c.value::text || coalesce(p_seed, 0)::text))
            from jsonb_array_elements_text(q.choices) with ordinality as c(value, ordinality))
    from training_questions q
   where q.active
   order by q.display_rank, q.id;
$$;

comment on function app.training_quiz is
  'Spec 7.2: the questions without the answer key. Each choice carries its '
  'original index as a stable id, so the display order can be shuffled per '
  'courier while grading still works. The answer key stays server-side.';
