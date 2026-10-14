-- Which release last asked the sandbox controller to prepare the sandbox image
-- in this workspace's own Modal account, and when. Modal caches an image per
-- workspace, so every workspace builds each new image once, for minutes; the
-- Worker asks for that build at Modal connect and again after a release
-- (`worker/modal/image-warm.ts`), so it does not happen inside a session's
-- start. Both NULL means never asked, which is how every existing row reads,
-- and leads to one preparation on the next sign-in. A record of a request,
-- not of a finished build: a session's own provisioning still prepares the
-- image and waits for it.
ALTER TABLE modal_connection ADD COLUMN image_warmed_release TEXT;
ALTER TABLE modal_connection ADD COLUMN image_warmed_at TEXT;
