import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";
import {
  parseObject, parseStrings, isFileId,
  canManage, canReview, reviewersProblem, resolveCurrentMember,
  audienceIds, inAudience, audienceLabel, completion,
  termsCanonical, termsHash, sha256Hex, submissionIntact, notifyAudience, safeLink,
  formDraft, questionDraft, cleanAnswer, cleanAnswers, cleanSignature, answerText,
  todoForms, byDueThenNewest, mySubmission, isOverdue, searchableFields, formatDay,
  outcomeUnknown, failureLine, uploadFailureLine,
  OPEN_FORM_SQL, CLOSE_FORM_SQL, REOPEN_FORM_SQL, ARCHIVE_FORM_SQL, SUBMIT_SQL, SUBMIT_SIGNED_SQL, SAVE_DRAFT_SQL,
  MAX_TITLE, MAX_OPTIONS, QUESTION_TYPES, ANSWER_FILE_SCOPE, attachedFile, answerFileIds,
  submittedWhileClosed, endClosedSpell,
} from "../src/logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(__dirname, path), "utf-8");
const manifest = JSON.parse(read("../manifest.json"));
const scenarios = JSON.parse(read("../scenarios.json")).scenarios;
const migration = read("../migrations/001_init.sql");
const html = read("../src/index.html");

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const UUID_2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const MEMBERS = [
  { id: "m1", name: "Alex", role: "admin" },
  { id: "m2", name: "Jamie", role: "adult" },
  { id: "m3", name: "Casey", role: "child" },
  { id: "m4", name: "Robin", role: "adult" },
];
const GROUPS = [{ id: "g1", name: "Board", memberIds: ["m1", "m2"] }];
const CTX = { groups: GROUPS, members: MEMBERS, appMembers: MEMBERS.slice(0, 3) };

const form = (over = {}) => ({
  id: "f1", title: "Pool waiver", description: "", status: "open", audience_kind: "everyone", audience_group_id: null,
  audience_member_ids: "[]", requires_signature: 1, signature_text: "I agree.", due_date: null,
  created_at: "2026-01-01T00:00:00Z", ...over,
});
const question = (over = {}) => ({ id: "q1", form_id: "f1", position: 0, type: "text", label: "Name", help: "", required: 1, options: "[]", body: "", link_url: "", file_id: null, file_name: "", ...over });

describe("json columns", () => {
  it("reads objects and string arrays defensively", () => {
    expect(parseObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseObject("[1]")).toEqual({});
    expect(parseObject(null)).toEqual({});
    expect(parseStrings('["a", 1, null]')).toEqual(["a"]);
    expect(parseStrings("{}")).toEqual([]);
  });
});

describe("who may do what", () => {
  it("lets any adult build in a household or a general space, the steward alone in a roster", () => {
    expect(canManage(true, { spaceKind: null })).toBe(true);
    expect(canManage(true, { spaceKind: "general", isAdmin: false })).toBe(true);
    expect(canManage(true, { spaceKind: "roster", isAdmin: false })).toBe(false);
    expect(canManage(true, { spaceKind: "roster", isAdmin: true })).toBe(true);
    expect(canManage(false, { spaceKind: null, isAdmin: true })).toBe(false);
  });

  it("lets only members of a set, existing, non-empty reviewers group read submissions", () => {
    expect(canReview({ id: "m1" }, GROUPS, "g1")).toBe(true);
    expect(canReview({ id: "m4" }, GROUPS, "g1")).toBe(false);
    expect(canReview({ id: "m1" }, GROUPS, null)).toBe(false);
    expect(canReview({ id: "m1" }, GROUPS, "gone")).toBe(false);
    expect(canReview(null, GROUPS, "g1")).toBe(false);
  });

  it("in a roster lets only a steward in the group review", () => {
    expect(canReview({ id: "m1" }, GROUPS, "g1", { spaceKind: "roster", isAdmin: true })).toBe(true);
    expect(canReview({ id: "m1" }, GROUPS, "g1", { spaceKind: "roster", isAdmin: false })).toBe(false);
    expect(canReview({ id: "m4" }, GROUPS, "g1", { spaceKind: "roster", isAdmin: true })).toBe(false);
    expect(canReview({ id: "m2" }, GROUPS, "g1", { spaceKind: "general", isAdmin: false })).toBe(true);
  });

  it("names why the reviewers group grants nobody access", () => {
    expect(reviewersProblem(GROUPS, null)).toBe("unset");
    expect(reviewersProblem(GROUPS, "gone")).toBe("missing");
    expect(reviewersProblem([{ id: "g2", name: "Empty", memberIds: [] }], "g2")).toBe("empty");
    expect(reviewersProblem(GROUPS, "g1")).toBe(null);
    // In a roster the steward who manages must be in the group to read anything.
    expect(reviewersProblem(GROUPS, "g1", { spaceKind: "roster", memberId: "m4" })).toBe("no_steward");
    expect(reviewersProblem(GROUPS, "g1", { spaceKind: "roster", memberId: "m1" })).toBe(null);
    expect(reviewersProblem(GROUPS, "g1", { spaceKind: "general", memberId: "m4" })).toBe(null);
  });

  it("never adopts a roster member as the current member inside the hub", () => {
    expect(resolveCurrentMember(null, MEMBERS, true)).toEqual({ id: "", name: "", role: "guest" });
    expect(resolveCurrentMember(null, MEMBERS, false)).toBe(MEMBERS[0]);
    expect(resolveCurrentMember(MEMBERS[1], MEMBERS, true)).toBe(MEMBERS[1]);
  });
});

