import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@beekeeper/db", () => ({
  db: {
    user:                  { findMany: vi.fn() },
    hive:                  { findMany: vi.fn() },
    alertNotificationLog:  { findFirst: vi.fn(), createMany: vi.fn() },
    emailLog:              { findFirst: vi.fn() },
  },
}));

vi.mock("../email/send", () => ({
  sendAlertDigest: vi.fn(),
}));

// Mock all 5 alert check functions
vi.mock("../routes/alerts", () => ({
  checkVarroaNoTreatment: vi.fn(),
  checkTreatmentTooLong:  vi.fn(),
  checkInspectionOverdue: vi.fn(),
  checkDiseaseFlags:      vi.fn(),
  checkQueenAbsent:       vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { runAlertNotifications } from "./alert-notifications";
import { db } from "@beekeeper/db";
import { sendAlertDigest } from "../email/send";
import {
  checkVarroaNoTreatment,
  checkTreatmentTooLong,
  checkInspectionOverdue,
  checkDiseaseFlags,
  checkQueenAbsent,
} from "../routes/alerts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_QUEEN = { id: "user-001", email: "queen@example.com", name: "Queen Bee", role: "queen" };
const USER_WORKER = { id: "user-002", email: "worker@example.com", name: "Worker Bee", role: "worker" };
const HIVE_A = { id: "hive-001", name: "Hive 1" };
const HIVE_B = { id: "hive-002", name: "Hive 2" };

const ALERT_VARROA = {
  rule: "varroa_no_treatment", severity: "critical",
  message: "Varroa level is high with no active treatment",
};
const ALERT_OVERDUE = {
  rule: "inspection_overdue", severity: "warning",
  message: "Inspection overdue by 5 days",
};

function setNoAlerts() {
  vi.mocked(checkVarroaNoTreatment).mockResolvedValue(null);
  vi.mocked(checkTreatmentTooLong).mockResolvedValue([]);
  vi.mocked(checkInspectionOverdue).mockResolvedValue(null);
  vi.mocked(checkDiseaseFlags).mockResolvedValue(null);
  vi.mocked(checkQueenAbsent).mockResolvedValue(null);
}

function setHealthyDefaults() {
  vi.mocked(db.user.findMany).mockResolvedValue([USER_QUEEN] as any);
  vi.mocked(db.hive.findMany).mockResolvedValue([HIVE_A] as any);
  vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);
  vi.mocked(db.alertNotificationLog.createMany).mockResolvedValue({ count: 0 } as any);
  vi.mocked(db.emailLog.findFirst).mockResolvedValue({ id: "email-log-001" } as any);
  vi.mocked(sendAlertDigest).mockResolvedValue({ id: "resend-001" } as any);
  setNoAlerts();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAlertNotifications — early exits", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("exits early when no active users", async () => {
    vi.mocked(db.user.findMany).mockResolvedValue([]);

    await runAlertNotifications();

    expect(db.hive.findMany).not.toHaveBeenCalled();
    expect(sendAlertDigest).not.toHaveBeenCalled();
  });

  it("exits early when no active hives", async () => {
    vi.mocked(db.hive.findMany).mockResolvedValue([]);

    await runAlertNotifications();

    expect(checkVarroaNoTreatment).not.toHaveBeenCalled();
    expect(sendAlertDigest).not.toHaveBeenCalled();
  });

  it("does not send email when all hives are healthy", async () => {
    setNoAlerts();

    await runAlertNotifications();

    expect(sendAlertDigest).not.toHaveBeenCalled();
    expect(db.alertNotificationLog.createMany).not.toHaveBeenCalled();
  });
});

