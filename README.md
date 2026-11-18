# ScholarGuard — Student Scholarship Monitoring and Academic Compliance System

**SAD Comprehensive Laboratory Examination — Section B**

ScholarGuard is a role-based academic compliance and scholarship renewal monitoring portal built on a zero-build frontend architecture (**HTML, Tailwind CSS via CDN, Vanilla JavaScript ES Modules**) backed by **Supabase (PostgreSQL, Auth, and Row-Level Security)**. It enforces strict separation between document verification, dynamic policy compliance evaluation (in `Asia/Manila` / `UTC+8`), and renewal decision authority.

---

## 1. System Overview & Architecture

### Technology Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Markup & Styling** | HTML5 + Tailwind CSS v3 (CDN) + Google Fonts (`Plus Jakarta Sans`, `Public Sans`, `JetBrains Mono`) | Responsive university portal UI with zero build step |
| **Client Application** | Vanilla JavaScript ES Modules (`app.js`, `js/evaluator.js`) | Role-aware workspace rendering, dynamic 6-check policy evaluator, Asia/Manila timestamp handling |
| **Client SDK** | `@supabase/supabase-js` v2 (CDN) | Authentication, PostgREST queries, and RPC execution |
| **Backend & Database** | Supabase PostgreSQL + GoTrue Auth | Relational schema, check/unique constraints, triggers, and Row-Level Security (RLS) |

### File Structure

```text
├── index.html              # Application shell, Tailwind CDN config, Supabase v2 CDN
├── app.js                  # Auth, state management, Scholar & Staff UIs, Supabase actions
├── js/
│   └── evaluator.js        # Dynamic 6-condition evaluator, input validation, PHT formatters
├── schema_and_seed.sql     # Complete DDL, constraints, RLS policies, and synthetic seed data
└── README.md               # Documentation, setup guide, and functional test matrix
```

### Backend Security & Role Enforcement (PostgreSQL RLS + Constraints)

Role access is strictly enforced on the database server rather than relying on UI hiding alone:

1. **Identity & Role Mapping (`profiles` + `handle_new_user`):**
   - Every authenticated user in `auth.users` maps 1:1 to `public.profiles` with `role IN ('scholar', 'staff')`.
   - A `SECURITY DEFINER` helper function `public.is_staff()` checks whether `auth.uid()` has `role = 'staff'` without causing recursive RLS policy evaluation on `profiles`.
   - Scholars cannot update their own `profiles.role` (`profiles_update_staff_only` restricts `UPDATE` to `public.is_staff()`).

2. **Strict Scholar Isolation:**
   - **Read Isolation:** `submissions_select_own_or_staff` and `assignments_select_own_or_staff` allow scholars to `SELECT` only rows where `scholar_id = auth.uid()`.
   - **Controlled Insertions:** `submissions_insert_scholar_own` requires `scholar_id = auth.uid()`, forces initial statuses to `Pending` / `Pending Evaluation` / `Pending` with `NULL` review notes, and verifies the submitted `program_id` matches the scholar's assigned record in `scholar_assignments`.
   - **Returned-Only Resubmissions:** `submissions_update_scholar_returned_only` permits a scholar to `UPDATE` a submission **only when** `verification_status = 'Returned'` (`USING`) and forces the updated row back to `verification_status = 'Pending'`, `compliance_status = 'Pending Evaluation'`, `renewal_decision = 'Pending'` (`WITH CHECK`).
   - **Audit Integrity:** Scholars can only insert `SUBMITTED` or `RESUBMITTED` audit entries for their own submissions; `VERIFIED`, `RETURNED`, `EVALUATED`, and `RENEWAL_DECISION` audit rows are restricted to `public.is_staff()`. Actor names are resolved safely via `public.get_submission_audit_history(p_submission_id)` (`SECURITY DEFINER`) so scholars see reviewer names on their own audit trail without exposing other users' profiles.

