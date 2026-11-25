import type { Action, Contact, CrmCompany, Task } from "@domain/crm.js"

export interface CompanyHistory {
  company: CrmCompany
  actions: Action[]
  tasks: Task[]
  contacts: Contact[]
}

export type ExportCell = string | number | null

export interface ExportSheet {
  name: string
  header: string[]
  dateColumns: string[]
  rows: Record<string, ExportCell>[]
}

const STATUS_LABEL: Record<Task["status"], string> = { open: "Abierta", done: "Hecha", cancelled: "Cancelada" }

function live<T extends { archivedAt: string | null }>(items: readonly T[]): T[] {
  return items.filter((item) => item.archivedAt === null)
}

function byDate<T>(date: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => date(a).localeCompare(date(b))
}

function names(ids: readonly string[], contacts: readonly Contact[]): string {
  return ids.flatMap((id) => contacts.find((contact) => contact.id === id)?.fullName ?? []).join(", ")
}

function origin(company: CrmCompany): string {
  return company.crmOrigin ?? company.originSource ?? ""
}

function lastAction(history: CompanyHistory): Action | null {
  return live(history.actions).sort(byDate((action) => action.date)).at(-1) ?? null
}

function currentState(histories: readonly CompanyHistory[], today: string): ExportSheet {
  const rows = histories.flatMap((history) => {
    const last = lastAction(history)
    return live(history.tasks)
      .filter((task) => task.status === "open")
      .map((task) => ({
        Empresa: history.company.businessName,
        CUIT: history.company.taxId,
        "Con quién": names(task.contactIds.length > 0 ? task.contactIds : (last?.contactIds ?? []), history.contacts),
        "Fecha última acción": last?.date ?? null,
        "Qué se hizo": last?.description ?? "",
        "Quién lo hizo": last?.doneBy ?? "",
        "Fecha próxima acción": task.dueDate,
        "Qué hacer": task.description,
        "Quién lo hará": task.assignee,
        Vencida: task.dueDate < today ? "Sí" : "",
      }))
  })
  rows.sort((a, b) => a["Fecha próxima acción"].localeCompare(b["Fecha próxima acción"]) || a.Empresa.localeCompare(b.Empresa))
  return {
    name: "Estado actual",
    header: ["Empresa", "CUIT", "Con quién", "Fecha última acción", "Qué se hizo", "Quién lo hizo", "Fecha próxima acción", "Qué hacer", "Quién lo hará", "Vencida"],
    dateColumns: ["Fecha última acción", "Fecha próxima acción"],
    rows,
  }
}

function followUp(histories: readonly CompanyHistory[]): ExportSheet {
  const rows = histories.flatMap((history) =>
    live(history.actions).map((action) => {
      const next = history.tasks.find((task) => task.id === action.createdTaskId && task.archivedAt === null)
      return {
        "Con quién": names(action.contactIds, history.contacts),
        Empresa: history.company.businessName,
        CUIT: history.company.taxId,
        "Quién lo hizo": action.doneBy,
        "Fecha última acción": action.date,
        "Qué se hizo": action.description,
        "Fecha próxima acción": next?.dueDate ?? null,
        "Qué hacer": next?.description ?? "",
        "Quién lo hará": next?.assignee ?? "",
        "Estado próxima": next ? STATUS_LABEL[next.status] : "",
      }
    })
  )
  rows.sort((a, b) => a["Fecha última acción"].localeCompare(b["Fecha última acción"]) || a.Empresa.localeCompare(b.Empresa))
  return {
    name: "Seguimiento",
    header: ["Con quién", "Empresa", "CUIT", "Quién lo hizo", "Fecha última acción", "Qué se hizo", "Fecha próxima acción", "Qué hacer", "Quién lo hará", "Estado próxima"],
    dateColumns: ["Fecha última acción", "Fecha próxima acción"],
    rows,
  }
}

interface TimelineEvent {
  date: string
  order: number
  kind: string
  detail: string
  who: string
  with: string
}

