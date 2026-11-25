import { describe, it, expect } from "vitest"
import { crmExportSheets, type CompanyHistory } from "@domain/crmExport"
import type { Action, Contact, CrmCompany, Task } from "@domain/crm"

const company = (taxId: string, businessName: string, extra: Partial<CrmCompany> = {}): CrmCompany => ({
  taxId,
  businessName,
  crmBrand: null,
  crmProduct: null,
  crmOrigin: "Bolsa",
  originSource: null,
  nosisPending: false,
  addedAt: null,
  addedBy: null,
  lastActionDate: null,
  nextDueDate: null,
  openTaskCount: 0,
  closedAt: null,
  closedReason: null,
  closedBy: null,
  ...extra,
})

const action = (id: string, date: string, description: string, createdTaskId: string | null, extra: Partial<Action> = {}): Action => ({
  id,
  companyTaxId: "30712345678",
  date,
  description,
  doneBy: "Flavia",
  recordedBy: "admin",
  contactIds: ["k1"],
  createdTaskId,
  completedTaskIds: [],
  createdAt: `${date}T10:00:00.000Z`,
  archivedAt: null,
  ...extra,
})

const task = (id: string, dueDate: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({
  id,
  companyTaxId: "30712345678",
  description: `tarea ${id}`,
  dueDate,
  status,
  cancelReason: null,
  assignee: "Luchi",
  createdBy: "admin",
  contactIds: [],
  createdAt: `${dueDate}T00:00:00.000Z`,
  closedAt: null,
  archivedAt: null,
  postponements: [],
  ...extra,
})

const contact: Contact = {
  id: "k1",
  fullName: "Elso",
  phone: "1155",
  email: null,
  birthday: "19/09/1975",
  cuil: null,
  companyTaxIds: ["30712345678"],
  createdAt: "2026-11-01T00:00:00.000Z",
  archivedAt: null,
}

const acme: CompanyHistory = {
  company: company("30712345678", "Acme SA", { lastActionDate: "2026-11-10", nextDueDate: "2026-11-20", openTaskCount: 1 }),
  actions: [
    action("a2", "2026-11-10", "segunda", "t2"),
    action("a1", "2026-10-01", "primera", "t1"),
    action("a0", "2026-09-01", "borrada", null, { archivedAt: "2026-09-02T00:00:00.000Z" }),
  ],
  tasks: [
    task("t1", "2026-10-15", "done", { postponements: [{ from: "2026-10-05", to: "2026-10-15", reason: "viaje", by: "flavia", at: "2026-10-04T12:00:00.000Z" }] }),
    task("t2", "2026-11-20", "open"),
    task("t3", "2026-10-20", "cancelled", { cancelReason: "duplicada", closedAt: "2026-10-21T09:00:00.000Z" }),
  ],
  contacts: [contact],
}

const closed: CompanyHistory = {
  company: company("30500000001", "Beta SRL", { closedAt: "2026-11-02T15:00:00.000Z", closedReason: "No opera", closedBy: "admin" }),
  actions: [action("b1", "2026-08-01", "llamé", null, { contactIds: [] })],
  tasks: [],
  contacts: [],
}

const sheet = (name: string) => crmExportSheets([acme, closed], "2026-11-25").find((candidate) => candidate.name === name)!

describe("crmExportSheets", () => {
  it("lists one row per open task with the last action, marking overdue ones", () => {
    expect(sheet("Estado actual").rows).toEqual([
      {
        Empresa: "Acme SA",
        CUIT: "30712345678",
        "Con quién": "Elso",
        "Fecha última acción": "2026-11-10",
        "Qué se hizo": "segunda",
        "Quién lo hizo": "Flavia",
        "Fecha próxima acción": "2026-11-20",
        "Qué hacer": "tarea t2",
        "Quién lo hará": "Luchi",
        Vencida: "Sí",
      },
    ])
  })

  it("writes every live action by date with the task it left and its status", () => {
    const rows = sheet("Seguimiento").rows
    expect(rows.map((row) => [row["Fecha última acción"], row.Empresa, row["Estado próxima"]])).toEqual([
      ["2026-08-01", "Beta SRL", ""],
      ["2026-10-01", "Acme SA", "Hecha"],
      ["2026-11-10", "Acme SA", "Abierta"],
    ])
  })

  it("builds each company's timeline in date order, ending with what is next", () => {
    const rows = sheet("Línea de tiempo").rows
    expect(rows.map((row) => [row.Empresa, row.Fecha, row["Qué pasó"]])).toEqual([
      ["Acme SA", "2026-10-01", "Acción"],
      ["Acme SA", "2026-10-04", "Postergación"],
      ["Acme SA", "2026-10-21", "Tarea cancelada"],
      ["Acme SA", "2026-11-10", "Acción"],
      ["Acme SA", "2026-11-20", "Próxima"],
      ["Beta SRL", "2026-08-01", "Acción"],
      ["Beta SRL", "2026-11-02", "Cerrada"],
    ])
    expect(rows[1]!.Detalle).toBe('"tarea t1" del 2026-10-05 al 2026-10-15 (viaje)')
    expect(rows[2]!.Detalle).toBe("tarea t3 (duplicada)")
  })

  it("summarises companies and lists their contacts", () => {
    expect(sheet("Empresas").rows.map((row) => [row.Empresa, row.Estado, row.Acciones, row["Motivo de cierre"]])).toEqual([
      ["Acme SA", "Activa", 2, ""],
      ["Beta SRL", "Cerrada", 1, "No opera"],
    ])
    expect(sheet("Contactos").rows).toEqual([
      { "Nombre y apellido": "Elso", Empresa: "Acme SA", CUIT: "30712345678", Teléfono: "1155", Email: "", Cumple: "19/09/1975", "CUIL contacto": "" },
    ])
  })
})
