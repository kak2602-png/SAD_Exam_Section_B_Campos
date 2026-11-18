-- ============================================================================
-- Student Scholarship Monitoring and Academic Compliance System
-- Complete PostgreSQL / Supabase Schema, Constraints, RLS Policies & Seed Data
-- Run this entire script in the Supabase SQL Editor.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. TABLES & CONSTRAINTS
-- ----------------------------------------------------------------------------

-- 1.1 Profiles (linked 1:1 to auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  student_id TEXT UNIQUE,
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('scholar', 'staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.2 Scholarship Programs (Dynamic policy thresholds)
CREATE TABLE IF NOT EXISTS public.scholarship_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL CHECK (length(trim(name)) > 0),
  max_gwa NUMERIC(3,2) NOT NULL CHECK (max_gwa >= 1.00 AND max_gwa <= 5.00),
  min_units INTEGER NOT NULL CHECK (min_units >= 0),
  max_failed INTEGER NOT NULL CHECK (max_failed >= 0),
  max_incomplete INTEGER NOT NULL CHECK (max_incomplete >= 0),
  max_dropped INTEGER NOT NULL CHECK (max_dropped >= 0),
  submission_deadline TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.3 Scholar Assignments (Independent award_status from semester compliance)
CREATE TABLE IF NOT EXISTS public.scholar_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scholar_id UUID UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  program_id UUID NOT NULL REFERENCES public.scholarship_programs(id) ON DELETE RESTRICT,
  award_status TEXT NOT NULL DEFAULT 'Active' CHECK (award_status IN ('Active', 'On Hold', 'Terminated')),
  assigned_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.4 Semester Submissions
CREATE TABLE IF NOT EXISTS public.semester_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scholar_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  program_id UUID NOT NULL REFERENCES public.scholarship_programs(id) ON DELETE RESTRICT,
  academic_year TEXT NOT NULL CHECK (length(trim(academic_year)) > 0),
  semester TEXT NOT NULL CHECK (length(trim(semester)) > 0),
  gwa NUMERIC(3,2) NOT NULL CHECK (gwa >= 1.00 AND gwa <= 5.00),
  enrolled_units INTEGER NOT NULL CHECK (enrolled_units >= 0),
  failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
  incomplete_count INTEGER NOT NULL CHECK (incomplete_count >= 0),
  dropped_count INTEGER NOT NULL CHECK (dropped_count >= 0),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verification_status TEXT NOT NULL DEFAULT 'Pending' CHECK (verification_status IN ('Pending', 'Verified', 'Returned')),
  verification_reason TEXT,
  compliance_status TEXT NOT NULL DEFAULT 'Pending Evaluation' CHECK (compliance_status IN ('Pending Evaluation', 'Compliant', 'With Deficiency')),
  deficiency_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  renewal_decision TEXT NOT NULL DEFAULT 'Pending' CHECK (renewal_decision IN ('Pending', 'Approved', 'Held')),
  decision_notes TEXT,

  -- Prevent duplicate submissions for the same scholar & term
  CONSTRAINT uq_scholar_academic_term UNIQUE (scholar_id, academic_year, semester),

  -- Verification Gate: compliance evaluation & renewal decisions require Verified status
  CONSTRAINT chk_evaluation_requires_verified CHECK (
    compliance_status = 'Pending Evaluation' OR verification_status = 'Verified'
  ),
  CONSTRAINT chk_decision_requires_verified CHECK (
    renewal_decision = 'Pending' OR verification_status = 'Verified'
  ),

  -- Renewal Authority: Approved requires Compliant status
  CONSTRAINT chk_approve_requires_compliant CHECK (
    renewal_decision <> 'Approved' OR compliance_status = 'Compliant'
  )
);

-- 1.5 Audit History
CREATE TABLE IF NOT EXISTS public.audit_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES public.semester_submissions(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('SUBMITTED', 'VERIFIED', 'RETURNED', 'RESUBMITTED', 'EVALUATED', 'RENEWAL_DECISION')),
  previous_state TEXT,
  new_state TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submissions_scholar_term ON public.semester_submissions(scholar_id, academic_year, semester);
CREATE INDEX IF NOT EXISTS idx_submissions_term ON public.semester_submissions(academic_year, semester);
CREATE INDEX IF NOT EXISTS idx_audit_submission ON public.audit_history(submission_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. AUTH HELPER & PROFILE SYNC TRIGGER
-- ----------------------------------------------------------------------------

-- Helper to check staff role without RLS recursion
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'staff'
  );
$$;

-- Safe RPC to fetch audit history with actor display names while keeping profiles RLS strict
CREATE OR REPLACE FUNCTION public.get_submission_audit_history(p_submission_id UUID)
RETURNS TABLE (
  id UUID,
  submission_id UUID,
  actor_id UUID,
  actor_name TEXT,
  actor_role TEXT,
  action_type TEXT,
  previous_state TEXT,
  new_state TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ah.id,
    ah.submission_id,
    ah.actor_id,
    COALESCE(p.full_name, 'System') AS actor_name,
    COALESCE(p.role, 'system') AS actor_role,
    ah.action_type,
    ah.previous_state,
    ah.new_state,
    ah.notes,
    ah.created_at
  FROM public.audit_history ah
  JOIN public.semester_submissions ss ON ss.id = ah.submission_id
  LEFT JOIN public.profiles p ON p.id = ah.actor_id
  WHERE ah.submission_id = p_submission_id
    AND (ss.scholar_id = auth.uid() OR public.is_staff())
  ORDER BY ah.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.get_submission_audit_history(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_submission_audit_history(UUID) TO authenticated;

-- Automatically create a profile row when a new user registers via Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_full_name TEXT;
  v_student_id TEXT;
BEGIN
  v_role := COALESCE(NULLIF(trim(NEW.raw_user_meta_data ->> 'role'), ''), 'scholar');
  IF v_role NOT IN ('scholar', 'staff') THEN
    v_role := 'scholar';
  END IF;

  v_full_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    split_part(NEW.email, '@', 1)
  );

  v_student_id := NULLIF(trim(NEW.raw_user_meta_data ->> 'student_id'), '');
  IF v_role = 'staff' THEN
    v_student_id := NULL;
  END IF;

  INSERT INTO public.profiles (id, student_id, full_name, email, role)
  VALUES (NEW.id, v_student_id, v_full_name, NEW.email, v_role)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scholarship_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scholar_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.semester_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_history ENABLE ROW LEVEL SECURITY;

-- Profiles policies
DROP POLICY IF EXISTS "profiles_select_own_or_staff" ON public.profiles;
CREATE POLICY "profiles_select_own_or_staff"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (id = auth.uid() OR public.is_staff());

DROP POLICY IF EXISTS "profiles_insert_self" ON public.profiles;
CREATE POLICY "profiles_insert_self"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid() OR public.is_staff());

DROP POLICY IF EXISTS "profiles_update_staff_only" ON public.profiles;
CREATE POLICY "profiles_update_staff_only"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());

