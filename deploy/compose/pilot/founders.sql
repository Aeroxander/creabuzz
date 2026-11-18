-- ./run.sh founders: one row per founder's project, for the question the pilot asks (DIRECTION.md): do founders post a
-- second and a third weekly update without being asked? Variables: asof, late_days, summary (on/off). base.sql is read first.
--
-- update_2 and update_3 say how long after the one before each came, and "after late flag" when it came more than
-- late_days days later, which is when the project was on `./run.sh due` and the owner may have nudged. Record times are the
-- ones the founders' own records carry.

select coalesce(nullif(s.founder_name, ''), left(s.founder_hex, 8)) as founder,
       s.name as project,
       ((:asof - s.began_at) / 86400)::int as days_live,
       s.updates,
       (select count(distinct ((w.at - s.began_at) / 604800)) from pilot_weekly w where w.coord = s.coord)
         || ' of ' || greatest(1, ceil((:asof - s.began_at) / 604800.0))::int as weeks_posted,
       round(s.updates / greatest(1, ceil((:asof - s.began_at) / 604800.0)), 1) as per_week,
       case
         when s.updates >= 2 then '+' || round(s.gap2 / 86400.0)::int || 'd'
              || case when s.gap2 > :late_days * 86400 then ' after late flag' else '' end
         when s.updates = 1 and :asof - s.last_update_at > :late_days * 86400
           then 'late: ' || ((:asof - s.last_update_at) / 86400)::int || 'd so far'
         else 'not yet' end as update_2,
       case
         when s.updates >= 3 then '+' || round(s.gap3 / 86400.0)::int || 'd'
              || case when s.gap3 > :late_days * 86400 then ' after late flag' else '' end
         when s.updates = 2 and :asof - s.last_update_at > :late_days * 86400
           then 'late: ' || ((:asof - s.last_update_at) / 86400)::int || 'd so far'
         else 'not yet' end as update_3,
       coalesce(((:asof - s.last_update_at) / 86400)::int::text, 'none') as days_since_last,
       s.promises,
       s.kept,
       s.missed,
       s.changed,
       s.unanswered,
       s.help_requests,
       s.offers,
       s.tasks,
       s.tasks_accepted
from pilot_stats s
order by s.began_at, s.name;

\if :summary
\echo
select count(*) as founders,
       count(*) filter (where updates >= 1) as posted_1,
       count(*) filter (where updates >= 2) as posted_2,
       count(*) filter (where updates >= 3) as posted_3,
       count(*) filter (where updates >= 2 and gap2 <= :late_days * 86400) as second_on_time,
       count(*) filter (where updates >= 3 and gap3 <= :late_days * 86400) as third_on_time,
       count(*) filter (where updates >= 2 and gap2 > :late_days * 86400) as second_after_late_flag,
       count(*) filter (where updates >= 3 and gap3 > :late_days * 86400) as third_after_late_flag
from pilot_stats;
\endif