describe("runAlertNotifications — cooldown gate", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("sends email when no prior notification exists (cooldown row is null)", async () => {
    vi.mocked(checkVarroaNoTreatment).mockResolvedValue(ALERT_VARROA as any);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);

    await runAlertNotifications();

    expect(sendAlertDigest).toHaveBeenCalledOnce();
  });

  it("skips email when critical alert is within 48h cooldown", async () => {
    vi.mocked(checkVarroaNoTreatment).mockResolvedValue(ALERT_VARROA as any);
    // sentAt 10 hours ago — within 48h critical cooldown
    const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue({ sentAt: tenHoursAgo } as any);

    await runAlertNotifications();

    expect(sendAlertDigest).not.toHaveBeenCalled();
  });

  it("sends email when critical alert is outside 48h cooldown", async () => {
    vi.mocked(checkVarroaNoTreatment).mockResolvedValue(ALERT_VARROA as any);
    // sentAt 50 hours ago — outside 48h critical cooldown
    const fiftyHoursAgo = new Date(Date.now() - 50 * 3_600_000);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue({ sentAt: fiftyHoursAgo } as any);

    await runAlertNotifications();

    expect(sendAlertDigest).toHaveBeenCalledOnce();
  });

  it("skips email when warning alert is within 7-day cooldown", async () => {
    vi.mocked(checkInspectionOverdue).mockResolvedValue(ALERT_OVERDUE as any);
    // sentAt 5 days ago — within 7-day warning cooldown
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3_600_000);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue({ sentAt: fiveDaysAgo } as any);

    await runAlertNotifications();

    expect(sendAlertDigest).not.toHaveBeenCalled();
  });

  it("sends email when warning alert is outside 7-day cooldown", async () => {
    vi.mocked(checkInspectionOverdue).mockResolvedValue(ALERT_OVERDUE as any);
    // sentAt 8 days ago — outside 7-day cooldown
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3_600_000);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue({ sentAt: eightDaysAgo } as any);

    await runAlertNotifications();

    expect(sendAlertDigest).toHaveBeenCalledOnce();
  });
});

describe("runAlertNotifications — per-user isolation", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("sends separate digests to each eligible user when alert fires", async () => {
    vi.mocked(db.user.findMany).mockResolvedValue([USER_QUEEN, USER_WORKER] as any);
    vi.mocked(checkVarroaNoTreatment).mockResolvedValue(ALERT_VARROA as any);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);

    await runAlertNotifications();

    expect(sendAlertDigest).toHaveBeenCalledTimes(2);
    const recipients = vi.mocked(sendAlertDigest).mock.calls.map(c => c[0]);
    expect(recipients).toContain(USER_QUEEN.email);
    expect(recipients).toContain(USER_WORKER.email);
  });

  it("continues to next user when one send fails", async () => {
    vi.mocked(db.user.findMany).mockResolvedValue([USER_QUEEN, USER_WORKER] as any);
    vi.mocked(checkVarroaNoTreatment).mockResolvedValue(ALERT_VARROA as any);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);

    // First call throws; second succeeds
    vi.mocked(sendAlertDigest)
      .mockRejectedValueOnce(new Error("Resend API error"))
      .mockResolvedValueOnce({ id: "resend-002" } as any);

    await runAlertNotifications();

    // Should not throw; second user still gets their email
    expect(sendAlertDigest).toHaveBeenCalledTimes(2);
  });

  it("does not write notification log when send fails", async () => {
    vi.mocked(checkVarroaNoTreatment).mockResolvedValue(ALERT_VARROA as any);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);
    vi.mocked(sendAlertDigest).mockRejectedValue(new Error("Resend down"));

    await runAlertNotifications();

    expect(db.alertNotificationLog.createMany).not.toHaveBeenCalled();
  });
});