-- Scholarship Programs policies (readable by all authenticated users, writable only by staff)
DROP POLICY IF EXISTS "programs_select_authenticated" ON public.scholarship_programs;
CREATE POLICY "programs_select_authenticated"
  ON public.scholarship_programs FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "programs_insert_staff" ON public.scholarship_programs;
CREATE POLICY "programs_insert_staff"
  ON public.scholarship_programs FOR INSERT
  TO authenticated
  WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "programs_update_staff" ON public.scholarship_programs;
CREATE POLICY "programs_update_staff"
  ON public.scholarship_programs FOR UPDATE
  TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "programs_delete_staff" ON public.scholarship_programs;
CREATE POLICY "programs_delete_staff"
  ON public.scholarship_programs FOR DELETE
  TO authenticated
  USING (public.is_staff());

-- Scholar Assignments policies
DROP POLICY IF EXISTS "assignments_select_own_or_staff" ON public.scholar_assignments;
CREATE POLICY "assignments_select_own_or_staff"
  ON public.scholar_assignments FOR SELECT
  TO authenticated
  USING (scholar_id = auth.uid() OR public.is_staff());

DROP POLICY IF EXISTS "assignments_insert_staff" ON public.scholar_assignments;
CREATE POLICY "assignments_insert_staff"
  ON public.scholar_assignments FOR INSERT
  TO authenticated
  WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "assignments_update_staff" ON public.scholar_assignments;
CREATE POLICY "assignments_update_staff"
  ON public.scholar_assignments FOR UPDATE
  TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "assignments_delete_staff" ON public.scholar_assignments;
CREATE POLICY "assignments_delete_staff"
  ON public.scholar_assignments FOR DELETE
  TO authenticated
  USING (public.is_staff());

