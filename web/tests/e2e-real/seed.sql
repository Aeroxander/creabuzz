-- Community host and relay membership for the real-relay tests.
--
-- Host binding is fail-closed, so the authority the client uses must exist, and
-- writes need relay membership. The *channel* is not created here: channel
-- discovery metadata (kind:39000) is relay-authored, so a SQL-inserted channel
-- has no discovery event and clients never see it. Create it through the relay
-- with `create-channel.mjs`, which publishes a kind:9007 and lets the relay
-- emit 39000/39001/39002.
INSERT INTO communities (host) VALUES ('localhost:3199') ON CONFLICT ((lower(host))) DO UPDATE SET host = EXCLUDED.host;
INSERT INTO communities (host) VALUES ('localhost'), ('127.0.0.1'), ('127.0.0.1:3199') ON CONFLICT ((lower(host))) DO NOTHING;
INSERT INTO relay_members (community_id, pubkey, role, added_by)
  SELECT id, 'e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34', 'owner', 'seed' FROM communities WHERE lower(host) = 'localhost:3199'
  ON CONFLICT DO NOTHING;
