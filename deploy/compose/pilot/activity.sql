-- ./run.sh daily, part of it: what happened in the last 24 hours. Variables: asof. base.sql is read first.

select (select count(*) from pilot_stats where :asof - began_at < 86400) as projects_started,
       (select count(*) from pilot_weekly where :asof - at < 86400) as weekly_updates,
       (select count(*) from pilot_recs r
         where :asof - r.at < 86400
           and pg_temp.hastag(r.tags, 'help-offer')
           and not exists (select 1 from pilot_team t where t.coord = r.coord and t.member_hex = r.author_hex)) as help_offers;