-- Semester Submissions policies
DROP POLICY IF EXISTS "submissions_select_own_or_staff" ON public.semester_submissions;
CREATE POLICY "submissions_select_own_or_staff"
  ON public.semester_submissions FOR SELECT
  TO authenticated
  USING (scholar_id = auth.uid() OR public.is_staff());

DROP POLICY IF EXISTS "submissions_insert_scholar_own" ON public.semester_submissions;
CREATE POLICY "submissions_insert_scholar_own"
  ON public.semester_submissions FOR INSERT
  TO authenticated
  WITH CHECK (
    scholar_id = auth.uid()
    AND verification_status = 'Pending'
    AND compliance_status = 'Pending Evaluation'
    AND renewal_decision = 'Pending'
    AND verification_reason IS NULL
    AND decision_notes IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.scholar_assignments sa
      WHERE sa.scholar_id = auth.uid()
        AND sa.program_id = semester_submissions.program_id
    )
  );

DROP POLICY IF EXISTS "submissions_update_scholar_returned_only" ON public.semester_submissions;
CREATE POLICY "submissions_update_scholar_returned_only"
  ON public.semester_submissions FOR UPDATE
  TO authenticated
  USING (
    scholar_id = auth.uid()
    AND verification_status = 'Returned'
  )
  WITH CHECK (
    scholar_id = auth.uid()
    AND verification_status = 'Pending'
    AND compliance_status = 'Pending Evaluation'
    AND renewal_decision = 'Pending'
    AND verification_reason IS NULL
    AND decision_notes IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.scholar_assignments sa
      WHERE sa.scholar_id = auth.uid()
        AND sa.program_id = semester_submissions.program_id
    )
  );

DROP POLICY IF EXISTS "submissions_update_staff" ON public.semester_submissions;
CREATE POLICY "submissions_update_staff"
  ON public.semester_submissions FOR UPDATE
  TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());

-- Audit History policies
DROP POLICY IF EXISTS "audit_select_own_or_staff" ON public.audit_history;
CREATE POLICY "audit_select_own_or_staff"
  ON public.audit_history FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.semester_submissions ss
      WHERE ss.id = audit_history.submission_id
        AND (ss.scholar_id = auth.uid() OR public.is_staff())
    )
  );

