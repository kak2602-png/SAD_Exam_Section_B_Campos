/**
 * Dynamic Academic Compliance Evaluation & Asia/Manila Timezone Utilities
 * All policy thresholds are read dynamically from the `scholarship_programs` record.
 */

export const MANILA_TZ = 'Asia/Manila';

/**
 * Format an ISO/timestamptz string in Asia/Manila (UTC+8) as "YYYY-MM-DD HH:mm:ss PHT".
 */
export function formatManilaDateTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}:${map.second} PHT`;
}

/**
 * Format an ISO/timestamptz string in Asia/Manila as "YYYY-MM-DD HH:mm".
 */
export function formatManilaShort(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}`;
}

/**
 * Convert an ISO timestamp to a "YYYY-MM-DDTHH:mm" string in Asia/Manila for <input type="datetime-local">.
 */
export function toManilaDatetimeLocal(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}`;
}

/**
 * Convert a "YYYY-MM-DDTHH:mm" value interpreted in Asia/Manila (+08:00) into an ISO timestamp string.
 */
export function fromManilaDatetimeLocal(localValue) {
  if (!localValue) return null;
  const normalized = localValue.length === 16 ? `${localValue}:00+08:00` : `${localValue}+08:00`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Format millisecond difference into readable duration string (e.g., "1 minute", "2 hours 5 minutes").
 */
export function formatDurationPast(diffMs) {
  const totalSeconds = Math.max(1, Math.round(diffMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    const hrPart = `${totalHours} hour${totalHours === 1 ? '' : 's'}`;
    return remMinutes > 0 ? `${hrPart} ${remMinutes} minute${remMinutes === 1 ? '' : 's'}` : hrPart;
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  const dayPart = `${days} day${days === 1 ? '' : 's'}`;
  return remHours > 0 ? `${dayPart} ${remHours} hour${remHours === 1 ? '' : 's'}` : dayPart;
}

/**
 * Validate semester submission input fields before sending to Supabase.
 */
export function validateSubmissionInput(input) {
  const errors = [];

  if (!input.academic_year || !String(input.academic_year).trim()) {
    errors.push('Academic Year is required.');
  }
  if (!input.semester || !String(input.semester).trim()) {
    errors.push('Semester is required.');
  }

  const gwa = Number(input.gwa);
  if (Number.isNaN(gwa) || gwa < 1.0 || gwa > 5.0) {
    errors.push('GWA must be a number between 1.00 and 5.00.');
  }

  const intFields = [
    ['enrolled_units', 'Enrolled Units'],
    ['failed_count', 'Failed Subjects'],
    ['incomplete_count', 'Incomplete Grades'],
    ['dropped_count', 'Dropped Subjects'],
  ];

  for (const [key, label] of intFields) {
    const raw = input[key];
    const num = Number(raw);
    if (raw === '' || raw === null || raw === undefined || !Number.isInteger(num) || num < 0) {
      errors.push(`${label} must be a whole integer greater than or equal to 0.`);
    }
  }

  if (!input.evidence_reference || !String(input.evidence_reference).trim()) {
    errors.push('Grade Document Reference cannot be empty.');
  }

  return errors;
}

/**
 * Dynamically evaluate a verified submission against the assigned scholarship program's thresholds.
 * Enforces all 6 policy checks including Asia/Manila deadline comparison.
 */
export function evaluateSubmissionCompliance(submission, program) {
  if (!submission || !program) {
    throw new Error('Submission and assigned scholarship program are required for evaluation.');
  }

  const gwa = Number(submission.gwa);
  const maxGwa = Number(program.max_gwa);
  const units = Number(submission.enrolled_units);
  const minUnits = Number(program.min_units);
  const failed = Number(submission.failed_count);
  const maxFailed = Number(program.max_failed);
  const inc = Number(submission.incomplete_count);
  const maxInc = Number(program.max_incomplete);
  const dropped = Number(submission.dropped_count);
  const maxDropped = Number(program.max_dropped);

  const submittedDate = new Date(submission.submitted_at);
  const deadlineDate = new Date(program.submission_deadline);
  const diffMs = submittedDate.getTime() - deadlineDate.getTime();

  const checks = [
    {
      key: 'gwa',
      label: 'General Weighted Average (GWA)',
      actual: gwa.toFixed(2),
      threshold: `<= ${maxGwa.toFixed(2)}`,
      passed: gwa <= maxGwa,
      reason: `GWA ${gwa.toFixed(2)} exceeds maximum permitted ${maxGwa.toFixed(2)}`,
    },
    {
      key: 'units',
      label: 'Enrolled Units',
      actual: `${units} units`,
      threshold: `>= ${minUnits} units`,
      passed: units >= minUnits,
      reason: `Enrolled units (${units}) below minimum required (${minUnits})`,
    },
    {
      key: 'failed',
      label: 'Failed Subjects',
      actual: String(failed),
      threshold: `<= ${maxFailed}`,
      passed: failed <= maxFailed,
      reason: `Failed subjects (${failed}) exceeds maximum permitted (${maxFailed})`,
    },
    {
      key: 'incomplete',
      label: 'Incomplete (INC) Grades',
      actual: String(inc),
      threshold: `<= ${maxInc}`,
      passed: inc <= maxInc,
      reason: `Incomplete grades (${inc}) exceeds maximum permitted (${maxInc})`,
    },
    {
      key: 'dropped',
      label: 'Dropped Subjects',
      actual: String(dropped),
      threshold: `<= ${maxDropped}`,
      passed: dropped <= maxDropped,
      reason: `Dropped subjects (${dropped}) exceeds maximum permitted (${maxDropped})`,
    },
    {
      key: 'deadline',
      label: 'Submission Deadline (Asia/Manila)',
      actual: formatManilaShort(submission.submitted_at) + ' PHT',
      threshold: `<= ${formatManilaShort(program.submission_deadline)} PHT`,
      passed: diffMs <= 0,
      reason:
        diffMs > 0
          ? `Submitted ${formatDurationPast(diffMs)} past deadline (${formatManilaShort(program.submission_deadline)} PHT)`
          : '',
    },
  ];

  const deficiency_reasons = checks.filter((c) => !c.passed).map((c) => c.reason);
  const compliant = deficiency_reasons.length === 0;

  return {
    compliant,
    compliance_status: compliant ? 'Compliant' : 'With Deficiency',
    deficiency_reasons,
    checks,
  };
}
