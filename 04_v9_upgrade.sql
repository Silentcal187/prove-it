-- Prove It Version 9 Upgrade
-- Run this once in Supabase SQL Editor after the original schema.
-- Adds automatic final verdicts, source-domain scoring, profile/clout helpers, and moderator review functions.

create extension if not exists pgcrypto;

-- Source-domain support. Existing projects may already have source_ratings, so add columns safely.
alter table public.source_ratings add column if not exists source_domain text;
alter table public.source_ratings add column if not exists base_weight numeric(4,2) default 0.30 check (base_weight >= 0 and base_weight <= 1);

-- One rating per domain. Postgres allows multiple NULL values in a unique constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'source_ratings_source_domain_key'
  ) then
    alter table public.source_ratings
      add constraint source_ratings_source_domain_key unique (source_domain);
  end if;
end;
$$;

alter table public.evidence add column if not exists source_domain text;

create or replace function public.extract_domain(source_url text)
returns text as $$
declare
  cleaned text;
begin
  if source_url is null or length(trim(source_url)) = 0 then
    return null;
  end if;
  cleaned := lower(trim(source_url));
  cleaned := regexp_replace(cleaned, '^https?://', '');
  cleaned := regexp_replace(cleaned, '^www\.', '');
  cleaned := split_part(cleaned, '/', 1);
  cleaned := split_part(cleaned, '?', 1);
  if cleaned = '' then
    return null;
  end if;
  return cleaned;
end;
$$ language plpgsql immutable;

create or replace function public.credibility_base_weight(level text)
returns numeric as $$
select case
  when level = 'very_high' then 1.00
  when level = 'high' then 0.85
  when level = 'medium' then 0.60
  when level = 'low' then 0.30
  when level = 'very_low' then 0.10
  else 0.30
end;
$$ language sql immutable;

create or replace function public.calculate_evidence_weight_v9(p_source_type text, p_ai_status text, p_source_url text)
returns numeric as $$
declare
  domain text;
  domain_level text;
  domain_weight numeric := 0.30;
  type_weight numeric := 0.30;
  ai_multiplier numeric := 1.00;
  final_weight numeric;
begin
  domain := public.extract_domain(p_source_url);

  select credibility_level into domain_level
  from public.source_ratings
  where source_domain = domain
  order by created_at desc
  limit 1;

  domain_weight := public.credibility_base_weight(coalesce(domain_level, 'unknown'));

  type_weight := case
    when p_source_type in ('peer_reviewed_study', 'university_study', 'government_report', 'official_data') then 0.95
    when p_source_type = 'court_record' then 0.90
    when p_source_type in ('recognized_news', 'expert_article') then 0.70
    when p_source_type = 'personal_experience' then 0.25
    when p_source_type in ('social_media', 'hearsay') then 0.10
    else 0.30
  end;

  ai_multiplier := case
    when p_ai_status = 'verified_strong' then 1.00
    when p_ai_status = 'verified_supporting' then 0.85
    when p_ai_status = 'context_only' then 0.55
    when p_ai_status = 'weak' then 0.20
    when p_ai_status = 'rejected' then 0.00
    else 0.50
  end;

  final_weight := greatest(type_weight, domain_weight) * ai_multiplier;
  return round(least(greatest(final_weight, 0), 1), 2);
end;
$$ language plpgsql stable;

create or replace function public.apply_evidence_scoring(target_evidence_id uuid)
returns void as $$
declare
  ev record;
  new_weight numeric;
  allowed boolean;
begin
  select * into ev from public.evidence where id = target_evidence_id;
  if not found then
    return;
  end if;

  new_weight := public.calculate_evidence_weight_v9(ev.source_type, ev.ai_review_status, ev.source_url);
  allowed := not (ev.ai_review_status = 'rejected' or new_weight = 0 or ev.source_type = 'hearsay');

  update public.evidence
  set source_domain = public.extract_domain(ev.source_url),
      evidence_weight = new_weight,
      is_allowed_as_evidence = allowed,
      updated_at = now()
  where id = target_evidence_id;
end;
$$ language plpgsql security definer;

