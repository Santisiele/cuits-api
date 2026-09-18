import { describe, it, expect } from "vitest"
import {
  extractVerificationToken,
  extractViIdentifier,
  extractBirthday,
  normaliseDate,
} from "@scrapers/nosisSacParsing"

const RESULT_PAGE = `
<!DOCTYPE html><html><body>
  <form action="/net/resultado/consultar" method="post">
    <input name="__RequestVerificationToken" type="hidden" value="AbC123-xYz_456==" />
    <input name="documento" type="text" value="" />
  </form>
</body></html>
`

const INDEX_HTML = `
<div class="indice">
  <a data-identificador="D1" data-prefijo="ID">Identificación</a>
  <a data-identificador="D6" data-prefijo="VI">Verificación de Identidad</a>
  <a data-identificador="D15" data-prefijo="SRT">Situación Riesgo Tributario</a>
</div>
`

const VI_BLOCK = `
<table>
  <tr><td>Documento:</td><td>46.123.578</td></tr>
  <tr><td>F. nacimiento:</td><td>30/07/2004  (22 años)</td></tr>
  <tr><td>Sexo:</td><td>Masculino</td></tr>
</table>
`

describe("extractVerificationToken", () => {
  it("reads the anti-forgery token out of the result page", () => {
    expect(extractVerificationToken(RESULT_PAGE)).toBe("AbC123-xYz_456==")
  })

  it("returns null when the form carries no token", () => {
    expect(extractVerificationToken("<form><input name='documento'/></form>")).toBeNull()
  })

  it("returns null for an empty page", () => {
    expect(extractVerificationToken("")).toBeNull()
  })
})

describe("extractViIdentifier", () => {
  it("resolves the block id by its prefix rather than by position", () => {
    expect(extractViIdentifier(INDEX_HTML)).toBe("D6")
  })

  it("does not fall for a neighbouring block with another prefix", () => {
    const withoutVi = INDEX_HTML.replace('data-prefijo="VI"', 'data-prefijo="XX"')
    expect(extractViIdentifier(withoutVi)).toBeNull()
  })

  it("follows the prefix when the numbering changes", () => {
    const renumbered = INDEX_HTML.replace('data-identificador="D6"', 'data-identificador="D22"')
    expect(extractViIdentifier(renumbered)).toBe("D22")
  })

  it("returns null when there is no index at all", () => {
    expect(extractViIdentifier("")).toBeNull()
  })
})

describe("extractBirthday", () => {
  it("reads the date out of the Verificación de Identidad block", () => {
    expect(extractBirthday(VI_BLOCK)).toBe("30/07/2004")
  })

  it("pads a single-digit day and month", () => {
    expect(extractBirthday("<tr><td>F. nacimiento:</td><td>5/7/1988 (38 años)</td></tr>")).toBe("05/07/1988")
  })

  it("tolerates the spacing around the label", () => {
    expect(extractBirthday("<td>F.nacimiento:</td>\n  <td>  01/01/1970</td>")).toBe("01/01/1970")
  })

  it("returns null for a company report, which carries no birth date", () => {
    const company = "<table><tr><td>Razón social:</td><td>ACME SA</td></tr></table>"
    expect(extractBirthday(company)).toBeNull()
  })

  it("returns null when the block is missing entirely", () => {
    expect(extractBirthday("")).toBeNull()
  })

  it("ignores a two-digit year rather than guessing the century", () => {
    expect(extractBirthday("<td>F. nacimiento:</td><td>30/07/04</td>")).toBeNull()
  })
})

describe("normaliseDate", () => {
  it("pads both day and month", () => {
    expect(normaliseDate("5/7/2004")).toBe("05/07/2004")
  })

  it("leaves an already padded date alone", () => {
    expect(normaliseDate("30/07/2004")).toBe("30/07/2004")
  })

  it("gives back anything it cannot split", () => {
    expect(normaliseDate("30-07-2004")).toBe("30-07-2004")
  })
})
