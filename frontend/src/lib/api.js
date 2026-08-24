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
};

// --- Users (admin) ---------------------------------------------------------
export const usersApi = {
  list: (params) => api.get('/users', { params }),
  create: (payload) => api.post('/users', payload),
  update: (uuid, payload) => api.patch(`/users/${uuid}`, payload),
  setStatus: (uuid, status) => api.patch(`/users/${uuid}/status`, { status }),
  resetPassword: (uuid, temporaryPassword) =>
    api.post(`/users/${uuid}/reset-password`, { temporaryPassword }),
  remove: (uuid) => api.delete(`/users/${uuid}`),
  facilities: (uuid) => api.get(`/users/${uuid}/facilities`),
  setFacilities: (uuid, facilityUuids) => api.put(`/users/${uuid}/facilities`, { facilityUuids }),
};

// --- Specialties (admin) ---------------------------------------------------
export const specialtiesApi = {
  list: () => api.get('/specialties'),
  create: (name) => api.post('/specialties', { name }),
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
  remove: (uuid) => api.delete(`/facilities/${uuid}`),
  assignProvider: (uuid, providerUuid) => api.post(`/facilities/${uuid}/providers`, { providerUuid }),
  unassignProvider: (uuid, providerUuid) => api.delete(`/facilities/${uuid}/providers/${providerUuid}`),
};

// --- Patients (EHR face sheet) ---------------------------------------------
export const patientsApi = {
  list: () => api.get('/patients'),
  get: (uuid) => api.get(`/patients/${uuid}`),
  create: (payload) => api.post('/patients', payload),
  update: (uuid, payload) => api.patch(`/patients/${uuid}`, payload),
  remove: (uuid) => api.delete(`/patients/${uuid}`),
  listDocuments: (uuid) => api.get(`/patients/${uuid}/documents`),
  uploadDocument: (uuid, docType, file, onProgress) => {
    const fd = new FormData();
    fd.append('docType', docType);
    fd.append('file', file);
    // Let the browser set multipart/form-data WITH its boundary — never set it
    // manually (a boundary-less header makes the server fail to parse the file).
    return api.post(`/patients/${uuid}/documents`, fd, {
      headers: { 'Content-Type': undefined },
      onUploadProgress: onProgress,
    });
  },
  documentUrl: (uuid, docUuid) => api.get(`/patients/${uuid}/documents/${docUuid}/url`),
  extractDocument: (uuid, docUuid) => api.post(`/patients/${uuid}/documents/${docUuid}/extract`),
  // Stateless auto-fill (no patient yet): OCR a face sheet, persist nothing.
  extractUpload: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    // Browser sets multipart/form-data + boundary; do not set it manually.
    return api.post('/patients/extract-upload', fd, { headers: { 'Content-Type': undefined } });
  },
  removeDocument: (uuid, docUuid) => api.delete(`/patients/${uuid}/documents/${docUuid}`),
};

// --- Encounters (EHR worklist) ---------------------------------------------
export const encountersApi = {
  list: () => api.get('/encounters'),
  // Server-side pagination (enterprise scale)
  listPatients: (params) => api.get('/encounters/patients', { params }),
  clinicalRecords: (params) => api.get('/encounters/clinical-records', { params }),
  patientEncounters: (patientUuid, params) => api.get(`/encounters/patient/${patientUuid}/encounters`, { params }),
  create: (payload) => api.post('/encounters', payload),
  updateStatus: (appointmentUuid, payload) => api.patch(`/encounters/${appointmentUuid}`, payload),
  // Clinical notes
  listNotes: (encounterUuid) => api.get(`/encounters/${encounterUuid}/notes`),
  createNote: (encounterUuid, payload) => api.post(`/encounters/${encounterUuid}/notes`, payload),
  getNote: (noteUuid) => api.get(`/encounters/notes/${noteUuid}`),
  updateNote: (noteUuid, payload) => api.patch(`/encounters/notes/${noteUuid}`, payload),
  signNote: (noteUuid, payload) => api.post(`/encounters/notes/${noteUuid}/sign`, payload),
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
  remove: (uuid) => api.delete(`/appointments/${uuid}`),
};

export default api;
