import { describe, it, expect } from "vitest"
import { nameWords, onlyMatch, peopleInTree, searchable, type TreeNode } from "@domain/crmContactCuits"

const node = (taxId: string, businessName: string, relations: TreeNode[] = []): TreeNode => ({ taxId, businessName, relations })

describe("nameWords", () => {
  it("drops accents, notes in brackets, titles and short words", () => {
    expect(nameWords("Arq. Marcelo A. Giorgelli (Dueño)")).toEqual(["marcelo", "giorgelli"])
    expect(nameWords("Luis Núñez")).toEqual(["luis", "nunez"])
  })

  it("only searches contacts with a name and a surname", () => {
    expect(searchable("Elso")).toBe(false)
    expect(searchable("Diego ( Dueno)")).toBe(false)
    expect(searchable("Jorge Pindur")).toBe(true)
  })
})

describe("peopleInTree", () => {
  it("collects every person at any depth once, leaving companies out", () => {
    const tree = [
      node("30712345678", "ACME SA", [
        node("20111111112", "PEREZ JUAN CARLOS", [node("27222222223", "GOMEZ ANA")]),
        node("30798765432", "OTRA SA", [node("20111111112", "PEREZ JUAN CARLOS")]),
      ]),
    ]
    expect(peopleInTree(tree).map((person) => person.taxId)).toEqual(["20111111112", "27222222223"])
  })
})

describe("onlyMatch", () => {
  const people = [
    { taxId: "20111111112", businessName: "PEREZ JUAN CARLOS" },
    { taxId: "20333333334", businessName: "PEREZ CARLOS ALBERTO" },
    { taxId: "27222222223", businessName: "GOMEZ ANA MARIA" },
    { taxId: "30712345678", businessName: "GOMEZ ANA SA" },
  ]

  it("takes the one person whose name holds every word of the contact", () => {
    expect(onlyMatch("Juan Perez", people)?.taxId).toBe("20111111112")
    expect(onlyMatch("Ana Gómez", people)?.taxId).toBe("27222222223")
  })

  it("leaves it blank when two people match", () => {
    expect(onlyMatch("Carlos Perez", people)).toBeNull()
  })

  it("leaves it blank when a word does not match exactly", () => {
    expect(onlyMatch("Juan Peres", people)).toBeNull()
  })

  it("never matches on a first name alone", () => {
    expect(onlyMatch("Juan", people)).toBeNull()
  })
})