describe("audience", () => {
  it("everyone means everyone the app admits", () => {
    expect(audienceIds(form(), CTX)).toEqual(["m1", "m2", "m3"]);
    expect(audienceIds(form(), { ...CTX, appMembers: null })).toEqual(["m1", "m2", "m3", "m4"]);
  });
  it("a group is intersected with the admitted set; a missing group is nobody", () => {
    expect(audienceIds(form({ audience_kind: "group", audience_group_id: "g1" }), { ...CTX, appMembers: [MEMBERS[1]] })).toEqual(["m2"]);
    expect(audienceIds(form({ audience_kind: "group", audience_group_id: "gone" }), CTX)).toEqual([]);
  });
  it("chosen members are filtered to those admitted, and an unknown kind is nobody", () => {
    expect(audienceIds(form({ audience_kind: "members", audience_member_ids: '["m3", "m4", "zz"]' }), CTX)).toEqual(["m3"]);
    expect(audienceIds(form({ audience_kind: "all" }), CTX)).toEqual([]);
    expect(inAudience(form(), "m4", CTX)).toBe(false);
  });
  it("labels the audience", () => {
    expect(audienceLabel(form(), CTX)).toBe("Everyone");
    expect(audienceLabel(form({ audience_kind: "group", audience_group_id: "g1" }), CTX)).toBe("Group: Board");
    expect(audienceLabel(form({ audience_kind: "group", audience_group_id: "x" }), CTX)).toBe("A group that no longer exists");
    expect(audienceLabel(form({ audience_kind: "members", audience_member_ids: '["m1","m2","m3","m4"]' }), CTX)).toBe("Alex, Jamie, Casey and 1 more");
    expect(audienceLabel(form({ audience_kind: "members", audience_member_ids: '["zz"]' }), CTX)).toBe("Chosen members (none left)");
  });
  it("does not call a live audience gone when the viewer sees only part of the roster", () => {
    const partial = { ...CTX, complete: false };
    expect(audienceLabel(form({ audience_kind: "members", audience_member_ids: '["zz"]' }), partial)).toBe("Chosen members");
    expect(audienceLabel(form({ audience_kind: "members", audience_member_ids: '["m1","zz"]' }), partial)).toBe("Alex and others");
    expect(audienceLabel(form({ audience_kind: "group", audience_group_id: "x" }), partial)).toBe("A group");
    // Never "… and 1 more and others".
    const many = { ...partial, members: [...MEMBERS, { id: "m5", name: "Sam", role: "adult" }] };
    expect(audienceLabel(form({ audience_kind: "members", audience_member_ids: '["m1","m2","m3","m4","m5","zz"]' }), many)).toBe("Alex, Jamie, Casey and others");
  });
  it("counts completion over the audience and keeps submissions from outside it", () => {
    const subs = [
      { id: "s1", form_id: "f1", member_id: "m1", status: "submitted" },
      { id: "s2", form_id: "f1", member_id: "m2", status: "draft" },
      { id: "s4", form_id: "f1", member_id: "m4", status: "submitted" },
      { id: "sx", form_id: "other", member_id: "m3", status: "submitted" },
    ];
    const c = completion(form(), subs, CTX);
    expect(c.done).toBe(1);
    expect(c.total).toBe(3);
    // A draft is the member's own; reviewers never read it, so it counts as not submitted.
    expect(c.rows.map(r => r.state)).toEqual(["submitted", "none", "none"]);
    expect(c.outstanding).toEqual(["m2", "m3"]);
    expect(c.extra.map(r => r.member_id)).toEqual(["m4"]);
  });
});

