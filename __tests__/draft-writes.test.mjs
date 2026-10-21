// The page's own draft-saving code (src/index.html, from ensureDraftRow to
// removeAnswerFile, plus loadMineFor) run as two tabs against one stored row.
// Every tab saves within the same millisecond here, as tabs really can, so a
// guard on a timestamp would pass. The fake store does what the hub does with
// an answers file: an UPDATE that stops naming it leaves it alone, and a
// delete is refused (403) while the row names it. Each test is a way a tab
// once wrote answers from before another tab's save over it.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import vm from "vm";
import { describe, it, expect } from "vitest";
import * as logic from "../src/logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

function slice(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`cannot find ${start}`);
  return html.slice(from, to);
}
const PAGE_CODE = slice("async function loadMineFor(formId) {", "\n}\n") + "\n}\n"
  + slice("async function ensureDraftRow(form) {", "async function submitForm(formId) {");

const FORM = { id: "f1", status: "open" };
const QUESTIONS = [
  { id: "q1", type: "file", label: "ID", required: 0, position: 1 },
  { id: "q2", type: "file", label: "Certificate", required: 0, position: 2 },
  { id: "q3", type: "text", label: "Note", required: 0, position: 3 },
];
const fileA = "11111111-1111-4111-8111-111111111111";
const fileB = "22222222-2222-4222-8222-222222222222";

/** The stored submissions table, shared by every tab. */
function makeStore() {
  const store = { row: null, deleted: new Set(), failNext: new Map() };
  let clock = 0;
  store.tick = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();
  store.db = (tab) => async (sql, params) => {
    const failure = store.failNext.get(tab);
    if (failure && sql.startsWith(failure.verb)) {
      store.failNext.delete(tab);
      throw Object.assign(new Error("network"), { status: 0 });
    }
    if (sql.startsWith("SELECT * FROM app_forms__submissions")) return { rows: store.row ? [{ ...store.row }] : [] };
    if (sql.startsWith("INSERT INTO app_forms__submissions")) {
      if (store.row) throw Object.assign(new Error("UNIQUE constraint failed"), { status: 400 });
      const [id, , member, created, updated, revision] = params;
      store.row = { id, form_id: "f1", member_id: member, status: "draft", answers: "{}", file_ids: "[]", created_at: created, updated_at: updated, revision };
      return { changed: 1 };
    }
    if (sql === logic.SAVE_DRAFT_SQL) {
      const [answers, fileIds, now, revision, id, expected] = params;
      const row = store.row;
      if (!row || row.id !== id || row.status !== "draft" || row.revision !== expected) return { changed: 0 };
      Object.assign(row, { answers, file_ids: fileIds, updated_at: now, revision });
      return { changed: 1 };
    }
    throw new Error(`unexpected statement ${sql}`);
  };
  return store;
}

/** One tab: the page's functions over its own state, against the store. */
function openTab(store, name) {
  const context = {
    console: { error() {} },
    crypto: globalThis.crypto,
    document: { querySelector: () => null },
    DB: "db",
    ME: { id: "m1" },
    view: { kind: "form", id: "f1" },
    forms: [FORM],
    mine: store.row ? [{ ...store.row }] : [],
    questionsByForm: new Map([["f1", QUESTIONS]]),
    questionsFailed: new Set(),
    fillState: { formId: "f1", answers: {}, signature: { name: null, agreed: false }, error: "", uploading: new Set() },
    db: store.db(name),
    files: {
      uploads: [],
      async upload(file) { return { id: file.id, name: file.name }; },
      async delete(id) {
        if (logic.parseStrings(store.row?.file_ids).includes(id)) throw Object.assign(new Error("named"), { status: 403 });
        store.deleted.add(id);
      },
    },
    render() {},
    toast() {},
    collectAnswers() { return context.fillState.answers; },
    formById: (list, id) => list.find((f) => f.id === id) ?? null,
    userError: (msg) => Object.assign(new Error(msg), { forUser: true }),
    ANSWER_FILE_SCOPE: logic.ANSWER_FILE_SCOPE,
    ...Object.fromEntries(["SAVE_DRAFT_SQL", "parseObject", "parseStrings", "attachedFile", "answerFileIds",
      "mySubmission", "outcomeUnknown", "failureLine", "uploadFailureLine"].map((k) => [k, logic[k]])),
  };
  vm.createContext(context);
  const api = vm.runInContext(`${PAGE_CODE}
    ({ attachAnswerFile, removeAnswerFile, saveDraft, draftBases,
       open() {
         const sub = mySubmission(mine, "f1", ME.id);
         fillState.answers = sub ? parseObject(sub.answers) : {};
         if (sub) draftBases.set("f1", sub.revision ?? ""); else draftBases.delete("f1");
       } })`, context);
  api.open();
  const pick = (id, name) => ({ files: [{ id, name }] });
  return {
    context,
    attach: (q, id) => api.attachAnswerFile("f1", q, pick(id, `${q}.pdf`)),
    remove: (q) => api.removeAnswerFile("f1", q),
    save: () => api.saveDraft("f1"),
    answers: () => context.fillState.answers,
    error: () => context.fillState.error,
  };
}