function events(history: CompanyHistory): TimelineEvent[] {
  const { company, contacts } = history
  const tasks = live(history.tasks)
  const list: TimelineEvent[] = live(history.actions).map((action) => ({
    date: action.date,
    order: 0,
    kind: "Acción",
    detail: action.description,
    who: action.doneBy,
    with: names(action.contactIds, contacts),
  }))
  for (const task of tasks) {
    for (const postponement of task.postponements) {
      list.push({
        date: postponement.at.slice(0, 10),
        order: 1,
        kind: "Postergación",
        detail: `"${task.description}" del ${postponement.from} al ${postponement.to}${postponement.reason ? ` (${postponement.reason})` : ""}`,
        who: postponement.by,
        with: "",
      })
    }
    if (task.status === "cancelled") {
      list.push({
        date: (task.closedAt ?? task.dueDate).slice(0, 10),
        order: 2,
        kind: "Tarea cancelada",
        detail: `${task.description}${task.cancelReason ? ` (${task.cancelReason})` : ""}`,
        who: task.assignee,
        with: names(task.contactIds, contacts),
      })
    }
    if (task.status === "open") {
      list.push({ date: task.dueDate, order: 4, kind: "Próxima", detail: task.description, who: task.assignee, with: names(task.contactIds, contacts) })
    }
  }
  if (company.closedAt) {
    list.push({ date: company.closedAt.slice(0, 10), order: 3, kind: "Cerrada", detail: company.closedReason ?? "", who: company.closedBy ?? "", with: "" })
  }
  return list.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order)
}

function timeline(histories: readonly CompanyHistory[]): ExportSheet {
  const ordered = [...histories].sort((a, b) => a.company.businessName.localeCompare(b.company.businessName))
  const rows = ordered.flatMap((history) =>
    events(history).map((event) => ({
      Empresa: history.company.businessName,
      CUIT: history.company.taxId,
      Fecha: event.date,
      "Qué pasó": event.kind,
      Detalle: event.detail,
      Quién: event.who,
      "Con quién": event.with,
    }))
  )
  return {
    name: "Línea de tiempo",
    header: ["Empresa", "CUIT", "Fecha", "Qué pasó", "Detalle", "Quién", "Con quién"],
    dateColumns: ["Fecha"],
    rows,
  }
}

function companies(histories: readonly CompanyHistory[]): ExportSheet {
  const rows = histories.map(({ company, actions, contacts }) => ({
    Empresa: company.businessName,
    CUIT: company.taxId,
    Marca: company.crmBrand ?? "",
    "Producto o servicio": company.crmProduct ?? "",
    Origen: origin(company),
    Estado: company.closedAt ? "Cerrada" : "Activa",
    "Motivo de cierre": company.closedReason ?? "",
    Contactos: live(contacts).length,
    Acciones: live(actions).length,
    "Última acción": company.lastActionDate,
    "Próxima acción": company.nextDueDate,
    "Tareas abiertas": company.openTaskCount,
  }))
  rows.sort((a, b) => a.Empresa.localeCompare(b.Empresa))
  return {
    name: "Empresas",
    header: ["Empresa", "CUIT", "Marca", "Producto o servicio", "Origen", "Estado", "Motivo de cierre", "Contactos", "Acciones", "Última acción", "Próxima acción", "Tareas abiertas"],
    dateColumns: ["Última acción", "Próxima acción"],
    rows,
  }
}

function contactList(histories: readonly CompanyHistory[]): ExportSheet {
  const rows = histories.flatMap(({ company, contacts }) =>
    live(contacts).map((contact) => ({
      "Nombre y apellido": contact.fullName,
      Empresa: company.businessName,
      CUIT: company.taxId,
      Teléfono: contact.phone ?? "",
      Email: contact.email ?? "",
      Cumple: contact.birthday ?? "",
      "CUIL contacto": contact.cuil ?? "",
    }))
  )
  rows.sort((a, b) => a.Empresa.localeCompare(b.Empresa) || a["Nombre y apellido"].localeCompare(b["Nombre y apellido"]))
  return {
    name: "Contactos",
    header: ["Nombre y apellido", "Empresa", "CUIT", "Teléfono", "Email", "Cumple", "CUIL contacto"],
    dateColumns: [],
    rows,
  }
}

export function crmExportSheets(histories: readonly CompanyHistory[], today: string): ExportSheet[] {
  return [currentState(histories, today), followUp(histories), timeline(histories), companies(histories), contactList(histories)]
}