describe("terms hash", () => {
  it("is SHA-256 (known vectors)", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("The quick brown fox jumps over the lazy dog")).toBe("d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
    // A multi-block input (> 55 bytes) exercises the padding across two chunks.
    expect(sha256Hex("a".repeat(100))).toBe("2816597888e4a0d3a36b82b83316ab32680eb8f00f8cd3b904d681246d285a0e");
  });
  it("does not depend on question order in the array or on stored JSON whitespace", () => {
    const a = question({ id: "q1", position: 0, options: '["x","y"]', type: "choice" });
    const b = question({ id: "q2", position: 1 });
    expect(termsHash([a, b], "sign")).toBe(termsHash([b, { ...a, options: '[ "x", "y" ]' }], "sign"));
  });
  it("changes when any wording a member saw changes", () => {
    const base = [question()];
    const h = termsHash(base, "sign");
    expect(termsHash(base, "sign ")).not.toBe(h);
    expect(termsHash([question({ label: "Full name" })], "sign")).not.toBe(h);
    expect(termsHash([question({ required: 0 })], "sign")).not.toBe(h);
    expect(termsHash([question({ type: "read", body: "rules", link_url: "https://x" })], "sign")).not.toBe(h);
    // The document is pinned by its id; its display name is not part of the terms.
    const docStep = (over) => [question({ type: "read", file_id: UUID, file_name: "a.pdf", ...over })];
    expect(termsHash(docStep({ file_id: UUID_2 }), "sign")).not.toBe(termsHash(docStep(), "sign"));
    expect(termsHash(docStep({ file_name: "renamed.pdf" }), "sign")).toBe(termsHash(docStep(), "sign"));
    expect(termsHash(docStep({ file_id: "bad" }), "sign")).toBe(termsHash(docStep({ file_id: null }), "sign"));
    expect(isFileId(UUID)).toBe(true);
    expect(isFileId(`${UUID}/..`)).toBe(false);
    expect(termsCanonical(base, "sign")).toContain('"v":1');
  });
  it("checks a signed copy against its own recorded statement and the form's current questions", () => {
    const qs = [question()];
    const copy = { signed_text: "I agree.", terms_hash: termsHash(qs, "I agree.") };
    expect(submissionIntact(qs, copy)).toBe(true);
    expect(submissionIntact([question({ label: "Edited" })], copy)).toBe(false);
    expect(submissionIntact(qs, { ...copy, signed_text: "Rewritten" })).toBe(false);
    expect(submissionIntact(qs, { signed_text: "", terms_hash: "" })).toBe(false);
  });
  it("names the notification audience, and nobody as null", () => {
    expect(notifyAudience(form(), CTX)).toBe("all");
    expect(notifyAudience(form({ audience_kind: "members", audience_member_ids: '["m3"]' }), CTX)).toEqual(["m3"]);
    expect(notifyAudience(form({ audience_kind: "group", audience_group_id: "gone" }), CTX)).toBe(null);
  });
  it("renders only an https link", () => {
    expect(safeLink("https://example.org/rules")).toBe("https://example.org/rules");
    expect(safeLink("javascript:alert(1)")).toBe("");
    expect(safeLink("http://example.org")).toBe("");
    expect(safeLink(null)).toBe("");
  });
});

describe("form settings", () => {
  it("needs a title and a valid audience", () => {
    expect(formDraft({ title: " " }).error).toMatch(/title/);
    expect(formDraft({ title: "x".repeat(MAX_TITLE + 1) }).error).toMatch(/characters/);
    expect(formDraft({ title: "T", audience_kind: "group" }).error).toMatch(/group/);
    expect(formDraft({ title: "T", audience_kind: "members", audience_member_ids: [] }).error).toMatch(/member/);
    expect(formDraft({ title: "T", requires_signature: 1, signature_text: "" }).error).toMatch(/statement/);
    expect(formDraft({ title: "T", due_date: "soon" }).error).toMatch(/date/);
  });
  it("normalises what it saves", () => {
    const v = formDraft({ title: " T ", description: " d ", audience_kind: "members", audience_member_ids: ["m1", "m1", "m2"], requires_signature: 0, signature_text: "ignored", due_date: "" }).value;
    expect(v).toEqual({ title: "T", description: "d", audience_kind: "members", audience_group_id: null, audience_member_ids: '["m1","m2"]', requires_signature: 0, signature_text: "", due_date: null });
    expect(formDraft({ title: "T", audience_kind: "weird" }).value.audience_kind).toBe("everyone");
    expect(formDraft({ title: "T", audience_kind: "group", audience_group_id: "g1" }).value.audience_group_id).toBe("g1");
  });
});

describe("question drafts", () => {
  it("validates by type", () => {
    expect(questionDraft({ type: "nope", label: "x" }).error).toMatch(/type/);
    expect(questionDraft({ type: "text", label: "" }).error).toMatch(/label/);
    expect(questionDraft({ type: "choice", label: "Pick", options: "one" }).error).toMatch(/two options/);
    expect(questionDraft({ type: "multi", label: "Pick", options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `o${i}`) }).error).toMatch(/options/);
    expect(questionDraft({ type: "read", label: "Rules" }).error).toMatch(/document step/);
    expect(questionDraft({ type: "read", label: "Rules", link_url: "http://x" }).error).toMatch(/https/);
  });
  it("keeps only the fields its type uses", () => {
    const v = questionDraft({ type: "choice", label: " Pick ", help: "", required: "1", options: "a\n a \nb\n\n", body: "dropped", link_url: "https://dropped" }).value;
    expect(v).toEqual({ type: "choice", label: "Pick", help: "", required: 1, options: '["a","b"]', body: "", link_url: "", file_id: null, file_name: "" });
    const r = questionDraft({ type: "read", label: "Rules", body: "text", link_url: "https://ok" }).value;
    expect(r).toMatchObject({ body: "text", link_url: "https://ok", options: "[]" });
    expect(questionDraft({ type: "read", label: "Rules", link_url: "https://ok" }).value.body).toBe("");
    const doc = questionDraft({ type: "read", label: "Handbook", file_id: UUID, file_name: " handbook.pdf " }).value;
    expect(doc).toMatchObject({ file_id: UUID, file_name: "handbook.pdf", body: "" });
    expect(questionDraft({ type: "read", label: "Handbook", file_id: "../x", file_name: "x" }).error).toMatch(/document step/);
    expect(questionDraft({ type: "text", label: "Name", file_id: UUID, file_name: "x" }).value).toMatchObject({ file_id: null, file_name: "" });
    expect(Object.keys(QUESTION_TYPES)).toEqual(["text", "multiline", "choice", "multi", "yesno", "number", "date", "read", "file"]);
  });
});

