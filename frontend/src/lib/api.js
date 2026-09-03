import axios from 'axios';

/**
 * Single axios client. All calls go to `/api`, which the dev server and the
 * production gateway both proxy to the internal API — the browser never talks
 * to the API directly. Auth tokens live in httpOnly cookies (not JS-readable);
 * we only hold the CSRF token in memory and echo it on mutating requests.
 */
const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

let csrfToken = null;
export function setCsrfToken(token) {
  csrfToken = token || null;
}

api.interceptors.request.use((cfg) => {
  const method = (cfg.method || 'get').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
    cfg.headers['X-CSRF-Token'] = csrfToken;
  }
  return cfg;
});

// Silent single-flight refresh on access-token expiry.
let refreshing = null;
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    const code = error.response?.data?.code;

    if (status === 401 && code === 'TOKEN_INVALID' && !original._retried) {
      original._retried = true;
      try {
        refreshing = refreshing || api.post('/auth/refresh');
        const { data } = await refreshing;
        refreshing = null;
        if (data?.csrfToken) setCsrfToken(data.csrfToken);
        return api(original);
      } catch (e) {
        refreshing = null;
        throw e;
      }
    }

    // Resilience: a transient gateway/upstream hiccup (e.g. a backend restart)
    // shouldn't surface as an error for a safe read — retry a GET once.
    const method = (original?.method || 'get').toLowerCase();
    if ([502, 503, 504].includes(status) && method === 'get' && !original._upRetried) {
      original._upRetried = true;
      await new Promise((r) => setTimeout(r, 900));
      return api(original);
    }
    throw error;
  },
);

/**
 * Fetch a binary document (PDF) through the same authenticated `/api` proxy and
 * hand the browser a Save dialog. The blob is fully in-memory and revoked right
 * after — nothing is cached and no direct API URL is ever exposed to the page.
 */
export async function downloadPdf(path, fallbackName = 'document.pdf') {
  const res = await api.get(path, { responseType: 'blob' });
  const disp = res.headers['content-disposition'] || '';
  const m = /filename="?([^"]+)"?/i.exec(disp);
  const name = m ? m[1] : fallbackName;
  const url = window.URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

/** Normalize server errors into a friendly shape for the UI. */
export function toApiError(err) {
  const data = err?.response?.data;
  return {
    message: data?.error || err?.message || 'Something went wrong.',
    code: data?.code || null,
    details: data?.details || null,
    status: err?.response?.status || 0,
  };
}

// --- Auth ------------------------------------------------------------------
export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  refresh: () => api.post('/auth/refresh'),
  changePassword: (currentPassword, newPassword) =>
    api.post('/auth/change-password', { currentPassword, newPassword }),
  // In-house MFA (TOTP). setup → QR + manual key; enroll confirms with the first code (returns
  // one-time recovery codes); verify/recovery complete the login challenge.
  mfaSetup: () => api.post('/auth/mfa/setup'),
  mfaEnroll: (code) => api.post('/auth/mfa/enroll', { code }),
  mfaVerify: (code) => api.post('/auth/mfa/verify', { code }),
  mfaRecovery: (code) => api.post('/auth/mfa/recovery', { code }),
};

// --- Users (admin) ---------------------------------------------------------
export const usersApi = {
  list: (params) => api.get('/users', { params }),
  nppes: (params) => api.get('/users/nppes', { params }),
  create: (payload) => api.post('/users', payload),
  update: (uuid, payload) => api.patch(`/users/${uuid}`, payload),
  setStatus: (uuid, status) => api.patch(`/users/${uuid}/status`, { status }),
  resetPassword: (uuid, temporaryPassword) =>
    api.post(`/users/${uuid}/reset-password`, { temporaryPassword }),
  // Super Admin MFA controls per user.
  setMfa: (uuid, enabled) => api.post(`/users/${uuid}/mfa`, { enabled }),
  resetMfa: (uuid) => api.post(`/users/${uuid}/mfa/reset`),
  remove: (uuid) => api.delete(`/users/${uuid}`),
  facilities: (uuid) => api.get(`/users/${uuid}/facilities`),
  setFacilities: (uuid, facilityUuids) => api.put(`/users/${uuid}/facilities`, { facilityUuids }),
};

