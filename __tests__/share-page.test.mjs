import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

/**
 * The intake link is rendered by the hub from `shareable`, and member row
 * policies do not apply to a visitor. These checks pin the declarations that
 * keep members' answers off the page and a visitor's row honest.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));

const migrationsDir = join(__dirname, "../migrations");
const schema = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf-8"))
  .join("\n");

function columnsOf(table) {
  const body = schema.match(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?app_[a-z0-9_]+__${table}\\s*\\(([\\s\\S]*?)\\n\\);`));
  expect(body, `no CREATE TABLE for ${table}`).toBeTruthy();
  const created = body[1].split("\n")
    .map((line) => line.trim().match(/^([a-z_]+)\s+(TEXT|INTEGER|REAL|BLOB)\b/i))
    .filter(Boolean).map((m) => m[1]);
  const altered = [...schema.matchAll(new RegExp(`ALTER TABLE app_[a-z0-9_]+__${table} ADD COLUMN ([a-z_]+)\\b`, "g"))].map((m) => m[1]);
  return [...created, ...altered];
}

const item = manifest.shareable.form;
const submit = item.submit;
const plaintext = new Set(manifest.db_plaintext_columns);

describe("what a visitor reads", () => {
  it("shares one item type, the form", () => {
    expect(Object.keys(manifest.shareable)).toEqual(["form"]);
  });
  it("resolves only while the form is open", () => {
    expect(item.visible_where).toEqual({ column: "status", values: ["open"] });
  });
  it("projects only the title and description, never the questions, answers or members", () => {
    expect(item.table).toBe("forms");
    expect(item.columns.map((c) => c.column)).toEqual(["description"]);
    expect(item.feeds).toBeUndefined();
    for (const column of [item.title_column, item.visible_where.column, ...item.columns.map((c) => c.column)]) {
      expect(columnsOf("forms")).toContain(column);
    }
  });
});

describe("what a visitor writes", () => {
  it("lands in the intake table, not in submissions", () => {
    expect(submit.table).toBe("intake");
    expect(submit.fk_column).toBe("form_id");
    expect(submit.fixed_values).toEqual({ source: "external" });
    expect(submit.timestamp_columns).toEqual(["created_at"]);
  });
  it("every column the hub writes is a real plaintext column", () => {
    const columns = columnsOf("intake");
    const written = [...submit.fields.map((f) => f.column), ...Object.keys(submit.fixed_values), ...submit.timestamp_columns, submit.fk_column];
    for (const column of written) expect(columns, column).toContain(column);
    for (const column of [...submit.fields.map((f) => f.column), ...Object.keys(submit.fixed_values)]) {
      expect(plaintext.has(column), `${column} must be in db_plaintext_columns`).toBe(true);
    }
  });
  it("names the guest columns guest_* so no member answer shares a plaintext name", () => {
    for (const f of submit.fields) expect(f.column).toMatch(/^guest_/);
    for (const column of ["answers", "signed_name", "title", "label", "body"]) expect(plaintext.has(column)).toBe(false);
  });
  it("closes with the form's cutoff and is capped per link and per table", () => {
    expect(submit.until_column).toBe("closes_at");
    expect(submit.max_submissions).toBe(200);
    expect(manifest.row_policies.intake.max_rows).toBe(5000);
    expect(manifest.row_policies.intake.audit_writes).toBe(true);
  });
  it("only adults read a visitor's contact details, the steward alone in a roster", () => {
    // steward_reads_only is roster-gated; adult_only is what keeps children
    // out in a household or a general space.
    expect(manifest.row_policies.intake.kind).toBe("adult_only");
    expect(manifest.row_policies.intake.steward_reads_only).toBe(true);
    expect(manifest.row_policies.intake.steward_writes_only).toBe(true);
  });
  it("members cannot write a row that looks like a visitor's", () => {
    const acls = manifest.row_policies.intake.column_write_acls;
    for (const column of ["form_id", "guest_name", "guest_email", "guest_phone", "guest_note", "source", "created_at"]) {
      expect(acls[column], column).toEqual({ writable_by: [] });
    }
  });
});
