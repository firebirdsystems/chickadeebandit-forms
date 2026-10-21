-- Forms: questionnaires, waivers and welcome packets that members fill in
-- and, where the form asks for it, sign.
--
-- Migrations are additive only: add 002_*.sql, 003_*.sql for later changes.
-- Never DROP/RENAME; the runner applies each version exactly once, in order.

-- One form. Adults build it (the steward alone in a roster space); everyone
-- the form is meant for fills it in. `adult_writable` + `steward_writes_only`.
CREATE TABLE IF NOT EXISTS app_forms__forms (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',

  -- draft: being built, nobody fills it; open: taking submissions;
  -- closed: no new submissions, still readable; archived: off the list.
  -- Enforceable as a CHECK because `status` is plaintext.
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'open', 'closed', 'archived')),

  -- Who the form is for: everyone the app admits, one hub member group, or a
  -- chosen list of members. Decides who is counted as outstanding and who is
  -- notified; it is not a read restriction (see README).
  audience_kind       TEXT NOT NULL DEFAULT 'everyone'
                        CHECK (audience_kind IN ('everyone', 'group', 'members')),
  audience_group_id   TEXT,
  audience_member_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of member ids

  -- 1 when a submission must carry a typed signature against signature_text.
  requires_signature  INTEGER NOT NULL DEFAULT 0
                        CHECK (requires_signature IN (0, 1)),
  signature_text      TEXT NOT NULL DEFAULT '',

  due_date            TEXT,                        -- yyyy-mm-dd, household-local
  -- When the form stopped taking submissions: an ISO instant, NULL while open.
  -- Also the share link's submit.until_column, so a closed form refuses an
  -- outside intake submission as well as a member's.
  closes_at           TEXT,

  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  opened_at           TEXT,
  closed_at           TEXT
);

-- One question or step on a form, in order. Frozen once the form is opened
-- (manifest frozen_when on the parent's status): the hub narrows an edit or
-- removal to nothing and refuses an insert under an opened form, so what a
-- member signed is what the builder wrote. The signed copy also carries its
-- own record of the wording (submissions.signed_text + terms_hash), so even
-- a change that got past the policy cannot rewrite what was agreed.
CREATE TABLE IF NOT EXISTS app_forms__questions (
  id        TEXT PRIMARY KEY,
  form_id   TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,

  -- text, multiline, choice, multi, yesno, number, date, read.
  -- `read` is a document step: the member reads the attached document, the
  -- text in `body` or the linked page, and ticks that they have.
  type      TEXT NOT NULL
              CHECK (type IN ('text', 'multiline', 'choice', 'multi', 'yesno', 'number', 'date', 'read')),
  label     TEXT NOT NULL,
  help      TEXT NOT NULL DEFAULT '',
  required  INTEGER NOT NULL DEFAULT 0
              CHECK (required IN (0, 1)),
  options   TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings (choice, multi)
  body      TEXT NOT NULL DEFAULT '',     -- the document text of a read step
  link_url  TEXT NOT NULL DEFAULT '',     -- an outside page a read step points at
  -- A document the builder uploaded for a read step. Its bytes never change
  -- under this id, and the question freezes when the form opens, so a signed
  -- copy's hash (which covers the id) pins the exact document it was shown.
  file_id   TEXT,
  file_name TEXT NOT NULL DEFAULT '',

  -- One question per place: two builders adding at once cannot both take
  -- the next position, and a reorder from a stale tab cannot leave two
  -- questions sharing one (the page swaps through a free position).
  UNIQUE (form_id, position)
);

-- One member's answers to one form. Owned by that member; readable by the
-- reviewers group once submitted; immutable once submitted (frozen_when).
CREATE TABLE IF NOT EXISTS app_forms__submissions (
  id           TEXT PRIMARY KEY,
  form_id      TEXT NOT NULL,
  member_id    TEXT NOT NULL,

  -- draft: the member is still filling it in; submitted: final and frozen.
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'submitted')),

  answers      TEXT NOT NULL DEFAULT '{}',   -- JSON object: question id -> answer

  -- The typed signature, the moment it was given, the statement as it read
  -- on screen, and a hash over that statement and the questions as rendered
  -- (logic.js termsHash). The copy records its own wording: a later change
  -- to the form cannot rewrite what this member agreed to. signed_name and
  -- signed_at are empty on a form that asks for no signature.
  signed_name  TEXT NOT NULL DEFAULT '',
  signed_at    TEXT,
  signed_text  TEXT NOT NULL DEFAULT '',
  terms_hash   TEXT NOT NULL DEFAULT '',

  submitted_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,

  -- One row per member per form: the row policy's max_per_member says the
  -- same thing to the hub, and this says it to the database.
  UNIQUE (form_id, member_id)
);

-- What someone outside the household sent through a share link: a name and
-- a way to reach them, before they are a member. Inserted by the hub's
-- share-link form only; members cannot write here (column_write_acls).
CREATE TABLE IF NOT EXISTS app_forms__intake (
  id          TEXT PRIMARY KEY,
  form_id     TEXT NOT NULL,
  guest_name  TEXT NOT NULL DEFAULT '',
  guest_email TEXT NOT NULL DEFAULT '',
  guest_phone TEXT NOT NULL DEFAULT '',
  guest_note  TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'external'
                CHECK (source IN ('external')),
  created_at  TEXT NOT NULL
);

-- The settings row that names the reviewers group (admin_config).
CREATE TABLE IF NOT EXISTS app_forms__settings (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Form list: open forms first by due date, then the rest newest first.
CREATE INDEX IF NOT EXISTS app_forms__forms_status_idx
  ON app_forms__forms (status, due_date);

CREATE INDEX IF NOT EXISTS app_forms__forms_created_idx
  ON app_forms__forms (created_at);

-- A form's questions in order.
CREATE INDEX IF NOT EXISTS app_forms__questions_form_idx
  ON app_forms__questions (form_id, position);

-- A member's own submissions (the first-render read) and a form's submissions
-- (the reviewers' view). The UNIQUE above already covers (form_id, member_id).
CREATE INDEX IF NOT EXISTS app_forms__submissions_member_idx
  ON app_forms__submissions (member_id, form_id);

-- A form's outside submissions, newest first.
CREATE INDEX IF NOT EXISTS app_forms__intake_form_idx
  ON app_forms__intake (form_id, created_at);
