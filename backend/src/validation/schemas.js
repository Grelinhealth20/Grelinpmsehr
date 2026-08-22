import { z } from 'zod';
import { ROLE_VALUES, USER_STATUS } from '../config/env.js';

const email = z.string().trim().toLowerCase().email('A valid email is required.').max(254);
const password = z.string().min(1, 'Password is required.').max(200);
const fullName = z.string().trim().min(2, 'Name is too short.').max(120);

// Roles an admin is allowed to *create*. master_admin is never creatable via API.
const creatableRole = z.enum([...ROLE_VALUES.filter((r) => r !== 'master_admin')]);
const assignableRole = creatableRole;

const permissions = z
  .object({
    // `access` gates entry to each blank system; the rest are module-level grants.
    pms: z.object({ access: z.boolean() }).strict().partial().optional(),
    billing: z.object({ editPatient: z.boolean(), deletePatient: z.boolean() }).strict().partial().optional(),
    ehr: z.object({ access: z.boolean(), editNotes: z.boolean(), deleteNotes: z.boolean() }).strict().partial().optional(),
  })
  .strict()
  .optional();

const accessLevel = z
  .object({
    scope: z.enum(['full', 'standard', 'read_only']).optional(),
    modules: z.array(z.string().max(60)).max(50).optional(),
    notes: z.string().max(500).optional(),
    permissions,
  })
  .strict()
  .nullable()
  .optional();

export const loginSchema = z.object({ email, password }).strict();

export const changePasswordSchema = z
  .object({
    currentPassword: password,
    newPassword: z.string().min(12).max(200),
  })
  .strict();

const specialtyUuid = z.string().uuid().nullable().optional();
// Provider credential tags (e.g. MD, DO, NP, APRN, ASNP, PA-C). Free-form but capped.
const credentials = z.array(z.string().trim().min(1).max(20)).max(12).optional();

export const createUserSchema = z
  .object({
    email,
    fullName,
    role: creatableRole,
    accessLevel,
    credentials,
    specialtyUuid,
    temporaryPassword: z.string().min(12).max(200),
  })
  .strict();

export const updateUserSchema = z
  .object({
    fullName: fullName.optional(),
    role: assignableRole.optional(),
    accessLevel,
    credentials,
    specialtyUuid,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

export const createSpecialtySchema = z
  .object({ name: z.string().trim().min(2, 'Name is too short.').max(120) })
  .strict();

export const statusSchema = z
  .object({ status: z.enum([USER_STATUS.ACTIVE, USER_STATUS.RESTRICTED, USER_STATUS.DISABLED]) })
  .strict();

export const adminResetPasswordSchema = z
  .object({ temporaryPassword: z.string().min(12).max(200) })
  .strict();

export const uuidParam = z.object({ uuid: z.string().uuid() });

// --- Appointments ----------------------------------------------------------
const apptType = z.enum(['consult', 'followup', 'procedure']);
const apptStatus = z.enum(['scheduled', 'cancelled', 'completed']);
const apptDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.');
const startMin = z.number().int().min(0).max(1439);
const durationMin = z.number().int().min(5).max(600);
const apptTitle = z.string().trim().min(1, 'Title is required.').max(200);
const apptPatient = z.string().trim().max(200).optional();
const apptPatientUuid = z.union([z.string().uuid(), z.literal('')]).optional();

const renderingProviderUuid = z.union([z.string().uuid(), z.literal('')]).optional();

export const createAppointmentSchema = z
  .object({ title: apptTitle, patient: apptPatient, patientUuid: apptPatientUuid, renderingProviderUuid, type: apptType, date: apptDate, startMin, durationMin })
  .strict();

export const updateAppointmentSchema = z
  .object({
    title: apptTitle.optional(),
    patient: apptPatient,
    patientUuid: apptPatientUuid,
    renderingProviderUuid,
    type: apptType.optional(),
    date: apptDate.optional(),
    startMin: startMin.optional(),
    durationMin: durationMin.optional(),
    status: apptStatus.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

// --- Patients (face sheet) -------------------------------------------------
const optStr = (n) => z.string().trim().max(n).optional();
const optEmail = z.union([z.string().trim().email().max(254), z.literal('')]).optional();
const optDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).optional();

const demographicsSchema = z
  .object({
    firstName: z.string().trim().min(1, 'First name is required.').max(80),
    lastName: z.string().trim().min(1, 'Last name is required.').max(80),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD.'),
    gender: z.enum(['male', 'female', 'other', 'unknown']).optional(),
    phone: optStr(40),
    email: optEmail,
    address: optStr(200),
    city: optStr(80),
    state: optStr(40),
    zip: optStr(12),
    ssn: optStr(11),
  })
  .strict();

// One or more insurance policies (primary / secondary / tertiary).
const insuranceItemSchema = z
  .object({
    type: z.enum(['primary', 'secondary', 'tertiary']).optional(),
    payer: optStr(120), memberId: optStr(80), group: optStr(80), planType: optStr(60),
    mbi: optStr(20),
  })
  .strict();
const insuranceSchema = z.array(insuranceItemSchema).max(5).nullable().optional();

// Emergency contact(s). A patient may have several (from the CONTACTS section).
const emergencyContactItemSchema = z
  .object({ name: optStr(120), relationship: optStr(60), phone: optStr(40), email: optEmail })
  .strict();
const emergencyContactSchema = emergencyContactItemSchema.nullable().optional(); // legacy single
const emergencyContactsSchema = z.array(emergencyContactItemSchema).max(8).nullable().optional();

// SNF facility information.
const facilitySchema = z
  .object({
    facilityName: optStr(160), npi: optStr(20), unit: optStr(40), room: optStr(40),
    residentId: optStr(40), admittedFrom: optStr(120), admissionLocation: optStr(160),
    admitDate: optDate, address: optStr(200), city: optStr(80), state: optStr(40), zip: optStr(12),
  })
  .strict()
  .nullable()
  .optional();

export const createPatientSchema = z
  .object({ demographics: demographicsSchema, insurance: insuranceSchema, facility: facilitySchema, emergencyContact: emergencyContactSchema, emergencyContacts: emergencyContactsSchema })
  .strict();

export const updatePatientSchema = z
  .object({ demographics: demographicsSchema.optional(), insurance: insuranceSchema, facility: facilitySchema, emergencyContact: emergencyContactSchema, emergencyContacts: emergencyContactsSchema })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

// --- Encounters ------------------------------------------------------------
export const updateEncounterSchema = z
  .object({
    eligibilityStatus: z.enum(['not_verified', 'eligible', 'ineligible', 'pending']).optional(),
    chartStatus: z.enum(['not_seen', 'charts_completed', 'cancelled']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });
