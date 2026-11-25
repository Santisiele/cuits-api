export interface Person {
  taxId: string
  businessName: string
}

export interface TreeNode extends Person {
  relations: TreeNode[]
}

export const CONTACT_CUIT_HEADERS = ["Contacto", "Empresa", "CUIT empresa", "CUIL", "Nombre en Nosis", "Sugerencia", "Estado", "Id"] as const

export const SURE_STATUS = "Seguro (árbol de la empresa)"
export const SUGGESTED_STATUS = "Sugerencia (búsqueda por nombre, revisar)"
export const NOT_FOUND_STATUS = "Sin coincidencia segura"
export const ONE_WORD_STATUS = "Solo un nombre, no se busca"

const IGNORED = new Set(["arq", "ing", "lic", "dr", "dra", "sr", "sra", "dueno", "duena", "del", "las", "los", "con"])
const PERSON = /^(20|23|24|27)\d{9}$/

export function nameWords(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !IGNORED.has(word))
}

export function searchable(name: string): boolean {
  return nameWords(name).length >= 2
}

export function peopleInTree(nodes: readonly TreeNode[]): Person[] {
  const found = new Map<string, Person>()
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (PERSON.test(node.taxId) && !found.has(node.taxId)) found.set(node.taxId, { taxId: node.taxId, businessName: node.businessName })
      walk(node.relations)
    }
  }
  walk(nodes)
  return [...found.values()]
}

export function onlyMatch(contactName: string, people: readonly Person[]): Person | null {
  const words = nameWords(contactName)
  if (words.length < 2) return null
  const matches = people.filter((person) => {
    const theirs = new Set(nameWords(person.businessName))
    return PERSON.test(person.taxId) && words.every((word) => theirs.has(word))
  })
  return matches.length === 1 ? matches[0]! : null
}
