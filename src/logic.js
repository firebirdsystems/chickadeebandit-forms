// Pure, browser-free logic for Forms — unit-tested in __tests__/logic.test.mjs.
// No DOM, no network, no module-level state.
//
// The permission helpers take plain booleans rather than importing the hub
// SDK's isAdult: logic.js is imported by Node in tests, where "/hub-sdk.js"
// does not resolve. index.html supplies the flags from the SDK.

const FILE_ID = /^[0-9a-f-]{36}$/;

export const MAX_TITLE = 120;
export const MAX_DESCRIPTION = 2000;
export const MAX_LABEL = 200;
export const MAX_HELP = 500;
export const MAX_BODY = 8000;
export const MAX_SIGNATURE_TEXT = 2000;
export const MAX_ANSWER = 4000;
export const MAX_OPTIONS = 20;
export const MAX_QUESTIONS = 60;
// The manifest's submit.max_submissions: what one intake link accepts in total.
export const MAX_INTAKE_PER_LINK = 200;

export const QUESTION_TYPES = Object.freeze({
  text: "Short answer",
  multiline: "Long answer",
  choice: "Choose one",
  multi: "Choose any",
  yesno: "Yes or no",
  number: "Number",
  date: "Date",
  read: "Read and acknowledge",
});

export const AUDIENCE_KINDS = ["everyone", "group", "members"];

const SERVER_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Ending a closed spell: the form's current close, if it has one, is added
 *  to `closed_windows` as [closed_at, now] (hub clock at both ends), so a copy
 *  that arrived during it still reads "After close" once closed_at is cleared.
 *  Shared by every statement that takes a form from closed back to open. */
const END_CLOSED_SPELL =
  "closed_windows = CASE WHEN closed_at IS NULL THEN closed_windows "
  + `ELSE json_insert(CASE WHEN json_valid(closed_windows) THEN closed_windows ELSE '[]' END, '$[#]', json_array(closed_at, ${SERVER_NOW})) END, `
  + "closed_at = NULL";

/** Opening a draft: the status moves to open, and the questions and
 *  statement freeze from here on (frozen_when). Guarded on `status = 'draft'` so two builders opening at once, or a retry
 *  after a lost answer, open it once. A draft that was once closed (set back
 *  by hand-written SQL) ends that spell here, or every later copy would read
 *  "After close". */
export const OPEN_FORM_SQL =
  `UPDATE app_forms__forms SET status = 'open', opened_at = ?, closes_at = NULL, ${END_CLOSED_SPELL}, updated_at = ? `
  + "WHERE id = ? AND status = 'draft'";

/** Closing an open form. `closes_at` is the share link's `submit.until_column`
 *  and is written from the hub's clock, so a device whose clock runs fast
 *  cannot leave the intake form open; it is never a time still to come. */
export const CLOSE_FORM_SQL =
  `UPDATE app_forms__forms SET status = 'closed', closes_at = MIN(COALESCE(closes_at, ${SERVER_NOW}), ${SERVER_NOW}), `
  + `closed_at = COALESCE(closed_at, ${SERVER_NOW}), updated_at = ? WHERE id = ? AND status = 'open'`;

/** Reopening a closed form keeps its terms: the questions stayed frozen. */
export const REOPEN_FORM_SQL =
  `UPDATE app_forms__forms SET status = 'open', closes_at = NULL, ${END_CLOSED_SPELL}, updated_at = ? WHERE id = ? AND status = 'closed'`;

/** The page's own copy of END_CLOSED_SPELL, for when it cannot read the
 *  stored row back: `closed_windows` with the form's current close ended at
 *  `endedAt`. The next read replaces it with the hub's. */
export function endClosedSpell(form, endedAt) {
  const windows = parseWindows(form?.closed_windows);
  if (form?.closed_at) windows.push([String(form.closed_at), String(endedAt)]);
  return JSON.stringify(windows);
}

function parseWindows(raw) {
  try {
    const windows = JSON.parse(raw ?? "[]");
    return Array.isArray(windows) ? windows : [];
  } catch { return []; }
}

/** Archiving takes the form off the list and stops every share link
 *  (shareable.visible_where). A closed form keeps its cutoff. */
export const ARCHIVE_FORM_SQL =
  `UPDATE app_forms__forms SET status = 'archived', closes_at = MIN(COALESCE(closes_at, ${SERVER_NOW}), ${SERVER_NOW}), `
  + `closed_at = COALESCE(closed_at, ${SERVER_NOW}), updated_at = ? WHERE id = ? AND status IN ('open', 'closed')`;