describe("runAlertNotifications — digest grouping", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("groups multiple alerts for the same hive into one HiveAlertGroup", async () => {
    vi.mocked(checkVarroaNoTreatment).mockResolvedValue(ALERT_VARROA as any);
    vi.mocked(checkInspectionOverdue).mockResolvedValue(ALERT_OVERDUE as any);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);

    await runAlertNotifications();

    expect(sendAlertDigest).toHaveBeenCalledOnce();
    const groups: any[] = vi.mocked(sendAlertDigest).mock.calls[0][3];
    expect(groups).toHaveLength(1); // one hive
    expect(groups[0].alerts).toHaveLength(2); // both alerts in the group
  });

  it("creates separate groups for alerts on different hives", async () => {
    vi.mocked(db.hive.findMany).mockResolvedValue([HIVE_A, HIVE_B] as any);
    vi.mocked(checkVarroaNoTreatment)
      .mockResolvedValueOnce(ALERT_VARROA as any)   // HIVE_A
      .mockResolvedValueOnce(null);                  // HIVE_B
    vi.mocked(checkInspectionOverdue)
      .mockResolvedValueOnce(null)                   // HIVE_A
      .mockResolvedValueOnce(ALERT_OVERDUE as any);  // HIVE_B
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);

    await runAlertNotifications();

    expect(sendAlertDigest).toHaveBeenCalledOnce();
    const groups: any[] = vi.mocked(sendAlertDigest).mock.calls[0][3];
    expect(groups).toHaveLength(2); // two hives
    const hiveNames = groups.map((g: any) => g.hiveName);
    expect(hiveNames).toContain(HIVE_A.name);
    expect(hiveNames).toContain(HIVE_B.name);
  });

  it("includes multiple treatment_too_long alerts for same hive (Option A — shared cooldown key)", async () => {
    const treatment1 = { rule: "treatment_too_long", severity: "warning", message: "Treatment running 70 days" };
    const treatment2 = { rule: "treatment_too_long", severity: "warning", message: "Treatment running 80 days" };
    vi.mocked(checkTreatmentTooLong).mockResolvedValue([treatment1, treatment2] as any);

    // Both share one cooldown key (treatment_too_long / hive / user) — null means both pass
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);

    await runAlertNotifications();

    const groups: any[] = vi.mocked(sendAlertDigest).mock.calls[0][3];
    expect(groups[0].alerts).toHaveLength(2); // both treatment alerts included in digest
    // Only one cooldown check key, but two log rows written (one per alert)
    const createManyCalls = vi.mocked(db.alertNotificationLog.createMany).mock.calls as any[];
    const createManyData = createManyCalls[0][0].data as any[];
    expect(createManyData).toHaveLength(2);
    expect(createManyData.every((r: any) => r.rule === "treatment_too_long")).toBe(true);
  });
});

describe("runAlertNotifications — notification log writes", () => {
  beforeEach(() => { vi.clearAllMocks(); setHealthyDefaults(); });

  it("writes one log row per pending alert after successful send", async () => {
    vi.mocked(checkVarroaNoTreatment).mockResolvedValue(ALERT_VARROA as any);
    vi.mocked(checkInspectionOverdue).mockResolvedValue(ALERT_OVERDUE as any);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);

    await runAlertNotifications();

    const createManyCalls = vi.mocked(db.alertNotificationLog.createMany).mock.calls as any[];
    const createManyData = createManyCalls[0][0].data as any[];
    expect(createManyData).toHaveLength(2);
    const rules = createManyData.map((r: any) => r.rule);
    expect(rules).toContain("varroa_no_treatment");
    expect(rules).toContain("inspection_overdue");
  });

  it("log rows include hiveId, recipientUserId, severity, emailLogId", async () => {
    vi.mocked(checkVarroaNoTreatment).mockResolvedValue(ALERT_VARROA as any);
    vi.mocked(db.alertNotificationLog.findFirst).mockResolvedValue(null);
    vi.mocked(db.emailLog.findFirst).mockResolvedValue({ id: "email-log-xyz" } as any);

    await runAlertNotifications();

    const createManyCalls = vi.mocked(db.alertNotificationLog.createMany).mock.calls as any[];
    const row = (createManyCalls[0][0].data as any[])[0];
    expect(row.hiveId).toBe(HIVE_A.id);
    expect(row.recipientUserId).toBe(USER_QUEEN.id);
    expect(row.severity).toBe("critical");
    expect(row.emailLogId).toBe("email-log-xyz");
  });
});