// --- Specialties (admin) ---------------------------------------------------
export const specialtiesApi = {
  list: () => api.get('/specialties'),
  create: (name, serviceLine) => api.post('/specialties', serviceLine ? { name, serviceLine } : { name }),
};

// --- Providers (picker for appointments) -----------------------------------
export const providersApi = {
  list: () => api.get('/providers'),
  schedulable: () => api.get('/providers/schedulable'),
  myFacilities: () => api.get('/providers/facilities'),
};

// --- Facilities (Super/Master admin) ---------------------------------------
export const facilitiesApi = {
  list: (params) => api.get('/facilities', { params }),
  nppes: (params) => api.get('/facilities/nppes', { params }),
  get: (uuid) => api.get(`/facilities/${uuid}`),
  create: (payload) => api.post('/facilities', payload),
  update: (uuid, payload) => api.patch(`/facilities/${uuid}`, payload),
  setStatus: (uuid, status) => api.post(`/facilities/${uuid}/status`, { status }),
  // Per-facility feature switches: { codingEnabled?, eligibilityEnabled? }
  setFlags: (uuid, flags) => api.post(`/facilities/${uuid}/flags`, flags),
  remove: (uuid) => api.delete(`/facilities/${uuid}`),
  assignProvider: (uuid, providerUuid) => api.post(`/facilities/${uuid}/providers`, { providerUuid }),
  unassignProvider: (uuid, providerUuid) => api.delete(`/facilities/${uuid}/providers/${providerUuid}`),
};

// --- Audit logs (super admin) ----------------------------------------------
export const auditApi = {
  list: (params) => api.get('/audit', { params }),
};

// --- AI usage logs (super-admin only; real-time token usage per request) -----
export const aiLogsApi = {
  list: (params) => api.get('/ai-logs', { params }),
};

// --- System settings (feature flags) ---------------------------------------
// GET readable by any authenticated user; PATCH is super-admin only (server-enforced).
export const settingsApi = {
  get: () => api.get('/settings'),
  update: (patch) => api.patch('/settings', patch),
};

// --- Payer directory (Stedi network) search --------------------------------
export const payersApi = {
  search: (q) => api.get('/payers/search', { params: { q } }),
};

// --- Patients (EHR face sheet) ---------------------------------------------
export const patientsApi = {
  list: () => api.get('/patients'),
  get: (uuid) => api.get(`/patients/${uuid}`),
  create: (payload) => api.post('/patients', payload),
  update: (uuid, payload) => api.patch(`/patients/${uuid}`, payload),
  remove: (uuid) => api.delete(`/patients/${uuid}`),
  // No params → full list (face-sheet slots). With { page, pageSize, q, category } → paginated,
  // searchable, category-filtered response { documents, total, page, pageSize, counts, categories }.
  listDocuments: (uuid, params) => api.get(`/patients/${uuid}/documents`, params ? { params } : undefined),
  uploadDocument: (uuid, docType, file, onProgress, serviceDate) => {
    const fd = new FormData();
    fd.append('docType', docType);
    if (serviceDate) fd.append('serviceDate', serviceDate);
    fd.append('file', file);
    // Let the browser set multipart/form-data WITH its boundary — never set it
    // manually (a boundary-less header makes the server fail to parse the file).
    return api.post(`/patients/${uuid}/documents`, fd, {
      headers: { 'Content-Type': undefined },
      onUploadProgress: onProgress,
    });
  },
  documentUrl: (uuid, docUuid, download) => api.get(`/patients/${uuid}/documents/${docUuid}/url`, download ? { params: { download: 1 } } : undefined),
  extractDocument: (uuid, docUuid) => api.post(`/patients/${uuid}/documents/${docUuid}/extract`),
  // Stateless auto-fill (no patient yet): OCR a face sheet, persist nothing.
  extractUpload: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    // Browser sets multipart/form-data + boundary; do not set it manually.
    return api.post('/patients/extract-upload', fd, { headers: { 'Content-Type': undefined } });
  },
  removeDocument: (uuid, docUuid) => api.delete(`/patients/${uuid}/documents/${docUuid}`),
  // Benefits Verification (real-time eligibility) — scoped to the owned patient.
  listEligibility: (uuid) => api.get(`/patients/${uuid}/eligibility`),
  // Downloadable records (real vector-text PDFs, facility-branded, grayscale).
  downloadFaceSheet: (uuid, name) => downloadPdf(`/patients/${uuid}/facesheet/pdf`, name || 'face-sheet.pdf'),
  downloadBenefits: (uuid, policyIndex, name) =>
    downloadPdf(`/patients/${uuid}/benefits/pdf${policyIndex != null ? `?policyIndex=${policyIndex}` : ''}`, name || 'benefits.pdf'),
  // Live, server-side Stedi check — inputs pulled from the Face Sheet.
  verifyEligibility: (uuid, payload) => api.post(`/patients/${uuid}/eligibility/verify`, payload),
  // Programmatic ingest of a 271 the caller already holds.
  importEligibility: (uuid, payload) => api.post(`/patients/${uuid}/eligibility`, payload),
};