/** Submitting: a draft row becomes final. Guarded on `status = 'draft'` so a
 *  second press, or a stale tab, cannot re-sign what is already signed.
 *
 *  The times come from the hub's clock, like a close's: a device clock that
 *  runs fast or slow cannot mark a copy "After close" wrongly or backdate a
 *  signature. The page's open-form check is a separate read (the hub refuses
 *  a subquery on another governed table inside an UPDATE), so a close can
 *  land between the two; a copy that does is stamped after `closed_at` by the
 *  same clock, and the review list marks it "After close". */
export const SUBMIT_SQL =
  "UPDATE app_forms__submissions SET status = 'submitted', answers = ?, signed_name = ?, signed_at = NULL, signed_text = ?, "
  + `terms_hash = ?, submitted_at = ${SERVER_NOW}, updated_at = ${SERVER_NOW} WHERE id = ? AND status = 'draft'`;

/** The same, for a form that asks for a signature: `signed_at` is the hub's
 *  moment of submitting. */
export const SUBMIT_SIGNED_SQL = SUBMIT_SQL.replace("signed_at = NULL", `signed_at = ${SERVER_NOW}`);

/** Re-read before a submit: only an open form takes one, and a stale tab must
 *  not sign against a form that closed meanwhile. */
export const FORM_STATE_SQL = "SELECT status, requires_signature, signature_text FROM app_forms__forms WHERE id = ?";

/** Hub file ids are UUIDs. A question's file column can be written by SQL,
 *  so the shape is checked before an id reaches a URL the page builds. */
export function isFileId(value) {
  return typeof value === "string" && FILE_ID.test(value);
}

/** A JSON object column (answers), read defensively. */
export function parseObject(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** A JSON array of strings (options, member ids), read defensively. */
export function parseStrings(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === "string") : [];
  } catch { return []; }
}

// ── Who may do what ───────────────────────────────────────────────────────────

/** Building, opening, closing and archiving forms. `forms` and `questions` are
 *  `adult_writable` with `steward_writes_only`: any adult in a household or a
 *  general space, the steward alone in a roster. The flags come from the SDK
 *  and the tenant globals in index.html. */
export function canManage(isAdultMember, { spaceKind = null, isAdmin = false } = {}) {
  if (!isAdultMember) return false;
  if (spaceKind === "roster") return isAdmin === true;
  return true;
}

/** Reading other members' submissions. Mirrors the hub: the submissions table
 *  is `owner_or_visibility` whose only widening is `privileged_values` for the
 *  reviewers group, so a member reads others' submitted forms IFF the group is
 *  set, still exists, and they are in it. There is no "all adults" fallback,
 *  not even for a hub admin: the hub rejects the read, so the controls stay
 *  hidden here too. See __tests__/helpers/privileged-gate.mjs.
 *
 *  In a roster space the hub's star topology also collapses a non-steward's
 *  widened reads to steward-authored rows, so there only a steward who is in
 *  the group reads anyone's copy; a participant reviewer would see an empty
 *  list, so the controls stay hidden for them too. */
export function canReview(me, groups, reviewersGroupId, { spaceKind = null, isAdmin = false } = {}) {
  if (!me || !reviewersGroupId) return false;
  const g = (groups ?? []).find(g => g.id === reviewersGroupId);
  if (!g || !(g.memberIds ?? []).includes(me.id)) return false;
  return spaceKind === "roster" ? isAdmin === true : true;
}

/** Why the reviewers group gives nobody access, or null when it works. In a
 *  roster space only a steward in the group reads anyone's copy (canReview),
 *  so a group the viewing steward is not in reads nothing either. Only a
 *  steward manages in a roster, so the viewer is the one to check. */
export function reviewersProblem(groups, reviewersGroupId, { spaceKind = null, memberId = null } = {}) {
  if (!reviewersGroupId) return "unset";
  const group = (groups ?? []).find(g => g.id === reviewersGroupId);
  if (!group) return "missing";
  if ((group.memberIds ?? []).length === 0) return "empty";
  if (spaceKind === "roster" && memberId && !(group.memberIds ?? []).includes(memberId)) return "no_steward";
  return null;
}

/** Who the page is being shown to. Outside the hub (demo mode) the first demo
 *  member stands in. Inside it, a missing current member is nobody. */
