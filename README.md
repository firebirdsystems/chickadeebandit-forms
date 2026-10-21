# Forms

A [Chickadee Bandit](https://chickadeebandit.com/app-library/forms) app.

Questionnaires, waivers and welcome packets. Build a form from questions, documents to read and acknowledge (an uploaded PDF, text or a link), files the member attaches and a signature, give it to everyone, a group or chosen members, see who has not finished, and keep each signed copy. An intake link lets people fill in a short form before they join.

## Model

| Table | What it holds |
| --- | --- |
| `forms` | One form: title, description, who it is for, whether it asks for a signature and the statement signed, its status and due date. `adult_writable` with `steward_writes_only`: any adult builds in a household or a general space, the steward alone in a roster. Everyone reads. |
| `questions` | The questions and document steps of a form, in order. A document step can carry a file the builder uploaded (`file_id`, `file_name`). Same policy as `forms`, plus `frozen_when` on the parent's status: once a form is opened the hub narrows an edit or removal to nothing and refuses a new question, so the attached document cannot be swapped while it stays open. |
| `submissions` | One member's answers to one form, with the typed signature, the time, the statement as it read on screen (`signed_text`) and a hash over it and the questions as rendered (`terms_hash`). `owner_or_visibility` with `write_owner_only`: a member writes their own row only, one per form (`max_per_member` and a UNIQUE), and it freezes once submitted (`frozen_when`). Only the reviewers group reads submitted rows (`privileged_values`); nobody else reads another member's row, not even a hub admin. `file_ids` lists the files the answers name (`file_columns.list_columns`). The hub never deletes an `answers` file because the draft stopped naming it: the page deletes a replaced or removed file once the saved draft no longer names it, and the hub refuses while any row does. In a roster space the hub also limits a participant's widened reads to the steward's rows, so there only a steward who is in the reviewers group reads anyone's copy. |
| `intake` | What someone outside sent through a share link: a name, email, phone and note. Written by the hub's share form only (every column is closed to members). `adult_only` with `steward_reads_only` and `steward_writes_only`: adults read and remove rows (children read nothing), and in a roster only the steward does. |
| `settings` | The reviewers group id (`app_config`, set by a hub admin through the gear). |

### What a signature is here

A signature is the member's typed name (the box starts empty: the hub name is not filled in for them), the moment the hub recorded the submit (its clock, not the device's), the statement as it read on screen, and a SHA-256 over that statement and the exact questions, options, document text and attached file ids that were rendered (`termsHash` in `src/logic.js`), computed when they press Sign and stored on their copy. A form's questions freeze when it opens. A reviewer's view marks a copy whose hash no longer matches the current questions with its recorded statement. The form's `signature_text` column is not itself locked after opening; that is why every copy records its own wording. It is a record of what was agreed and when, inside the hub; it is not a cryptographic signature anyone can verify outside it, and nothing here is legal advice.

### Who reads what

- A member reads every form and its questions, and their own submission.
- The **reviewers group** reads every submitted form and the completion view (who has submitted and who has not). A member's draft is theirs alone, so a reviewer sees someone mid-way as not submitted. A hub admin names the group from the gear; the group's membership is managed in hub settings. With no group set, submissions are kept but nobody can read them, and the app says so.
- In a **roster** space (a classroom or team) only the steward builds forms and a participant never sees another family's submission. Only a steward who is also in the reviewers group reads submissions: the steward alone is not enough, and a participant in the group reads nothing, so the page offers the review view to neither.
- In a **general** space (an HOA, a club) every adult builds forms; reading submissions still needs the reviewers group.

### Files

The app's files are in two scopes (`file_acls.read: "scoped"`). Each file's scope is fixed when it is uploaded, and decides who opens it; no row does.

- **`documents`**: what a builder attaches to a document step. Uploaded by an adult who can build forms (the steward in a roster), opened by every member.
- **`answers`**: what a member attaches to an "Attach a file" question (an ID, a certificate). Opened by that member and the reviewers group only: not by a hub admin outside the group, and in a roster only by a steward who is in the group. Only the member can delete it, and only while no row names it.