// --- Encounters (EHR worklist) ---------------------------------------------
export const encountersApi = {
  list: () => api.get('/encounters'),
  // Server-side pagination (enterprise scale)
  listPatients: (params) => api.get('/encounters/patients', { params }),
  clinicalRecords: (params) => api.get('/encounters/clinical-records', { params }),
  patientEncounters: (patientUuid, params) => api.get(`/encounters/patient/${patientUuid}/encounters`, { params }),
  // Carried-forward medication list + pharmacy/PBM vendor (from the patient's latest
  // eligibility) for a new note. Strictly patient-scoped server-side.
  rxContext: (patientUuid) => api.get(`/encounters/patient/${patientUuid}/rx-context`),
  create: (payload) => api.post('/encounters', payload),
  // Deterministic auto-coding suggestions from the note content (diagnoses + visit charge).
  predictCodes: (noteUuid) => api.get(`/encounters/notes/${noteUuid}/predict`),
  updateStatus: (appointmentUuid, payload) => api.patch(`/encounters/${appointmentUuid}`, payload),
  // Backend-authoritative note-type templates (H&P / SOAP / Progress).
  noteTemplates: () => api.get('/encounters/note-templates'),
  // Custom (provider-authored) note templates — owner-scoped.
  listCustomTemplates: () => api.get('/encounters/custom-templates'),
  createCustomTemplate: (payload) => api.post('/encounters/custom-templates', payload),
  generateCustomTemplate: (prompt) => api.post('/encounters/custom-templates/generate', { prompt }),
  updateCustomTemplate: (uuid, payload) => api.put(`/encounters/custom-templates/${uuid}`, payload),
  deleteCustomTemplate: (uuid) => api.delete(`/encounters/custom-templates/${uuid}`),
  // Encounter lab / imaging document attachments (S3-backed, per-encounter folders).
  listEncounterDocs: (encounterUuid, kind) => api.get(`/encounters/${encounterUuid}/documents`, { params: { kind } }),
  uploadEncounterDoc: (encounterUuid, kind, file, onProgress) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post(`/encounters/${encounterUuid}/documents`, fd, {
      params: { kind },
      headers: { 'Content-Type': undefined }, // browser sets multipart boundary
      onUploadProgress: onProgress,
    });
  },
  encounterDocUrl: (docUuid) => api.get(`/encounters/documents/${docUuid}/url`),
  deleteEncounterDoc: (docUuid) => api.delete(`/encounters/documents/${docUuid}`),
  // Authoritative encounter-header details (patient, MRN, DOB, age, facility, provider).
  encounterDetails: (encounterUuid) => api.get(`/encounters/${encounterUuid}/details`),
  // Clinical notes
  listNotes: (encounterUuid) => api.get(`/encounters/${encounterUuid}/notes`),
  createNote: (encounterUuid, payload) => api.post(`/encounters/${encounterUuid}/notes`, payload),
  getNote: (noteUuid) => api.get(`/encounters/notes/${noteUuid}`),
  // Download a signed note as a real, non-editable medical-record PDF. Drafts are
  // downloadable only by an MD (enforced server-side).
  downloadNote: (noteUuid, name) => downloadPdf(`/encounters/notes/${noteUuid}/pdf`, name || 'medical-record.pdf'),
  updateNote: (noteUuid, payload) => api.patch(`/encounters/notes/${noteUuid}`, payload),
  signNote: (noteUuid, payload) => api.post(`/encounters/notes/${noteUuid}/sign`, payload),
  amendNote: (noteUuid, payload) => api.post(`/encounters/notes/${noteUuid}/amend`, payload),
  // Billable codes captured on a note (diagnoses SNOMED→ICD-10, procedures CPT) + Part B scrub.
  getNoteCodes: (noteUuid) => api.get(`/encounters/notes/${noteUuid}/codes`),
  saveNoteCodes: (noteUuid, payload) => api.put(`/encounters/notes/${noteUuid}/codes`, payload),
  scrubNote: (noteUuid, payload) => api.post(`/encounters/notes/${noteUuid}/scrub`, payload || {}),
};