describe("answers", () => {
  it("requires an answer only when the question is required", () => {
    expect(cleanAnswer(question({ required: 1 }), "").error).toMatch(/needs an answer/);
    expect(cleanAnswer(question({ required: 0 }), "").value).toBe(null);
    expect(cleanAnswer(question(), "  Alex ").value).toBe("Alex");
  });
  it("holds choices to the options and each type to its shape", () => {
    const choice = question({ type: "choice", options: '["a","b"]' });
    expect(cleanAnswer(choice, "c").error).toMatch(/options/);
    expect(cleanAnswer(choice, "b").value).toBe("b");
    const multi = question({ type: "multi", options: '["a","b"]' });
    expect(cleanAnswer(multi, ["b", "zz"]).value).toEqual(["b"]);
    expect(cleanAnswer(multi, ["zz"]).error).toMatch(/needs an answer/);
    expect(cleanAnswer(question({ type: "signature" }), ["x"]).error).toMatch(/Unknown/);
    expect(cleanAnswer(question({ type: "yesno" }), "maybe").error).toMatch(/needs an answer/);
    expect(cleanAnswer(question({ type: "number" }), "12x").error).toMatch(/number/);
    expect(cleanAnswer(question({ type: "number" }), "12").value).toBe(12);
    expect(cleanAnswer(question({ type: "date" }), "2026-02-30x").error).toMatch(/date/);
    expect(cleanAnswer(question({ type: "read" }), false).error).toMatch(/Confirm/);
    expect(cleanAnswer(question({ type: "read" }), true).value).toBe(true);
    expect(cleanAnswer(question({ type: "read", required: 0 }), false).value).toBe(null);
  });
  it("checks every question in order and drops empties", () => {
    const qs = [question({ id: "q2", position: 1, type: "date", required: 0 }), question({ id: "q1", position: 0 })];
    expect(cleanAnswers(qs, { q1: "" }).error).toMatch(/Name/);
    expect(cleanAnswers(qs, { q1: "Alex", q2: "2026-03-01" }).value.answers).toEqual({ q1: "Alex", q2: "2026-03-01" });
    expect(cleanAnswers(qs, { q1: "Alex" }).value.answers).toEqual({ q1: "Alex" });
  });
  it("needs a typed name and the tick when the form asks for a signature", () => {
    expect(cleanSignature(form({ requires_signature: 0 }), {}).value).toEqual({ signed_name: "", agreed: true });
    expect(cleanSignature(form(), { name: "", agreed: true }).error).toMatch(/name/);
    expect(cleanSignature(form(), { name: "Alex", agreed: false }).error).toMatch(/Tick/);
    expect(cleanSignature(form(), { name: " Alex Doe ", agreed: true }).value.signed_name).toBe("Alex Doe");
  });
  it("renders answers as text", () => {
    expect(answerText(question({ type: "multi" }), ["a", "b"])).toBe("a, b");
    expect(answerText(question({ type: "yesno" }), "yes")).toBe("Yes");
    expect(answerText(question({ type: "read" }), true)).toBe("Read and acknowledged");
    expect(answerText(question(), null)).toBe("");
  });
});

describe("lists", () => {
  it("to do is open forms for me that I have not submitted, due soonest first", () => {
    const forms = [
      form({ id: "a", due_date: "2026-03-01", created_at: "2026-01-01" }),
      form({ id: "b", due_date: null, created_at: "2026-01-05" }),
      form({ id: "c", due_date: "2026-02-01", created_at: "2026-01-02" }),
      form({ id: "d", status: "closed" }),
      form({ id: "e", audience_kind: "members", audience_member_ids: '["m2"]' }),
    ];
    const subs = [{ form_id: "c", member_id: "m1", status: "submitted" }, { form_id: "a", member_id: "m1", status: "draft" }];
    expect(todoForms(forms, subs, "m1", CTX).map(f => f.id)).toEqual(["a", "b"]);
    expect([form({ id: "x", created_at: "2026-01-01" }), form({ id: "y", created_at: "2026-01-02" })].sort(byDueThenNewest).map(f => f.id)).toEqual(["y", "x"]);
  });
  it("finds my submission and overdue forms", () => {
    expect(mySubmission([{ form_id: "f1", member_id: "m1", id: "s" }], "f1", "m1").id).toBe("s");
    expect(mySubmission([], "f1", "m1")).toBe(null);
    expect(isOverdue(form({ due_date: "2026-01-01" }), "2026-01-02")).toBe(true);
    expect(isOverdue(form({ due_date: "2026-01-02" }), "2026-01-02")).toBe(false);
    expect(isOverdue(form({ due_date: "2026-01-01", status: "closed" }), "2026-01-02")).toBe(false);
    expect(searchableFields(form({ description: "d" }))).toEqual(["Pool waiver", "d"]);
    expect(formatDay("2026-03-04")).toMatch(/Mar 4, 2026/);
    expect(formatDay(null)).toBe("");
  });
});

