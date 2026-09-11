-- Community host, channel and membership for the real-relay tests.
-- Host binding is fail-closed, so the authority the client uses must exist, and
-- writes need channel (and relay) membership.
INSERT INTO communities (host) VALUES ('localhost:3199') ON CONFLICT ((lower(host))) DO UPDATE SET host = EXCLUDED.host;
INSERT INTO communities (host) VALUES ('localhost'), ('127.0.0.1'), ('127.0.0.1:3199') ON CONFLICT ((lower(host))) DO NOTHING;
INSERT INTO relay_members (community_id, pubkey, role, added_by)
  SELECT id, 'e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34', 'owner', 'seed' FROM communities WHERE lower(host) = 'localhost:3199'
  ON CONFLICT DO NOTHING;
INSERT INTO channels (community_id, name, created_by, visibility, channel_type)
  SELECT id, 'general', decode('e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34', 'hex'), 'open', 'stream' FROM communities WHERE lower(host) = 'localhost:3199'
  AND NOT EXISTS (
    SELECT 1 FROM channels c JOIN communities co ON c.community_id = co.id
    WHERE lower(co.host) = 'localhost:3199' AND c.name = 'general'
  );
INSERT INTO channel_members (community_id, channel_id, pubkey, role)
  SELECT c.community_id, c.id, decode('e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34', 'hex'), 'owner'
  FROM channels c JOIN communities co ON c.community_id = co.id
  WHERE lower(co.host) = 'localhost:3199' AND c.name = 'general'
  ON CONFLICT DO NOTHING;
