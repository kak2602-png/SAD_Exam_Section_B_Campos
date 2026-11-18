import {
  evaluateSubmissionCompliance,
  formatManilaDateTime,
  formatManilaShort,
  fromManilaDatetimeLocal,
  toManilaDatetimeLocal,
  validateSubmissionInput,
} from './js/evaluator.js';

/**
 * Optional hardcoded defaults (leave empty to configure via the UI modal & localStorage).
 */
const DEFAULT_SUPABASE_URL = '';
const DEFAULT_SUPABASE_ANON_KEY = '';

const STORAGE_URL_KEY = 'sg_supabase_url';
const STORAGE_KEY_KEY = 'sg_supabase_anon_key';

const QUICK_FILL_ACCOUNTS = [
  { label: 'Dr. Elena Navarro', sublabel: 'Administration', email: 'staff@exam.edu', tag: 'staff', badge: 'Staff', tone: 'indigo' },
  { label: 'Mateo Villanueva', sublabel: 'B01 · Exact Deadline', email: 'b01@exam.edu', tag: 'scholar', badge: 'Excellence', tone: 'emerald' },
  { label: 'Clarisse Mendoza', sublabel: 'B02 · GWA 2.01', email: 'b02@exam.edu', tag: 'scholar', badge: 'Excellence', tone: 'emerald' },
  { label: 'Rafael Dizon', sublabel: 'B03 · 1 Drop Allowed', email: 'b03@exam.edu', tag: 'scholar', badge: 'Access', tone: 'sky' },
  { label: 'Bianca Pascual', sublabel: 'B04 · Units & INC', email: 'b04@exam.edu', tag: 'scholar', badge: 'Access', tone: 'sky' },
  { label: 'Gabriel Soriano', sublabel: 'B05 · Failed & 1m Late', email: 'b05@exam.edu', tag: 'scholar', badge: 'Excellence', tone: 'emerald' },
  { label: 'Angela Bautista', sublabel: 'B06 · Pending Verification', email: 'b06@exam.edu', tag: 'scholar', badge: 'Access', tone: 'sky' },
];

const state = {
  supabaseUrl: DEFAULT_SUPABASE_URL || localStorage.getItem(STORAGE_URL_KEY) || '',
  supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY || localStorage.getItem(STORAGE_KEY_KEY) || '',
  client: null,
  showConfigModal: false,
  loading: false,
  busyAction: false,

  // Auth & User
  session: null,
  profile: null,
  authMode: 'login', // 'login' | 'register'
  authError: '',
  authMessage: '',

  // Domain Data
  programs: [],
  assignment: null, // scholar's own assignment
  allScholars: [], // staff: all scholar profiles
  allAssignments: [], // staff: all assignments
  submissions: [], // scholar's own OR staff's all submissions

  // Scholar UI state
  resubmitTarget: null, // submission being edited & resubmitted
  expandedAuditIds: new Set(),
  auditCache: {}, // submission_id -> array

  // Staff UI state
  staffTab: 'submissions', // 'submissions' | 'assignments' | 'policies'
  filterYear: '2026-2027',
  filterSemester: 'Semester 1',
  searchQuery: '',
  filterProgramId: 'ALL',
  filterVerification: 'ALL',
  filterCompliance: 'ALL',
  selectedSubmissionId: null,

  // Toast notifications
  toasts: [],
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function addToast(type, message) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  state.toasts.push({ id, type, message });
  renderToasts();
  setTimeout(() => {
    state.toasts = state.toasts.filter((t) => t.id !== id);
    renderToasts();
  }, 5000);
}

function renderStatusTag(status) {
  const styles = {
    Verified: { cls: 'bg-emerald-100 text-emerald-900 border-emerald-300', icon: 'check' },
    Compliant: { cls: 'bg-emerald-100 text-emerald-900 border-emerald-300', icon: 'check' },
    Approved: { cls: 'bg-emerald-100 text-emerald-900 border-emerald-300', icon: 'check' },
    Active: { cls: 'bg-emerald-100 text-emerald-900 border-emerald-300', icon: 'check' },

    Pending: { cls: 'bg-amber-100 text-amber-900 border-amber-300', icon: 'clock' },
    'Pending Evaluation': { cls: 'bg-slate-200/80 text-slate-800 border-slate-300', icon: 'clock' },
    'On Hold': { cls: 'bg-amber-100 text-amber-900 border-amber-300', icon: 'pause' },

    Returned: { cls: 'bg-rose-100 text-rose-900 border-rose-300', icon: 'return' },
    'With Deficiency': { cls: 'bg-rose-100 text-rose-900 border-rose-300', icon: 'alert' },
    Held: { cls: 'bg-rose-100 text-rose-900 border-rose-300', icon: 'pause' },
    Terminated: { cls: 'bg-rose-100 text-rose-900 border-rose-300', icon: 'alert' },
  };

  const cfg = styles[status] || { cls: 'bg-slate-200/80 text-slate-800 border-slate-300', icon: 'clock' };
  const icons = {
    check: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.2" stroke-linecap="round"/></svg>',
    return: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5.5 6L2.5 9l3 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 9h7.5a3 3 0 000-6H8" stroke-linecap="round"/></svg>',
    alert: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 2.5L14 13H2L8 2.5z" stroke-linejoin="round"/><path d="M8 6.5v3" stroke-linecap="round"/><circle cx="8" cy="11.2" r="0.6" fill="currentColor" stroke="none"/></svg>',
    pause: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3.5" width="2.5" height="9" rx="0.5"/><rect x="9.5" y="3.5" width="2.5" height="9" rx="0.5"/></svg>',
  };

  return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold border rounded-full whitespace-nowrap shrink-0 ${cfg.cls}">${icons[cfg.icon] || ''}<span>${escapeHtml(status)}</span></span>`;
}

// ---------------------------------------------------------------------------
// Supabase Initialization & Data Fetching
// ---------------------------------------------------------------------------

function initSupabaseClient() {
  if (!state.supabaseUrl || !state.supabaseAnonKey) {
    state.client = null;
    state.showConfigModal = true;
    return false;
  }

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    addToast('error', 'Supabase JS CDN failed to load. Check your network connection.');
    return false;
  }

  try {
    state.client = window.supabase.createClient(state.supabaseUrl.trim(), state.supabaseAnonKey.trim());
    return true;
  } catch (err) {
    state.client = null;
    addToast('error', `Invalid Supabase configuration: ${err.message}`);
    return false;
  }
}

async function bootstrapSession() {
  if (!state.client) {
    render();
    return;
  }

  state.loading = true;
  render();

  try {
    const { data, error } = await state.client.auth.getSession();
    if (error) throw error;

    state.session = data.session;
    if (state.session?.user) {
      await loadUserContextAndData();
    }
  } catch (err) {
    addToast('error', err.message || 'Failed to initialize session.');
  } finally {
    state.loading = false;
    render();
  }
}

async function ensureProfileForSession(user) {
  const { data: existing, error: fetchErr } = await state.client
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (existing) return existing;

  const meta = user.user_metadata || {};
  const role = meta.role === 'staff' ? 'staff' : 'scholar';
  const fullName = meta.full_name || (user.email ? user.email.split('@')[0] : 'User');
  const studentId = role === 'scholar' ? meta.student_id || null : null;

  const { data: inserted, error: insertErr } = await state.client
    .from('profiles')
    .insert({
      id: user.id,
      full_name: fullName,
      email: user.email,
      role,
      student_id: studentId,
    })
    .select('*')
    .single();

  if (insertErr) throw insertErr;
  return inserted;
}

async function loadUserContextAndData() {
  if (!state.client || !state.session?.user) return;

  state.profile = await ensureProfileForSession(state.session.user);

  // Always load programs dynamically from DB
  const { data: programs, error: progErr } = await state.client
    .from('scholarship_programs')
    .select('*')
    .order('name', { ascending: true });
  if (progErr) throw progErr;
  state.programs = programs || [];

  if (state.profile.role === 'staff') {
    await loadStaffData();
  } else {
    await loadScholarData();
  }
}

async function loadScholarData() {
  const userId = state.profile.id;

  const [{ data: assignment, error: assignErr }, { data: submissions, error: subErr }] = await Promise.all([
    state.client
      .from('scholar_assignments')
      .select('*, program:scholarship_programs(*)')
      .eq('scholar_id', userId)
      .maybeSingle(),
    state.client
      .from('semester_submissions')
      .select('*, program:scholarship_programs(*)')
      .eq('scholar_id', userId)
      .order('submitted_at', { ascending: false }),
  ]);

  if (assignErr) throw assignErr;
  if (subErr) throw subErr;

  state.assignment = assignment || null;
  state.submissions = submissions || [];
}

async function loadStaffData() {
  const [
    { data: scholars, error: schErr },
    { data: assignments, error: assErr },
    { data: submissions, error: subErr },
  ] = await Promise.all([
    state.client
      .from('profiles')
      .select('*')
      .eq('role', 'scholar')
      .order('student_id', { ascending: true, nullsFirst: false }),
    state.client
      .from('scholar_assignments')
      .select('*, program:scholarship_programs(*)'),
    state.client
      .from('semester_submissions')
      .select('*, scholar:profiles!semester_submissions_scholar_id_fkey(*), program:scholarship_programs(*)')
      .order('submitted_at', { ascending: false }),
  ]);

  if (schErr) throw schErr;
  if (assErr) throw assErr;
  if (subErr) throw subErr;

  state.allScholars = scholars || [];
  state.allAssignments = assignments || [];
  state.submissions = submissions || [];
}

async function fetchAuditHistory(submissionId, force = false) {
  if (!force && state.auditCache[submissionId]) {
    return state.auditCache[submissionId];
  }
  const { data, error } = await state.client.rpc('get_submission_audit_history', {
    p_submission_id: submissionId,
  });
  if (error) {
    addToast('error', `Failed to load audit history: ${error.message}`);
    return [];
  }
  state.auditCache[submissionId] = data || [];
  return state.auditCache[submissionId];
}

async function logAuditEvent({ submissionId, actionType, previousState, newState, notes }) {
  const { error } = await state.client.from('audit_history').insert({
    submission_id: submissionId,
    actor_id: state.profile.id,
    action_type: actionType,
    previous_state: previousState,
    new_state: newState,
    notes: notes || null,
  });
  if (error) throw error;
  delete state.auditCache[submissionId];
}

// ---------------------------------------------------------------------------
// Actions & Handlers
// ---------------------------------------------------------------------------

async function handleSaveConfig(url, anonKey) {
  if (!url.trim() || !anonKey.trim()) {
    addToast('error', 'Both Supabase Project URL and Anon Key are required.');
    return;
  }
  state.supabaseUrl = url.trim();
  state.supabaseAnonKey = anonKey.trim();
  localStorage.setItem(STORAGE_URL_KEY, state.supabaseUrl);
  localStorage.setItem(STORAGE_KEY_KEY, state.supabaseAnonKey);

  state.showConfigModal = false;
  state.session = null;
  state.profile = null;
  state.submissions = [];
  state.auditCache = {};

  if (initSupabaseClient()) {
    addToast('success', 'Supabase connection updated.');
    await bootstrapSession();
  } else {
    render();
  }
}

