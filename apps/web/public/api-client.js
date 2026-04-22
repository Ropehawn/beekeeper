/**
 * BeeKeeper API Client
 * Thin layer that manages JWT auth and API calls to the Express backend.
 * All methods return parsed JSON or throw on error.
 */
const BeeAPI = (() => {
  // API base URL — same origin in production, configurable for dev
  const BASE = window.__BEEKEEPER_API_URL || '';

  function getToken() {
    return localStorage.getItem('beekeeper_token');
  }

  function setToken(token) {
    localStorage.setItem('beekeeper_token', token);
  }

  function setUser(user) {
    localStorage.setItem('beekeeper_user', JSON.stringify(user));
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem('beekeeper_user')); } catch { return null; }
  }

  function clearAuth() {
    localStorage.removeItem('beekeeper_token');
    localStorage.removeItem('beekeeper_user');
  }

  function isLoggedIn() {
    return !!getToken();
  }

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${path}`, opts);

    if (res.status === 401) {
      clearAuth();
      // Show login screen if token expired
      const loginEl = document.getElementById('login-screen');
      if (loginEl) loginEl.style.display = 'flex';
      throw new Error('Session expired — please log in again');
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ── Auth ──────────────────────────────────────────────────
  async function login(email, password) {
    const data = await request('POST', '/api/v1/auth/login', { email, password });
    setToken(data.token);
    setUser(data.user);
    return data;
  }

  async function setPassword(token, newPassword) {
    const data = await request('POST', '/api/v1/auth/set-password', { token, password: newPassword });
    return data;
  }

  async function forgotPassword(email) {
    return request('POST', '/api/v1/auth/forgot-password', { email });
  }

  async function resetPassword(token, newPassword) {
    return request('POST', '/api/v1/auth/reset-password', { token, newPassword });
  }

  // ── Hives ─────────────────────────────────────────────────
  async function getHives() {
    return request('GET', '/api/v1/hives');
  }

  async function getHive(id) {
    return request('GET', `/api/v1/hives/${id}`);
  }

  async function createHive(data) {
    return request('POST', '/api/v1/hives', data);
  }

  async function updateHive(id, data) {
    return request('PATCH', `/api/v1/hives/${id}`, data);
  }

  async function updateHiveComponents(hiveId, components) {
    return request('PUT', `/api/v1/hives/${hiveId}/components`, components);
  }

  async function updateFrame(hiveId, compId, frameId, data) {
    return request('PATCH', `/api/v1/hives/${hiveId}/components/${compId}/frames/${frameId}`, data);
  }

  // ── Inspections ───────────────────────────────────────────
  async function getInspections(hiveId) {
    const qs = hiveId ? `?hiveId=${encodeURIComponent(hiveId)}` : '';
    return request('GET', `/api/v1/inspections${qs}`);
  }

  async function createInspection(data) {
    return request('POST', '/api/v1/inspections', data);
  }

  // ── Feeding ───────────────────────────────────────────────
  async function getFeedingLogs(hiveId) {
    const qs = hiveId ? `?hiveId=${encodeURIComponent(hiveId)}` : '';
    return request('GET', `/api/v1/feeding${qs}`);
  }

  async function createFeedingLog(data) {
    return request('POST', '/api/v1/feeding', data);
  }

  // ── Harvest ───────────────────────────────────────────────
  async function getHarvestLogs() {
    return request('GET', '/api/v1/harvest');
  }

  async function createHarvestLog(data) {
    return request('POST', '/api/v1/harvest', data);
  }

  // ── Financials ────────────────────────────────────────────
  async function getFinancials() {
    return request('GET', '/api/v1/financials');
  }

  async function createFinancial(data) {
    return request('POST', '/api/v1/financials', data);
  }

  // ── Receipts ──────────────────────────────────────────────
  async function getReceiptUploadUrl(data) {
    return request('POST', '/api/v1/receipts/upload-url', data);
  }
  async function scanReceipt(receiptId) {
    return request('POST', '/api/v1/receipts/scan', { receiptId });
  }
  async function getReceiptDownloadUrl(id) {
    return request('GET', `/api/v1/receipts/${id}/download`);
  }
  // Legacy alias
  async function uploadReceipt(formData) {
    return request('POST', '/api/v1/receipts/scan', formData);
  }

  // ── Users ─────────────────────────────────────────────────
  async function getUsers() {
    return request('GET', '/api/v1/users');
  }

  async function inviteUser(data) {
    return request('POST', '/api/v1/users/invite', data);
  }

  async function updateUser(id, data) {
    return request('PATCH', `/api/v1/users/${id}`, data);
  }

  async function deleteUser(id) {
    return request('DELETE', `/api/v1/users/${id}`);
  }

  // ── Health Events ──────────────────────────────────────────
  async function getHealthEvents() {
    return request('GET', '/api/v1/health-events');
  }

  async function createHealthEvent(data) {
    return request('POST', '/api/v1/health-events', data);
  }

  async function updateHealthEvent(id, data) {
    return request('PATCH', `/api/v1/health-events/${id}`, data);
  }

  // ── Tasks ─────────────────────────────────────────────────
  async function getTasks() {
    return request('GET', '/api/v1/tasks');
  }

  async function createTask(data) {
    return request('POST', '/api/v1/tasks', data);
  }

  async function updateTask(id, data) {
    return request('PATCH', `/api/v1/tasks/${id}`, data);
  }

  async function deleteTask(id) {
    return request('DELETE', `/api/v1/tasks/${id}`);
  }

  // ── Frame Photos & Analysis ───────────────────────────────

  // R2 upload flow:
  //
  //   Step 1: getFrameUploadUrl  → creates FramePhoto (PENDING) + presigned PUT URL
  //   Step 2: client PUTs file directly to R2 via presignedUrl (not through API)
  //   Step 3: confirmFramePhotoUpload  → verifies file in R2, marks FramePhoto confirmed
  //   Step 4: analyzeFramePhotoById   → fetches from R2, calls Claude Vision

  // POST /api/v1/frames/:frameId/photos/upload-url
  // data: { side, mimeType, fileSizeBytes, inspectionId?, inspectionSessionId? }
  // Returns: { photoId, presignedUrl, storageKey, expiresAt }
  async function getFrameUploadUrl(frameId, data) {
    return request('POST', `/api/v1/frames/${frameId}/photos/upload-url`, data);
  }

  // POST /api/v1/frame-photos/:photoId/confirm-upload
  // Call after a successful PUT to the presignedUrl. Verifies the file exists in R2.
  // Returns: { photoId, storageKey, uploadConfirmedAt, fileSizeBytes }
  async function confirmFramePhotoUpload(photoId) {
    return request('POST', `/api/v1/frame-photos/${photoId}/confirm-upload`);
  }

  // POST /api/v1/frame-photos/:photoId/analyze
  // Requires: confirm-upload must have been called first (uploadConfirmedAt set).
  // Response shape is identical to analyzeFramePhoto (base64 route), plus previousAnalysisCount.
  async function analyzeFramePhotoById(photoId) {
    return request('POST', `/api/v1/frame-photos/${photoId}/analyze`);
  }

  // ── Frame Observations ────────────────────────────────────
  // POST /api/v1/frame-observations
  // Creates a human-approved canonical FrameObservation.
  // Call this after the user reviews AI results and clicks Apply.
  async function createFrameObservation(data) {
    return request('POST', '/api/v1/frame-observations', data);
  }

  // GET /api/v1/frame-observations?frameId=xxx&limit=N
  // Returns observations for a frame, newest first.
  async function getFrameObservations(frameId, limit) {
    const qs = new URLSearchParams({ frameId });
    if (limit) qs.set('limit', String(limit));
    return request('GET', `/api/v1/frame-observations?${qs}`);
  }

  // POST /api/v1/frame-observations/link-inspection
  // Links all FramePhoto + FrameObservation rows for a session to a real Inspection.
  // Call after saveInspection() returns the inspection UUID.
  // { inspectionId: uuid, sessionId: string }
  async function linkFrameInspection(data) {
    return request('POST', '/api/v1/frame-observations/link-inspection', data);
  }

  // GET /api/v1/inspections/:id/frame-summary
  // Returns hiveObservations, derivedTotals, and per-frame observations with AI metadata.
  // linkPending: true when the inspection is recent and link-inspection may not have run yet.
  async function getInspectionSummary(inspectionId) {
    return request('GET', `/api/v1/inspections/${inspectionId}/frame-summary`);
  }

  // GET /api/v1/frame-photos/:photoId/view-url
  // Returns a short-lived presigned R2 GET URL for viewing a confirmed frame photo.
  // { photoId, url, expiresAt, side, mimeType }
  async function getPhotoViewUrl(photoId) {
    return request('GET', `/api/v1/frame-photos/${photoId}/view-url`);
  }

  // ── Varroa Counts ─────────────────────────────────────────
  // POST /api/v1/varroa-counts
  // data: { hiveId, countedAt, method, miteCount, beeSample?, daysOnBoard?, notes? }
  // Returns the created count with computed mitesPer100 / mitesPerDay / status.
  async function createVarroaCount(data) {
    return request('POST', '/api/v1/varroa-counts', data);
  }

  // GET /api/v1/varroa-counts?hiveId=uuid&limit=N
  // Returns counts for a hive, newest first (countedAt DESC).
  // limit defaults to 10 on the server, capped at 50.
  async function getVarroaCounts(hiveId, limit = 10) {
    const qs = new URLSearchParams({ hiveId, limit: String(limit) });
    return request('GET', `/api/v1/varroa-counts?${qs}`);
  }

  // ── Treatment Logs ────────────────────────────────────────
  // POST /api/v1/treatment-logs
  // data: { hiveId, appliedAt, treatmentType, productName?, dosage?, endedAt?, notes? }
  // Returns the created log with computed daysActive / isActive.
  async function createTreatmentLog(data) {
    return request('POST', '/api/v1/treatment-logs', data);
  }

  // GET /api/v1/treatment-logs?hiveId=uuid&limit=N
  // Returns treatment logs newest first (appliedAt DESC).
  // limit defaults to 10 on the server, capped at 50.
  async function getTreatmentLogs(hiveId, limit = 10) {
    const qs = new URLSearchParams({ hiveId, limit: String(limit) });
    return request('GET', `/api/v1/treatment-logs?${qs}`);
  }

  // PATCH /api/v1/treatment-logs/:id
  // data: { endedAt?, notes?, dosage? } — at least one field required.
  // Use this to record when a treatment ended (e.g. Apivar strip removal).
  async function updateTreatmentLog(id, data) {
    return request('PATCH', `/api/v1/treatment-logs/${id}`, data);
  }

  // ── Sensors ───────────────────────────────────────────────

  // GET /api/v1/sensors/test-connection
  // Tests connectivity to the UniFi cloud API using the server-side UNIFI_API_KEY.
  // Returns: { connected: boolean, sensorCount?: number, error?: string }
  async function testSensorConnection() {
    return request('GET', '/api/v1/sensors/test-connection');
  }

  // GET /api/v1/sensors/discover
  // Lists all sensors on the account from the UniFi cloud API.
  // Returns: { sensors: [{ id, name, type, connected, tempF, humidity, lux }] }
  async function discoverSensors() {
    return request('GET', '/api/v1/sensors/discover');
  }

  // GET /api/v1/sensors/devices
  // Returns all registered sensor devices from the DB, with hive name.
  // Returns: [{ id, deviceId, name, hiveId, hiveName, pollInterval, createdAt }]
  async function getSensorDevices() {
    return request('GET', '/api/v1/sensors/devices');
  }

  // DELETE /api/v1/sensors/devices/:id
  // Soft-deletes (deactivates) a registered sensor device.
  async function deleteSensorDevice(id) {
    return request('DELETE', `/api/v1/sensors/devices/${encodeURIComponent(id)}`);
  }

  // POST /api/v1/sensors/devices
  // Register (or update) a UniFi Protect sensor linked to a hive.
  // data: { hiveId?, unifiDeviceId, name, pollInterval? }
  async function registerSensorDevice(data) {
    return request('POST', '/api/v1/sensors/devices', data);
  }

  // GET /api/v1/sensors/latest?hiveId=uuid
  // Returns the most recent reading for a hive, or null if no device is assigned.
  // { hiveId, deviceId, deviceName, tempF, humidity, lux, recordedAt, minutesAgo }
  async function getLatestSensorReading(hiveId) {
    return request('GET', `/api/v1/sensors/latest?hiveId=${encodeURIComponent(hiveId)}`);
  }

  // ── Cameras ──────────────────────────────────────────────
  async function discoverCameras() {
    return request('GET', '/api/v1/cameras/discover');
  }
  async function getCameraDevices() {
    return request('GET', '/api/v1/cameras/devices');
  }
  async function registerCameraDevice(data) {
    return request('POST', '/api/v1/cameras/devices', data);
  }
  async function deleteCameraDevice(id) {
    return request('DELETE', `/api/v1/cameras/devices/${id}`);
  }
  // Returns the proxy URL with auth token — use as img src. Append &t=timestamp to bust cache.
  function getCameraSnapshotUrl(unifiDeviceId) {
    const token = getToken();
    return `/api/v1/cameras/snapshot/${encodeURIComponent(unifiDeviceId)}?token=${encodeURIComponent(token || '')}`;
  }

  // GET /api/v1/health-analysis/:hiveId
  // LLM-powered intelligent health analysis with caching
  async function getHiveHealthAnalysis(hiveId) {
    return request('GET', `/api/v1/health-analysis/${hiveId}`);
  }

  // GET /api/v1/sensors/history?hiveId=uuid&hours=168
  async function getSensorHistory(hiveId, hours) {
    const qs = new URLSearchParams({ hiveId });
    if (hours) qs.set('hours', String(hours));
    return request('GET', `/api/v1/sensors/history?${qs}`);
  }

  // ── Hive Alerts ───────────────────────────────────────────
  // GET /api/v1/alerts?hiveId=uuid
  // Returns an array of active rule-based alerts for a hive.
  // Returns [] when the hive is healthy. Never returns 404.
  // Each alert: { rule, severity ("critical"|"warning"), message, data? }
  async function getHiveAlerts(hiveId) {
    return request('GET', `/api/v1/alerts?hiveId=${hiveId}`);
  }

  // GET /api/v1/scores?hiveId=uuid
  // Returns: { hiveId, score (0-100), label ("Strong"|"Watch"|"At Risk"),
  //            penalties [{ points, reason, rule? }], summary }
  // score=100, label=Strong, penalties=[] when hive is healthy.
  async function getHiveScore(hiveId) {
    return request('GET', `/api/v1/scores?hiveId=${hiveId}`);
  }

  // GET /api/v1/hive-summary
  // Returns: [{ hiveId, score, scoreLabel, alertCount, hasCritical,
  //             varroaStatusColor, varroaMetric, daysSinceInspection, activeTreatment }]
  // One call for all active hives — used for the dashboard status row.
  async function getHiveSummary() {
    return request('GET', '/api/v1/hive-summary');
  }

  // GET /api/v1/hives/coverage/:hiveId
  // Returns sensor coverage for a single hive:
  // { hiveId, hiveName,
  //   conditions: [{ label, displayValue, rawValue, unit, freshness, lastSeenAgo, recordedAt }],
  //   trends:     [{ label, displayValue, direction, period, freshness }],
  //   insights:   string[],
  //   sources:    { internalClimate, externalClimate, scale, audio:
  //                 { freshness, lastSeenAgo, assigned } } }
  async function getHiveIntelligence(hiveId) {
    return request('GET', `/api/v1/hives/intelligence/${encodeURIComponent(hiveId)}`);
  }

  // ── Public API ────────────────────────────────────────────
  return {
    request, // exposed for ad-hoc API calls
    getToken, setToken, getUser, setUser, clearAuth, isLoggedIn,
    login, setPassword, forgotPassword, resetPassword,
    getHives, getHive, createHive, updateHive, updateHiveComponents, updateFrame,
    getInspections, createInspection,
    getFeedingLogs, createFeedingLog,
    getHarvestLogs, createHarvestLog,
    getFinancials, createFinancial,
    uploadReceipt, getReceiptUploadUrl, scanReceipt, getReceiptDownloadUrl,
    getUsers, inviteUser, updateUser, deleteUser,
    getHealthEvents, createHealthEvent, updateHealthEvent,
    getTasks, createTask, updateTask, deleteTask,
    getFrameUploadUrl, confirmFramePhotoUpload, analyzeFramePhotoById,
    createFrameObservation, getFrameObservations, linkFrameInspection,
    getInspectionSummary,
    getPhotoViewUrl,
    createVarroaCount, getVarroaCounts,
    createTreatmentLog, getTreatmentLogs, updateTreatmentLog,
    testSensorConnection, discoverSensors, getSensorDevices, deleteSensorDevice,
    registerSensorDevice, getLatestSensorReading, getSensorHistory,
    discoverCameras, getCameraDevices, registerCameraDevice, deleteCameraDevice, getCameraSnapshotUrl,
    getHiveAlerts,
    getHiveScore,
    getHiveHealthAnalysis,
    getHiveSummary,
    getHiveIntelligence,
  };
})();