Attaching a file saves the draft right after the upload, and draft saves run one at a time, so a later save never drops a file an earlier one named. A save or submit from a tab holding an older draft is refused (both are guarded on `revision`, a random id each draft save writes; a timestamp would not do, since two tabs can save in the same millisecond), so it cannot drop a file attached in another tab or on another device; the page then takes the stored files and asks the member to check and save again. The same happens when two tabs both start a draft and the other one created it first. A submit waits for every queued save and stops if the draft changed after its answers were checked (a file finished attaching meanwhile), so it never signs answers that would drop a saved file. Writing a file id into any row changes nobody's access, so a member who copies someone else's id into their answer still cannot open it.

### The audience

A form is for everyone the app admits, one hub member group, or chosen members. That decides who is counted as outstanding, who is notified when the form opens, and who a reminder goes to. It is not a read restriction: a member outside the audience can open the form and read its questions, and the page tells them the form is not for them.

## Sharing

An open form can carry an **intake link**. The page shows the form's title and description and a short form: a name, an email, a phone number and a note. It never shows a question or an answer. Each link takes up to 200 submissions, the table holds 5,000, every row is logged, and the form's close time shuts the link's form. Writable links need an active plan; the hub's share panel says so.

## Known limits

- **Documents are uploaded by builders only.** An adult who can build forms uploads them, and only the steward in a roster (the `documents` scope's write rule). Every member who can read the question opens its document, which fits because a form's questions are readable by everyone anyway.
- **Reviewers can open a member's file before the form is submitted.** A draft's answers are the member's alone, but a file they attach is in the `answers` scope from the moment it is uploaded, and the reviewers group opens every file there. The form says so beside each file question. A file uploaded and then abandoned (the save failed and the page could not delete it) is opened by the same people until it is deleted.
- **A member's attachment is deleted only once no row names it.** The page saves the draft without it, then deletes it. The hub refuses while a row names it, so once a copy is submitted (and frozen) its attachments stay with it. A file the page let go of but could not delete (the page closed, the network dropped) is kept until the member leaves the household.
- **A member's attachments stay when they leave,** like their signed copy. Uploads no row names are deleted then.
- **An attached document can be deleted, not changed.** A file's bytes never change under its id, and a signed copy's hash covers the id. The uploader or a household supervisor (in a roster, only the steward) can still delete the file through the hub after the form opens, and the page never offers that delete. The question keeps the id and the document's name, but the link no longer opens. A signed copy stores neither; it keeps only its hash.
- **A signer keeps their copy.** Archiving a form takes it off the lists, but each member who signed it still finds it under their own Archived tab and can view and print their copy.
- **The statement is checked again at Sign.** If the stored statement, or whether the form asks for a signature at all, no longer matches what the member was shown, the submit stops, shows the form as it now reads and asks again.
- **Deleting a form is only offered while it is a draft.** Once opened, a form is closed or archived. A raw delete of an opened form removes its questions, their attached documents and its intake rows, but never its signed copies. Those copies then keep their answers and hash, with nothing left to say which questions or document they answered.
- **A notification tells the audience the form opened; nothing nags on its own.** A reviewer presses Remind.
- **The intake form's fields are fixed** (name, email, phone, note). The questions on the form itself are for members only.
- **Questions freeze when a form opens, through the page.** To change them, archive the form and start a new one. The freeze keys on the form's status, which a builder writing SQL by hand can set back to draft, then edit a question or swap its document, then reopen. Copies signed before that change no longer match their hash, so the reviewers' view marks them; copies signed after it hash the new wording.
- **A closed form is closed by the page, not the hub.** The page re-reads the form before a submit and refuses one that is not open. A close that lands between that read and the submit, or a member writing SQL by hand, can still put a copy on a closed form. The submit and the close are both stamped by the hub's clock, so such a copy always sorts after `closed_at` and the reviewers' view marks it "After close". Reopening keeps that mark: the closed spell it ends is added to `closed_windows`, and a copy inside any recorded spell is still marked.
- **The Today screen and home glance cannot tell group membership.** They list open forms for everyone, for a chosen list that names the viewer, and for any group (the query has no way to read the viewer's groups), and they drop or tick off forms the viewer has submitted. Inside the app the To do list does check the group.

## Development

```bash
make setup     # once per clone: enables the pre-push hook (build + tests)
npm install
npm run dev    # local dev server, demo mode (no hub attached)
npm test
npm run build  # writes dist/
```