export function resolveCurrentMember(hubMember, members, inHub) {
  if (hubMember) return hubMember;
  if (inHub) return { id: "", name: "", role: "guest" };
  return members[0] ?? { id: "guest", name: "Guest", role: "adult" };
}

// ── Audience ─────────────────────────────────────────────────────────────────

/** The members a form is for, as ids. `appMembers` is the set the hub admits
 *  to this app (`family.app_members`), falling back to the roster; a group's
 *  members are intersected with it so someone the app does not admit is never
 *  counted as outstanding. Unknown kinds mean nobody, never everyone. */
export function audienceIds(form, { groups = [], appMembers = null, members = [] } = {}) {
  const admitted = new Set((appMembers ?? members).map(m => m.id));
  if (!form) return [];
  if (form.audience_kind === "everyone") return [...admitted];
  if (form.audience_kind === "group") {
    const group = groups.find(g => g.id === form.audience_group_id);
    return (group?.memberIds ?? []).filter(id => admitted.has(id));
  }
  if (form.audience_kind === "members") {
    return parseStrings(form.audience_member_ids).filter(id => admitted.has(id));
  }
  return [];
}

/** Whether a member is in the form's audience. A member not admitted to the
 *  app is not, whatever the form says. */
export function inAudience(form, memberId, ctx) {
  return audienceIds(form, ctx).includes(memberId);
}

/** `complete` says whether the viewer's members and groups are the whole
 *  roster. A roster participant sees only the steward and themselves, so an
 *  id or group they cannot resolve is someone else's, not a deleted one, and
 *  the label says so rather than "no longer exists". */
export function audienceLabel(form, { groups = [], members = [], complete = true } = {}) {
  if (form?.audience_kind === "group") {
    const group = groups.find(g => g.id === form.audience_group_id);
    if (group) return `Group: ${group.name}`;
    return complete ? "A group that no longer exists" : "A group";
  }
  if (form?.audience_kind === "members") {
    const ids = parseStrings(form.audience_member_ids);
    const names = ids.map(id => members.find(m => m.id === id)?.name).filter(Boolean);
    const hidden = ids.length - names.length;
    if (names.length === 0) return complete ? "Chosen members (none left)" : "Chosen members";
    // With some names hidden from this viewer, the count would be wrong; say "others".
    if (!complete && hidden > 0) return `${names.slice(0, 3).join(", ")} and others`;
    return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  }
  return "Everyone";
}

/** Completion for the reviewers' view: who in the audience has submitted
 *  and who has not. Reviewers read submitted copies only (the row policy's
 *  privileged_values), never another member's draft, so an in-progress
 *  member is "not submitted" like one who has not started. Submissions from
 *  members outside the audience (the audience was narrowed after they
 *  answered) are listed too, under `extra`, so a signed copy is never hidden. */
export function completion(form, submissions, ctx) {
  const ids = audienceIds(form, ctx);
  const byMember = new Map((submissions ?? [])
    .filter(s => s.form_id === form.id && s.status === "submitted")
    .map(s => [s.member_id, s]));
  const rows = ids.map(id => {
    const s = byMember.get(id);
    return { member_id: id, state: s ? "submitted" : "none", submission: s ?? null };
  });
  const extra = [...byMember.values()].filter(s => !ids.includes(s.member_id)).map(s => ({ member_id: s.member_id, state: "submitted", submission: s }));
  const done = rows.filter(r => r.state === "submitted").length;
  return { rows, extra, done, total: rows.length, outstanding: rows.filter(r => r.state !== "submitted").map(r => r.member_id) };
}

// ── Terms hash ───────────────────────────────────────────────────────────────

/** The text a signature is given against: every question as the member saw
 *  it, in order, and the signature statement. Stable across whitespace in
 *  the stored JSON because it is rebuilt from fields, not from raw columns. */
export function termsCanonical(questions, signatureText) {
  const ordered = [...(questions ?? [])].sort((a, b) => (a.position - b.position) || String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({
    v: 1,
    signature: String(signatureText ?? ""),
    questions: ordered.map(q => ({
      id: q.id,
      type: q.type,
      label: q.label,
      help: q.help ?? "",
      required: Number(q.required) ? 1 : 0,
      options: parseStrings(q.options),
      body: q.body ?? "",
      link_url: q.link_url ?? "",
      // The id, not the name: a file's bytes never change under its id, so
      // the id pins exactly the document the member was shown.
      file_id: isFileId(q.file_id) ? q.file_id : null,
    })),
  });
}

/** SHA-256 of the canonical terms, as lowercase hex. Synchronous and
 *  dependency-free so the page and the tests compute the same value. */
export function termsHash(questions, signatureText) {
  return sha256Hex(termsCanonical(questions, signatureText));
}

// A compact SHA-256 (FIPS 180-4) over a UTF-8 string.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => x.toString(16).padStart(8, "0")).join("");
}

