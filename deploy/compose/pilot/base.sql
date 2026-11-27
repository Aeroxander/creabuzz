-- What the pilot commands (`./run.sh founders`, `due`, `daily`) read, as temporary views: they live only for the one
-- psql session that runs them and change nothing in the database. Read before them (run.sh puts this file first).
--
-- The rules mirror the app's own, so a number here is the number a founder's page shows:
--   * a project is a founder's newest project record (kind 37001, one per founder and short name);
--   * a project's records are the update records (kind 47003) that name it in an `a` tag, and a deleted record is
--     ignored, as it is in the app (packages/creaton-core/src/project/*.ts);
--   * a weekly update is one the founder signed that answers a prompt, makes or answers a promise, or carries the
--     dialog's own mark (`isWeeklyUpdateTags`, project/weekly-update.ts);
--   * a promise stands as `promiseRecord` (project/promises.ts) says: an answer counts only for a promise of an earlier
--     update, and when answers disagree the worse one is counted.
-- Needs: psql variables `exclude` (comma-separated hex keys whose projects are the operator's own: left out of every
-- number, because the pilot measures other people) and `asof` (the clock, in seconds since 1970).
-- Task acceptance is an approximation of the app's rule (lib/tasks.ts): a piece of evidence the task's helper handed in,
-- confirmed by the founder or a listed team member who is not the helper, and not sent back by the team. The page's own
-- reading decides in a dispute.

\set ON_ERROR_STOP on

create function pg_temp.tagv(tags jsonb, name text) returns text language sql immutable as
$$ select t ->> 1 from jsonb_array_elements(tags) t where t ->> 0 = name limit 1 $$;

create function pg_temp.hastag(tags jsonb, name text) returns boolean language sql immutable as
$$ select exists (select 1 from jsonb_array_elements(tags) t where t ->> 0 = name) $$;

-- A profile's name, or nothing when the profile is not readable as JSON.
create function pg_temp.profile_name(content text) returns text language plpgsql immutable as
$$ begin return btrim((content::jsonb) ->> 'name'); exception when others then return null; end $$;

create temp view pilot_projects as
select distinct on (e.community_id, e.pubkey, slug)
       e.community_id,
       e.pubkey,
       encode(e.pubkey, 'hex') as founder_hex,
       slug,
       '37001:' || encode(e.pubkey, 'hex') || ':' || slug as coord,
       coalesce(nullif(btrim(pg_temp.tagv(e.tags, 'name')), ''), slug) as name,
       e.created_at as record_at,
       e.tags
from events e
cross join lateral (select coalesce(e.d_tag, pg_temp.tagv(e.tags, 'd')) as slug) s
where e.kind = 37001
  and e.deleted_at is null
  and slug is not null
  and not (encode(e.pubkey, 'hex') = any (string_to_array(lower(:'exclude'), ',')))
order by e.community_id, e.pubkey, slug, e.created_at desc, e.id;

-- Every live update record that names a project.
create temp view pilot_recs as
select p.coord,
       p.founder_hex,
       encode(e.id, 'hex') as id_hex,
       encode(e.pubkey, 'hex') as author_hex,
       e.created_at,
       extract(epoch from e.created_at)::bigint as at,
       e.tags
from pilot_projects p
join events e
  on e.kind = 47003
 and e.deleted_at is null
 and e.community_id = p.community_id
 and e.tags @> jsonb_build_array(jsonb_build_array('a', p.coord));

-- The founder and the people the project's record lists as team: who may act for the project.
create temp view pilot_team as
select coord, founder_hex as member_hex from pilot_projects
union
select coord, t ->> 1 from pilot_projects, jsonb_array_elements(tags) t where t ->> 0 = 'team';

create temp view pilot_weekly as
select r.*,
       row_number() over (partition by r.coord order by r.created_at, r.id_hex) as n,
       r.at - lag(r.at) over (partition by r.coord order by r.created_at, r.id_hex) as gap_secs
from pilot_recs r
where r.author_hex = r.founder_hex
  and exists (
    select 1 from jsonb_array_elements(r.tags) t
    where t ->> 0 in ('update-part', 'promise', 'promise-mark') or (t ->> 0 = 'update-kind' and t ->> 1 = 'weekly'));

create temp view pilot_promises as
select distinct on (r.coord, r.id_hex, x.t ->> 1)
       r.coord, r.id_hex as uid, r.id_hex || ':' || (x.t ->> 1) as pid
from pilot_recs r
cross join lateral jsonb_array_elements(r.tags) with ordinality as x(t, ord)
where r.author_hex = r.founder_hex
  and x.t ->> 0 = 'promise'
  and x.t ->> 1 ~ '^[0-9]$'
  and btrim(coalesce(x.t ->> 2, '')) <> ''
order by r.coord, r.id_hex, x.t ->> 1, x.ord;

create temp view pilot_marks as
select distinct on (r.coord, r.id_hex, x.t ->> 1)
       r.coord, r.id_hex as uid, x.t ->> 1 as pid, x.t ->> 2 as state
from pilot_recs r
cross join lateral jsonb_array_elements(r.tags) with ordinality as x(t, ord)
where r.author_hex = r.founder_hex
  and x.t ->> 0 = 'promise-mark'
  and x.t ->> 1 ~ '^[0-9a-f]{64}:[0-9]{1,2}$'
  and x.t ->> 2 in ('done', 'not-done', 'changed')
order by r.coord, r.id_hex, x.t ->> 1, x.ord;

-- kept | missed | changed | unanswered (a later weekly update did not say) | waiting (no later weekly update yet)
create temp view pilot_promise_state as
select p.coord, p.pid,
       coalesce(
         (select case when bool_or(m.state = 'not-done') then 'missed'
                      when bool_or(m.state = 'changed') then 'changed'
                      when bool_or(m.state = 'done') then 'kept' end
            from pilot_marks m where m.coord = p.coord and m.pid = p.pid and m.uid <> p.uid),
         case when (select w.id_hex from pilot_weekly w where w.coord = p.coord order by w.n desc limit 1) <> p.uid
              then 'unanswered' else 'waiting' end) as state
from pilot_promises p;

-- A founder's help requests: weekly updates that carry a non-empty `help-needed` tag.
create temp view pilot_help_requests as
select w.coord, w.id_hex
from pilot_weekly w
where exists (select 1 from jsonb_array_elements(w.tags) t where t ->> 0 = 'help-needed' and btrim(coalesce(t ->> 1, '')) <> '');

-- One offer per person and request; the team's own offers are not offers.
create temp view pilot_offers as
select distinct r.coord, pg_temp.tagv(r.tags, 'help-offer') as request_id, r.author_hex
from pilot_recs r
join pilot_help_requests h on h.coord = r.coord and h.id_hex = pg_temp.tagv(r.tags, 'help-offer')
where not exists (select 1 from pilot_team t where t.coord = r.coord and t.member_hex = r.author_hex);

create temp view pilot_tasks as
select r.coord, r.id_hex
from pilot_recs r
where pg_temp.tagv(r.tags, 'task-part') = 'task'
  and exists (select 1 from pilot_team t where t.coord = r.coord and t.member_hex = r.author_hex);

create temp view pilot_tasks_accepted as
select t.coord, t.id_hex
from pilot_tasks t
join pilot_recs task on task.coord = t.coord and task.id_hex = t.id_hex
where exists (
  select 1
  from pilot_recs ev
  join pilot_recs c on c.coord = ev.coord and pg_temp.tagv(c.tags, 'task-evidence') = ev.id_hex
  where ev.coord = t.coord
    and pg_temp.tagv(ev.tags, 'task-part') = 'evidence'
    and pg_temp.tagv(ev.tags, 'task') = t.id_hex
    and ev.author_hex = pg_temp.tagv(task.tags, 'task-helper')
    and pg_temp.tagv(c.tags, 'task-part') = 'confirm'
    and pg_temp.tagv(c.tags, 'task') = t.id_hex
    and c.author_hex <> ev.author_hex
    and exists (select 1 from pilot_team m where m.coord = t.coord and m.member_hex = c.author_hex)
    and not exists (
      select 1 from pilot_recs s
      where s.coord = t.coord
        and pg_temp.tagv(s.tags, 'task-part') = 'send-back'
        and pg_temp.tagv(s.tags, 'task-evidence') = ev.id_hex
        and exists (select 1 from pilot_team m where m.coord = t.coord and m.member_hex = s.author_hex)));

-- One row per project: the numbers every command reads.
create temp view pilot_stats as
select p.coord,
       p.founder_hex,
       p.slug,
       p.name,
       coalesce(
         (select pg_temp.profile_name(e.content) from events e
           where e.kind = 0 and e.pubkey = p.pubkey and e.deleted_at is null
           order by e.created_at desc, e.id limit 1), '') as founder_name,
       -- When the project began: its first record by the founder, or its project record.
       least(
         extract(epoch from p.record_at)::bigint,
         coalesce((select min(r.at) from pilot_recs r where r.coord = p.coord and r.author_hex = p.founder_hex), 9e18::bigint)
       ) as began_at,
       (select count(*) from pilot_weekly w where w.coord = p.coord) as updates,
       (select max(w.at) from pilot_weekly w where w.coord = p.coord) as last_update_at,
       (select w.gap_secs from pilot_weekly w where w.coord = p.coord and w.n = 2) as gap2,
       (select w.gap_secs from pilot_weekly w where w.coord = p.coord and w.n = 3) as gap3,
       (select count(*) from pilot_promise_state s where s.coord = p.coord) as promises,
       (select count(*) from pilot_promise_state s where s.coord = p.coord and s.state = 'kept') as kept,
       (select count(*) from pilot_promise_state s where s.coord = p.coord and s.state = 'missed') as missed,
       (select count(*) from pilot_promise_state s where s.coord = p.coord and s.state = 'changed') as changed,
       (select count(*) from pilot_promise_state s where s.coord = p.coord and s.state = 'unanswered') as unanswered,
       (select count(*) from pilot_help_requests h where h.coord = p.coord) as help_requests,
       (select count(*) from pilot_offers o where o.coord = p.coord) as offers,
       (select count(*) from pilot_tasks k where k.coord = p.coord) as tasks,
       (select count(*) from pilot_tasks_accepted k where k.coord = p.coord) as tasks_accepted
from pilot_projects p;
