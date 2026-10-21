-- The closed spells a reopened form has had: a JSON array of
-- [closed_at, reopened_at] pairs, both ISO instants from the hub's clock.
-- Reopening clears closed_at, so without this a copy that landed while the
-- form was closed (a submit racing the close, or hand-written SQL) would lose
-- its "After close" mark the moment the form reopened. Appended by
-- REOPEN_FORM_SQL only. Plaintext (db_plaintext_columns): the review list
-- compares the submission times against it.
ALTER TABLE app_forms__forms ADD COLUMN closed_windows TEXT NOT NULL DEFAULT '[]';