// ── Drafts and validation ────────────────────────────────────────────────────

/** What a form's settings may save, or the reason they may not. */
export function formDraft({ title, description, audience_kind, audience_group_id, audience_member_ids, requires_signature, signature_text, due_date } = {}) {
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) return { error: "Give the form a title." };
  if (cleanTitle.length > MAX_TITLE) return { error: `Keep the title to ${MAX_TITLE} characters.` };
  const cleanDescription = String(description ?? "").trim();
  if (cleanDescription.length > MAX_DESCRIPTION) return { error: `Keep the description to ${MAX_DESCRIPTION} characters.` };
  const kind = AUDIENCE_KINDS.includes(audience_kind) ? audience_kind : "everyone";
  const groupId = kind === "group" ? String(audience_group_id ?? "").trim() : "";
  if (kind === "group" && !groupId) return { error: "Choose the group this form is for." };
  const memberIds = kind === "members" ? [...new Set(parseStrings(audience_member_ids))] : [];
  if (kind === "members" && memberIds.length === 0) return { error: "Choose at least one member." };
  const signs = Number(requires_signature) ? 1 : 0;
  const cleanSignature = String(signature_text ?? "").trim();
  if (signs && !cleanSignature) return { error: "Write the statement the signature agrees to." };
  if (cleanSignature.length > MAX_SIGNATURE_TEXT) return { error: `Keep the signature statement to ${MAX_SIGNATURE_TEXT} characters.` };
  const due = String(due_date ?? "").trim();
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { error: "The due date is not a date." };
  return {
    value: {
      title: cleanTitle,
      description: cleanDescription,
      audience_kind: kind,
      audience_group_id: groupId || null,
      audience_member_ids: JSON.stringify(memberIds),
      requires_signature: signs,
      signature_text: signs ? cleanSignature : "",
      due_date: due || null,
    },
  };
}

/** What a question may save, or the reason it may not. */
export function questionDraft({ type, label, help, required, options, body, link_url, file_id, file_name } = {}) {
  if (!Object.hasOwn(QUESTION_TYPES, type)) return { error: "Pick a question type." };
  const cleanLabel = String(label ?? "").trim();
  if (!cleanLabel) return { error: "Give the question a label." };
  if (cleanLabel.length > MAX_LABEL) return { error: `Keep the label to ${MAX_LABEL} characters.` };
  const cleanHelp = String(help ?? "").trim();
  if (cleanHelp.length > MAX_HELP) return { error: `Keep the help text to ${MAX_HELP} characters.` };
  let cleanOptions = [];
  if (type === "choice" || type === "multi") {
    cleanOptions = [...new Set(
      (Array.isArray(options) ? options : String(options ?? "").split("\n"))
        .map(o => String(o).trim()).filter(Boolean),
    )];
    if (cleanOptions.length < 2) return { error: "Give at least two options, one per line." };
    if (cleanOptions.length > MAX_OPTIONS) return { error: `Keep it to ${MAX_OPTIONS} options.` };
  }
  const cleanBody = type === "read" ? String(body ?? "").trim() : "";
  if (cleanBody.length > MAX_BODY) return { error: `Keep the document text to ${MAX_BODY} characters.` };
  const cleanLink = type === "read" ? String(link_url ?? "").trim() : "";
  if (cleanLink && !/^https:\/\//.test(cleanLink)) return { error: "A link must start with https://." };
  const cleanFile = type === "read" && isFileId(file_id) ? file_id : null;
  const cleanFileName = cleanFile ? String(file_name ?? "").trim().slice(0, MAX_LABEL) : "";
  if (type === "read" && !cleanBody && !cleanLink && !cleanFile) return { error: "A document step needs a document, text or a link to read." };
  return {
    value: {
      type,
      label: cleanLabel,
      help: cleanHelp,
      required: Number(required) ? 1 : 0,
      options: JSON.stringify(cleanOptions),
      body: cleanBody,
      link_url: cleanLink,
      file_id: cleanFile,
      file_name: cleanFileName,
    },
  };
}

/** One answer, normalised for its question, or the reason it is not
 *  acceptable. A missing answer is fine unless the question is required. */
export function cleanAnswer(question, raw) {
  const required = Number(question?.required) === 1;
  const missing = () => required ? { error: `"${question.label}" needs an answer.` } : { value: null };
  switch (question?.type) {
    case "text":
    case "multiline": {
      const text = String(raw ?? "").trim();
      if (!text) return missing();
      if (text.length > MAX_ANSWER) return { error: `Keep "${question.label}" to ${MAX_ANSWER} characters.` };
      return { value: text };
    }
    case "choice": {
      const options = parseStrings(question.options);
      if (raw === null || raw === undefined || raw === "") return missing();
      if (!options.includes(raw)) return { error: `Pick one of the options for "${question.label}".` };
      return { value: raw };
    }
    case "multi": {
      const options = parseStrings(question.options);
      const picked = (Array.isArray(raw) ? raw : []).filter(v => options.includes(v));
      if (picked.length === 0) return missing();
      return { value: picked };
    }
    case "yesno": {
      if (raw === "yes" || raw === "no") return { value: raw };
      return missing();
    }
    case "number": {
      if (raw === null || raw === undefined || raw === "") return missing();
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `"${question.label}" needs a number.` };
      return { value: n };
    }
    case "date": {
      const text = String(raw ?? "").trim();
      if (!text) return missing();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { error: `"${question.label}" needs a date.` };
      return { value: text };
    }
    case "read": {
      if (raw === true || raw === "yes" || raw === 1) return { value: true };
      return required ? { error: `Confirm you have read "${question.label}".` } : { value: raw ? true : null };
    }
    default:
      return { error: "Unknown question type." };
  }
}

