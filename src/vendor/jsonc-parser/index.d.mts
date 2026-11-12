// The parts of jsonc-parser 3.3.1 that Ballast uses.
export type JSONPath = (string | number)[]
export interface Edit {
  offset: number
  length: number
  content: string
}
export interface FormattingOptions {
  tabSize?: number
  insertSpaces?: boolean
  eol?: string
  insertFinalNewline?: boolean
  keepLines?: boolean
}
export interface ModificationOptions {
  formattingOptions?: FormattingOptions
  isArrayInsertion?: boolean
  getInsertionIndex?: (properties: string[]) => number
}
export interface ParseError {
  error: number
  offset: number
  length: number
}
export interface ParseOptions {
  disallowComments?: boolean
  allowTrailingComma?: boolean
  allowEmptyContent?: boolean
}
export function parse(text: string, errors?: ParseError[], options?: ParseOptions): any
export function modify(
  text: string,
  path: JSONPath,
  value: unknown,
  options: ModificationOptions
): Edit[]
export function applyEdits(text: string, edits: Edit[]): string
export function printParseErrorCode(code: number): string
export interface JSONVisitor {
  onLiteralValue?: (
    value: unknown,
    offset: number,
    length: number,
    startLine: number,
    startCharacter: number,
    pathSupplier: () => JSONPath
  ) => void
}
export function visit(text: string, visitor: JSONVisitor, options?: ParseOptions): any
