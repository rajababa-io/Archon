-- Share links (#345): a published page or file under the public files root,
-- reachable at /share/<code>/ without the deployment's login.
--
-- `code` is the unguessable part of the address and never changes, so turning
-- a share off and on again keeps the link people already have. `path` is
-- relative to the public files root (what follows `/files/` in its private
-- address); one share per path. `access` is 'link' (anyone with the address)
-- or 'restricted' (the address answers 404 and only `/files/` serves it).
CREATE TABLE IF NOT EXISTS remote_agent_shares (
  code VARCHAR(32) PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  access VARCHAR(16) NOT NULL DEFAULT 'link' CHECK (access IN ('link', 'restricted')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_shares IS
  'Published pages and files reachable at /share/<code>/ without a login, while access is link.';