-- Recalculate all current evidence after adding source-domain scoring.
create or replace function public.rescore_all_evidence()
returns void as $$
declare
  ev record;
begin
  for ev in select id from public.evidence loop
    perform public.apply_evidence_scoring(ev.id);
  end loop;
end;
$$ language plpgsql security definer;

-- Popularity shortens open voting windows as activity rises.
create or replace function public.refresh_claim_popularity(target_claim_id uuid)
returns void as $$
declare
  activity_count integer;
  new_level text;
  proposed_close timestamptz;
  current_status text;
begin
  select
    (select count(*) from public.claim_votes where claim_id = target_claim_id) +
    (select count(*) from public.evidence where claim_id = target_claim_id) +
    (select count(*) from public.comments where claim_id = target_claim_id)
  into activity_count;

  select status into current_status from public.claims where id = target_claim_id;

  if activity_count >= 50 then
    new_level := 'trending';
    proposed_close := now() + interval '48 hours';
  elsif activity_count >= 20 then
    new_level := 'high';
    proposed_close := now() + interval '3 days';
  elsif activity_count >= 8 then
    new_level := 'medium';
    proposed_close := now() + interval '7 days';
  else
    new_level := 'new';
    proposed_close := null;
  end if;

  update public.claims
  set popularity_level = new_level,
      voting_closes_at = case
        when current_status in ('open', 'under_reassessment', 'additional_evidence_required')
          and proposed_close is not null
          and voting_closes_at > proposed_close
        then proposed_close
        else voting_closes_at
      end,
      updated_at = now()
  where id = target_claim_id;
end;
$$ language plpgsql security definer;

-- Automatic final verdict calculation. Runs only when the voting window has ended.
create or replace function public.calculate_final_verdict(target_claim_id uuid)
returns text as $$
declare
  claim_record record;
  agree_weight numeric := 0;
  disagree_weight numeric := 0;
  needs_weight numeric := 0;
  total_weight numeric := 0;
  agree_pct numeric := 0;
  disagree_pct numeric := 0;
  support_score numeric := 0;
  oppose_score numeric := 0;
  context_score numeric := 0;
  vote_count integer := 0;
  new_status text;
  basis text;
begin
  select * into claim_record from public.claims where id = target_claim_id;
  if not found then
    return 'claim_not_found';
  end if;

  if claim_record.voting_closes_at > now() then
    return 'voting_window_still_open';
  end if;

  select
    coalesce(sum(vote_weight) filter (where vote = 'agree'), 0),
    coalesce(sum(vote_weight) filter (where vote = 'disagree'), 0),
    coalesce(sum(vote_weight) filter (where vote = 'needs_evidence'), 0),
    count(*)
  into agree_weight, disagree_weight, needs_weight, vote_count
  from public.claim_votes
  where claim_id = target_claim_id;

  total_weight := agree_weight + disagree_weight + needs_weight;
  if total_weight > 0 then
    agree_pct := agree_weight / total_weight;
    disagree_pct := disagree_weight / total_weight;
  end if;

  select
    coalesce(sum(evidence_weight) filter (where stance = 'supports' and is_allowed_as_evidence), 0),
    coalesce(sum(evidence_weight) filter (where stance = 'disproves' and is_allowed_as_evidence), 0),
    coalesce(sum(evidence_weight) filter (where stance = 'context' and is_allowed_as_evidence), 0)
  into support_score, oppose_score, context_score
  from public.evidence
  where claim_id = target_claim_id;

  if vote_count < 3 then
    new_status := 'additional_evidence_required';
  elsif agree_pct >= 0.60 and support_score >= 1.00 and support_score > oppose_score then
    new_status := 'proven_with_evidence';
  elsif disagree_pct >= 0.60 and oppose_score >= 1.00 and oppose_score > support_score then
    new_status := 'disproven_with_evidence';
  else
    new_status := 'additional_evidence_required';
  end if;

  basis := 'Votes: agree ' || round(agree_pct * 100, 1) || '%, disagree ' || round(disagree_pct * 100, 1) || '%. Evidence scores: support ' || round(support_score, 2) || ', oppose ' || round(oppose_score, 2) || ', context ' || round(context_score, 2) || '. Based on current cited evidence and public vote.';

  update public.claims
  set status = new_status,
      final_verdict_basis = basis,
      updated_at = now()
  where id = target_claim_id;

  return new_status;
