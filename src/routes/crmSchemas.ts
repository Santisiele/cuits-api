
export const nullableString = { type: ["string", "null"] } as const

export const companySchema = {
  type: "object",
  properties: {
    taxId: { type: "string" },
    businessName: { type: "string" },
    crmBrand: nullableString,
    crmProduct: nullableString,
    crmOrigin: nullableString,
    originSource: nullableString,
    nosisPending: { type: "boolean" },
    addedAt: nullableString,
    addedBy: nullableString,
    lastActionDate: nullableString,
    nextDueDate: nullableString,
    openTaskCount: { type: "number" },
    closedAt: nullableString,
    closedReason: nullableString,
    closedBy: nullableString,
  },
} as const

export const contactSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    fullName: { type: "string" },
    phone: nullableString,
    email: nullableString,
    birthday: nullableString,
    cuil: nullableString,
    companyTaxIds: { type: "array", items: { type: "string" } },
    createdAt: { type: "string" },
    archivedAt: nullableString,
  },
} as const

export const idList = { type: "array", items: { type: "string" } } as const

export const actionSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    companyTaxId: { type: "string" },
    date: { type: "string" },
    description: { type: "string" },
    doneBy: { type: "string" },
    recordedBy: { type: "string" },
    contactIds: idList,
    createdTaskId: nullableString,
    completedTaskIds: idList,
    createdAt: { type: "string" },
    archivedAt: nullableString,
  },
} as const

export const taskProperties = {
  id: { type: "string" },
  companyTaxId: { type: "string" },
  description: { type: "string" },
  dueDate: { type: "string" },
  status: { type: "string" },
  cancelReason: nullableString,
  assignee: { type: "string" },
  createdBy: { type: "string" },
  contactIds: idList,
  createdAt: { type: "string" },
  closedAt: nullableString,
  archivedAt: nullableString,
} as const

export const taskSchema = { type: "object", properties: taskProperties } as const

export const agendaItemSchema = {
  type: "object",
  properties: {
    ...taskProperties,
    businessName: { type: "string" },
    overdue: { type: "boolean" },
    lastAction: {
      type: ["object", "null"],
      properties: {
        date: { type: "string" },
        description: { type: "string" },
        doneBy: { type: "string" },
        contacts: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const

export const changeSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    at: { type: "string" },
    by: { type: "string" },
    entityType: { type: "string" },
    entityId: { type: "string" },
    operation: { type: "string" },
    before: { type: "object", additionalProperties: true },
    after: { type: "object", additionalProperties: true },
  },
} as const

export const taskBodyProperties = {
  companyTaxId: { type: "string" },
  description: { type: "string" },
  dueDate: { type: "string" },
  assignee: nullableString,
  contactIds: idList,
  status: { type: "string" },
  cancelReason: nullableString,
} as const

export const actionBodySchema = {
  type: "object",
  properties: {
    companyTaxId: { type: "string" },
    doneBy: nullableString,
    date: { type: "string" },
    description: { type: "string" },
    contactIds: idList,
    completesTaskIds: idList,
    nextTask: { type: ["object", "null"], properties: taskBodyProperties },
  },
} as const

export const companyBodySchema = {
  type: "object",
  properties: {
    taxId: { type: "string" },
    businessName: nullableString,
    crmBrand: nullableString,
    crmProduct: nullableString,
    crmOrigin: nullableString,
    originSource: nullableString,
  },
} as const

export const contactBodySchema = {
  type: "object",
  properties: {
    fullName: { type: "string" },
    companyTaxIds: { type: "array", items: { type: "string" } },
    phone: nullableString,
    email: nullableString,
    birthday: nullableString,
    cuil: nullableString,
  },
} as const

export const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const

export const errors = { 400: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema } as const

export const taxIdParams = { type: "object", properties: { taxId: { type: "string" } } } as const

export const idParams = { type: "object", properties: { id: { type: "string" } } } as const

export type CompanyBody = {
  taxId?: string
  businessName?: string | null
  crmBrand?: string | null
  crmProduct?: string | null
  crmOrigin?: string | null
  originSource?: string | null
}

export type ContactBody = {
  fullName?: string
  companyTaxIds?: string[]
  phone?: string | null
  email?: string | null
  birthday?: string | null
  cuil?: string | null
}

export type TaskBody = {
  companyTaxId?: string
  description?: string
  dueDate?: string
  assignee?: string | null
  contactIds?: string[]
  status?: string
  cancelReason?: string | null
}

export type ActionBody = {
  companyTaxId?: string
  doneBy?: string | null
  date?: string
  description?: string
  contactIds?: string[]
  completesTaskIds?: string[]
  nextTask?: TaskBody | null
}