/** Every answer on a form checked at once. Returns the answers to store (by
 *  question id, nulls dropped), or the first error. */
export function cleanAnswers(questions, rawAnswers) {
  const answers = {};
  for (const q of [...(questions ?? [])].sort((a, b) => a.position - b.position)) {
    const result = cleanAnswer(q, rawAnswers?.[q.id]);
    if (result.error) return { error: result.error };
    if (result.value === null || result.value === undefined) continue;
    answers[q.id] = result.value;
  }
  return { value: { answers } };
}

/** The signature block, when the form asks for one. */
export function cleanSignature(form, { name, agreed } = {}) {
  if (!Number(form?.requires_signature)) return { value: { signed_name: "", agreed: true } };
  const cleanName = String(name ?? "").trim();
  if (!cleanName) return { error: "Type your full name to sign." };
  if (cleanName.length > MAX_LABEL) return { error: `Keep the signature to ${MAX_LABEL} characters.` };
  if (!agreed) return { error: "Tick the box to agree to the statement." };
  return { value: { signed_name: cleanName, agreed: true } };
}

/** Whether the form's current questions, with the statement this copy
 *  recorded, still hash to what the copy was signed against. False means the
 *  questions changed after this member signed, or the copy's own record was
 *  altered; the reviewers' view says so per copy rather than quietly. */
export function submissionIntact(questions, submission) {
  if (!submission?.terms_hash) return false;
  return termsHash(questions, submission.signed_text) === submission.terms_hash;
}

/** The hub's audience for a form's notification: "all" for everyone, the ids
 *  otherwise, or null when nobody the app admits is in it (a deleted group,
 *  chosen members who left) — then nothing is sent and the page says so. */
export function notifyAudience(form, ctx) {
  if ((form?.audience_kind ?? "everyone") === "everyone") return "all";
  const ids = audienceIds(form, ctx);
  return ids.length ? ids : null;
}

/** Whether a read step's link may be rendered as one. The builder's validator
 *  requires https, but a column any adult can write by SQL is re-checked
 *  where it becomes a clickable href. */
export function safeLink(url) {
  return typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : "";
}

/** True when a copy was submitted while its form was closed: after the
 *  current close, or inside a closed spell the form has since been reopened
 *  from. Every time compared is the hub's (SUBMIT_SQL, CLOSE_FORM_SQL,
 *  END_CLOSED_SPELL). The page compares a device time only when a read-back
 *  failed (endClosedSpell), until its next load. */
