-- ./run.sh due: founders whose last weekly update is late_days or more days old (a project with none counts from its
-- start), with how many days late: the list to message by hand. Variables: asof, late_days. base.sql is read first.

select coalesce(nullif(s.founder_name, ''), left(s.founder_hex, 8)) as founder,
       s.name as project,
       case when s.last_update_at is null then 'no update yet' else to_char(to_timestamp(s.last_update_at), 'YYYY-MM-DD') end
         as last_update,
       ((:asof - coalesce(s.last_update_at, s.began_at)) / 86400)::int as days_since,
       ((:asof - coalesce(s.last_update_at, s.began_at)) / 86400)::int - :late_days as days_late,
       s.updates
from pilot_stats s
where :asof - coalesce(s.last_update_at, s.began_at) >= :late_days * 86400
order by coalesce(s.last_update_at, s.began_at), s.name;