describe("failure lines", () => {
  const err = (status, code) => Object.assign(new Error("hub text"), { status, code });
  it("treats no status, 400, UNIQUE and 5xx (not 507) as unknown outcomes", () => {
    expect(outcomeUnknown(err(0))).toBe(true);
    expect(outcomeUnknown(err(400))).toBe(true);
    expect(outcomeUnknown(err(500))).toBe(true);
    expect(outcomeUnknown(err(400, "UNIQUE_CONSTRAINT"))).toBe(true);
    expect(outcomeUnknown(err(507))).toBe(false);
    expect(outcomeUnknown(err(403))).toBe(false);
  });
  it("picks the line from status, code and the re-read", () => {
    const w = { action: "submit the form", thing: "submission" };
    expect(failureLine(err(403), w)).toBe("You don’t have permission to submit the form.");
    expect(failureLine(null, { ...w, found: true })).toBe("You don’t have permission to submit the form.");
    expect(failureLine(null, { ...w, found: true, guarded: true })).toBe("This submission was changed by someone else — check it first.");
    expect(failureLine(null, { ...w, found: false })).toBe("This submission has been removed.");
    expect(failureLine(null, { ...w, found: null })).toBe("Couldn’t submit the form — try again.");
    expect(failureLine(err(500), w)).toBe("Couldn’t submit the form — try again.");
    expect(uploadFailureLine(err(413))).toBe("That file is too large.");
    expect(uploadFailureLine(err(500))).toBe("Couldn’t attach that document — try again.");
  });
});

describe("copies that arrived while the form was closed", () => {
  const sub = (submitted_at) => ({ submitted_at });
  it("marks a copy after the current close, and only a submitted one", () => {
    const form = { closed_at: "2026-03-01T10:00:00.000Z", closed_windows: "[]" };
    expect(submittedWhileClosed(form, sub("2026-03-01T10:00:00.500Z"))).toBe(true);
    expect(submittedWhileClosed(form, sub("2026-03-01T09:59:59.000Z"))).toBe(false);
    expect(submittedWhileClosed(form, sub(null))).toBe(false);
  });
  it("keeps the mark through a reopen: the closed spell is in closed_windows", () => {
    const form = { closed_at: null, closed_windows: JSON.stringify([["2026-03-01T10:00:00.000Z", "2026-03-02T08:00:00.000Z"]]) };
    expect(submittedWhileClosed(form, sub("2026-03-01T12:00:00.000Z"))).toBe(true);
    // Before the close and after the reopen are both on time.
    expect(submittedWhileClosed(form, sub("2026-03-01T09:00:00.000Z"))).toBe(false);
    expect(submittedWhileClosed(form, sub("2026-03-02T09:00:00.000Z"))).toBe(false);
  });
  it("compares times, not text: a time without milliseconds still orders", () => {
    const form = { closed_at: "2026-01-02T00:00:00Z", closed_windows: "[]" };
    expect(submittedWhileClosed(form, sub("2026-01-02T00:00:00.500Z"))).toBe(true);
    expect(submittedWhileClosed(form, sub("not a time"))).toBe(false);
  });
  it("reads a time with no zone as UTC, as the hub writes, whatever this device's zone", () => {
    const form = { closed_at: "2026-01-01T12:00:00", closed_windows: "[]" };
    expect(submittedWhileClosed(form, sub("2026-01-01T13:00:00.000Z"))).toBe(true);
    expect(submittedWhileClosed(form, sub("2026-01-01T11:00:00.000Z"))).toBe(false);
    expect(submittedWhileClosed({ closed_at: "2026-01-01T12:00:00+02:00" }, sub("2026-01-01T10:30:00Z"))).toBe(true);
  });
  it("the page's copy of a reopen keeps the spell it ended", () => {
    const form = { closed_at: "2026-03-01T10:00:00.000Z", closed_windows: "[]" };
    const reopened = { closed_at: null, closed_windows: endClosedSpell(form, "2026-03-02T08:00:00.000Z") };
    expect(submittedWhileClosed(reopened, sub("2026-03-01T12:00:00.000Z"))).toBe(true);
    // Nothing to end: the history is kept as it was.
    expect(endClosedSpell({ closed_at: null, closed_windows: reopened.closed_windows }, "x")).toBe(reopened.closed_windows);
    expect(endClosedSpell({ closed_at: null, closed_windows: "garbage" }, "x")).toBe("[]");
  });
  it("reads a damaged closed_windows as no history, never as a throw", () => {
    for (const closed_windows of ["not json", "{}", "[[1, 2]]", null, undefined]) {
      expect(submittedWhileClosed({ closed_at: null, closed_windows }, sub("2026-03-01T12:00:00.000Z"))).toBe(false);
    }
  });
});

