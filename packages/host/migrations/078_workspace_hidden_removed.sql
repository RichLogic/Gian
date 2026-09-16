-- The Workspace hidden feature was retired (Hide/Show UI removed, repo lists
-- must show every repo). Keep the column for schema/type compatibility, but
-- reset every value so no repo stays invisible after upgrading.
UPDATE workspaces SET hidden = 0 WHERE hidden <> 0;