async function handleSignIn(email, password) {
  state.authError = '';
  state.authMessage = '';
  state.busyAction = true;
  render();

  try {
    const { data, error } = await state.client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) throw error;
    state.session = data.session;
    await loadUserContextAndData();
    addToast('success', `Signed in as ${state.profile.full_name}.`);
  } catch (err) {
    state.authError = err.message || 'Sign-in failed.';
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleRegister({ fullName, email, password, role, studentId }) {
  state.authError = '';
  state.authMessage = '';

  if (!fullName.trim() || !email.trim() || !password) {
    state.authError = 'Full Name, Email, and Password are required.';
    render();
    return;
  }
  if (role === 'scholar' && !studentId.trim()) {
    state.authError = 'Student ID is required when registering as a Scholar.';
    render();
    return;
  }

  state.busyAction = true;
  render();

  try {
    const { data, error } = await state.client.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          full_name: fullName.trim(),
          role,
          student_id: role === 'scholar' ? studentId.trim().toUpperCase() : null,
        },
      },
    });
    if (error) throw error;

    if (data.session) {
      state.session = data.session;
      await loadUserContextAndData();
      addToast('success', 'Account created and signed in.');
    } else {
      state.authMessage =
        'Account created. Check your email to confirm your address before signing in (or disable Confirm Email in Supabase Auth settings for instant test logins).';
      state.authMode = 'login';
    }
  } catch (err) {
    state.authError = err.message || 'Registration failed.';
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleSignOut() {
  if (!state.client) return;
  await state.client.auth.signOut();
  state.session = null;
  state.profile = null;
  state.assignment = null;
  state.submissions = [];
  state.allScholars = [];
  state.allAssignments = [];
  state.selectedSubmissionId = null;
  state.resubmitTarget = null;
  state.expandedAuditIds.clear();
  state.auditCache = {};
  render();
}

async function handleScholarSubmit(formData) {
  if (!state.assignment?.program_id) {
    addToast('error', 'You must be assigned to a scholarship program before submitting.');
    return;
  }

  const errors = validateSubmissionInput(formData);
  if (errors.length > 0) {
    addToast('error', errors[0]);
    return;
  }

  state.busyAction = true;
  render();

  try {
    const payload = {
      scholar_id: state.profile.id,
      program_id: state.assignment.program_id,
      academic_year: formData.academic_year.trim(),
      semester: formData.semester.trim(),
      gwa: Number(Number(formData.gwa).toFixed(2)),
      enrolled_units: Number(formData.enrolled_units),
      failed_count: Number(formData.failed_count),
      incomplete_count: Number(formData.incomplete_count),
      dropped_count: Number(formData.dropped_count),
      evidence_reference: formData.evidence_reference.trim(),
      submitted_at: new Date().toISOString(),
      verification_status: 'Pending',
      verification_reason: null,
      compliance_status: 'Pending Evaluation',
      deficiency_reasons: [],
      renewal_decision: 'Pending',
      decision_notes: null,
    };

    const { data: created, error } = await state.client
      .from('semester_submissions')
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new Error(
          `Duplicate submission rejected: you already submitted grades for ${payload.academic_year} · ${payload.semester}.`
        );
      }
      throw error;
    }

    await logAuditEvent({
      submissionId: created.id,
      actionType: 'SUBMITTED',
      previousState: null,
      newState: 'Pending',
      notes: `Submitted ${payload.academic_year} ${payload.semester} (Ref: ${payload.evidence_reference}).`,
    });

    await loadScholarData();
    addToast('success', 'Semester grades submitted for staff verification.');
  } catch (err) {
    addToast('error', err.message || 'Submission failed.');
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleScholarResubmit(submission, formData) {
  if (submission.verification_status !== 'Returned') {
    addToast('error', 'Only Returned submissions can be corrected and resubmitted.');
    return;
  }

  const errors = validateSubmissionInput({
    ...formData,
    academic_year: submission.academic_year,
    semester: submission.semester,
  });
  if (errors.length > 0) {
    addToast('error', errors[0]);
    return;
  }

  state.busyAction = true;
  render();

  try {
    const nowIso = new Date().toISOString();
    const { error } = await state.client
      .from('semester_submissions')
      .update({
        gwa: Number(Number(formData.gwa).toFixed(2)),
        enrolled_units: Number(formData.enrolled_units),
        failed_count: Number(formData.failed_count),
        incomplete_count: Number(formData.incomplete_count),
        dropped_count: Number(formData.dropped_count),
        evidence_reference: formData.evidence_reference.trim(),
        submitted_at: nowIso,
        verification_status: 'Pending',
        verification_reason: null,
        compliance_status: 'Pending Evaluation',
        deficiency_reasons: [],
        renewal_decision: 'Pending',
        decision_notes: null,
      })
      .eq('id', submission.id)
      .eq('verification_status', 'Returned');

    if (error) throw error;

    await logAuditEvent({
      submissionId: submission.id,
      actionType: 'RESUBMITTED',
      previousState: 'Returned',
      newState: 'Pending',
      notes: `Corrected and resubmitted at ${formatManilaDateTime(nowIso)}.`,
    });

    state.resubmitTarget = null;
    await loadScholarData();
    if (state.expandedAuditIds.has(submission.id)) {
      await fetchAuditHistory(submission.id, true);
    }
    addToast('success', 'Submission corrected and resubmitted for verification.');
  } catch (err) {
    addToast('error', err.message || 'Resubmission failed.');
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleVerifySubmission(submission) {
  state.busyAction = true;
  render();

  try {
    const prev = submission.verification_status;
    const { error } = await state.client
      .from('semester_submissions')
      .update({
        verification_status: 'Verified',
        verification_reason: null,
      })
      .eq('id', submission.id);

    if (error) throw error;

    await logAuditEvent({
      submissionId: submission.id,
      actionType: 'VERIFIED',
      previousState: prev,
      newState: 'Verified',
      notes: 'Evidence and academic figures verified by scholarship staff.',
    });

    await loadStaffData();
    await fetchAuditHistory(submission.id, true);
    addToast('success', 'Submission marked as Verified.');
  } catch (err) {
    addToast('error', err.message || 'Verification failed.');
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleReturnSubmission(submission, reason) {
  if (!reason || !reason.trim()) {
    addToast('error', 'A return reason is required when returning a submission.');
    return;
  }

  state.busyAction = true;
  render();

  try {
    const prev = submission.verification_status;
    const { error } = await state.client
      .from('semester_submissions')
      .update({
        verification_status: 'Returned',
        verification_reason: reason.trim(),
        compliance_status: 'Pending Evaluation',
        deficiency_reasons: [],
        renewal_decision: 'Pending',
        decision_notes: null,
      })
      .eq('id', submission.id);

    if (error) throw error;

    await logAuditEvent({
      submissionId: submission.id,
      actionType: 'RETURNED',
      previousState: prev,
      newState: 'Returned',
      notes: reason.trim(),
    });

    await loadStaffData();
    await fetchAuditHistory(submission.id, true);
    addToast('success', 'Submission returned to scholar for correction.');
  } catch (err) {
    addToast('error', err.message || 'Failed to return submission.');
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleEvaluateSubmission(submission) {
  if (submission.verification_status !== 'Verified') {
    addToast('error', 'Verification Gate: Only Verified submissions can be evaluated.');
    return;
  }

  // Always read the latest policy thresholds from state.programs
  const program = state.programs.find((p) => p.id === submission.program_id) || submission.program;
  const result = evaluateSubmissionCompliance(submission, program);

  state.busyAction = true;
  render();

  try {
    const prev = submission.compliance_status;
    const { error } = await state.client
      .from('semester_submissions')
      .update({
        compliance_status: result.compliance_status,
        deficiency_reasons: result.deficiency_reasons,
      })
      .eq('id', submission.id);

    if (error) throw error;

    await logAuditEvent({
      submissionId: submission.id,
      actionType: 'EVALUATED',
      previousState: prev,
      newState: result.compliance_status,
      notes: result.compliant
        ? `All 6 ${program.name} policy checks passed.`
        : `Deficiencies: ${result.deficiency_reasons.join('; ')}`,
    });

    await loadStaffData();
    await fetchAuditHistory(submission.id, true);
    addToast('success', `Compliance evaluated: ${result.compliance_status}.`);
  } catch (err) {
    addToast('error', err.message || 'Evaluation failed.');
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleEvaluateAllVerified(visibleSubmissions) {
  const candidates = visibleSubmissions.filter((s) => s.verification_status === 'Verified');
  if (candidates.length === 0) {
    addToast('error', 'No Verified submissions in the current view to evaluate.');
    return;
  }

  state.busyAction = true;
  render();

  let count = 0;
  try {
    for (const sub of candidates) {
      const program = state.programs.find((p) => p.id === sub.program_id) || sub.program;
      const result = evaluateSubmissionCompliance(sub, program);
      const { error } = await state.client
        .from('semester_submissions')
        .update({
          compliance_status: result.compliance_status,
          deficiency_reasons: result.deficiency_reasons,
        })
        .eq('id', sub.id);
      if (error) throw error;

      await logAuditEvent({
        submissionId: sub.id,
        actionType: 'EVALUATED',
        previousState: sub.compliance_status,
        newState: result.compliance_status,
        notes: result.compliant
          ? `Batch evaluation: All 6 ${program.name} checks passed.`
          : `Batch evaluation deficiencies: ${result.deficiency_reasons.join('; ')}`,
      });
      count += 1;
    }
    await loadStaffData();
    if (state.selectedSubmissionId) {
      await fetchAuditHistory(state.selectedSubmissionId, true);
    }
    addToast('success', `Evaluated ${count} verified submission${count === 1 ? '' : 's'} dynamically.`);
  } catch (err) {
    addToast('error', err.message || 'Batch evaluation failed.');
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleRenewalDecision(submission, decision, notes) {
  if (submission.verification_status !== 'Verified') {
    addToast('error', 'Verification Gate: Submission must be Verified before recording a renewal decision.');
    return;
  }
  if (decision === 'Approved' && submission.compliance_status !== 'Compliant') {
    addToast('error', 'Renewal Authority Rule: Cannot approve renewal unless Compliance Status is Compliant.');
    return;
  }

  state.busyAction = true;
  render();

  try {
    const prev = submission.renewal_decision;
    const { error } = await state.client
      .from('semester_submissions')
      .update({
        renewal_decision: decision,
        decision_notes: notes?.trim() || null,
      })
      .eq('id', submission.id);

    if (error) throw error;

    await logAuditEvent({
      submissionId: submission.id,
      actionType: 'RENEWAL_DECISION',
      previousState: prev,
      newState: decision,
      notes: notes?.trim() || `Renewal decision recorded as ${decision}.`,
    });

    await loadStaffData();
    await fetchAuditHistory(submission.id, true);
    addToast('success', `Renewal decision recorded: ${decision}.`);
  } catch (err) {
    addToast('error', err.message || 'Failed to record renewal decision.');
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleSaveAssignment({ scholarId, programId, awardStatus }) {
  if (!scholarId || !programId) {
    addToast('error', 'Please select both a scholar and a scholarship program.');
    return;
  }

  state.busyAction = true;
  render();

  try {
    const { error } = await state.client.from('scholar_assignments').upsert(
      {
        scholar_id: scholarId,
        program_id: programId,
        award_status: awardStatus,
        assigned_by: state.profile.id,
        assigned_at: new Date().toISOString(),
      },
      { onConflict: 'scholar_id' }
    );
    if (error) throw error;

    await loadStaffData();
    addToast('success', 'Scholar assignment updated.');
  } catch (err) {
    addToast('error', err.message || 'Failed to save assignment.');
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleUpdatePolicy(programId, fields) {
  const deadlineIso = fromManilaDatetimeLocal(fields.deadlineLocal);
  if (!deadlineIso) {
    addToast('error', 'Invalid submission deadline.');
    return;
  }

  const maxGwa = Number(fields.max_gwa);
  if (Number.isNaN(maxGwa) || maxGwa < 1.0 || maxGwa > 5.0) {
    addToast('error', 'Max GWA must be between 1.00 and 5.00.');
    return;
  }

  state.busyAction = true;
  render();

  try {
    const { error } = await state.client
      .from('scholarship_programs')
      .update({
        max_gwa: Number(maxGwa.toFixed(2)),
        min_units: Number(fields.min_units),
        max_failed: Number(fields.max_failed),
        max_incomplete: Number(fields.max_incomplete),
        max_dropped: Number(fields.max_dropped),
        submission_deadline: deadlineIso,
      })
      .eq('id', programId);

    if (error) throw error;

    await loadStaffData();
    const { data: programs } = await state.client.from('scholarship_programs').select('*').order('name');
    state.programs = programs || [];
    addToast('success', 'Policy thresholds updated. Future evaluations will use these rules.');
  } catch (err) {
    addToast('error', err.message || 'Failed to update policy.');
  } finally {
    state.busyAction = false;
    render();
  }
}

async function handleCreatePolicy(fields) {
  const deadlineIso = fromManilaDatetimeLocal(fields.deadlineLocal);
  if (!fields.name?.trim() || !deadlineIso) {
    addToast('error', 'Program Name and Deadline are required.');
    return;
  }

  state.busyAction = true;
  render();

  try {
    const { error } = await state.client.from('scholarship_programs').insert({
      name: fields.name.trim(),
      max_gwa: Number(Number(fields.max_gwa).toFixed(2)),
      min_units: Number(fields.min_units),
      max_failed: Number(fields.max_failed),
      max_incomplete: Number(fields.max_incomplete),
      max_dropped: Number(fields.max_dropped),
      submission_deadline: deadlineIso,
    });
    if (error) throw error;

    const { data: programs } = await state.client.from('scholarship_programs').select('*').order('name');
    state.programs = programs || [];
    addToast('success', `Program "${fields.name.trim()}" created.`);
  } catch (err) {
    addToast('error', err.message || 'Failed to create program.');
  } finally {
    state.busyAction = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Rendering: Shared Components
// ---------------------------------------------------------------------------

function renderToasts() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-md pointer-events-none';
    document.body.appendChild(container);
  }

  container.innerHTML = state.toasts
    .map((t) => {
      const cls =
        t.type === 'error'
          ? 'bg-rose-950 text-white border-rose-800'
          : 'bg-slate-900 text-white border-slate-700';
      return `
        <div class="pointer-events-auto flex items-start justify-between gap-3 px-4 py-3 text-sm border rounded-md shadow-sm ${cls}">
          <span>${escapeHtml(t.message)}</span>
          <button data-dismiss-toast="${escapeHtml(t.id)}" class="text-slate-300 hover:text-white text-xs shrink-0" aria-label="Dismiss">&times;</button>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('[data-dismiss-toast]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-dismiss-toast');
      state.toasts = state.toasts.filter((t) => t.id !== id);
      renderToasts();
    });
  });
}

function renderTopBar() {
  const isLoggedIn = Boolean(state.session && state.profile);
  const isStaff = state.profile?.role === 'staff';

  return `
    <header class="bg-gradient-to-r from-[#0f172a] to-[#1e3a8a] text-white shadow-md sticky top-0 z-30">
      <div class="max-w-[1360px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
        <a href="#top" id="brand-home" class="inline-flex items-center gap-2.5 font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0">
          <span class="w-8 h-8 rounded-lg bg-white/15 border border-white/20 flex items-center justify-center shrink-0">
            <svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <path d="m9 12 2 2 4-4"/>
            </svg>
          </span>
          <span>ScholarGuard</span>
        </a>

        ${
          isLoggedIn
            ? isStaff
              ? `
                <nav class="hidden md:flex items-center gap-6 text-sm font-medium">
                  <button data-staff-tab="submissions" class="py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                    state.staffTab === 'submissions'
                      ? 'border-white text-white'
                      : 'border-transparent text-indigo-100/80 hover:text-white'
                  }">Submissions Review</button>
                  <button data-staff-tab="assignments" class="py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                    state.staffTab === 'assignments'
                      ? 'border-white text-white'
                      : 'border-transparent text-indigo-100/80 hover:text-white'
                  }">Scholars &amp; Assignments</button>
                  <button data-staff-tab="policies" class="py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                    state.staffTab === 'policies'
                      ? 'border-white text-white'
                      : 'border-transparent text-indigo-100/80 hover:text-white'
                  }">Policy Thresholds</button>
                </nav>
              `
              : `
                <nav class="hidden md:flex items-center gap-6 text-sm font-medium">
                  <span class="text-white border-b-2 border-white py-1.5 whitespace-nowrap shrink-0">My Academic Compliance</span>
                </nav>
              `
            : '<div></div>'
        }

        <div class="flex items-center gap-3 shrink-0">
          ${
            isLoggedIn
              ? `
                <span class="hidden sm:inline text-xs text-indigo-100 whitespace-nowrap truncate max-w-[260px]">
                  ${escapeHtml(state.profile.full_name)} · ${
                  state.profile.role === 'staff'
                    ? 'Staff'
                    : escapeHtml(state.profile.student_id || 'Scholar')
                }
                </span>
              `
              : ''
          }
          <button
            id="btn-open-config"
            class="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-white/10 border border-white/25 rounded-full hover:bg-white/20 transition-colors whitespace-nowrap shrink-0"
          >
            <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
              <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>
            </svg>
            <span>Supabase Config</span>
          </button>
          ${
            isLoggedIn
              ? `
                <button
                  id="btn-sign-out"
                  class="px-4 py-1.5 text-xs font-semibold text-[#0f172a] bg-white rounded-full hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 shadow-sm"
                >
                  Sign Out
                </button>
              `
              : ''
          }
        </div>
      </div>
    </header>
  `;
}

function renderConfigModal() {
  if (!state.showConfigModal) return '';
  const canDismiss = Boolean(state.client);

  return `
    <div class="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div class="bg-white border border-slate-200 border-t-4 border-t-[#1e3a8a] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div class="px-6 py-5 border-b border-slate-200 flex items-start justify-between gap-4 bg-slate-50/70">
          <div>
            <h2 class="font-display text-lg font-semibold text-slate-900">Connect Supabase Project</h2>
            <p class="text-sm text-slate-600 mt-1">
              Enter your Supabase Project URL and public Anon Key. Credentials are stored locally in your browser via <span class="font-mono text-xs">localStorage</span>.
            </p>
          </div>
          ${
            canDismiss
              ? `<button id="btn-close-config" class="text-slate-400 hover:text-slate-700 text-xl leading-none px-1.5 py-0.5 rounded hover:bg-slate-200/60">&times;</button>`
              : ''
          }
        </div>

        <form id="config-form" class="p-6 space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1.5" for="cfg-url">Supabase Project URL</label>
            <input
              id="cfg-url"
              type="url"
              required
              placeholder="https://your-project-ref.supabase.co"
              value="${escapeHtml(state.supabaseUrl)}"
              class="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700 focus:border-blue-700"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1.5" for="cfg-key">Supabase Anon Public Key</label>
            <input
              id="cfg-key"
              type="text"
              required
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              value="${escapeHtml(state.supabaseAnonKey)}"
              class="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700 focus:border-blue-700"
            />
          </div>

          <div class="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 leading-relaxed">
            Before signing in, execute <span class="font-mono text-slate-800">schema_and_seed.sql</span> in your Supabase SQL Editor to provision all tables, RLS policies, and synthetic test accounts (<span class="font-mono">staff@exam.edu</span>, <span class="font-mono">b01@exam.edu</span>–<span class="font-mono">b06@exam.edu</span>).
          </div>

          <div class="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
            ${
              canDismiss
                ? `<button type="button" id="btn-cancel-config" class="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>`
                : ''
            }
            <button type="submit" class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1e3a8a] rounded-lg hover:bg-blue-900 shadow-sm">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              <span>Save &amp; Connect</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Rendering: Auth View
// ---------------------------------------------------------------------------

function renderAuthView() {
  const isRegister = state.authMode === 'register';
  const badgeToneClasses = {
    indigo: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    sky: 'bg-sky-100 text-sky-800 border-sky-200',
  };

  return `
    <main class="min-h-[calc(100vh-4rem)] bg-gradient-to-br from-slate-100 via-slate-50 to-indigo-50/70 py-10 px-6">
      <div class="max-w-[1160px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <section class="lg:col-span-6 bg-white border border-slate-200 border-t-4 border-t-[#1e3a8a] rounded-xl shadow-lg p-8">
          <div class="mb-6 pb-5 border-b border-slate-100">
            <h1 class="font-display text-2xl font-bold text-slate-900 tracking-tight">
              Student Scholarship Monitoring &amp; Academic Compliance
            </h1>
            <p class="text-sm text-slate-600 mt-2 leading-relaxed">
              Sign in with your institutional account to submit semester grade reports, verify academic records, evaluate dynamic policy compliance in Asia/Manila time, and record renewal decisions.
            </p>
          </div>

          <div class="inline-flex p-1 bg-slate-100 rounded-lg mb-6">
            <button
              type="button"
              data-auth-mode="login"
              class="px-4 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                !isRegister ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }"
            >
              Sign In
            </button>
            <button
              type="button"
              data-auth-mode="register"
              class="px-4 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                isRegister ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }"
            >
              Register Test Account
            </button>
          </div>

          ${
            state.authError
              ? `<div class="mb-4 p-3 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">${escapeHtml(
                  state.authError
                )}</div>`
              : ''
          }
          ${
            state.authMessage
              ? `<div class="mb-4 p-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">${escapeHtml(
                  state.authMessage
                )}</div>`
              : ''
          }

          ${
            !isRegister
              ? `
                <form id="login-form" class="space-y-4">
                  <div>
                    <label class="block text-xs font-semibold text-slate-700 mb-1.5" for="login-email">Institutional Email</label>
                    <input
                      id="login-email"
                      type="email"
                      required
                      placeholder="staff@exam.edu or b01@exam.edu"
                      class="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700 focus:border-blue-700"
                    />
                  </div>
                  <div>
                    <label class="block text-xs font-semibold text-slate-700 mb-1.5" for="login-password">Password</label>
                    <input
                      id="login-password"
                      type="password"
                      required
                      placeholder="Enter password"
                      class="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700 focus:border-blue-700"
                    />
                  </div>
                  <button
                    type="submit"
                    ${state.busyAction ? 'disabled' : ''}
                    class="w-full py-2.5 px-4 text-sm font-semibold text-white bg-[#1e3a8a] rounded-lg hover:bg-blue-900 disabled:opacity-50 transition-colors shadow-sm"
                  >
                    ${state.busyAction ? 'Signing in...' : 'Sign In to Portal'}
                  </button>
                </form>
              `
              : `
                <form id="register-form" class="space-y-4">
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label class="block text-xs font-semibold text-slate-700 mb-1.5" for="reg-name">Full Name</label>
                      <input
                        id="reg-name"
                        type="text"
                        required
                        placeholder="Juan Dela Cruz"
                        class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                      />
                    </div>
                    <div>
                      <label class="block text-xs font-semibold text-slate-700 mb-1.5" for="reg-role">Account Role</label>
                      <select
                        id="reg-role"
                        class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                      >
                        <option value="scholar">Scholar</option>
                        <option value="staff">Scholarship Staff</option>
                      </select>
                    </div>
                  </div>

                  <div id="reg-student-id-wrap">
                    <label class="block text-xs font-semibold text-slate-700 mb-1.5" for="reg-student-id">Student ID (for Scholars)</label>
                    <input
                      id="reg-student-id"
                      type="text"
                      placeholder="e.g. B07"
                      class="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                    />
                  </div>

                  <div>
                    <label class="block text-xs font-semibold text-slate-700 mb-1.5" for="reg-email">Email Address</label>
                    <input
                      id="reg-email"
                      type="email"
                      required
                      placeholder="b07@exam.edu"
                      class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                    />
                  </div>

                  <div>
                    <label class="block text-xs font-semibold text-slate-700 mb-1.5" for="reg-password">Password</label>
                    <input
                      id="reg-password"
                      type="password"
                      required
                      minlength="6"
                      placeholder="Minimum 6 characters"
                      class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                    />
                  </div>

                  <button
                    type="submit"
                    ${state.busyAction ? 'disabled' : ''}
                    class="w-full py-2.5 px-4 text-sm font-semibold text-white bg-[#1e3a8a] rounded-lg hover:bg-blue-900 disabled:opacity-50 transition-colors shadow-sm"
                  >
                    ${state.busyAction ? 'Creating account...' : 'Create Account'}
                  </button>
                </form>
              `
          }
        </section>

        <aside class="lg:col-span-6 bg-white border border-slate-200 rounded-xl shadow-md p-6">
          <div class="pb-4 mb-4 border-b border-slate-100">
            <h2 class="font-display text-base font-semibold text-slate-900">Seeded Test Accounts (Quick-Fill)</h2>
            <p class="text-xs text-slate-600 mt-1">
              Click any card to auto-fill credentials with password <span class="font-mono font-medium text-slate-800">Password123!</span>.
            </p>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${QUICK_FILL_ACCOUNTS.map((acc) => {
              const badgeCls = badgeToneClasses[acc.tone] || badgeToneClasses.indigo;
              return `
                <button
                  type="button"
                  data-quick-fill="${escapeHtml(acc.email)}"
                  class="group p-3.5 text-left bg-slate-50/60 hover:bg-white border border-slate-200 hover:border-blue-300 rounded-lg transition-all shadow-xs hover:shadow-sm flex flex-col justify-between gap-2"
                >
                  <div class="flex items-center justify-between gap-2 w-full">
                    <span class="inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-full border ${badgeCls}">
                      ${escapeHtml(acc.badge)}
                    </span>
                    <span class="text-[11px] font-semibold text-blue-700 group-hover:translate-x-0.5 transition-transform">Fill &rarr;</span>
                  </div>
                  <div class="min-w-0">
                    <div class="text-xs font-semibold text-slate-900 truncate">${escapeHtml(acc.label)}</div>
                    <div class="text-[11px] text-slate-500 truncate">${escapeHtml(acc.sublabel)}</div>
                    <div class="text-[11px] font-mono text-slate-600 truncate mt-1">${escapeHtml(acc.email)}</div>
                  </div>
                </button>
              `;
            }).join('')}
          </div>
        </aside>
      </div>
    </main>
  `;
}

// ---------------------------------------------------------------------------
// Rendering: Audit History Timeline
// ---------------------------------------------------------------------------

function renderAuditTimeline(entries) {
  if (!entries) {
    return `<div class="py-3 text-xs text-slate-500">Loading audit history...</div>`;
  }
  if (entries.length === 0) {
    return `<div class="py-3 text-xs text-slate-500">No audit history entries recorded yet.</div>`;
  }

  return `
    <div class="divide-y divide-slate-100 border border-slate-200 rounded bg-slate-50/50">
      ${entries
        .map(
          (entry) => `
          <div class="px-3.5 py-2.5 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="font-medium text-slate-900">
                ${escapeHtml(entry.action_type)}
                ${
                  entry.previous_state || entry.new_state
                    ? `<span class="font-normal text-slate-500 ml-1">(${escapeHtml(entry.previous_state || 'None')} &rarr; ${escapeHtml(entry.new_state || 'None')})</span>`
                    : ''
                }
              </div>
              <div class="font-mono text-[11px] text-slate-500 tabular-nums">${escapeHtml(formatManilaDateTime(entry.created_at))}</div>
            </div>
            <div class="text-slate-600 mt-1">
              Actor: <span class="font-medium text-slate-800">${escapeHtml(entry.actor_name)}</span> (${escapeHtml(entry.actor_role)})
            </div>
            ${entry.notes ? `<div class="text-slate-700 mt-1">${escapeHtml(entry.notes)}</div>` : ''}
          </div>
        `
        )
        .join('')}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Rendering: Scholar View
// ---------------------------------------------------------------------------

function renderScholarView() {
  const assignment = state.assignment;
  const program = assignment?.program || null;

  return `
    <main class="max-w-[1360px] mx-auto px-6 py-8 space-y-8">
      <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <p class="text-xs font-medium text-slate-500">
            Scholar Portal · Student ID ${escapeHtml(state.profile.student_id || 'Unassigned')}
          </p>
          <h1 class="font-display text-2xl font-bold text-slate-900 mt-1">
            ${escapeHtml(state.profile.full_name)}
          </h1>
        </div>
        ${
          assignment
            ? `
              <div class="flex items-center gap-3 text-xs text-slate-600">
                <span>Assigned Award: <strong class="text-slate-900">${escapeHtml(program?.name || 'Unknown')}</strong></span>
                <span aria-hidden="true">&middot;</span>
                <span>Award Status:</span>
                ${renderStatusTag(assignment.award_status)}
              </div>
            `
            : `<div class="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded">No scholarship program assigned yet. Contact scholarship staff.</div>`
        }
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <!-- Assigned Program Thresholds -->
        <section class="lg:col-span-4 bg-white border border-slate-200 rounded-xl shadow-sm p-6">
          <h2 class="font-display text-base font-semibold text-slate-900">Active Policy Thresholds</h2>
          ${
            program
              ? `
                <p class="text-xs text-slate-500 mt-1 mb-4">
                  ${escapeHtml(program.name)} · Philippine grading scale (1.00 highest, 5.00 failing)
                </p>
                <dl class="divide-y divide-slate-100 text-sm">
                  <div class="py-2.5 flex items-center justify-between">
                    <dt class="text-slate-600">Maximum GWA</dt>
                    <dd class="font-mono font-semibold text-slate-900 tabular-nums">&le; ${Number(program.max_gwa).toFixed(2)}</dd>
                  </div>
                  <div class="py-2.5 flex items-center justify-between">
                    <dt class="text-slate-600">Minimum Enrolled Units</dt>
                    <dd class="font-mono font-semibold text-slate-900 tabular-nums">&ge; ${program.min_units} units</dd>
                  </div>
                  <div class="py-2.5 flex items-center justify-between">
                    <dt class="text-slate-600">Max Failed Subjects</dt>
                    <dd class="font-mono font-semibold text-slate-900 tabular-nums">&le; ${program.max_failed}</dd>
                  </div>
                  <div class="py-2.5 flex items-center justify-between">
                    <dt class="text-slate-600">Max Incomplete (INC)</dt>
                    <dd class="font-mono font-semibold text-slate-900 tabular-nums">&le; ${program.max_incomplete}</dd>
                  </div>
                  <div class="py-2.5 flex items-center justify-between">
                    <dt class="text-slate-600">Max Dropped Subjects</dt>
                    <dd class="font-mono font-semibold text-slate-900 tabular-nums">&le; ${program.max_dropped}</dd>
                  </div>
                  <div class="py-2.5 flex items-center justify-between gap-3">
                    <dt class="text-slate-600">Deadline (PHT)</dt>
                    <dd class="font-mono text-xs font-semibold text-slate-900 tabular-nums text-right">${escapeHtml(
                      formatManilaDateTime(program.submission_deadline)
                    )}</dd>
                  </div>
                </dl>
              `
              : `<p class="text-xs text-slate-500 mt-3">Policy thresholds will appear once scholarship staff assigns your program.</p>`
          }
        </section>

        <!-- Submit Semester Grades -->
        <section class="lg:col-span-8 bg-white border border-slate-200 rounded-xl shadow-sm p-6">
          <h2 class="font-display text-base font-semibold text-slate-900">Submit Semester Grade Report</h2>
          <p class="text-xs text-slate-500 mt-1 mb-5">
            One submission is permitted per Academic Year and Semester. Submissions enter <strong class="text-slate-700">Pending</strong> verification status until reviewed by staff.
          </p>

          <form id="scholar-submit-form" class="grid grid-cols-1 sm:grid-cols-6 gap-4">
            <div class="sm:col-span-2">
              <label class="block text-xs font-medium text-slate-700 mb-1" for="sub-ay">Academic Year</label>
              <input id="sub-ay" type="text" required value="2026-2027" placeholder="2026-2027" class="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700" />
            </div>
            <div class="sm:col-span-2">
              <label class="block text-xs font-medium text-slate-700 mb-1" for="sub-sem">Semester</label>
              <select id="sub-sem" class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700">
                <option value="Semester 1">Semester 1</option>
                <option value="Semester 2">Semester 2</option>
                <option value="Midyear">Midyear</option>
              </select>
            </div>
            <div class="sm:col-span-2">
              <label class="block text-xs font-medium text-slate-700 mb-1" for="sub-gwa">GWA (1.00 – 5.00)</label>
              <input id="sub-gwa" type="number" step="0.01" min="1.00" max="5.00" required placeholder="1.75" class="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700" />
            </div>

            <div class="sm:col-span-2">
              <label class="block text-xs font-medium text-slate-700 mb-1" for="sub-units">Enrolled Units</label>
              <input id="sub-units" type="number" step="1" min="0" required placeholder="18" class="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700" />
            </div>
            <div class="sm:col-span-1">
              <label class="block text-xs font-medium text-slate-700 mb-1" for="sub-failed">Failed</label>
              <input id="sub-failed" type="number" step="1" min="0" value="0" required class="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700" />
            </div>
            <div class="sm:col-span-1">
              <label class="block text-xs font-medium text-slate-700 mb-1" for="sub-inc">INC</label>
              <input id="sub-inc" type="number" step="1" min="0" value="0" required class="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700" />
            </div>
            <div class="sm:col-span-2">
              <label class="block text-xs font-medium text-slate-700 mb-1" for="sub-drop">Dropped</label>
              <input id="sub-drop" type="number" step="1" min="0" value="0" required class="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700" />
            </div>

            <div class="sm:col-span-6">
              <label class="block text-xs font-medium text-slate-700 mb-1" for="sub-ref">Grade Document Reference (Registrar Code or URL)</label>
              <input id="sub-ref" type="text" required placeholder="e.g. REG-2026-S2-B01-TOR or https://registrar.edu/doc/..." class="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700" />
            </div>

            <div class="sm:col-span-6 flex justify-end pt-1">
              <button
                type="submit"
                ${!assignment || state.busyAction ? 'disabled' : ''}
                class="px-5 py-2.5 text-sm font-semibold text-white bg-[#1e3a8a] rounded-lg hover:bg-blue-900 disabled:opacity-50 transition-colors shadow-sm"
              >
                ${state.busyAction ? 'Submitting...' : 'Submit Grade Report'}
              </button>
            </div>
          </form>
        </section>
      </div>

      <!-- Scholar Submissions History -->
      <section class="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 bg-slate-50/70">
          <div>
            <h2 class="font-display text-base font-semibold text-slate-900">My Semester Submissions</h2>
            <p class="text-xs text-slate-500 mt-0.5">Verification, compliance evaluation, and renewal status remain strictly independent.</p>
          </div>
          <span class="text-xs font-mono text-slate-500 tabular-nums">${state.submissions.length} record${state.submissions.length === 1 ? '' : 's'}</span>
        </div>

        ${
          state.submissions.length === 0
            ? `<div class="p-10 text-center text-sm text-slate-500">No semester grade submissions recorded yet. Use the form above to submit your first report.</div>`
            : `
              <div class="divide-y divide-slate-200">
                ${state.submissions
                  .map((sub) => {
                    const isExpanded = state.expandedAuditIds.has(sub.id);
                    const reasons = Array.isArray(sub.deficiency_reasons) ? sub.deficiency_reasons : [];
                    return `
                      <div class="p-6">
                        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                          <div>
                            <div class="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                              <span>${escapeHtml(sub.academic_year)} &middot; ${escapeHtml(sub.semester)}</span>
                              <span class="text-slate-300">/</span>
                              <span class="font-normal text-slate-600">${escapeHtml(sub.program?.name || '')}</span>
                            </div>
                            <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 font-mono tabular-nums">
                              <span>GWA: <strong class="text-slate-900">${Number(sub.gwa).toFixed(2)}</strong></span>
                              <span>Units: <strong class="text-slate-900">${sub.enrolled_units}</strong></span>
                              <span>Failed: <strong class="text-slate-900">${sub.failed_count}</strong></span>
                              <span>INC: <strong class="text-slate-900">${sub.incomplete_count}</strong></span>
                              <span>Drop: <strong class="text-slate-900">${sub.dropped_count}</strong></span>
                              <span>Submitted: <strong class="text-slate-900">${escapeHtml(formatManilaDateTime(sub.submitted_at))}</strong></span>
                            </div>
                            <div class="mt-1 text-xs text-slate-500 font-mono">
                              Document Ref: ${escapeHtml(sub.evidence_reference)}
                            </div>
                          </div>

                          <div class="flex flex-wrap items-center gap-4">
                            <div>
                              <div class="text-[11px] text-slate-500 mb-1">Verification</div>
                              ${renderStatusTag(sub.verification_status)}
                            </div>
                            <div>
                              <div class="text-[11px] text-slate-500 mb-1">Compliance</div>
                              ${renderStatusTag(sub.compliance_status)}
                            </div>
                            <div>
                              <div class="text-[11px] text-slate-500 mb-1">Renewal Decision</div>
                              ${renderStatusTag(sub.renewal_decision)}
                            </div>
                          </div>
                        </div>

                        ${
                          sub.verification_status === 'Returned' && sub.verification_reason
                            ? `
                              <div class="mt-4 p-3.5 bg-rose-50 border border-rose-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                <div class="text-xs text-rose-900">
                                  <strong>Returned by Staff:</strong> ${escapeHtml(sub.verification_reason)}
                                </div>
                                <button
                                  type="button"
                                  data-open-resubmit="${escapeHtml(sub.id)}"
                                  class="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-rose-700 rounded-lg hover:bg-rose-800 whitespace-nowrap shrink-0 shadow-sm"
                                >
                                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                  <span>Correct &amp; Resubmit</span>
                                </button>
                              </div>
                            `
                            : ''
                        }

                        ${
                          reasons.length > 0
                            ? `
                              <div class="mt-4 p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
                                <div class="text-xs font-semibold text-slate-800 mb-1">Deficiency Reasons</div>
                                <ul class="list-disc list-inside text-xs text-rose-800 space-y-0.5">
                                  ${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
                                </ul>
                              </div>
                            `
                            : ''
                        }

                        ${
                          sub.decision_notes
                            ? `
                              <div class="mt-3 text-xs text-slate-700">
                                <strong>Decision Notes:</strong> ${escapeHtml(sub.decision_notes)}
                              </div>
                            `
                            : ''
                        }

                        <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                          <button
                            type="button"
                            data-toggle-audit="${escapeHtml(sub.id)}"
                            class="text-xs font-semibold text-blue-700 hover:text-blue-900"
                          >
                            ${isExpanded ? 'Hide Audit History' : 'View Audit History'}
                          </button>
                        </div>

                        ${isExpanded ? `<div class="mt-3">${renderAuditTimeline(state.auditCache[sub.id])}</div>` : ''}
                      </div>
                    `;
                  })
                  .join('')}
              </div>
            `
        }
      </section>

      ${renderResubmitModal()}
    </main>
  `;
}

function renderResubmitModal() {
  const sub = state.resubmitTarget;
  if (!sub) return '';

  return `
    <div class="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div class="bg-white border border-slate-200 border-t-4 border-t-rose-600 rounded-xl w-full max-w-xl shadow-2xl overflow-hidden">
        <div class="px-6 py-5 border-b border-slate-200 flex items-start justify-between gap-4 bg-slate-50/70">
          <div>
            <h3 class="font-display text-lg font-semibold text-slate-900">Correct &amp; Resubmit Grade Report</h3>
            <p class="text-xs text-slate-500 mt-1">
              ${escapeHtml(sub.academic_year)} &middot; ${escapeHtml(sub.semester)} &middot; Resubmitting resets verification status to Pending and updates submission timestamp.
            </p>
          </div>
          <button id="btn-close-resubmit" class="text-slate-400 hover:text-slate-700 text-xl leading-none px-1.5 py-0.5 rounded hover:bg-slate-200/60">&times;</button>
        </div>

        <div class="p-6">
          ${
            sub.verification_reason
              ? `<div class="mb-4 p-3 text-xs text-rose-900 bg-rose-50 border border-rose-200 rounded-lg"><strong>Staff Return Reason:</strong> ${escapeHtml(
                  sub.verification_reason
                )}</div>`
              : ''
          }

          <form id="resubmit-form" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="resub-gwa">GWA (1.00 – 5.00)</label>
              <input id="resub-gwa" type="number" step="0.01" min="1.00" max="5.00" required value="${Number(sub.gwa).toFixed(2)}" class="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="resub-units">Enrolled Units</label>
              <input id="resub-units" type="number" step="1" min="0" required value="${sub.enrolled_units}" class="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="resub-failed">Failed Subjects</label>
              <input id="resub-failed" type="number" step="1" min="0" required value="${sub.failed_count}" class="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="resub-inc">Incomplete (INC)</label>
              <input id="resub-inc" type="number" step="1" min="0" required value="${sub.incomplete_count}" class="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="resub-drop">Dropped Subjects</label>
              <input id="resub-drop" type="number" step="1" min="0" required value="${sub.dropped_count}" class="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg" />
            </div>
            <div class="sm:col-span-2">
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="resub-ref">Grade Document Reference</label>
              <input id="resub-ref" type="text" required value="${escapeHtml(sub.evidence_reference)}" class="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg" />
            </div>
            <div class="sm:col-span-2 flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button type="button" id="btn-cancel-resubmit" class="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
              <button type="submit" ${state.busyAction ? 'disabled' : ''} class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1e3a8a] rounded-lg hover:bg-blue-900 disabled:opacity-50 shadow-sm">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4Z"/></svg>
                <span>${state.busyAction ? 'Resubmitting...' : 'Resubmit for Verification'}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Rendering: Staff View
// ---------------------------------------------------------------------------

function getFilteredSubmissionsByTerm() {
  return state.submissions.filter((s) => {
    const matchYear = state.filterYear === 'ALL' || s.academic_year === state.filterYear;
    const matchSem = state.filterSemester === 'ALL' || s.semester === state.filterSemester;
    return matchYear && matchSem;
  });
}

function getFilteredSubmissionsForTable() {
  const termSubs = getFilteredSubmissionsByTerm();
  const q = state.searchQuery.trim().toLowerCase();

  return termSubs.filter((s) => {
    if (q) {
      const sid = (s.scholar?.student_id || '').toLowerCase();
      const name = (s.scholar?.full_name || '').toLowerCase();
      if (!sid.includes(q) && !name.includes(q)) return false;
    }
    if (state.filterProgramId !== 'ALL' && s.program_id !== state.filterProgramId) return false;
    if (state.filterVerification !== 'ALL' && s.verification_status !== state.filterVerification) return false;
    if (state.filterCompliance !== 'ALL' && s.compliance_status !== state.filterCompliance) return false;
    return true;
  });
}

function renderStaffView() {
  const years = Array.from(new Set(['2026-2027', ...state.submissions.map((s) => s.academic_year)])).sort();
  const semesters = Array.from(
    new Set(['Semester 1', 'Semester 2', 'Midyear', ...state.submissions.map((s) => s.semester)])
  );

  const termSubs = getFilteredSubmissionsByTerm();
  const totalAssigned = state.allAssignments.length;
  const pendingVerification = termSubs.filter((s) => s.verification_status === 'Pending').length;
  const compliantCount = termSubs.filter((s) => s.compliance_status === 'Compliant').length;
  const deficiencyCount = termSubs.filter((s) => s.compliance_status === 'With Deficiency').length;

  return `
    <main class="max-w-[1360px] mx-auto px-6 py-8 space-y-6">
      <!-- Staff Workspace Header + Term Filter -->
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <p class="text-xs font-medium text-slate-500">Scholarship Administration Console</p>
          <h1 class="font-display text-2xl font-bold text-slate-900 mt-1">Academic Compliance &amp; Renewal Review</h1>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <div>
            <label class="block text-[11px] font-medium text-slate-500 mb-1" for="kpi-year">Academic Year</label>
            <select id="kpi-year" class="px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded">
              <option value="ALL" ${state.filterYear === 'ALL' ? 'selected' : ''}>All Years</option>
              ${years.map((y) => `<option value="${escapeHtml(y)}" ${state.filterYear === y ? 'selected' : ''}>${escapeHtml(y)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-[11px] font-medium text-slate-500 mb-1" for="kpi-sem">Semester</label>
            <select id="kpi-sem" class="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded">
              <option value="ALL" ${state.filterSemester === 'ALL' ? 'selected' : ''}>All Semesters</option>
              ${semesters.map((s) => `<option value="${escapeHtml(s)}" ${state.filterSemester === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>

      <!-- Mobile Tab Switcher -->
      <div class="flex md:hidden items-center gap-1 p-1 bg-slate-100 rounded">
        <button data-staff-tab="submissions" class="flex-1 py-1.5 text-xs font-medium rounded ${
          state.staffTab === 'submissions' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
        }">Submissions</button>
        <button data-staff-tab="assignments" class="flex-1 py-1.5 text-xs font-medium rounded ${
          state.staffTab === 'assignments' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
        }">Assignments</button>
        <button data-staff-tab="policies" class="flex-1 py-1.5 text-xs font-medium rounded ${
          state.staffTab === 'policies' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
        }">Policies</button>
      </div>

      <!-- 4 KPI Summary Cards -->
      <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="bg-indigo-50/50 border border-slate-200 border-l-4 border-l-indigo-600 rounded-xl shadow-sm p-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-semibold text-slate-600">Total Assigned Scholars</div>
              <div class="font-display text-2xl font-bold text-slate-900 tabular-nums mt-2">${totalAssigned}</div>
              <div class="text-xs text-slate-500 mt-1">Active roster across programs</div>
            </div>
            <span class="w-9 h-9 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </span>
          </div>
        </div>
        <div class="bg-amber-50/50 border border-slate-200 border-l-4 border-l-amber-500 rounded-xl shadow-sm p-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-semibold text-slate-600">Pending Verification</div>
              <div class="font-display text-2xl font-bold text-amber-800 tabular-nums mt-2">${pendingVerification}</div>
              <div class="text-xs text-slate-500 mt-1">${escapeHtml(state.filterYear)} &middot; ${escapeHtml(state.filterSemester)}</div>
            </div>
            <span class="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </span>
          </div>
        </div>
        <div class="bg-emerald-50/50 border border-slate-200 border-l-4 border-l-emerald-600 rounded-xl shadow-sm p-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-semibold text-slate-600">Compliant</div>
              <div class="font-display text-2xl font-bold text-emerald-800 tabular-nums mt-2">${compliantCount}</div>
              <div class="text-xs text-slate-500 mt-1">Eligible for renewal approval</div>
            </div>
            <span class="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
            </span>
          </div>
        </div>
        <div class="bg-rose-50/50 border border-slate-200 border-l-4 border-l-rose-600 rounded-xl shadow-sm p-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-semibold text-slate-600">With Deficiency</div>
              <div class="font-display text-2xl font-bold text-rose-800 tabular-nums mt-2">${deficiencyCount}</div>
              <div class="text-xs text-slate-500 mt-1">Requires staff hold review</div>
            </div>
            <span class="w-9 h-9 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </span>
          </div>
        </div>
      </section>

      ${
        state.staffTab === 'submissions'
          ? renderStaffSubmissionsTab()
          : state.staffTab === 'assignments'
          ? renderStaffAssignmentsTab()
          : renderStaffPoliciesTab()
      }

      ${renderStaffDetailDrawer()}
    </main>
  `;
}

function renderStaffSubmissionsTab() {
  const rows = getFilteredSubmissionsForTable();
  const verifiedCount = rows.filter((r) => r.verification_status === 'Verified').length;

  return `
    <section class="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <!-- Search & Filter Bar -->
      <div class="p-4 border-b border-slate-200 bg-slate-50/70 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3 flex-1">
          <input
            id="staff-search"
            type="search"
            value="${escapeHtml(state.searchQuery)}"
            placeholder="Search Student ID or Name..."
            class="w-full sm:w-64 px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
          />

          <select id="filter-program" class="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg">
            <option value="ALL">All Programs</option>
            ${state.programs
              .map(
                (p) =>
                  `<option value="${escapeHtml(p.id)}" ${state.filterProgramId === p.id ? 'selected' : ''}>${escapeHtml(
                    p.name
                  )}</option>`
              )
              .join('')}
          </select>

          <select id="filter-verification" class="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg">
            <option value="ALL">All Verification</option>
            <option value="Pending" ${state.filterVerification === 'Pending' ? 'selected' : ''}>Pending</option>
            <option value="Verified" ${state.filterVerification === 'Verified' ? 'selected' : ''}>Verified</option>
            <option value="Returned" ${state.filterVerification === 'Returned' ? 'selected' : ''}>Returned</option>
          </select>

          <select id="filter-compliance" class="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg">
            <option value="ALL">All Compliance</option>
            <option value="Pending Evaluation" ${
              state.filterCompliance === 'Pending Evaluation' ? 'selected' : ''
            }>Pending Evaluation</option>
            <option value="Compliant" ${state.filterCompliance === 'Compliant' ? 'selected' : ''}>Compliant</option>
            <option value="With Deficiency" ${
              state.filterCompliance === 'With Deficiency' ? 'selected' : ''
            }>With Deficiency</option>
          </select>
        </div>

        <button
          id="btn-evaluate-all"
          type="button"
          ${verifiedCount === 0 || state.busyAction ? 'disabled' : ''}
          class="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-[#1e3a8a] rounded-lg hover:bg-blue-900 disabled:opacity-40 whitespace-nowrap shrink-0 shadow-sm"
          title="Dynamically evaluate all Verified submissions in the filtered list"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>Evaluate All Verified (${verifiedCount})</span>
        </button>
      </div>

      ${
        rows.length === 0
          ? `<div class="p-10 text-center text-sm text-slate-500">No submissions match the selected term and filters.</div>`
          : `
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse text-sm">
                <thead>
                  <tr class="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th class="py-2.5 px-4 whitespace-nowrap">Student ID</th>
                    <th class="py-2.5 px-4 whitespace-nowrap">Scholar</th>
                    <th class="py-2.5 px-4 whitespace-nowrap">Program</th>
                    <th class="py-2.5 px-4 text-right whitespace-nowrap">GWA</th>
                    <th class="py-2.5 px-4 text-right whitespace-nowrap">Units</th>
                    <th class="py-2.5 px-4 text-right whitespace-nowrap">F / I / D</th>
                    <th class="py-2.5 px-4 whitespace-nowrap">Submitted (PHT)</th>
                    <th class="py-2.5 px-4 whitespace-nowrap">Verification</th>
                    <th class="py-2.5 px-4 whitespace-nowrap">Compliance</th>
                    <th class="py-2.5 px-4 whitespace-nowrap">Renewal</th>
                    <th class="py-2.5 px-4 text-right whitespace-nowrap">Action</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${rows
                    .map(
                      (row) => `
                    <tr class="hover:bg-slate-50 transition-colors cursor-pointer" data-inspect-submission="${escapeHtml(row.id)}">
                      <td class="py-2.5 px-4 font-mono text-xs font-semibold text-slate-900 whitespace-nowrap">${escapeHtml(
                        row.scholar?.student_id || '—'
                      )}</td>
                      <td class="py-2.5 px-4 text-xs font-medium text-slate-900 whitespace-nowrap">${escapeHtml(
                        row.scholar?.full_name || 'Unknown'
                      )}</td>
                      <td class="py-2.5 px-4 text-xs text-slate-600 whitespace-nowrap">${escapeHtml(row.program?.name || '—')}</td>
                      <td class="py-2.5 px-4 font-mono text-xs text-right tabular-nums text-slate-900 whitespace-nowrap">${Number(
                        row.gwa
                      ).toFixed(2)}</td>
                      <td class="py-2.5 px-4 font-mono text-xs text-right tabular-nums text-slate-900 whitespace-nowrap">${
                        row.enrolled_units
                      }</td>
                      <td class="py-2.5 px-4 font-mono text-xs text-right tabular-nums text-slate-700 whitespace-nowrap">${
                        row.failed_count
                      } / ${row.incomplete_count} / ${row.dropped_count}</td>
                      <td class="py-2.5 px-4 font-mono text-[11px] text-slate-600 tabular-nums whitespace-nowrap">${escapeHtml(
                        formatManilaShort(row.submitted_at)
                      )}</td>
                      <td class="py-2.5 px-4 whitespace-nowrap">${renderStatusTag(row.verification_status)}</td>
                      <td class="py-2.5 px-4 whitespace-nowrap">${renderStatusTag(row.compliance_status)}</td>
                      <td class="py-2.5 px-4 whitespace-nowrap">${renderStatusTag(row.renewal_decision)}</td>
                      <td class="py-2.5 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          data-inspect-submission="${escapeHtml(row.id)}"
                          class="px-2.5 py-1 text-xs font-medium text-blue-700 hover:text-blue-900 border border-slate-200 rounded bg-white hover:bg-slate-50"
                        >
                          Review
                        </button>
                      </td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          `
      }
    </section>
  `;
}

function renderStaffAssignmentsTab() {
  const assignmentByScholar = new Map(state.allAssignments.map((a) => [a.scholar_id, a]));

  return `
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <section class="lg:col-span-4 bg-white border border-slate-200 rounded-md p-6">
        <h2 class="font-display text-base font-semibold text-slate-900">Assign Scholar Program</h2>
        <p class="text-xs text-slate-500 mt-1 mb-4">
          Bind a registered scholar to a scholarship policy and manage their award status independently of semester deficiencies.
        </p>

        <form id="assign-scholar-form" class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1" for="assign-scholar">Scholar</label>
            <select id="assign-scholar" required class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded">
              <option value="">Select scholar...</option>
              ${state.allScholars
                .map(
                  (s) =>
                    `<option value="${escapeHtml(s.id)}">${escapeHtml(s.student_id || 'NO-ID')} · ${escapeHtml(
                      s.full_name
                    )}</option>`
                )
                .join('')}
            </select>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1" for="assign-program">Scholarship Program</label>
            <select id="assign-program" required class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded">
              ${state.programs
                .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
                .join('')}
            </select>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1" for="assign-status">Award Status</label>
            <select id="assign-status" required class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded">
              <option value="Active">Active</option>
              <option value="On Hold">On Hold</option>
              <option value="Terminated">Terminated</option>
            </select>
          </div>
          <button type="submit" ${state.busyAction ? 'disabled' : ''} class="w-full py-2 px-4 text-xs font-medium text-white bg-blue-700 rounded hover:bg-blue-800 disabled:opacity-50">
            Save Assignment
          </button>
        </form>
      </section>

      <section class="lg:col-span-8 bg-white border border-slate-200 rounded-md overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 class="font-display text-base font-semibold text-slate-900">Registered Scholars Roster</h2>
          <span class="text-xs font-mono text-slate-500 tabular-nums">${state.allScholars.length} scholars</span>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-sm">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th class="py-2.5 px-4">Student ID</th>
                <th class="py-2.5 px-4">Full Name</th>
                <th class="py-2.5 px-4">Email</th>
                <th class="py-2.5 px-4">Assigned Program</th>
                <th class="py-2.5 px-4">Award Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${state.allScholars
                .map((s) => {
                  const a = assignmentByScholar.get(s.id);
                  return `
                    <tr class="hover:bg-slate-50">
                      <td class="py-2.5 px-4 font-mono text-xs font-semibold text-slate-900">${escapeHtml(s.student_id || '—')}</td>
                      <td class="py-2.5 px-4 text-xs font-medium text-slate-900">${escapeHtml(s.full_name)}</td>
                      <td class="py-2.5 px-4 font-mono text-xs text-slate-600">${escapeHtml(s.email)}</td>
                      <td class="py-2.5 px-4 text-xs text-slate-800">${escapeHtml(a?.program?.name || 'Unassigned')}</td>
                      <td class="py-2.5 px-4">${a ? renderStatusTag(a.award_status) : '<span class="text-xs text-slate-400">None</span>'}</td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
}

function renderStaffPoliciesTab() {
  return `
    <div class="space-y-6">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        ${state.programs
          .map(
            (p) => `
          <form class="bg-white border border-slate-200 rounded-md p-6 space-y-4" data-policy-form="${escapeHtml(p.id)}">
            <div class="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 class="font-display text-base font-semibold text-slate-900">${escapeHtml(p.name)}</h2>
                <p class="text-xs text-slate-500 mt-0.5">Live thresholds read dynamically by compliance evaluator</p>
              </div>
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">Max GWA</label>
                <input name="max_gwa" type="number" step="0.01" min="1.00" max="5.00" required value="${Number(p.max_gwa).toFixed(2)}" class="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded" />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">Min Units</label>
                <input name="min_units" type="number" step="1" min="0" required value="${p.min_units}" class="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded" />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">Max Failed</label>
                <input name="max_failed" type="number" step="1" min="0" required value="${p.max_failed}" class="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded" />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">Max INC</label>
                <input name="max_incomplete" type="number" step="1" min="0" required value="${p.max_incomplete}" class="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded" />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">Max Dropped</label>
                <input name="max_dropped" type="number" step="1" min="0" required value="${p.max_dropped}" class="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded" />
              </div>
              <div class="col-span-2 sm:col-span-3">
                <label class="block text-xs font-medium text-slate-700 mb-1">Submission Deadline (Asia/Manila PHT)</label>
                <input name="deadlineLocal" type="datetime-local" required value="${escapeHtml(
                  toManilaDatetimeLocal(p.submission_deadline)
                )}" class="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded" />
              </div>
            </div>

            <div class="flex justify-end pt-1">
              <button type="submit" ${state.busyAction ? 'disabled' : ''} class="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded hover:bg-slate-800 disabled:opacity-50">
                Save Policy Changes
              </button>
            </div>
          </form>
        `
          )
          .join('')}
      </div>

      <section class="bg-white border border-slate-200 rounded-md p-6">
        <h3 class="font-display text-sm font-semibold text-slate-900 mb-3">Add New Scholarship Policy</h3>
        <form id="create-policy-form" class="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div class="sm:col-span-2">
            <label class="block text-xs font-medium text-slate-700 mb-1">Program Name</label>
            <input name="name" type="text" required placeholder="e.g. Merit Scholar" class="w-full px-3 py-1.5 text-sm border border-slate-300 rounded" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1">Max GWA</label>
            <input name="max_gwa" type="number" step="0.01" min="1.00" max="5.00" value="2.25" required class="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1">Min Units</label>
            <input name="min_units" type="number" min="0" value="15" required class="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1">Max Failed</label>
            <input name="max_failed" type="number" min="0" value="0" required class="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1">Max INC</label>
            <input name="max_incomplete" type="number" min="0" value="0" required class="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1">Max Dropped</label>
            <input name="max_dropped" type="number" min="0" value="0" required class="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1">Deadline (PHT)</label>
            <input name="deadlineLocal" type="datetime-local" value="2026-11-06T17:00" required class="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded" />
          </div>
          <div class="sm:col-span-4 flex justify-end">
            <button type="submit" ${state.busyAction ? 'disabled' : ''} class="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded hover:bg-blue-800 disabled:opacity-50">
              Create Policy
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderStaffDetailDrawer() {
  if (!state.selectedSubmissionId) return '';
  const sub = state.submissions.find((s) => s.id === state.selectedSubmissionId);
  if (!sub) return '';

  const program = state.programs.find((p) => p.id === sub.program_id) || sub.program;
  const preview = evaluateSubmissionCompliance(sub, program);
  const isVerified = sub.verification_status === 'Verified';
  const canApprove = isVerified && sub.compliance_status === 'Compliant';
  const auditEntries = state.auditCache[sub.id];
  const persistedReasons = Array.isArray(sub.deficiency_reasons) ? sub.deficiency_reasons : [];

  return `
    <div class="fixed inset-0 z-40 bg-slate-900/45 backdrop-blur-[2px] flex justify-end">
      <div class="bg-white border-l border-slate-200 w-full max-w-2xl h-full overflow-y-auto shadow-2xl flex flex-col">
        <div class="px-6 py-5 border-b border-slate-200 bg-slate-50/80 flex items-start justify-between gap-4 sticky top-0 z-10">
          <div>
            <div class="text-xs font-mono text-slate-500">
              ${escapeHtml(sub.scholar?.student_id || '—')} &middot; ${escapeHtml(sub.academic_year)} &middot; ${escapeHtml(
    sub.semester
  )}
            </div>
            <h2 class="font-display text-xl font-bold text-slate-900 mt-0.5">${escapeHtml(
              sub.scholar?.full_name || 'Scholar'
            )}</h2>
            <div class="text-xs text-slate-600 mt-1">
              Program: <strong class="text-slate-900">${escapeHtml(program?.name || '—')}</strong> &middot; Document Ref: <span class="font-mono text-slate-800">${escapeHtml(
    sub.evidence_reference
  )}</span>
            </div>
          </div>
          <button id="btn-close-drawer" class="text-slate-400 hover:text-slate-700 text-xl leading-none px-2 py-1 rounded-lg hover:bg-slate-200/60" aria-label="Close detail drawer">&times;</button>
        </div>

        <div class="p-6 space-y-6 flex-1">
          <!-- Status Strip -->
          <div class="grid grid-cols-3 gap-3 p-4 bg-slate-50 border border-slate-200 rounded-xl">
            <div>
              <div class="text-[11px] font-medium text-slate-500 mb-1.5">Verification</div>
              ${renderStatusTag(sub.verification_status)}
            </div>
            <div>
              <div class="text-[11px] font-medium text-slate-500 mb-1.5">Compliance</div>
              ${renderStatusTag(sub.compliance_status)}
            </div>
            <div>
              <div class="text-[11px] font-medium text-slate-500 mb-1.5">Renewal Decision</div>
              ${renderStatusTag(sub.renewal_decision)}
            </div>
          </div>

          <!-- Step 1: Verification Controls -->
          <section class="border border-slate-200 rounded-xl shadow-xs p-5 space-y-3.5 bg-white">
            <div class="flex items-center justify-between gap-3 pb-3 border-b border-slate-100">
              <h3 class="font-display text-sm font-semibold text-slate-900">1. Verification Gate</h3>
              <span class="text-xs font-mono text-slate-500 tabular-nums">${escapeHtml(formatManilaDateTime(sub.submitted_at))}</span>
            </div>

            ${
              sub.verification_reason
                ? `<div class="p-3 text-xs text-rose-900 bg-rose-50 border border-rose-200 rounded-lg"><strong>Return Reason:</strong> ${escapeHtml(
                    sub.verification_reason
                  )}</div>`
                : ''
            }

            <div class="flex flex-wrap items-center gap-2">
              <button
                id="btn-verify-sub"
                type="button"
                ${isVerified || state.busyAction ? 'disabled' : ''}
                class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-40 shadow-sm"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                <span>Verify Submission</span>
              </button>
            </div>

            <form id="return-sub-form" class="pt-3 border-t border-slate-100 space-y-2">
              <label class="block text-xs font-semibold text-slate-700" for="return-reason-input">Return to Scholar with Reason</label>
              <div class="flex gap-2">
                <input
                  id="return-reason-input"
                  type="text"
                  required
                  placeholder="e.g. Unclear registrar stamp or GWA mismatch on TOR"
                  class="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-600"
                />
                <button
                  type="submit"
                  ${state.busyAction ? 'disabled' : ''}
                  class="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 whitespace-nowrap shrink-0"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
                  <span>Return Submission</span>
                </button>
              </div>
            </form>
          </section>

          <!-- Step 2: Dynamic Compliance Evaluation -->
          <section class="border border-slate-200 rounded-xl shadow-xs p-5 space-y-3.5 bg-white">
            <div class="flex items-center justify-between gap-3 pb-3 border-b border-slate-100">
              <div>
                <h3 class="font-display text-sm font-semibold text-slate-900">2. Dynamic Compliance Evaluation</h3>
                <p class="text-xs text-slate-500 mt-0.5">Evaluates all 6 conditions against live ${escapeHtml(program?.name || '')} thresholds.</p>
              </div>
              <button
                id="btn-run-evaluation"
                type="button"
                ${!isVerified || state.busyAction ? 'disabled' : ''}
                title="${isVerified ? 'Persist evaluation result to database' : 'Blocked: Submission must be Verified before evaluation'}"
                class="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#1e3a8a] rounded-lg hover:bg-blue-900 disabled:opacity-40 whitespace-nowrap shrink-0 shadow-sm"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span>Run Compliance Evaluation</span>
              </button>
            </div>

            ${
              !isVerified
                ? `<div class="p-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg">Evaluation blocked until Verification Status is <strong>Verified</strong>.</div>`
                : ''
            }

            <div class="overflow-x-auto border border-slate-200 rounded-lg">
              <table class="w-full text-left text-xs border-collapse">
                <thead>
                  <tr class="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th class="py-2 px-3">Policy Condition</th>
                    <th class="py-2 px-3 text-right">Submitted</th>
                    <th class="py-2 px-3 text-right">Threshold</th>
                    <th class="py-2 px-3 text-right">Check</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${preview.checks
                    .map(
                      (c) => `
                    <tr>
                      <td class="py-2 px-3 font-medium text-slate-800">${escapeHtml(c.label)}</td>
                      <td class="py-2 px-3 text-right font-mono tabular-nums text-slate-900">${escapeHtml(c.actual)}</td>
                      <td class="py-2 px-3 text-right font-mono tabular-nums text-slate-600">${escapeHtml(c.threshold)}</td>
                      <td class="py-2 px-3 text-right font-semibold ${c.passed ? 'text-emerald-700' : 'text-rose-700'}">
                        ${c.passed ? 'PASS' : 'FAIL'}
                      </td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>
            </div>

            ${
              persistedReasons.length > 0
                ? `
                  <div class="p-3.5 bg-rose-50 border border-rose-200 rounded-lg">
                    <div class="text-xs font-semibold text-rose-900 mb-1">Recorded Deficiency Reasons</div>
                    <ul class="list-disc list-inside text-xs text-rose-800 space-y-0.5">
                      ${persistedReasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
                    </ul>
                  </div>
                `
                : sub.compliance_status === 'Compliant'
                ? `<div class="p-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">Persisted evaluation: <strong>Compliant</strong> (0 deficiencies).</div>`
                : ''
            }
          </section>

          <!-- Step 3: Renewal Decision Authority -->
          <section class="border border-slate-200 rounded-xl shadow-xs p-5 space-y-3.5 bg-white">
            <div class="pb-3 border-b border-slate-100">
              <h3 class="font-display text-sm font-semibold text-slate-900">3. Renewal Decision Authority</h3>
              <p class="text-xs text-slate-500 mt-0.5">
                Approved requires Compliant status. Deficiency flags allow Hold Renewal only and never auto-terminate the award.
              </p>
            </div>

            ${
              !isVerified
                ? `<div class="p-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg">Renewal decisions blocked until Verification Status is <strong>Verified</strong>.</div>`
                : sub.compliance_status === 'Pending Evaluation'
                ? `<div class="p-3 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg">Run Compliance Evaluation above before approving renewal.</div>`
                : ''
            }

            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1" for="decision-notes-input">Decision Notes (Optional)</label>
              <textarea
                id="decision-notes-input"
                rows="2"
                placeholder="Optional notes for renewal decision..."
                class="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              >${escapeHtml(sub.decision_notes || '')}</textarea>
            </div>

            <div class="flex flex-wrap items-center gap-2.5 pt-1">
              <button
                id="btn-approve-renewal"
                type="button"
                ${!canApprove || state.busyAction ? 'disabled' : ''}
                title="${canApprove ? 'Approve scholarship renewal for next term' : 'Blocked: Compliance Status must be Compliant'}"
                class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-40 shadow-sm"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
                <span>Approve Renewal</span>
              </button>
              <button
                id="btn-hold-renewal"
                type="button"
                ${!isVerified || state.busyAction ? 'disabled' : ''}
                title="${isVerified ? 'Place renewal on hold' : 'Blocked: Submission must be Verified'}"
                class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-rose-800 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 disabled:opacity-40"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>
                <span>Hold Renewal</span>
              </button>
            </div>
          </section>

          <!-- Step 4: Audit History Log -->
          <section class="space-y-2 pb-6">
            <h3 class="font-display text-sm font-semibold text-slate-900">4. Audit History Log</h3>
            ${renderAuditTimeline(auditEntries)}
          </section>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main Render & Event Wiring
// ---------------------------------------------------------------------------

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  let bodyHtml = '';
  if (!state.client) {
    bodyHtml = `
      <main class="max-w-xl mx-auto px-6 py-16 text-center">
        <div class="bg-white border border-slate-200 rounded-md p-8">
          <h1 class="font-display text-xl font-bold text-slate-900">Configure Supabase to Begin</h1>
          <p class="text-sm text-slate-600 mt-2 mb-5">
            Connect your Supabase Project URL and Anon Key to launch the ScholarGuard compliance workspace.
          </p>
          <button id="btn-open-config-hero" class="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded hover:bg-blue-800">
            Configure Supabase Connection
          </button>
        </div>
      </main>
    `;
  } else if (state.loading) {
    bodyHtml = `
      <main class="max-w-[1360px] mx-auto px-6 py-12 space-y-4">
        <div class="h-8 w-64 bg-slate-200 rounded animate-pulse"></div>
        <div class="grid grid-cols-4 gap-4">
          <div class="h-24 bg-slate-200 rounded animate-pulse"></div>
          <div class="h-24 bg-slate-200 rounded animate-pulse"></div>
          <div class="h-24 bg-slate-200 rounded animate-pulse"></div>
          <div class="h-24 bg-slate-200 rounded animate-pulse"></div>
        </div>
        <div class="h-64 bg-slate-200 rounded animate-pulse"></div>
      </main>
    `;
  } else if (!state.session || !state.profile) {
    bodyHtml = renderAuthView();
  } else if (state.profile.role === 'staff') {
    bodyHtml = renderStaffView();
  } else {
    bodyHtml = renderScholarView();
  }

  app.innerHTML = `${renderTopBar()}${bodyHtml}${renderConfigModal()}`;
  wireEventListeners();
  renderToasts();
}

function wireEventListeners() {
  // Top bar & Config Modal
  document.getElementById('btn-open-config')?.addEventListener('click', () => {
    state.showConfigModal = true;
    render();
  });
  document.getElementById('btn-open-config-hero')?.addEventListener('click', () => {
    state.showConfigModal = true;
    render();
  });
  document.getElementById('btn-close-config')?.addEventListener('click', () => {
    state.showConfigModal = false;
    render();
  });
  document.getElementById('btn-cancel-config')?.addEventListener('click', () => {
    state.showConfigModal = false;
    render();
  });
  document.getElementById('config-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = document.getElementById('cfg-url').value;
    const key = document.getElementById('cfg-key').value;
    handleSaveConfig(url, key);
  });
  document.getElementById('btn-sign-out')?.addEventListener('click', handleSignOut);

  // Auth mode & forms
  document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.authMode = btn.getAttribute('data-auth-mode');
      state.authError = '';
      state.authMessage = '';
      render();
    });
  });

  document.getElementById('reg-role')?.addEventListener('change', (e) => {
    const wrap = document.getElementById('reg-student-id-wrap');
    if (wrap) {
      wrap.style.display = e.target.value === 'scholar' ? 'block' : 'none';
    }
  });

  document.querySelectorAll('[data-quick-fill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const email = btn.getAttribute('data-quick-fill');
      if (state.authMode !== 'login') {
        state.authMode = 'login';
        render();
      }
      const emailInput = document.getElementById('login-email');
      const passInput = document.getElementById('login-password');
      if (emailInput && passInput) {
        emailInput.value = email;
        passInput.value = 'Password123!';
        emailInput.focus();
      }
    });
  });

  document.getElementById('login-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSignIn(
      document.getElementById('login-email').value,
      document.getElementById('login-password').value
    );
  });

  document.getElementById('register-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleRegister({
      fullName: document.getElementById('reg-name').value,
      email: document.getElementById('reg-email').value,
      password: document.getElementById('reg-password').value,
      role: document.getElementById('reg-role').value,
      studentId: document.getElementById('reg-student-id').value,
    });
  });

  // Scholar submission & resubmission
  document.getElementById('scholar-submit-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleScholarSubmit({
      academic_year: document.getElementById('sub-ay').value,
      semester: document.getElementById('sub-sem').value,
      gwa: document.getElementById('sub-gwa').value,
      enrolled_units: document.getElementById('sub-units').value,
      failed_count: document.getElementById('sub-failed').value,
      incomplete_count: document.getElementById('sub-inc').value,
      dropped_count: document.getElementById('sub-drop').value,
      evidence_reference: document.getElementById('sub-ref').value,
    });
  });

  document.querySelectorAll('[data-open-resubmit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-open-resubmit');
      state.resubmitTarget = state.submissions.find((s) => s.id === id) || null;
      render();
    });
  });

  document.getElementById('btn-close-resubmit')?.addEventListener('click', () => {
    state.resubmitTarget = null;
    render();
  });
  document.getElementById('btn-cancel-resubmit')?.addEventListener('click', () => {
    state.resubmitTarget = null;
    render();
  });
  document.getElementById('resubmit-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.resubmitTarget) return;
    handleScholarResubmit(state.resubmitTarget, {
      gwa: document.getElementById('resub-gwa').value,
      enrolled_units: document.getElementById('resub-units').value,
      failed_count: document.getElementById('resub-failed').value,
      incomplete_count: document.getElementById('resub-inc').value,
      dropped_count: document.getElementById('resub-drop').value,
      evidence_reference: document.getElementById('resub-ref').value,
    });
  });

  document.querySelectorAll('[data-toggle-audit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-toggle-audit');
      if (state.expandedAuditIds.has(id)) {
        state.expandedAuditIds.delete(id);
        render();
      } else {
        state.expandedAuditIds.add(id);
        render();
        await fetchAuditHistory(id, true);
        render();
      }
    });
  });

  // Staff tabs & filters
  document.querySelectorAll('[data-staff-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.staffTab = btn.getAttribute('data-staff-tab');
      render();
    });
  });

  document.getElementById('kpi-year')?.addEventListener('change', (e) => {
    state.filterYear = e.target.value;
    render();
  });
  document.getElementById('kpi-sem')?.addEventListener('change', (e) => {
    state.filterSemester = e.target.value;
    render();
  });
  document.getElementById('staff-search')?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    const cursorPos = e.target.selectionStart;
    render();
    const input = document.getElementById('staff-search');
    if (input) {
      input.focus();
      input.setSelectionRange(cursorPos, cursorPos);
    }
  });
  document.getElementById('filter-program')?.addEventListener('change', (e) => {
    state.filterProgramId = e.target.value;
    render();
  });
  document.getElementById('filter-verification')?.addEventListener('change', (e) => {
    state.filterVerification = e.target.value;
    render();
  });
  document.getElementById('filter-compliance')?.addEventListener('change', (e) => {
    state.filterCompliance = e.target.value;
    render();
  });

  document.getElementById('btn-evaluate-all')?.addEventListener('click', () => {
    handleEvaluateAllVerified(getFilteredSubmissionsForTable());
  });

  document.querySelectorAll('[data-inspect-submission]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.getAttribute('data-inspect-submission');
      state.selectedSubmissionId = id;
      render();
      await fetchAuditHistory(id, true);
      render();
    });
  });

  // Staff Detail Drawer Actions
  const selectedSub = state.submissions.find((s) => s.id === state.selectedSubmissionId);
  document.getElementById('btn-close-drawer')?.addEventListener('click', () => {
    state.selectedSubmissionId = null;
    render();
  });
  document.getElementById('btn-verify-sub')?.addEventListener('click', () => {
    if (selectedSub) handleVerifySubmission(selectedSub);
  });
  document.getElementById('return-sub-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!selectedSub) return;
    handleReturnSubmission(selectedSub, document.getElementById('return-reason-input').value);
  });
  document.getElementById('btn-run-evaluation')?.addEventListener('click', () => {
    if (selectedSub) handleEvaluateSubmission(selectedSub);
  });
  document.getElementById('btn-approve-renewal')?.addEventListener('click', () => {
    if (!selectedSub) return;
    handleRenewalDecision(selectedSub, 'Approved', document.getElementById('decision-notes-input').value);
  });
  document.getElementById('btn-hold-renewal')?.addEventListener('click', () => {
    if (!selectedSub) return;
    handleRenewalDecision(selectedSub, 'Held', document.getElementById('decision-notes-input').value);
  });

  // Staff Assignment & Policy Forms
  document.getElementById('assign-scholar-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSaveAssignment({
      scholarId: document.getElementById('assign-scholar').value,
      programId: document.getElementById('assign-program').value,
      awardStatus: document.getElementById('assign-status').value,
    });
  });

  document.querySelectorAll('[data-policy-form]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const programId = form.getAttribute('data-policy-form');
      const fd = new FormData(form);
      handleUpdatePolicy(programId, Object.fromEntries(fd.entries()));
    });
  });

  document.getElementById('create-policy-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    handleCreatePolicy(Object.fromEntries(fd.entries()));
  });
}

// ---------------------------------------------------------------------------
// App Entry
// ---------------------------------------------------------------------------

initSupabaseClient();
bootstrapSession();
