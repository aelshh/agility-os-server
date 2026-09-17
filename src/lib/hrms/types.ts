/**
 * Platform-agnostic employee record produced by the CSV parser.
 * This is the single normalized shape consumed by the tree builder.
 */
export interface NormalizedEmployee {
  externalHrmsId: string;
  externalManagerId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  designation: string | null;
  hireDate: string | null;
  /** 1-indexed CSV row (incl. header) for row-level error attribution. */
  rowNumber?: number;
}

/** HRMS platforms supported by the manual CSV upload flow. */
export type CsvPlatform = "keka" | "darwinbox" | "peoplehr";

/** Per-row validation failure surfaced in the upload preview. */
export interface CsvRowError {
  rowNumber: number;
  message: string;
}

export interface CsvParseResult {
  employees: NormalizedEmployee[];
  errors: CsvRowError[];
  parsedRows: number;
  skippedRows: number;
}