end;
$$ language plpgsql security definer;

-- Moderator/admin convenience function for testing or manually closing a claim.
create or replace function public.close_and_calculate_claim(target_claim_id uuid)
returns text as $$
declare
  user_role text;
begin
  select role into user_role from public.profiles where id = auth.uid();
  if user_role not in ('moderator', 'admin') then
    raise exception 'moderator_or_admin_required';
  end if;

  update public.claims
  set voting_closes_at = now() - interval '1 second',
      updated_at = now()
  where id = target_claim_id;

  return public.calculate_final_verdict(target_claim_id);
end;
$$ language plpgsql security definer;

-- Comment clout and cooldown. Runs after comment votes.
create or replace function public.run_comment_clout(target_comment_id uuid)
returns void as $$
declare
  cm record;
  agree_votes integer;
  disagree_votes integer;
  total_votes integer;
begin
  select * into cm from public.comments where id = target_comment_id;
  if not found then
    return;
  end if;

  select
    count(*) filter (where vote = 'agree'),
    count(*) filter (where vote = 'disagree'),
    count(*)
  into agree_votes, disagree_votes, total_votes
  from public.comment_votes
  where comment_id = target_comment_id;

  if total_votes < 3 or cm.clout_awarded <> 0 then
    update public.comments
    set vote_status = case when total_votes < 3 then 'needs_more_votes' else vote_status end,
        updated_at = now()
    where id = target_comment_id;
    return;
  end if;

  if agree_votes > disagree_votes then
    update public.comments
    set vote_status = 'agreed', clout_awarded = 10, updated_at = now()
    where id = target_comment_id;

    update public.profiles
    set clout = clout + 10, updated_at = now()
    where id = cm.user_id;
  else
    update public.comments
    set vote_status = 'disagreed', clout_awarded = -5, updated_at = now()
    where id = target_comment_id;

    update public.profiles
    set clout = clout - 5,
        comment_cooldown_until = now() + interval '12 hours',
        updated_at = now()
    where id = cm.user_id;
  end if;
end;
$$ language plpgsql security definer;

-- Update source_ratings policy if needed. Existing moderator policy still applies.
grant execute on function public.apply_evidence_scoring(uuid) to authenticated;
grant execute on function public.rescore_all_evidence() to authenticated;
grant execute on function public.refresh_claim_popularity(uuid) to authenticated;
grant execute on function public.calculate_final_verdict(uuid) to authenticated;
grant execute on function public.close_and_calculate_claim(uuid) to authenticated;
grant execute on function public.run_comment_clout(uuid) to authenticated;

-- Recommended starter source-domain ratings. Adjust later in the moderator dashboard.
insert into public.source_ratings (source_name, source_domain, credibility_level, base_weight, notes)
values
  ('Government of Canada', 'canada.ca', 'very_high', 1.00, 'Official government source.'),
  ('Statistics Canada', 'statcan.gc.ca', 'very_high', 1.00, 'Official Canadian statistical data.'),
  ('Nature', 'nature.com', 'very_high', 1.00, 'Peer-reviewed scientific publisher.'),
  ('PubMed', 'pubmed.ncbi.nlm.nih.gov', 'very_high', 1.00, 'Biomedical research index.'),
  ('Reuters', 'reuters.com', 'high', 0.85, 'Established wire/news source.'),
  ('Associated Press', 'apnews.com', 'high', 0.85, 'Established wire/news source.'),
  ('Wikipedia', 'wikipedia.org', 'medium', 0.60, 'Useful context but not primary evidence.'),
  ('Facebook', 'facebook.com', 'very_low', 0.10, 'Social media source. Discussion only unless backed elsewhere.'),
  ('X / Twitter', 'x.com', 'very_low', 0.10, 'Social media source. Discussion only unless backed elsewhere.'),
  ('TikTok', 'tiktok.com', 'very_low', 0.10, 'Social media source. Discussion only unless backed elsewhere.')
on conflict do nothing;

select public.rescore_all_evidence();