3. **Database-Level Business Rule Constraints (`semester_submissions`):**
   - **Duplicate Prevention:** `uq_scholar_academic_term UNIQUE (scholar_id, academic_year, semester)`.
   - **Verification Gate:** `chk_evaluation_requires_verified` and `chk_decision_requires_verified` block any non-pending `compliance_status` or `renewal_decision` unless `verification_status = 'Verified'`.
   - **Renewal Authority:** `chk_approve_requires_compliant` enforces `renewal_decision <> 'Approved' OR compliance_status = 'Compliant'`.
   - **Independent Award Status:** `scholar_assignments.award_status` (`Active`, `On Hold`, `Terminated`) is decoupled from `semester_submissions.compliance_status`; a deficiency flag never automatically terminates an award.

---

## 2. Setup & Local Run Instructions

### Step 1: Provision the Database in Supabase

1. Create a new project in [Supabase](https://supabase.com/).
2. Open the **SQL Editor** in your Supabase dashboard.
3. Open `schema_and_seed.sql` from the repository root, paste its entire contents into the SQL Editor, and click **Run**.
4. Verify that the following tables were created under the `public` schema: `profiles`, `scholarship_programs`, `scholar_assignments`, `semester_submissions`, and `audit_history`.
5. *(Recommended for synthetic testing)* In **Authentication → Providers → Email**, disable **Confirm email** if you plan to register new synthetic test accounts and sign in immediately without email verification.

### Step 2: Configure `SUPABASE_URL` and `SUPABASE_ANON_KEY`

Do **not** embed `service_role` keys or test passwords in client-side source files or version control. Only the public **Project URL** and **Anon Public Key** (from **Project Settings → API**) are used in the browser:

- **Option A — In-App Supabase Config Modal (Recommended):**
  1. Launch the application in your browser.
  2. Click **Supabase Config** in the top navigation bar (it opens automatically on first launch if unconfigured).
  3. Paste your `SUPABASE_URL` and `SUPABASE_ANON_KEY` and click **Save & Connect**.
  4. The app persists these public values locally in browser `localStorage` under `sg_supabase_url` and `sg_supabase_anon_key`.

- **Option B — Pre-populate Browser `localStorage` (DevTools Console):**
  ```javascript
  localStorage.setItem('sg_supabase_url', 'https://your-project-ref.supabase.co');
  localStorage.setItem('sg_supabase_anon_key', 'your-public-anon-key');
  ```

### Step 3: Run Locally (Zero-Build Static Server)

Serve the project root over HTTP (do not open via `file://`, as browser ES module imports require an HTTP origin):

- **Using VS Code Live Server:**
  1. Open the project folder in VS Code.
  2. Right-click `index.html` and select **Open with Live Server**.
- **Using Node (`serve`):**
  ```bash
  npx serve . -l 3000
  ```
- **Using Python 3:**
  ```bash
  python -m http.server 3000
  ```
Then open `http://localhost:3000` in your browser.

---

## 3. Seeded Synthetic Test Accounts Reference

`schema_and_seed.sql` provisions 1 Scholarship Staff account and 6 Scholar accounts (`B01`–`B06`) with pre-seeded assignments and `2026-2027` · `Semester 1` submissions. *Actual test account passwords are supplied privately to the instructor and are intentionally omitted from this repository.*

| Email | Role | Student ID | Assigned Program | Seeded Submission State (AY `2026-2027`, `Semester 1`) |
| :--- | :--- | :--- | :--- | :--- |
| `staff@exam.edu` | `staff` | — | — | Scholarship Administrator (Dr. Elena Navarro) |
| `b01@exam.edu` | `scholar` | `B01` | Excellence Scholar | GWA `2.00`, Units `18`, F `0` / INC `0` / Drop `0`, Verified, Submitted `2026-11-06 17:00:00+08` (exact deadline) |
| `b02@exam.edu` | `scholar` | `B02` | Excellence Scholar | GWA `2.01`, Units `18`, F `0` / INC `0` / Drop `0`, Verified, Submitted `2026-11-05 14:00:00+08` |
| `b03@exam.edu` | `scholar` | `B03` | Access Scholar | GWA `2.50`, Units `15`, F `0` / INC `0` / Drop `1`, Verified, Submitted `2026-11-05 14:00:00+08` |
| `b04@exam.edu` | `scholar` | `B04` | Access Scholar | GWA `2.50`, Units `14`, F `0` / INC `1` / Drop `0`, Verified, Submitted `2026-11-05 14:00:00+08` |
| `b05@exam.edu` | `scholar` | `B05` | Excellence Scholar | GWA `1.75`, Units `18`, F `1` / INC `0` / Drop `0`, Verified, Submitted `2026-11-06 17:01:00+08` (1 min past deadline) |
| `b06@exam.edu` | `scholar` | `B06` | Access Scholar | GWA `2.25`, Units `15`, F `0` / INC `0` / Drop `0`, **Pending** verification, Submitted `2026-11-05 14:00:00+08` |

---

## 4. Functional Test Results Matrix (`TC01` to `TC10`)

| Test ID | Test Case | Input / Action | Expected Result | Actual Result | Status (Pass/Fail) | Evidence Reference |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TC01** | Excellence Boundary & Exact Deadline (`B01`) | Staff runs compliance evaluation on verified `B01` submission (`GWA 2.00`, `18` units, `0/0/0`, `2026-11-06 17:00:00+08`). | All 6 conditions pass (`2.00 <= 2.00`, `submitted_at <= deadline`); `compliance_status = 'Compliant'`, `deficiency_reasons = []`. | Evaluated as `Compliant` with empty `deficiency_reasons` and `EVALUATED` audit entry logged. | **Pass** | `js/evaluator.js` (`evaluateSubmissionCompliance`); `schema_and_seed.sql` (`B01` seed) |
| **TC02** | Excellence GWA Threshold Breach (`B02`) | Staff runs compliance evaluation on verified `B02` submission (`GWA 2.01`, `18` units, `0/0/0`, on time). | `compliance_status = 'With Deficiency'` with explicit reason `"GWA 2.01 exceeds maximum permitted 2.00"`. | Evaluated as `With Deficiency`; `deficiency_reasons` populated with exact GWA threshold message. | **Pass** | `js/evaluator.js` (`evaluateSubmissionCompliance`); `schema_and_seed.sql` (`B02` seed) |
| **TC03** | Access Scholar Permitted Drop (`B03`) | Staff runs compliance evaluation on verified `B03` submission (`GWA 2.50`, `15` units, `0` F / `0` INC / `1` Drop, on time). | Passes `max_dropped <= 1` and boundary `GWA <= 2.50`; `compliance_status = 'Compliant'`. | Evaluated as `Compliant` with 0 deficiencies against `Access Scholar` DB thresholds. | **Pass** | `js/evaluator.js` (`evaluateSubmissionCompliance`); `schema_and_seed.sql` (`B03` seed) |
| **TC04** | Multi-Deficiency Detection (`B04`) | Staff runs compliance evaluation on verified `B04` submission (`GWA 2.50`, `14` units, `0` F / `1` INC / `0` Drop). | Evaluates all 6 rules without short-circuiting; `With Deficiency` listing both below-min units (`14 < 15`) and INC (`1 > 0`). | Evaluated as `With Deficiency` with 2 explicit items in `deficiency_reasons`. | **Pass** | `js/evaluator.js` (`evaluateSubmissionCompliance`); `schema_and_seed.sql` (`B04` seed) |
| **TC05** | Failed Subject & 1-Minute Late Deadline (`B05`) | Staff runs compliance evaluation on verified `B05` submission (`GWA 1.75`, `1` Failed, `2026-11-06 17:01:00+08`). | Fails `max_failed <= 0` and `Asia/Manila` deadline check by 1 minute; `With Deficiency` lists both reasons. | Evaluated as `With Deficiency`: failed subject (`1 > 0`) and `"Submitted 1 minute past deadline (2026-11-06 17:00 PHT)"`. | **Pass** | `js/evaluator.js` (`formatDurationPast`, `evaluateSubmissionCompliance`); `schema_and_seed.sql` (`B05` seed) |
| **TC06** | Verification Gate Blocking (`B06`) | Staff opens `B06` (`verification_status = 'Pending'`) in Review Drawer and attempts evaluation or renewal decision. | **Run Compliance Evaluation**, **Approve Renewal**, and **Hold Renewal** are disabled in UI and rejected by DB constraints. | Buttons disabled with gate notice; PostgreSQL `chk_evaluation_requires_verified` & `chk_decision_requires_verified` enforce block. | **Pass** | `app.js` (`renderStaffDetailDrawer`, `handleEvaluateSubmission`); `schema_and_seed.sql` (`CHECK` constraints) |
| **TC07** | Return & Scholar Resubmission Workflow | Staff returns a submission with reason; Scholar logs in, edits fields in **Correct & Resubmit** modal, and submits. | Status resets to `Pending`, `compliance_status = 'Pending Evaluation'`, `submitted_at` updates to `now()`, and `RETURNED` / `RESUBMITTED` log to `audit_history`. | Resubmission resets states, updates timestamp, clears prior return reason, and records `RESUBMITTED` audit row. | **Pass** | `app.js` (`handleReturnSubmission`, `handleScholarResubmit`); `schema_and_seed.sql` (`submissions_update_scholar_returned_only`) |
| **TC08** | Duplicate Term Submission Rejection | Scholar (`B01`) submits a second report for `2026-2027` · `Semester 1`. | Rejected by `uq_scholar_academic_term` (`23505`) with a clear, user-friendly duplicate error message. | Duplicate insert blocked by Postgres unique constraint; app surfaces readable duplicate-term toast error. | **Pass** | `schema_and_seed.sql` (`uq_scholar_academic_term`); `app.js` (`handleScholarSubmit` `23505` handler) |
| **TC09** | Renewal Decision Authority & Independent Award Status | Staff opens a `With Deficiency` submission (`B02`) and attempts **Approve Renewal**, then clicks **Hold Renewal**. | **Approve Renewal** is disabled and blocked by DB constraint; **Hold Renewal** succeeds while `scholar_assignments.award_status` remains `Active`. | Approve disabled (`chk_approve_requires_compliant`); Hold recorded with notes and `RENEWAL_DECISION` audit entry without altering `award_status`. | **Pass** | `app.js` (`handleRenewalDecision`, `renderStaffDetailDrawer`); `schema_and_seed.sql` (`chk_approve_requires_compliant`) |
| **TC10** | Strict RLS Scholar Isolation & Dynamic Policy Update | Scholar `b01@exam.edu` queries `semester_submissions` / `profiles`; Staff updates `Access Scholar` `max_gwa` in **Policy Thresholds** and re-evaluates. | Scholar sees only `B01` records and cannot alter verification/evaluation/renewal; evaluator dynamically applies updated DB thresholds. | RLS policies isolate scholar rows and block self-approval; `evaluateSubmissionCompliance` reads latest `scholarship_programs` row from Supabase. | **Pass** | `schema_and_seed.sql` (RLS policies); `app.js` (`handleUpdatePolicy`, `handleEvaluateSubmission`) |

---

## 5. Known Defects & Limitations

1. **No Live Registrar / SIS Integration:** Grade document verification relies on scholar-entered Registrar reference codes or document URLs (`evidence_reference`) manually reviewed by scholarship staff; there is no automated transcript fetch or file-upload virus scanning in Supabase Storage.
2. **No Financial Disbursement / Payment Release Module:** Consistent with the academic compliance scope, the system records `renewal_decision` (`Approved` / `Held`) and `award_status` (`Active` / `On Hold` / `Terminated`) but does not trigger tuition billing credits, stipend payouts, or accounting ledger exports.
3. **Client-Side Batch Evaluation:** The **Evaluate All Verified** action iterates over visible `Verified` rows sequentially from the authenticated staff client rather than executing as a server-side scheduled edge function or background queue.
4. **Browser-Local Supabase Configuration:** When `DEFAULT_SUPABASE_URL` and `DEFAULT_SUPABASE_ANON_KEY` are left empty in `app.js`, each browser profile must enter the Project URL and Anon Key once via the **Supabase Config** modal (persisted in `localStorage`).
5. **No Automated Email / Deadline Notifications:** Status transitions (`Returned`, `Compliant`, `With Deficiency`, `Approved`, `Held`) are logged in `audit_history` and displayed in-app, but automated email reminders prior to `submission_deadline` are outside the current scope.