// --- Clinical terminology (SNOMED CT / ICD-10-CM / CPT / RxNorm) -------------
export const terminologyApi = {
  snomed: (q, pageSize) => api.get('/terminology/snomed', { params: { q, pageSize } }),
  rxnorm: (q, pageSize) => api.get('/terminology/rxnorm', { params: { q, pageSize } }),
  // Real-time prescribing safety: FDA-label interactions/warnings + allergy + duplicate-therapy check.
  rxSafety: ({ name, rxcui, allergies, current }) =>
    api.get('/terminology/rx-safety', { params: { name, rxcui, allergies, current } }),
  cpt: (q, pageSize) => api.get('/terminology/cpt', { params: { q, pageSize } }),
  search: (q, source, pageSize) => api.get('/terminology/search', { params: { q, source, pageSize } }),
  // SNOMED concept → billable ICD-10-CM (official complex map).
  snomedToIcd: (conceptId) => api.get(`/terminology/snomed/${conceptId}/icd10cm`),
};

// --- Coding engine (claim edits, PDPM, HCC, MPFS RVU) ----------------------
export const codingApi = {
  scrub: (payload) => api.post('/coding/scrub', payload),
  pdpm: (icd, fy) => api.get(`/coding/pdpm/${encodeURIComponent(icd)}`, { params: { fy } }),
  hcc: (icd) => api.get(`/coding/hcc/${encodeURIComponent(icd)}`),
  rvu: (hcpcs, params) => api.get(`/coding/rvu/${encodeURIComponent(hcpcs)}`, { params }),
};

// --- Appointments (EHR scheduler) ------------------------------------------
export const appointmentsApi = {
  list: (from, to) => api.get('/appointments', { params: { from, to } }),
  create: (payload) => api.post('/appointments', payload),
  update: (uuid, payload) => api.patch(`/appointments/${uuid}`, payload),
  cancel: (uuid) => api.patch(`/appointments/${uuid}`, { status: 'cancelled' }),
  setStatus: (uuid, status) => api.patch(`/appointments/${uuid}`, { status }),
  reschedule: (uuid, { date, startMin, durationMin }) =>
    api.patch(`/appointments/${uuid}`, { date, startMin, durationMin }),
  remove: (uuid, reason) => api.delete(`/appointments/${uuid}`, { data: { reason } }),
  // Appointment-level eligibility (real-time): live (re)verify + fetch benefits.
  verifyEligibility: (uuid) => api.post(`/appointments/${uuid}/eligibility/verify`, {}),
  eligibility: (uuid) => api.get(`/appointments/${uuid}/eligibility`),
};

export default api;