DROP POLICY IF EXISTS "audit_insert_authorized" ON public.audit_history;
CREATE POLICY "audit_insert_authorized"
  ON public.audit_history FOR INSERT
  TO authenticated
  WITH CHECK (
    actor_id = auth.uid()
    AND (
      public.is_staff()
      OR (
        action_type IN ('SUBMITTED', 'RESUBMITTED')
        AND EXISTS (
          SELECT 1
          FROM public.semester_submissions ss
          WHERE ss.id = audit_history.submission_id
            AND ss.scholar_id = auth.uid()
        )
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 4. SEED DATA: SCHOLARSHIP POLICIES, TEST ACCOUNTS & SYNTHETIC SUBMISSIONS
-- ----------------------------------------------------------------------------
-- Default Password for all seeded test accounts: Password123!

-- 4.1 Seed exact Scholarship Programs (Deadline: 2026-11-06 17:00:00+08 Asia/Manila)
INSERT INTO public.scholarship_programs (
  name, max_gwa, min_units, max_failed, max_incomplete, max_dropped, submission_deadline
)
VALUES
  ('Excellence Scholar', 2.00, 18, 0, 0, 0, '2026-11-06 17:00:00+08'::timestamptz),
  ('Access Scholar',     2.50, 15, 0, 0, 1, '2026-11-06 17:00:00+08'::timestamptz)
ON CONFLICT (name) DO UPDATE SET
  max_gwa = EXCLUDED.max_gwa,
  min_units = EXCLUDED.min_units,
  max_failed = EXCLUDED.max_failed,
  max_incomplete = EXCLUDED.max_incomplete,
  max_dropped = EXCLUDED.max_dropped,
  submission_deadline = EXCLUDED.submission_deadline;

-- 4.2 Helper function to create seeded auth.users + auth.identities safely
CREATE OR REPLACE FUNCTION public._seed_user(
  p_email TEXT,
  p_password TEXT,
  p_full_name TEXT,
  p_role TEXT,
  p_student_id TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, auth
AS $$
DECLARE
  v_user_id UUID;
  v_pw_hash TEXT;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email);
  v_pw_hash := crypt(p_password, gen_salt('bf', 10));

  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();

    INSERT INTO auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      v_user_id,
      'authenticated',
      'authenticated',
      lower(p_email),
      v_pw_hash,
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object(
        'full_name', p_full_name,
        'role', p_role,
        'student_id', p_student_id
      ),
      now(),
      now(),
      '',
      '',
      '',
      ''
    );

    INSERT INTO auth.identities (
      id,
      user_id,
      identity_data,
      provider,
      provider_id,
      last_sign_in_at,
      created_at,
      updated_at
    ) VALUES (
      gen_random_uuid(),
      v_user_id,
      jsonb_build_object(
        'sub', v_user_id::text,
        'email', lower(p_email),
        'email_verified', true,
        'phone_verified', false
      ),
      'email',
      v_user_id::text,
      now(),
      now(),
      now()
    );
  ELSE
    UPDATE auth.users
    SET
      encrypted_password = v_pw_hash,
      email_confirmed_at = COALESCE(email_confirmed_at, now()),
      raw_user_meta_data = jsonb_build_object(
        'full_name', p_full_name,
        'role', p_role,
        'student_id', p_student_id
      ),
      updated_at = now()
    WHERE id = v_user_id;

    IF NOT EXISTS (
      SELECT 1 FROM auth.identities WHERE user_id = v_user_id AND provider = 'email'
    ) THEN
      INSERT INTO auth.identities (
        id,
        user_id,
        identity_data,
        provider,
        provider_id,
        last_sign_in_at,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        v_user_id,
        jsonb_build_object(
          'sub', v_user_id::text,
          'email', lower(p_email),
          'email_verified', true,
          'phone_verified', false
        ),
        'email',
        v_user_id::text,
        now(),
        now(),
        now()
      );
    END IF;
  END IF;

  -- Ensure profile exists and matches seed attributes
  INSERT INTO public.profiles (id, student_id, full_name, email, role)
  VALUES (v_user_id, p_student_id, p_full_name, p_email, p_role)
  ON CONFLICT (id) DO UPDATE SET
    student_id = EXCLUDED.student_id,
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role;

  RETURN v_user_id;
END;
$$;

-- 4.3 Seed 1 Staff + 6 Scholars (B01..B06), Assignments & AY 2026-2027 Semester 1 Submissions
DO $$
DECLARE
  v_staff_id UUID;
  v_b01_id UUID;
  v_b02_id UUID;
  v_b03_id UUID;
  v_b04_id UUID;
  v_b05_id UUID;
  v_b06_id UUID;

  v_excellence_id UUID;
  v_access_id UUID;

  v_sub_id UUID;
BEGIN
  SELECT id INTO v_excellence_id FROM public.scholarship_programs WHERE name = 'Excellence Scholar';
  SELECT id INTO v_access_id FROM public.scholarship_programs WHERE name = 'Access Scholar';

  -- Create Staff & 6 Scholar test accounts (password: Password123!)
  v_staff_id := public._seed_user('staff@exam.edu', 'Password123!', 'Dr. Elena Navarro', 'staff', NULL);
  v_b01_id   := public._seed_user('b01@exam.edu',   'Password123!', 'Mateo Villanueva',  'scholar', 'B01');
  v_b02_id   := public._seed_user('b02@exam.edu',   'Password123!', 'Clarisse Mendoza',  'scholar', 'B02');
  v_b03_id   := public._seed_user('b03@exam.edu',   'Password123!', 'Rafael Dizon',      'scholar', 'B03');
  v_b04_id   := public._seed_user('b04@exam.edu',   'Password123!', 'Bianca Pascual',    'scholar', 'B04');
  v_b05_id   := public._seed_user('b05@exam.edu',   'Password123!', 'Gabriel Soriano',   'scholar', 'B05');
  v_b06_id   := public._seed_user('b06@exam.edu',   'Password123!', 'Angela Bautista',   'scholar', 'B06');

  -- Assign scholars to programs
  INSERT INTO public.scholar_assignments (scholar_id, program_id, award_status, assigned_by)
  VALUES
    (v_b01_id, v_excellence_id, 'Active', v_staff_id),
    (v_b02_id, v_excellence_id, 'Active', v_staff_id),
    (v_b03_id, v_access_id,     'Active', v_staff_id),
    (v_b04_id, v_access_id,     'Active', v_staff_id),
    (v_b05_id, v_excellence_id, 'Active', v_staff_id),
    (v_b06_id, v_access_id,     'Active', v_staff_id)
  ON CONFLICT (scholar_id) DO UPDATE SET
    program_id = EXCLUDED.program_id,
    award_status = EXCLUDED.award_status,
    assigned_by = EXCLUDED.assigned_by;

  -- Seed Submissions for Academic Year 2026-2027, Semester 1

  -- B01: Excellence Scholar | GWA 2.00 | Units 18 | F 0 | INC 0 | Drop 0 | Verified | Exact deadline
  INSERT INTO public.semester_submissions (
    scholar_id, program_id, academic_year, semester,
    gwa, enrolled_units, failed_count, incomplete_count, dropped_count,
    evidence_reference, submitted_at, verification_status, compliance_status, renewal_decision
  ) VALUES (
    v_b01_id, v_excellence_id, '2026-2027', 'Semester 1',
    2.00, 18, 0, 0, 0,
    'REG-2026-S1-B01-TOR', '2026-11-06 17:00:00+08'::timestamptz,
    'Verified', 'Pending Evaluation', 'Pending'
  )
  ON CONFLICT (scholar_id, academic_year, semester) DO NOTHING
  RETURNING id INTO v_sub_id;
  IF v_sub_id IS NOT NULL THEN
    INSERT INTO public.audit_history (submission_id, actor_id, action_type, previous_state, new_state, notes, created_at)
    VALUES
      (v_sub_id, v_b01_id, 'SUBMITTED', NULL, 'Pending', 'Initial Semester 1 grade report submitted.', '2026-11-06 17:00:00+08'::timestamptz),
      (v_sub_id, v_staff_id, 'VERIFIED', 'Pending', 'Verified', 'Registrar document code verified.', '2026-11-07 09:15:00+08'::timestamptz);
  END IF;

  -- B02: Excellence Scholar | GWA 2.01 | Units 18 | F 0 | INC 0 | Drop 0 | Verified | Expected: With Deficiency (GWA)
  INSERT INTO public.semester_submissions (
    scholar_id, program_id, academic_year, semester,
    gwa, enrolled_units, failed_count, incomplete_count, dropped_count,
    evidence_reference, submitted_at, verification_status, compliance_status, renewal_decision
  ) VALUES (
    v_b02_id, v_excellence_id, '2026-2027', 'Semester 1',
    2.01, 18, 0, 0, 0,
    'REG-2026-S1-B02-TOR', '2026-11-05 14:00:00+08'::timestamptz,
    'Verified', 'Pending Evaluation', 'Pending'
  )
  ON CONFLICT (scholar_id, academic_year, semester) DO NOTHING
  RETURNING id INTO v_sub_id;
  IF v_sub_id IS NOT NULL THEN
    INSERT INTO public.audit_history (submission_id, actor_id, action_type, previous_state, new_state, notes, created_at)
    VALUES
      (v_sub_id, v_b02_id, 'SUBMITTED', NULL, 'Pending', 'Initial Semester 1 grade report submitted.', '2026-11-05 14:00:00+08'::timestamptz),
      (v_sub_id, v_staff_id, 'VERIFIED', 'Pending', 'Verified', 'Registrar document code verified.', '2026-11-06 10:00:00+08'::timestamptz);
  END IF;

  -- B03: Access Scholar | GWA 2.50 | Units 15 | F 0 | INC 0 | Drop 1 | Verified | Expected: Compliant (1 drop allowed)
  INSERT INTO public.semester_submissions (
    scholar_id, program_id, academic_year, semester,
    gwa, enrolled_units, failed_count, incomplete_count, dropped_count,
    evidence_reference, submitted_at, verification_status, compliance_status, renewal_decision
  ) VALUES (
    v_b03_id, v_access_id, '2026-2027', 'Semester 1',
    2.50, 15, 0, 0, 1,
    'REG-2026-S1-B03-TOR', '2026-11-05 14:00:00+08'::timestamptz,
    'Verified', 'Pending Evaluation', 'Pending'
  )
  ON CONFLICT (scholar_id, academic_year, semester) DO NOTHING
  RETURNING id INTO v_sub_id;
  IF v_sub_id IS NOT NULL THEN
    INSERT INTO public.audit_history (submission_id, actor_id, action_type, previous_state, new_state, notes, created_at)
    VALUES
      (v_sub_id, v_b03_id, 'SUBMITTED', NULL, 'Pending', 'Initial Semester 1 grade report submitted.', '2026-11-05 14:00:00+08'::timestamptz),
      (v_sub_id, v_staff_id, 'VERIFIED', 'Pending', 'Verified', 'Registrar document code verified.', '2026-11-06 10:15:00+08'::timestamptz);
  END IF;

  -- B04: Access Scholar | GWA 2.50 | Units 14 | F 0 | INC 1 | Drop 0 | Verified | Expected: With Deficiency (Units & INC)
  INSERT INTO public.semester_submissions (
    scholar_id, program_id, academic_year, semester,
    gwa, enrolled_units, failed_count, incomplete_count, dropped_count,
    evidence_reference, submitted_at, verification_status, compliance_status, renewal_decision
  ) VALUES (
    v_b04_id, v_access_id, '2026-2027', 'Semester 1',
    2.50, 14, 0, 1, 0,
    'REG-2026-S1-B04-TOR', '2026-11-05 14:00:00+08'::timestamptz,
    'Verified', 'Pending Evaluation', 'Pending'
  )
  ON CONFLICT (scholar_id, academic_year, semester) DO NOTHING
  RETURNING id INTO v_sub_id;
  IF v_sub_id IS NOT NULL THEN
    INSERT INTO public.audit_history (submission_id, actor_id, action_type, previous_state, new_state, notes, created_at)
    VALUES
      (v_sub_id, v_b04_id, 'SUBMITTED', NULL, 'Pending', 'Initial Semester 1 grade report submitted.', '2026-11-05 14:00:00+08'::timestamptz),
      (v_sub_id, v_staff_id, 'VERIFIED', 'Pending', 'Verified', 'Registrar document code verified.', '2026-11-06 10:30:00+08'::timestamptz);
  END IF;

  -- B05: Excellence Scholar | GWA 1.75 | Units 18 | F 1 | INC 0 | Drop 0 | Verified | 1 min late -> Expected: With Deficiency (Failed & Late)
  INSERT INTO public.semester_submissions (
    scholar_id, program_id, academic_year, semester,
    gwa, enrolled_units, failed_count, incomplete_count, dropped_count,
    evidence_reference, submitted_at, verification_status, compliance_status, renewal_decision
  ) VALUES (
    v_b05_id, v_excellence_id, '2026-2027', 'Semester 1',
    1.75, 18, 1, 0, 0,
    'REG-2026-S1-B05-TOR', '2026-11-06 17:01:00+08'::timestamptz,
    'Verified', 'Pending Evaluation', 'Pending'
  )
  ON CONFLICT (scholar_id, academic_year, semester) DO NOTHING
  RETURNING id INTO v_sub_id;
  IF v_sub_id IS NOT NULL THEN
    INSERT INTO public.audit_history (submission_id, actor_id, action_type, previous_state, new_state, notes, created_at)
    VALUES
      (v_sub_id, v_b05_id, 'SUBMITTED', NULL, 'Pending', 'Initial Semester 1 grade report submitted.', '2026-11-06 17:01:00+08'::timestamptz),
      (v_sub_id, v_staff_id, 'VERIFIED', 'Pending', 'Verified', 'Registrar document code verified.', '2026-11-07 09:30:00+08'::timestamptz);
  END IF;

  -- B06: Access Scholar | GWA 2.25 | Units 15 | F 0 | INC 0 | Drop 0 | Pending | Expected: Blocked from evaluation/approval until verified
  INSERT INTO public.semester_submissions (
    scholar_id, program_id, academic_year, semester,
    gwa, enrolled_units, failed_count, incomplete_count, dropped_count,
    evidence_reference, submitted_at, verification_status, compliance_status, renewal_decision
  ) VALUES (
    v_b06_id, v_access_id, '2026-2027', 'Semester 1',
    2.25, 15, 0, 0, 0,
    'REG-2026-S1-B06-TOR', '2026-11-05 14:00:00+08'::timestamptz,
    'Pending', 'Pending Evaluation', 'Pending'
  )
  ON CONFLICT (scholar_id, academic_year, semester) DO NOTHING
  RETURNING id INTO v_sub_id;
  IF v_sub_id IS NOT NULL THEN
    INSERT INTO public.audit_history (submission_id, actor_id, action_type, previous_state, new_state, notes, created_at)
    VALUES
      (v_sub_id, v_b06_id, 'SUBMITTED', NULL, 'Pending', 'Initial Semester 1 grade report submitted.', '2026-11-05 14:00:00+08'::timestamptz);
  END IF;
END;
$$;

-- Remove temporary seed helper function from public exposure
DROP FUNCTION IF EXISTS public._seed_user(TEXT, TEXT, TEXT, TEXT, TEXT);