function seed(store, answers = {}) {
  const now = store.tick();
  store.row = {
    id: "s1", form_id: "f1", member_id: "m1", status: "draft",
    answers: JSON.stringify(answers), file_ids: JSON.stringify(logic.answerFileIds(QUESTIONS, answers)),
    created_at: now, updated_at: now, revision: "r0",
  };
}

describe("letting go of files", () => {
  it("deletes a replaced or removed file only once the saved draft no longer names it", async () => {
    const store = makeStore();
    seed(store);
    const one = openTab(store, "one");
    await one.attach("q1", fileA);
    await one.attach("q1", fileB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.deleted.has(fileA)).toBe(true);
    expect(logic.parseStrings(store.row.file_ids)).toEqual([fileB]);
    await one.remove("q1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.deleted.has(fileB)).toBe(true);
    expect(logic.parseStrings(store.row.file_ids)).toEqual([]);
  });

  it("lets a new file go when its save definitely failed", async () => {
    const store = makeStore();
    seed(store);
    const one = openTab(store, "one");
    const db = one.context.db;
    one.context.db = async (sql, params) => {
      if (sql === logic.SAVE_DRAFT_SQL) { one.context.db = db; throw Object.assign(new Error("refused"), { status: 403 }); }
      return db(sql, params);
    };
    await one.attach("q1", fileA);
    expect(store.deleted.has(fileA)).toBe(true);
    expect(one.answers().q1).toBeFalsy();
    expect(one.error()).not.toBe("");
  });

  it("never leaves a saved draft naming a deleted file when another save races a failed attach", async () => {
    const store = makeStore();
    seed(store, { q2: { file_id: fileB, name: "b" } });
    const one = openTab(store, "one");
    const db = one.context.db;
    let removal;
    one.context.db = async (sql, params) => {
      if (sql === logic.SAVE_DRAFT_SQL && !removal) {
        // The member removes the other file while this save is failing.
        removal = one.remove("q2");
        throw Object.assign(new Error("refused"), { status: 403 });
      }
      return db(sql, params);
    };
    await one.attach("q1", fileA);
    await removal;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The removal was queued while the attach's save was in flight, holding
    // the new file: it landed naming it, so the delete was refused and the
    // file is back on the answer. Never a saved draft naming a deleted file.
    expect(logic.parseStrings(store.row.file_ids)).toEqual([fileA]);
    expect(store.deleted.has(fileA)).toBe(false);
    expect(one.answers().q1?.file_id).toBe(fileA);
    expect(store.deleted.has(fileB)).toBe(true);
  });

  it("does not put back a file whose delete's answer was lost: it may be gone", async () => {
    const store = makeStore();
    seed(store);
    const one = openTab(store, "one");
    const db = one.context.db;
    one.context.db = async (sql, params) => {
      if (sql === logic.SAVE_DRAFT_SQL) { one.context.db = db; throw Object.assign(new Error("refused"), { status: 403 }); }
      return db(sql, params);
    };
    const remove = one.context.files.delete;
    one.context.files.delete = async (id) => { await remove(id); throw new TypeError("Failed to fetch"); };
    await one.attach("q1", fileA);
    expect(store.deleted.has(fileA)).toBe(true);
    expect(one.answers().q1).toBeFalsy();
    await one.save();
    expect(logic.parseStrings(store.row.file_ids)).not.toContain(fileA);
  });

  it("a failed removal never puts the old file back over one attached since", async () => {
    const store = makeStore();
    seed(store, { q1: { file_id: fileA, name: "a" } });
    const one = openTab(store, "one");
    const db = one.context.db;
    let replacement;
    one.context.db = async (sql, params) => {
      if (sql === logic.SAVE_DRAFT_SQL && !replacement) {
        // The member attaches a replacement while the removal's save is in flight.
        replacement = one.attach("q1", fileB);
        throw Object.assign(new Error("refused"), { status: 403 });
      }
      return db(sql, params);
    };
    await one.remove("q1");
    await replacement;
    expect(one.answers().q1?.file_id).toBe(fileB);
    expect(logic.parseStrings(store.row.file_ids)).toEqual([fileB]);
    await one.save();
    expect(logic.parseStrings(store.row.file_ids)).toEqual([fileB]);
  });

  it("a failed removal never brings a file back after a later attach and remove", async () => {
    const store = makeStore();
    seed(store, { q1: { file_id: fileA, name: "a" } });
    const one = openTab(store, "one");
    const db = one.context.db;
    // The first removal's save is held, then refused.
    let fail;
    let first = true;
    one.context.db = async (sql, params) => {
      if (sql === logic.SAVE_DRAFT_SQL && first) {
        first = false;
        await new Promise((_, reject) => { fail = () => reject(Object.assign(new Error("refused"), { status: 403 })); });
      }
      return db(sql, params);
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const removingA = one.remove("q1");
    await tick();
    // While it is held: attach B, then remove B.
    const attachingB = one.attach("q1", fileB);
    await tick();
    expect(one.answers().q1?.file_id).toBe(fileB);
    const removingB = one.remove("q1");
    expect(one.answers().q1).toBeNull();
    fail();
    await Promise.all([removingA, attachingB, removingB]);
    expect(one.answers().q1).toBeFalsy();
    await one.save();
    expect(logic.parseStrings(store.row.file_ids)).toEqual([]);
  });

  it("keeps a new file whose save landed though its answer was lost", async () => {
    const store = makeStore();
    seed(store);
    const one = openTab(store, "one");
    const db = one.context.db;
    one.context.db = async (sql, params) => {
      const result = await db(sql, params);
      if (sql === logic.SAVE_DRAFT_SQL) { one.context.db = db; throw Object.assign(new Error("lost"), { status: 0 }); }
      return result;
    };
    await one.attach("q1", fileA);
    expect(one.error()).toBe("");
    expect(store.deleted.has(fileA)).toBe(false);
    expect(logic.parseStrings(store.row.file_ids)).toEqual([fileA]);
  });
});

describe("draft writes across two tabs", () => {
  it("after a failed save, the next save takes the other tab's save and keeps its file", async () => {
    const store = makeStore();
    seed(store);
    const one = openTab(store, "one");
    const two = openTab(store, "two");
    await two.attach("q1", fileA);
    expect(store.deleted.has(fileA)).toBe(false);

    // Tab one's save is lost on the way, so whether it landed is unknown:
    // the file stays on the answer.
    store.failNext.set("one", { verb: "UPDATE" });
    await one.attach("q2", fileB);
    expect(store.deleted.has(fileB)).toBe(false);
    expect(one.answers().q2?.file_id).toBe(fileB);

    // Its next save is refused and takes tab two's, letting go of the file
    // the stored draft does not name.
    await one.save();
    expect(one.error()).toMatch(/another tab/);
    expect(one.answers().q1?.file_id).toBe(fileA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.deleted.has(fileB)).toBe(true);
    await one.save();
    expect(store.deleted.has(fileA)).toBe(false);
    expect(logic.parseStrings(store.row.file_ids)).toContain(fileA);
  });

  it("a failed removal keeps the file, and the next save does the same", async () => {
    const store = makeStore();
    seed(store, { q2: { file_id: fileB, name: "b" } });
    const one = openTab(store, "one");
    const two = openTab(store, "two");
    await two.attach("q1", fileA);

    // The removal is lost: the file stays, on screen and stored.
    store.failNext.set("one", { verb: "UPDATE" });
    await one.remove("q2");
    expect(one.answers().q2?.file_id).toBe(fileB);
    expect(store.deleted.has(fileB)).toBe(false);
    await one.save();
    expect(one.answers().q1?.file_id).toBe(fileA);
    await one.save();
    expect(store.deleted.has(fileA)).toBe(false);
  });

  it("a tab whose first save collides with the other tab's new draft takes it rather than writing over it", async () => {
    const store = makeStore();
    const one = openTab(store, "one");
    const two = openTab(store, "two");
    await two.attach("q1", fileA);
    expect(store.row.file_ids).toContain(fileA);

    await one.save();
    expect(one.error()).toMatch(/another tab/);
    expect(store.deleted.has(fileA)).toBe(false);
    expect(one.answers().q1?.file_id).toBe(fileA);
    await one.save();
    expect(store.deleted.has(fileA)).toBe(false);
  });

  it("a plain save from a tab holding an older draft is refused and takes the stored one", async () => {
    const store = makeStore();
    seed(store);
    const one = openTab(store, "one");
    const two = openTab(store, "two");
    await two.attach("q1", fileA);
    await one.save();
    expect(store.deleted.has(fileA)).toBe(false);
    expect(one.answers().q1?.file_id).toBe(fileA);
  });

  it("a draft created by a lost insert is reconciled with what another tab saved on it meanwhile", async () => {
    const store = makeStore();
    const one = openTab(store, "one");
    let two;
    // Tab one's INSERT lands, its answer is lost, and before tab one reads it
    // back, tab two opens the new draft and attaches a file to it.
    const db = one.context.db;
    one.context.db = async (sql, params) => {
      const result = await db(sql, params);
      if (sql.startsWith("INSERT INTO app_forms__submissions")) {
        two = openTab(store, "two");
        await two.attach("q1", fileA);
        throw Object.assign(new Error("lost"), { status: 0 });
      }
      return result;
    };
    await one.attach("q2", fileB);
    expect(store.deleted.has(fileA)).toBe(false);
    expect(one.answers().q1?.file_id).toBe(fileA);
    expect(one.error()).toMatch(/another tab/);
    await one.save();
    expect(store.deleted.has(fileA)).toBe(false);
    expect(logic.parseStrings(store.row.file_ids)).toContain(fileA);
  });

  it("a lost insert nobody else touched carries on as the page's own draft", async () => {
    const store = makeStore();
    const one = openTab(store, "one");
    const db = one.context.db;
    one.context.db = async (sql, params) => {
      const result = await db(sql, params);
      if (sql.startsWith("INSERT INTO app_forms__submissions")) throw Object.assign(new Error("lost"), { status: 0 });
      return result;
    };
    await one.attach("q1", fileA);
    expect(one.error()).toBe("");
    expect(logic.parseStrings(store.row.file_ids)).toEqual([fileA]);
  });

  it("a write whose answer was lost but landed becomes the base, and the next save goes through", async () => {
    const store = makeStore();
    seed(store);
    const one = openTab(store, "one");
    // The UPDATE lands, then the reply is lost.
    const db = one.context.db;
    let lose = true;
    one.context.db = async (sql, params) => {
      const result = await db(sql, params);
      if (lose && sql === logic.SAVE_DRAFT_SQL) { lose = false; throw Object.assign(new Error("lost"), { status: 0 }); }
      return result;
    };
    await one.attach("q1", fileA);
    expect(store.deleted.has(fileA)).toBe(false);
    expect(one.error()).not.toMatch(/another tab/);
    await one.save();
    expect(one.error()).toBe("");
    expect(logic.parseStrings(store.row.file_ids)).toEqual([fileA]);
  });
});