describe("the statements the page sends", () => {
  it("open and submit are guarded on the state they leave", () => {
    expect(OPEN_FORM_SQL).toMatch(/WHERE id = \? AND status = 'draft'$/);
    expect(SUBMIT_SQL).toContain("signed_text = ?");
    expect(SUBMIT_SQL).toMatch(/WHERE id = \? AND status = 'draft' AND revision = \?$/);
    expect(SUBMIT_SIGNED_SQL).toMatch(/WHERE id = \? AND status = 'draft' AND revision = \?$/);
    expect(CLOSE_FORM_SQL).toMatch(/AND status = 'open'$/);
    expect(REOPEN_FORM_SQL).toMatch(/AND status = 'closed'$/);
    expect(ARCHIVE_FORM_SQL).toMatch(/status IN \('open', 'closed'\)$/);
  });
  it("reopening, and opening a draft that was once closed, record the closed spell they end", () => {
    for (const sql of [REOPEN_FORM_SQL, OPEN_FORM_SQL]) expect(sql).toContain("closed_at = NULL");
    expect(OPEN_FORM_SQL).toContain("json_insert(");
    expect(OPEN_FORM_SQL.split("?").length - 1).toBe(3);
    expect(REOPEN_FORM_SQL).toContain("json_insert(CASE WHEN json_valid(closed_windows) THEN closed_windows ELSE '[]' END, '$[#]', json_array(closed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))");
    // Bound: updated_at, id.
    expect(REOPEN_FORM_SQL.split("?").length - 1).toBe(2);
    expect(manifest.db_plaintext_columns).toContain("closed_windows");
  });
  it("closing writes the share cutoff from the hub's clock and never a future one", () => {
    expect(CLOSE_FORM_SQL).toContain("closes_at = MIN(COALESCE(closes_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
    expect(ARCHIVE_FORM_SQL).toContain("closes_at = MIN(COALESCE(closes_at");
    expect(manifest.shareable.form.submit.until_column).toBe("closes_at");
  });
  it("submitting stamps its times from the hub's clock, the one closed_at uses", () => {
    const hub = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    for (const sql of [SUBMIT_SQL, SUBMIT_SIGNED_SQL]) {
      expect(sql).toContain(`submitted_at = ${hub}`);
      expect(sql).toContain(`updated_at = ${hub}`);
      // Bound: answers, file_ids, signed_name, signed_text, terms_hash, id and
      // the revision the answers rest on. No new time.
      expect(sql.split("?").length - 1).toBe(7);
    }
    expect(SUBMIT_SIGNED_SQL).toContain(`signed_at = ${hub}`);
    expect(SUBMIT_SQL).toContain("signed_at = NULL");
  });
  it("scenarios.json replays the page's exact open and submit statements", () => {
    const all = JSON.stringify(scenarios);
    expect(all).toContain(JSON.stringify(OPEN_FORM_SQL).slice(1, -1));
    expect(all).toContain(JSON.stringify(SUBMIT_SQL).slice(1, -1));
    expect(all).toContain(JSON.stringify(SUBMIT_SIGNED_SQL).slice(1, -1));
    expect(all).toContain(JSON.stringify(CLOSE_FORM_SQL).slice(1, -1));
    expect(all).toContain(JSON.stringify(REOPEN_FORM_SQL).slice(1, -1));
  });
  it("the page uses the exported statements, not copies", () => {
    for (const name of ["OPEN_FORM_SQL", "CLOSE_FORM_SQL", "REOPEN_FORM_SQL", "ARCHIVE_FORM_SQL", "SUBMIT_SQL", "SUBMIT_SIGNED_SQL", "SAVE_DRAFT_SQL"]) expect(html).toContain(name);
  });
});

describe("schema and manifest agree", () => {
  it("question types in the CHECK are the types the page offers", () => {
    const m = migration.match(/type IN \(([^)]*)\)/);
    const checked = m[1].split(",").map(s => s.trim().replace(/'/g, ""));
    expect(checked.sort()).toEqual(Object.keys(QUESTION_TYPES).sort());
  });
  it("submissions are owned, one per member per form, frozen once submitted and readable only by reviewers", () => {
    const p = manifest.row_policies.submissions;
    expect(p.kind).toBe("owner_or_visibility");
    expect(p.write_owner_only).toBe(true);
    expect(p.everyone_values).toEqual([]);
    expect(p.adult_values).toEqual([]);
    expect(p.privileged_values).toEqual(["submitted"]);
    expect(p.privileged_groups).toEqual([{ settings_table: "settings", settings_key: "reviewers_group_id", actions: ["select"] }]);
    expect(p.max_per_member).toEqual({ member_column: "member_id", scope_columns: ["form_id"], limit: 1 });
    expect(p.frozen_when).toEqual({ status_column: "status", locked_values: ["submitted"] });
    expect(migration).toMatch(/UNIQUE \(form_id, member_id\)/);
  });
  it("questions freeze once the form leaves draft", () => {
    expect(manifest.row_policies.questions.frozen_when).toEqual({ parent_table: "forms", fk_column: "form_id", status_column: "status", locked_values: ["open", "closed", "archived"] });
    expect(manifest.row_policies.questions.steward_writes_only).toBe(true);
    expect(manifest.row_policies.forms.steward_writes_only).toBe(true);
  });
  it("a read step's document is uploaded by builders and opened by every member", () => {
    expect(manifest.file_columns.questions).toEqual({ columns: ["file_id"] });
    expect(manifest.delete_cascades.forms.find(c => c.table === "questions").file_id_column).toBe("file_id");
    // Builder uploads name no scope, so they land in the default one.
    expect(manifest.file_acls.read).toBe("scoped");
    expect(manifest.file_acls.default_scope).toBe("documents");
    expect(manifest.file_acls.scopes.documents).toEqual({ write: { require_role: "adult", roster_steward_only: true }, read: "members" });
  });
  it("a member's attachment is opened by them and the same reviewers group that reads submitted copies", () => {
    expect(ANSWER_FILE_SCOPE).toBe("answers");
    const scope = manifest.file_acls.scopes[ANSWER_FILE_SCOPE];
    // No write rule: any member answering may attach.
    expect(scope).toEqual({ read: { uploader: true, require_group_setting: { settings_table: "settings", settings_key: "reviewers_group_id" } } });
    const reviewers = manifest.row_policies.submissions.privileged_groups[0];
    expect(scope.read.require_group_setting).toEqual({ settings_table: reviewers.settings_table, settings_key: reviewers.settings_key });
    // Named by the row's file list, so the hub deletes a file the draft drops.
    expect(manifest.file_columns.submissions).toEqual({ list_columns: ["file_ids"] });
    expect(migration).toMatch(/file_ids\s+TEXT NOT NULL DEFAULT '\[\]'/);
    expect(html).toContain("scope: ANSWER_FILE_SCOPE");
  });
  it("never takes signed copies with a deleted form", () => {
    // A cascade runs as trusted engine statements, past the submissions'
    // freeze; a raw DELETE of an opened form must leave every signed copy.
    expect(manifest.delete_cascades.forms.map(c => c.table)).not.toContain("submissions");
  });
  it("a question dialog mid-save cannot be closed or acted on, so its upload is never deleted under it", () => {
    // closeModal, the click handler, and the signed-copy viewer that opens a dialog after a load.
    expect(html.match(/if \(modalEl\?\.dataset\.saving\) return;/g)).toHaveLength(3);
    // A stale edit never writes back a document another builder replaced.
    expect(html).toContain("WHERE id = ? AND file_id IS ?`");
    // An add that landed becomes an edit of its row, never a second insert.
    expect(html).toContain("if (btn) btn.dataset.id = row.id;");
    expect(html).toContain("if (v.file_id && v.file_id === host.dataset.uploadedFileId) host.dataset.uploadedFileId = \"\";");
  });
  it("never records a statement the member did not see, and never loses a member's own row", () => {
    // A statement that changed since it was shown stops the submit and asks again.
    expect(html).toContain("|| (signs && (state.signature_text ?? \"\") !== (form.signature_text ?? \"\"))) {");
    expect(html).toContain("if (Number(state.requires_signature) !== Number(form.requires_signature)");
    // Every live form, every submission of mine and every submission to a
    // form a reviewer opens are loaded, page by page, through one helper;
    // recovery reads one form's row directly.
    expect(html.match(/while \(rows\?\.length === PAGE\) \{/g)).toHaveLength(1);
    expect(html.match(/await readAllById\(/g)).toHaveLength(3);
    // Each statement read in full ends with the page size.
    for (const sql of html.match(/`SELECT [^`]*ORDER BY id ASC LIMIT \d+`/g)) expect(sql).toMatch(/LIMIT 200`$/);
    // "Show older" ignores a second press while a page is loading.
    expect(html).toContain("if (loadingMore.has(key)) return;");
    expect(html).not.toMatch(/FROM app_forms__submissions WHERE form_id = \? ORDER BY submitted_at/);
    // Intake pages with "Show older" instead of stopping at a fixed count.
    expect(html).not.toContain("LIMIT 500");
    expect(html).toContain('data-action="intake-more"');
    // Every paged statement's literal LIMIT is the page size.
    expect(html).toContain("const PAGE = 200;");
    // A reorder swaps both rows or neither.
    // A reorder is a guarded three-step swap through a free position, all or nothing.
    expect(html).toContain("const move = `UPDATE app_forms__questions SET position = ? WHERE id = ? AND position = ?`;");
    expect(html.match(/\{ sql: move, params: \[[^\]]+\], requireChanges: true \}/g)).toHaveLength(3);
    // The free position is random, so two builders' swaps never take the same one.
    expect(html).toContain("const parked = -1 - Math.floor(Math.random() * 1e9);");
    expect(migration).toContain("UNIQUE (form_id, position)");
    // A search of a partly loaded archive says so and keeps "Show older".
    expect(html).toContain('data-testid="archive-partial"');
    expect(html).not.toContain("archiveCursor && !searchQ");
    expect(html).not.toMatch(/await loadMine\(\);\s*(sub|const again) = mySubmission/);
    // An archived form's signed copy stays reachable for its signer.
    // A save closes only its own dialog: one that finishes after the user
    // moved on to another must leave that one, its edits and its upload alone.
    expect(html).toContain("if (only !== undefined && modalEl !== only) return;");
    expect(html.match(/closeModal\(host\)/g)).toHaveLength(4);
    // The unconditional close is for opening a new dialog, the backdrop and the close button only.
    expect(html.match(/closeModal\(\)/g)).toHaveLength(3);
    // A retried create that finds its row already there writes the dialog's
    // values onto it and shows the stored row, never values it did not save.
    expect(html).toContain("const { changed } = await db(UPDATE_FORM_SQL, updateFormParams(v, now, id));");
    expect(html).toContain("forms = [stored ?? { id, ...v,");
    // A printed copy starts on the first page: the app leaves the print layout.
    expect(html).toContain("body > *:not(.modal-backdrop) { display: none !important; }");
    expect(html).not.toContain("visibility: hidden");
    // The signer types their name: the box is never filled in for them.
    expect(html).toContain('value="${esc(fillState.signature.name ?? "")}"');
    // One notice for a submitted copy, whatever the form's state since.
    expect(html.match(/data-testid="submitted-notice"/g)).toHaveLength(1);
    expect(html).toContain('if (sub?.status === "submitted") {');
  });
  it("escapes a question id wherever it lands in markup", () => {
    expect(html).toContain("const id = `ans-${esc(q.id)}`;");
  });
  it("reads the admitted member set for completeness", () => {
    expect(manifest.data_access.reads).toContain("family.app_members");
    expect(manifest.data_access.reads).toContain("family.groups");
  });
});

describe("attached files", () => {
  const fileQ = { id: "qf", type: "file", label: "Photo ID", required: 1, position: 2 };
  const optionalQ = { ...fileQ, id: "qo", required: 0, position: 3 };
  const textQ = { id: "qt", type: "text", label: "Name", required: 0, position: 1 };

  it("an answer is a stored file: its id and name, nothing else", () => {
    expect(attachedFile({ file_id: UUID, name: " id.pdf ", extra: 1 })).toEqual({ file_id: UUID, name: "id.pdf" });
    expect(attachedFile({ file_id: "not-an-id", name: "x" })).toBeNull();
    expect(attachedFile(UUID)).toBeNull();
    expect(attachedFile(null)).toBeNull();
  });

  it("a required file question needs one, and an optional one may stay empty", () => {
    expect(cleanAnswer(fileQ, null)).toEqual({ error: 'Attach a file for "Photo ID".' });
    expect(cleanAnswer(fileQ, { file_id: "nope" })).toEqual({ error: 'Attach a file for "Photo ID".' });
    expect(cleanAnswer(fileQ, { file_id: UUID, name: "id.pdf" })).toEqual({ value: { file_id: UUID, name: "id.pdf" } });
    expect(cleanAnswer(optionalQ, null)).toEqual({ value: null });
  });

  it("the row's file list is the files the answers name, in question order, once each", () => {
    const answers = { qo: { file_id: UUID_2, name: "b" }, qf: { file_id: UUID, name: "a" }, qt: UUID };
    expect(answerFileIds([optionalQ, textQ, fileQ], answers)).toEqual([UUID, UUID_2]);
    expect(answerFileIds([fileQ, optionalQ], { qf: { file_id: UUID }, qo: { file_id: UUID } })).toEqual([UUID]);
    // A text answer that looks like an id is not a file.
    expect(answerFileIds([textQ], { qt: UUID })).toEqual([]);
    expect(answerFileIds(null, null)).toEqual([]);
  });

  it("reads back as the file's name", () => {
    expect(answerText(fileQ, { file_id: UUID, name: "id.pdf" })).toBe("id.pdf");
    expect(answerText(fileQ, { file_id: UUID, name: "" })).toBe("Attached file");
    expect(answerText(fileQ, { file_id: "x" })).toBe("");
  });

  it("a draft save and a submit write the answers and the files they name together", () => {
    expect(SAVE_DRAFT_SQL).toBe("UPDATE app_forms__submissions SET answers = ?, file_ids = ?, updated_at = ?, revision = ? WHERE id = ? AND status = 'draft' AND revision = ?");
    // Both refuse a tab holding an older draft, which would drop files attached
    // since. On a random revision: two tabs can save in the same millisecond.
    for (const sql of [SAVE_DRAFT_SQL, SUBMIT_SQL, SUBMIT_SIGNED_SQL]) expect(sql).toMatch(/AND revision = \?$/);
    expect(manifest.db_plaintext_columns).toContain("revision");
    expect(migration).toMatch(/revision\s+TEXT NOT NULL DEFAULT ''/);
    // The scenarios run the page's own statement against the hub.
    expect(JSON.stringify(scenarios)).toContain(JSON.stringify(SAVE_DRAFT_SQL).slice(1, -1));
    for (const sql of [SUBMIT_SQL, SUBMIT_SIGNED_SQL]) expect(sql).toContain("answers = ?, file_ids = ?, signed_name = ?");
  });

  it("an upload failure says what failed", () => {
    expect(uploadFailureLine({ status: 413 }, { action: "attach that file", thing: "file" })).toBe("That file is too large.");
    expect(uploadFailureLine({ status: 0 }, { action: "attach that file", thing: "file" })).toBe("Couldn’t attach that file — try again.");
  });
});