export function submittedWhileClosed(form, submission) {
  // Parsed, not compared as text: "…T00:00:00Z" (a seeded or hand-written
  // time) sorts after "…T00:00:00.500Z" as a string. A time with no zone is
  // read as UTC, as the hub writes every time, never as this device's zone.
  const time = (v) => {
    if (typeof v !== "string") return NaN;
    return Date.parse(v.includes("T") && !/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(v) ? `${v}Z` : v);
  };
  const at = time(submission?.submitted_at);
  if (Number.isNaN(at) || !form) return false;
  const closed = time(form.closed_at);
  if (!Number.isNaN(closed) && at > closed) return true;
  return parseWindows(form.closed_windows).some(w => Array.isArray(w) && at > time(w[0]) && at < time(w[1]));
}

/** A read-only rendering of one answer, as text. */
export function answerText(question, value) {
  if (value === null || value === undefined) return "";
  switch (question?.type) {
    case "multi": return (Array.isArray(value) ? value : []).join(", ");
    case "yesno": return value === "yes" ? "Yes" : value === "no" ? "No" : "";
    case "read": return value ? "Read and acknowledged" : "";
    case "number": return String(value);
    default: return String(value);
  }
}

// ── Lists ────────────────────────────────────────────────────────────────────

/** Open forms this member is meant to fill and has not finished, due soonest first. */
export function todoForms(forms, submissions, memberId, ctx) {
  const done = new Set((submissions ?? []).filter(s => s.member_id === memberId && s.status === "submitted").map(s => s.form_id));
  return (forms ?? [])
    .filter(f => f.status === "open" && !done.has(f.id) && inAudience(f, memberId, ctx))
    .sort(byDueThenNewest);
}

export function byDueThenNewest(a, b) {
  if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date);
  if (a.due_date && !b.due_date) return -1;
  if (!a.due_date && b.due_date) return 1;
  return String(b.created_at).localeCompare(String(a.created_at));
}

export function formById(forms, id) {
  return (forms ?? []).find(f => f.id === id) ?? null;
}

export function mySubmission(submissions, formId, memberId) {
  return (submissions ?? []).find(s => s.form_id === formId && s.member_id === memberId) ?? null;
}

/** Whether a form is past its due date on the household's day. Due is INCLUSIVE. */
export function isOverdue(form, today) {
  return !!form?.due_date && form.status === "open" && String(form.due_date) < String(today);
}

/** Fields the form-list search matches against (see hub-sdk `searchMatch`). */
export function searchableFields(form) {
  return [form.title, form.description];
}

export function formatDay(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  const dt = Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? new Date(y, m - 1, d) : new Date(iso);
  return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// ── Failure lines ("Refused, gone, or failed: which line") ───────────────────

/** Whether a failed create's answer leaves its outcome unknown — no status, a
 *  400, or a 5xx other than 507 — so the page reads the row back by its
 *  pinned id. A UNIQUE answer is a 400 too: a retry of a create that landed
 *  collides on its own pinned id. */
export function outcomeUnknown(e) {
  if (e?.code === "UNIQUE_CONSTRAINT" || /UNIQUE constraint failed/i.test(String(e?.message ?? ""))) return true;
  const status = Number(e?.status) || 0;
  return status === 0 || status === 400 || (status >= 500 && status !== 507);
}

/** The line a failed document upload shows: the upload's own refusals first. */
export function uploadFailureLine(e) {
  if (e?.status === 413) return "That file is too large.";
  if (e?.status === 415) return "That kind of file can’t be uploaded.";
  return failureLine(e, { action: "attach that document", thing: "document" });
}

/** The line a failed write shows, from the error's status / code, never the
 *  hub's text. `found` is the caller's re-read after a write that changed
 *  nothing: false = gone, true = still there, null = the re-read failed. */
export function failureLine(e, { action, thing, found, guarded = false } = {}) {
  if (e?.forUser) return e.message;
  if (e?.code === "UNIQUE_CONSTRAINT" || /UNIQUE constraint failed/i.test(String(e?.message ?? ""))) return `That ${thing} already exists.`;
  if (e?.status === 403 || (found === true && !guarded)) return `You don’t have permission to ${action}.`;
  if (e?.status === 507) return "The household’s storage is full — free up space first.";
  if (e?.status === 429) return "Too many tries — wait a minute and try again.";
  if (found === null) return `Couldn’t ${action} — try again.`;
  if (found === false || (found === undefined && e?.status === 404)) return `This ${thing} has been removed.`;
  if (found === true || e?.status === 409) return `This ${thing} was changed by someone else — check it first.`;
  return `Couldn’t ${action} — try again.`;
}
